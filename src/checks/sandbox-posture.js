import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { CLIENTS } from '../clients.js';
import { readFileSafe, readJsonSafe } from '../utils.js';

const CODEX_DOCS = 'https://developers.openai.com/codex/config-reference';
const CLAUDE_DOCS = 'https://docs.claude.com/en/docs/claude-code/settings';

// Targeted key reader for Codex's `config.toml` — NOT a TOML parser. Reads only
// `approval_policy`/`sandbox_mode` (root) + `network_access` ([sandbox_workspace_write]).
// Anything it cannot parse is `undefined` — unknown, never dangerous. See the docs page.
export function readCodexKeys(text) {
  const out = {};
  let table = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // `[[array-of-tables]]` / anything unrecognized parks us in `null` — no key is read from it.
    if (line.startsWith('[')) {
      const header = line.match(/^\[\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\]$/);
      table = header ? header[1] : null;
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!kv) continue;
    const value = parseScalar(kv[2]);
    if (table === '' && (kv[1] === 'approval_policy' || kv[1] === 'sandbox_mode')) {
      if (typeof value === 'string') out[kv[1]] = value;
    } else if (table === 'sandbox_workspace_write' && kv[1] === 'network_access') {
      if (typeof value === 'boolean') out.network_access = value;
    }
  }
  return out;
}

/** A quoted string or a bare boolean. Anything else → undefined (unknown). */
function parseScalar(rhs) {
  const s = rhs.trim();
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1);
    return end === -1 ? undefined : s.slice(1, end);
  }
  const bare = s.split('#')[0].trim();
  if (bare === 'true' || bare === 'false') return bare === 'true';
  return undefined;
}

// `network_access` binds only workspace-write; danger-full-access has no boundary at all.
function networkOpen(k) {
  if (k.sandbox_mode === 'danger-full-access') return true;
  if (k.sandbox_mode === 'workspace-write') return k.network_access === true;
  return false;
}

/** Normalize Codex's knobs into one cross-vendor posture verdict. */
function codexPosture(k) {
  if (k.sandbox_mode === 'danger-full-access') return 'unrestricted';
  if (k.sandbox_mode === 'read-only') return 'restricted';
  if (k.approval_policy === 'never') return 'unrestricted';
  return 'partial';
}

// Ordered Codex rules — first match wins; no match = nothing worth reporting.
const CODEX_RULES = [
  { id: 'codex-no-sandbox', severity: 'critical', verb: 'sandbox disabled',
    when: (k) => k.sandbox_mode === 'danger-full-access',
    detail: (k) => `sandbox_mode = "danger-full-access" drops the filesystem and network boundary entirely${k.approval_policy === 'never' ? ', and approval_policy = "never" drops the approval prompt — the agent acts with full host access and never asks' : ''}.`,
    remediation: 'Set sandbox_mode = "workspace-write" (or "read-only") in .codex/config.toml.' },
  { id: 'codex-auto-approve-networked', severity: 'critical', verb: 'auto-approves with network access',
    when: (k) => k.approval_policy === 'never' && networkOpen(k),
    detail: () => 'approval_policy = "never" with [sandbox_workspace_write] network_access = true: the agent edits the workspace and reaches the network without ever prompting — a self-contained exfiltration path.',
    remediation: 'Set network_access = false, or raise approval_policy to "on-request" / "untrusted".' },
  { id: 'codex-auto-approve', severity: 'warning', verb: 'never prompts for approval',
    when: (k) => k.approval_policy === 'never' && k.sandbox_mode !== 'read-only',
    detail: () => 'approval_policy = "never" lets the agent run every command it chooses, unprompted. The sandbox is the only remaining limit.',
    remediation: 'Set approval_policy = "on-request" (or "untrusted") in .codex/config.toml.' },
];

/**
 * Claude Code's posture surface. It ships no sandbox knob: `permissions.deny` plus the
 * approval mode ARE the boundary. Only the posture question is read here — how many deny
 * rules exist at all — never *which* allow entries are dangerous; `claude-settings` grades those.
 */
