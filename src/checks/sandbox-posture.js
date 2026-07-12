import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe } from '../utils.js';

const DOCS = 'https://developers.openai.com/codex/config-reference';

// Only client with a sandbox-config surface today; carried here, not imported from a registry (see docs).
const CODEX_ID = 'codex';
const CODEX_NAME = 'Codex CLI';
const CODEX_CONFIG = '.codex/config.toml';

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

    // $HOME first, then the project file — which wins, matching Codex precedence.
    const keys = {};
    const files = [];
    for (const base of [homedir, cwd]) {
      const file = path.join(base, CODEX_CONFIG);
      const text = await readFileSafe(file);
      if (text === null) continue;
      files.push(file);
      Object.assign(keys, readCodexKeys(text));
    }
    if (files.length > 0) {
      surfacesScanned++;
      postures[CODEX_ID] = codexPosture(keys);
      const rule = CODEX_RULES.find((r) => r.when(keys));
      if (rule) findings.push({
        findingId: `sandbox-posture/${rule.id}`, severity: rule.severity,
        title: `${CODEX_NAME} ${rule.verb} in ${label(files[files.length - 1])}`,
        detail: rule.detail(keys), remediation: rule.remediation, learnMore: DOCS,
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
