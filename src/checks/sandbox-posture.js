import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { CLIENTS, parseMinimalToml } from '../clients.js';
import { readFileSafe, readJsonSafe, walkDirSafe, relPosix, toPosix } from '../utils.js';

const CODEX_DOCS = 'https://developers.openai.com/codex/config-reference';
const CLAUDE_DOCS = 'https://docs.claude.com/en/docs/claude-code/settings';
const GEMINI_DOCS = 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md';
const QWEN_DOCS = 'https://qwenlm.github.io/qwen-code-docs/en/users/features/approval-mode/';
const OPENCODE_DOCS = 'https://opencode.ai/docs/permissions/';
const CURSOR_DOCS = 'https://cursor.com/docs/reference/permissions';
const DEVCONTAINER_DOCS = 'https://containers.dev/implementors/json_reference/';

// Package / devcontainer-feature identifiers that install an agent CLI into the container.
// Names, not command words: prose mentioning "claude" is not an install.
const AGENT_INSTALL =
  /@anthropic-ai\/claude-code|@openai\/codex|@google\/gemini-cli|@github\/copilot|opencode-ai|aider-chat|cursor-agent|claude-code|codex-cli|gemini-cli/i;

// PRESENCE signals — each is evidence that someone ATTEMPTED egress control, and nothing more.
// A hit can never prove the container is contained: the script may no-op, the proxy may be
// bypassable, the rule may never load. So a hit only silences the finding; it grades nothing.
const EGRESS_CONTROLS = [
  ['firewall', /\biptables\b|\bip6tables\b|\bnftables\b|\bipset\b|\bufw\b|firewalld|init-firewall/i],
  ['proxy', /HTTPS?_PROXY|\bhttps?_proxy\b|tinyproxy|\bsquid\b|mitmproxy/i],
  ['default-deny', /--network[= ]"?none|"network"\s*:\s*"none"|internal:\s*true|FilterDefaultDeny|default[-_]?deny|-P\s+OUTPUT\s+DROP|policy\s+drop|allowlist|allowed[_-]?hosts/i],
  ['cap-drop', /--cap-drop|cap_drop|no-new-privileges|securityOpt|--security-opt/i],
];

const DEVCONTAINER_MAX_FILES = 200;

/**
 * The devcontainer egress surface: a `.devcontainer/` (or the single-file `.devcontainer.json`)
 * that installs an agent CLI. Returns `{ devcontainer, truncated, depthTruncated }`; `devcontainer` is null when
 * there is no devcontainer, or when the one here runs no agent — that is not this check's
 * business, so it is no surface, not a passing one.
 *
 * `truncated`/`depthTruncated` are `walkDirSafe`'s signals that the walk stopped early — at the file
 * cap or the depth cap. They are reported EVEN when `devcontainer` is null, because the most dangerous truncation is exactly
 * that case: the file naming the agent install can fall past the cap, so `AGENT_INSTALL` never
 * matches and a container with no egress boundary reads as "no surface here". The caller must
 * disclose it rather than certify absence — see the N/A gate below.
 *
 * Presence-only BY CONSTRUCTION, which is a ceiling and not a bug — see the docs page.
 */
async function scanDevcontainer(cwd) {
  const { files, truncated, depthTruncated } = await walkDirSafe(path.join(cwd, '.devcontainer'), {
    maxFiles: DEVCONTAINER_MAX_FILES, skipHidden: false,
  });
  const single = path.join(cwd, '.devcontainer.json'); // the documented single-file form
  let text = '';
  for (const file of [...files, single]) text += (await readFileSafe(file)) ?? '';
  if (!AGENT_INSTALL.test(text)) return { devcontainer: null, truncated, depthTruncated };
  return {
    devcontainer: {
      where: files.length ? '.devcontainer/' : '.devcontainer.json',
      controls: EGRESS_CONTROLS.filter(([, re]) => re.test(text)).map(([id]) => id),
    },
    truncated,
    depthTruncated,
  };
}

/**
 * Targeted projection of Codex's `config.toml` onto the three keys this check grades:
 * `approval_policy`/`sandbox_mode` (root) + `network_access` ([sandbox_workspace_write]).
 * The TOML reading itself is `parseMinimalToml` in src/clients.js — the SAME reader that
 * resolves Codex's `[mcp_servers.*]` MCP surface, so the sandbox arm and the MCP arm can
 * never disagree about what a given config.toml says. A key of the wrong type (or one the
 * reader cannot model) stays absent → undefined — unknown, never dangerous.
 */
export function readCodexKeys(text) {
  const toml = parseMinimalToml(text);
  const out = {};
  for (const key of ['approval_policy', 'sandbox_mode']) {
    if (typeof toml[key] === 'string') out[key] = toml[key];
  }
  const networkAccess = toml.sandbox_workspace_write?.network_access;
  if (typeof networkAccess === 'boolean') out.network_access = networkAccess;
  return out;
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
    bypass: defaultModeOf(settings) === 'bypassPermissions',
  };
}