export function readDenyKeys(settings) {
  const deny = settings?.permissions?.deny;
  return {
    denyCount: Array.isArray(deny) ? deny.length : 0,
    bypass: settings?.defaultMode === 'bypassPermissions',
  };
}

/** Nothing denied and nothing prompted is unrestricted; otherwise something still binds. */
function denyPosture(k) {
  if (k.denyCount === 0 && k.bypass) return 'unrestricted';
  return 'partial'; // `restricted` needs a real sandbox — Claude Code has none to read.
}

const DENY_RULES = [
  { id: 'claude-no-deny-rules', severity: 'warning', verb: 'declares no deny rules',
    when: (k) => k.denyCount === 0,
    detail: (k) => `permissions.deny is empty or absent — no tool call is refused outright, so the allow list plus an approval prompt are the whole boundary${k.bypass ? ', and defaultMode = "bypassPermissions" removes the prompt too' : ''}.`,
    remediation: 'Add permissions.deny entries (e.g. "Bash(curl:*)", "Read(./.env)") to .claude/settings.json.' },
];

/**
 * One reader + rule set per declared `format` in the client registry. The run loop below
 * knows nothing about any specific client: a new registry entry declaring a `sandbox`
 * surface in a known format is scanned with no change here. `merge` folds a client's files
 * in precedence order ($HOME first, project last).
 */
const FORMATS = {
  toml: {
    read: async (file) => {
      const text = await readFileSafe(file);
      return text === null ? null : readCodexKeys(text);
    },
    merge: (a, b) => Object.assign(a, b), // later file wins, key by key
    posture: codexPosture, rules: CODEX_RULES, docs: CODEX_DOCS,
  },
  json: {
    // Unparseable JSON reads as absent — unknown, never dangerous (same stance as the TOML reader).
    read: async (file) => {
      const settings = await readJsonSafe(file);
      return settings === null ? null : readDenyKeys(settings);
    },
    merge: (a, b) => ({ denyCount: a.denyCount + b.denyCount, bypass: a.bypass || b.bypass }),
    posture: denyPosture, rules: DENY_RULES, docs: CLAUDE_DOCS,
  },
};

export default {
  id: 'sandbox-posture',
  enforcementGrade: 'mechanical',
  name: 'Sandbox posture',
  category: 'isolation',

  async run(context) {
    const { cwd, homedir } = context;
    const findings = [];
    const postures = {};
    let surfacesScanned = 0;
    const label = (f) => (f.startsWith(homedir) ? f.replace(homedir, '~') : path.relative(cwd, f));

    // The registry is the surface list. Each client's entries are read in declaration
    // order — $HOME first, then the project file, which wins. A client's entries share
    // one format; an unknown format is skipped (unknown, never dangerous).
    for (const client of CLIENTS.filter((c) => c.sandbox)) {
      let keys = null;
      let format = null;
      let last = null;
      for (const entry of client.sandbox) {
        const fmt = FORMATS[entry.format];
        if (!fmt) continue;
        const file = path.join(entry.base === 'home' ? homedir : cwd, entry.path);
        const read = await fmt.read(file);
        if (read === null) continue;
        keys = keys === null ? read : fmt.merge(keys, read);
        format = fmt;
        last = file;
      }
      if (keys === null) continue; // client declares a surface, this machine has no file
      surfacesScanned++;
      postures[client.id] = format.posture(keys);
      const rule = format.rules.find((r) => r.when(keys));
      if (rule) findings.push({
        findingId: `sandbox-posture/${rule.id}`, severity: rule.severity,
        title: `${client.name} ${rule.verb} in ${label(last)}`,
        detail: rule.detail(keys), remediation: rule.remediation, learnMore: format.docs,
      });
    }

    // No sandbox surface anywhere is N/A, never 0 — most repos configure none.
    if (surfacesScanned === 0) {
      return { score: NOT_APPLICABLE_SCORE, findings: [], data: { postures: {}, surfacesScanned: 0 } };
    }
    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'No dangerous sandbox or permission combination found' });
    }
    return { score: calculateCheckScore(findings), findings, data: { postures, surfacesScanned } };
  },
};