/**
 * Claude Code writes the approval mode at `permissions.defaultMode`; the top-level key is the
 * legacy shape. Nested is read FIRST, top-level only as the fallback: reading the top level alone
 * graded a real-world bypassing config as if it had no bypass at all — `bypass` never went true,
 * so the `unrestricted` posture and the bypass clause of the detail string could not fire.
 */
function defaultModeOf(settings) {
  return settings?.permissions?.defaultMode ?? settings?.defaultMode;
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
 * Gemini CLI's posture surface: `.gemini/settings.json`, key `general.defaultApprovalMode`.
 * "default" prompts on every tool call, "auto_edit" auto-approves file edits, "plan" is
 * read-only, "yolo" auto-approves everything. (Gemini honors `yolo` only from the CLI flag,
 * but a committed value still declares the intent, so it is graded.) Anything else →
 * undefined — unknown, never dangerous. See the docs page.
 */
export function readGeminiKeys(settings) {
  const mode = settings?.general?.defaultApprovalMode;
  return { defaultApprovalMode: typeof mode === 'string' ? mode : undefined };
}

/** Read-only "plan" is the sandbox; "yolo" drops the approval prompt entirely. */
function geminiPosture(k) {
  if (k.defaultApprovalMode === 'plan') return 'restricted';
  if (k.defaultApprovalMode === 'yolo') return 'unrestricted';
  return 'partial'; // "default"/"auto_edit"/absent: at least some tools still prompt, no sandbox
}

const GEMINI_RULES = [
  { id: 'gemini-yolo-approval', severity: 'warning', verb: 'auto-approves every tool call',
    when: (k) => k.defaultApprovalMode === 'yolo',
    detail: () => 'general.defaultApprovalMode = "yolo" auto-approves every tool call, including shell commands — the agent never prompts. Gemini honors yolo only from the CLI flag, but a committed value declares the intent.',
    remediation: 'Set general.defaultApprovalMode = "default" (or "plan") in .gemini/settings.json.' },
  { id: 'gemini-auto-edit', severity: 'warning', verb: 'auto-approves file edits without prompting',
    when: (k) => k.defaultApprovalMode === 'auto_edit',
    detail: () => 'general.defaultApprovalMode = "auto_edit" auto-approves write_file/replace edits without asking; only non-edit tools still prompt.',
    remediation: 'Set general.defaultApprovalMode = "default" to prompt on every tool call in .gemini/settings.json.' },
];

/**
 * Qwen Code's posture surface: `.qwen/settings.json`, key `tools.approvalMode` (a Gemini-CLI
 * fork that MOVED the knob off Gemini's `general.defaultApprovalMode`, so the gemini reader can't
 * grade it). Values: "plan" is read-only, "default" prompts on every call, "auto-edit" auto-approves
 * edits, "auto" is an LLM classifier, "yolo" auto-approves everything. Anything else → undefined
 * (unknown, never dangerous). See the docs page.
 */
export function readQwenKeys(settings) {
  const mode = settings?.tools?.approvalMode;
  return { approvalMode: typeof mode === 'string' ? mode : undefined };
}

/** Read-only "plan" is the sandbox; "yolo" drops the approval prompt entirely. */
function qwenPosture(k) {
  if (k.approvalMode === 'plan') return 'restricted';
  if (k.approvalMode === 'yolo') return 'unrestricted';
  return 'partial'; // "default"/"auto-edit"/"auto"/absent: at least some tools still prompt
}

const QWEN_RULES = [
  { id: 'qwen-yolo-approval', severity: 'warning', verb: 'auto-approves every tool call',
    when: (k) => k.approvalMode === 'yolo',
    detail: () => 'tools.approvalMode = "yolo" grants Qwen Code the highest permissions — every tool call, including shell commands, is auto-approved with no prompt.',
    remediation: 'Set tools.approvalMode = "default" (or "plan") in .qwen/settings.json.' },
  { id: 'qwen-auto-edit', severity: 'warning', verb: 'auto-approves file edits without prompting',
    when: (k) => k.approvalMode === 'auto-edit',
    detail: () => 'tools.approvalMode = "auto-edit" auto-approves file edits without asking; only shell commands still prompt.',
    remediation: 'Set tools.approvalMode = "default" to prompt on every tool call in .qwen/settings.json.' },
];

/**
 * opencode's posture surface: `opencode.json`, the `permission` block. Each tool (`bash`,
 * `edit`, …) or the `*` catch-all maps to "allow" | "ask" | "deny"; a value may be a string
 * or a `{ pattern: verdict }` object. This resolves the COARSE verdict for the highest-risk
 * tool — bash — falling back to `*`, and reads an object form's own `*` entry. Returns null
 * when there is no `permission` block (unknown, never dangerous — same stance as the others).
 */
export function readOpencodeKeys(config) {
  const perm = config?.permission;
  if (!perm || typeof perm !== 'object') return null;
  const coarse = (v) =>
    typeof v === 'string' ? v
      : (v && typeof v === 'object' && typeof v['*'] === 'string' ? v['*'] : undefined);
  return { bashVerdict: coarse(perm.bash) ?? coarse(perm['*']) };
}

/** "deny" binds; "allow" auto-runs shell; "ask" (or unresolved) still prompts. */
function opencodePosture(k) {
  if (k.bashVerdict === 'deny') return 'restricted';
  if (k.bashVerdict === 'allow') return 'unrestricted';
  return 'partial';
}

const OPENCODE_RULES = [
  { id: 'opencode-auto-run-shell', severity: 'warning', verb: 'auto-runs shell commands without asking',
    when: (k) => k.bashVerdict === 'allow',
    detail: () => 'permission.bash (or the "*" catch-all) is "allow" in opencode.json — opencode runs shell/bash tool calls automatically, with no approval prompt. A prompt-injected instruction becomes an executed command.',
    remediation: 'Set "permission": { "bash": "ask" } (or "deny") in opencode.json.' },
];

/**
 * Cursor's posture surface: the COMMITTED `.cursor/permissions.json`. It is an ALLOWLIST —
 * `terminalAllowlist` (command prefixes) and `mcpAllowlist` ("server:tool" patterns) — with
 * no sandbox knob, so its ceiling is `partial` (a narrow allowlist), never `restricted`. A
 * bare "*" in the terminal list, or "*:*"/"*" in the MCP list, auto-runs everything unprompted.
 */
export function readCursorKeys(config) {
  const term = Array.isArray(config?.terminalAllowlist) ? config.terminalAllowlist : [];
  const mcp = Array.isArray(config?.mcpAllowlist) ? config.mcpAllowlist : [];
  return { wildcardTerminal: term.includes('*'), wildcardMcp: mcp.includes('*:*') || mcp.includes('*') };
}

/** Any wildcard allowlist auto-runs everything; otherwise the allowlist is bounded. */
function cursorPosture(k) {
  return (k.wildcardTerminal || k.wildcardMcp) ? 'unrestricted' : 'partial';
}

const CURSOR_RULES = [
  { id: 'cursor-wildcard-autorun', severity: 'warning', verb: 'auto-runs any command via a wildcard allowlist',
    when: (k) => k.wildcardTerminal || k.wildcardMcp,
    detail: (k) => `${k.wildcardTerminal ? 'terminalAllowlist contains "*"' : 'mcpAllowlist contains "*:*"'} in .cursor/permissions.json — every ${k.wildcardTerminal ? 'terminal command' : 'MCP tool'} auto-runs with no approval prompt.`,
    remediation: 'Replace the wildcard with specific prefixes (e.g. "git", "npm:install*", "github:list_issues") in .cursor/permissions.json.' },
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
  gemini: {
    read: async (file) => {
      const settings = await readJsonSafe(file);
      return settings === null ? null : readGeminiKeys(settings);
    },
    merge: (a, b) => ({ defaultApprovalMode: b.defaultApprovalMode ?? a.defaultApprovalMode }),
    posture: geminiPosture, rules: GEMINI_RULES, docs: GEMINI_DOCS,
  },
  qwen: {
    read: async (file) => {
      const settings = await readJsonSafe(file);
      return settings === null ? null : readQwenKeys(settings);
    },
    merge: (a, b) => ({ approvalMode: b.approvalMode ?? a.approvalMode }),
    posture: qwenPosture, rules: QWEN_RULES, docs: QWEN_DOCS,
  },
  opencode: {
    read: async (file) => {
      const config = await readJsonSafe(file);
      return config === null ? null : readOpencodeKeys(config);
    },
    merge: (a, b) => ({ bashVerdict: b.bashVerdict ?? a.bashVerdict }),
    posture: opencodePosture, rules: OPENCODE_RULES, docs: OPENCODE_DOCS,
  },
  cursor: {
    read: async (file) => {
      const config = await readJsonSafe(file);
      return config === null ? null : readCursorKeys(config);
    },
    merge: (a, b) => ({
      wildcardTerminal: a.wildcardTerminal || b.wildcardTerminal,
      wildcardMcp: a.wildcardMcp || b.wildcardMcp,
    }),
    posture: cursorPosture, rules: CURSOR_RULES, docs: CURSOR_DOCS,
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
    const label = (f) => toPosix(f.startsWith(homedir) ? f.replace(homedir, '~') : path.relative(cwd, f));

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

    // The devcontainer arm deliberately writes NO entry into `postures`: a posture is a claim
    // about what the agent can reach, and presence evidence cannot support one in either
    // direction. Silence on a hit, a finding on none — never a grade.
    const { devcontainer, truncated: devcontainerTruncated, depthTruncated: devcontainerDepthTruncated } = await scanDevcontainer(cwd);
    if (devcontainer) {
      surfacesScanned++;
      if (devcontainer.controls.length === 0) findings.push({
        findingId: 'sandbox-posture/devcontainer-no-egress-control',
        severity: 'warning',
        title: `Devcontainer runs an agent with no egress control in ${devcontainer.where}`,
        detail: 'This devcontainer installs an agent CLI and carries no firewall, no proxy, no default-deny network rule and no capability drop — nothing in it even attempts to bound what the agent can reach, so the agent inherits the host\'s network. This is a presence check: it reports that no attempt at containment is visible, and a hit would have proven only an attempt, never containment.',
        remediation: 'Give the container an egress boundary — an internal-only network plus a deny-by-default proxy, --cap-drop=ALL and --security-opt=no-new-privileges (templates/container is a worked example). Then prove it blocks: a proxy whose filter fails to parse fails OPEN, and a happy-path healthcheck calls that healthy.',
        learnMore: DEVCONTAINER_DOCS,
      });
    }

    // A truncated devcontainer walk read only SOME of the box the agent runs inside, so
    // "no surface here" is a claim it did not earn. WARNING, not INFO: what an unread file
    // can hide here is `devcontainer-no-egress-control` — a container running an agent with
    // no containment at all — which is itself a WARNING, so the disclosure is priced to
    // match. The point is the score: without it this returned NOT_APPLICABLE (-1, "not in
    // scope") over exactly that container. Emitted whenever the walk truncated, even when
    // the agent install WAS seen — the egress-control scan then ran over an incomplete file
    // set too, and an unread firewall would have silenced the finding above. Making the
    // surface count non-zero is what keeps the N/A gate below from firing.
    if (devcontainerTruncated || devcontainerDepthTruncated) {
      surfacesScanned++;
      findings.push({
        findingId: 'sandbox-posture/devcontainer-file-cap-reached',
        severity: 'warning',
        title: 'Devcontainer scan stopped early (cap reached)',
        detail: `The .devcontainer walk stopped early (${DEVCONTAINER_MAX_FILES}-file limit and/or directory-depth limit), so files past the cap were never read. The file that installs the agent CLI — or an egress control that would bound it — can sit past the cap, so this result cannot be read as "no agent, no surface".`,
        remediation: `Move generated or vendored trees out of .devcontainer/, or reduce nesting, so the whole surface fits under the caps.`,
        learnMore: DEVCONTAINER_DOCS,
      });
    }

    // No sandbox surface anywhere is N/A, never 0 — most repos configure none. But a
    // truncated walk bumped surfacesScanned above, so "I did not finish looking" never
    // renders as "there is nothing to look at".
    if (surfacesScanned === 0) {
      return { score: NOT_APPLICABLE_SCORE, findings: [], data: { postures: {}, surfacesScanned: 0 } };
    }
    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'No dangerous sandbox or permission combination found' });
    }
    return {
      score: calculateCheckScore(findings), findings,
      data: { postures, surfacesScanned, devcontainer },
    };
  },
};
