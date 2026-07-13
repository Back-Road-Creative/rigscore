import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readJsonSafe } from '../utils.js';

const DANGEROUS_HOOK_RE = [
  /\bcurl\b/, /\bwget\b/, /\brm\s+-rf\b/, /\beval\b/, /\bbase64\s+-d\b/,
  /\bnc\b/, /\/dev\/tcp/, /\bpython[23]?\s+-c\b/, /\bnode\s+-e\b/,
];

const SETTINGS_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
];

// Allow-list entries that grant dangerous broad access
const DANGEROUS_ALLOW_PATTERNS = [
  { re: /sudo\s+-u\s+\w+\s+bash/i,   msg: 'allows arbitrary execution as another user via sudo bash' },
  { re: /sudo\s+-u\s+dev\b/i,         msg: 'allows any operation as the dev user (overly broad)' },
  { re: /Bash\(docker\s+run/i,         msg: 'allows unrestricted docker run (potential container escape)' },
  { re: /Bash\(pip[23]?\s+install/i,  msg: 'allows raw pip install (should use project-specific wrapper)' },
];

// The 4 meaningful Claude Code lifecycle hooks
const CLAUDE_LIFECYCLE_HOOKS = ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'];

/**
 * Flatten every shell command configured under one hook event.
 *
 * The documented schema (https://code.claude.com/docs/en/hooks) nests the
 * command two levels down, behind a matcher:
 *   "PreToolUse": [ { "matcher": "Bash",
 *                     "hooks": [ { "type": "command", "command": "…", "args": [] } ] } ]
 * Hand-written and older configs put the command straight on the entry:
 *   "PreToolUse": [ { "command": "…" } ]
 * Read BOTH — scanning only the flat shape makes every real-world hook command
 * invisible to the dangerous-pattern scan below. `args` are folded into the
 * command string so `bash -c "<payload>"` cannot hide the payload.
 * Non-command handler types (http, mcp_tool, prompt, agent) carry no shell
 * command and contribute nothing.
 */
function extractHookCommands(hookList) {
  const commands = [];
  const collect = (entry) => {
    if (!entry || typeof entry.command !== 'string') return;
    const args = Array.isArray(entry.args) ? entry.args.filter(a => typeof a === 'string') : [];
    const cmd = [entry.command, ...args].join(' ').trim();
    if (cmd) commands.push(cmd);
  };
  for (const entry of Array.isArray(hookList) ? hookList : []) {
    if (!entry || typeof entry !== 'object') continue;
    collect(entry);                                                  // flat / legacy shape
    for (const inner of Array.isArray(entry.hooks) ? entry.hooks : []) collect(inner); // real schema
  }
  return commands;
}

/**
 * Read a permission key from BOTH settings shapes, nested first.
 *
 * The published schema (json.schemastore.org/claude-code-settings.json) nests the
 * mode under `permissions`:
 *   { "permissions": { "defaultMode": "bypassPermissions", "deny": [...] } }
 * which is also the shape rigscore's own templates/guards/settings.json writes.
 * Hand-written and older configs put it at the top level:
 *   { "defaultMode": "bypassPermissions" }
 * Reading only the top level made every REAL bypassPermissions config invisible —
 * the check scored it 98/100 and printed "Claude settings look secure".
 *
 * `skipDangerousModePermissionPrompt` appears nowhere in the published schema, so it
 * has no canonical home; accept it in either position for the same reason.
 */
function readPermissionKey(settings, key) {
  const perms = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  return perms[key] !== undefined ? perms[key] : settings[key];
}

export default {
  id: 'claude-settings',
  enforcementGrade: 'mechanical',
  name: 'Claude settings safety',
  category: 'governance',

  async run(context) {
    const { cwd, homedir } = context;
    const findings = [];
    let foundAny = false;

    // Aggregate data across all found settings files
    const allConfiguredHooks = new Set();
    const allAllowListEntries = [];
    let hasBypassPermissions = false;
    let defaultMode = null;

    const paths = [
      ...SETTINGS_FILES.map(f => ({ p: path.join(cwd, f), rel: f })),
      ...SETTINGS_FILES.map(f => ({ p: path.join(homedir, f), rel: '~/' + f })),
    ];

    for (const { p, rel } of paths) {
      const settings = await readJsonSafe(p);
      if (!settings) continue;
      foundAny = true;

      // enableAllProjectMcpServers
      if (settings.enableAllProjectMcpServers === true) {
        findings.push({
          findingId: 'claude-settings/mcp-auto-approve-enabled',
          severity: 'critical',
          title: `MCP auto-approve enabled in ${rel}`,
          detail: 'enableAllProjectMcpServers is true — all project MCP servers are auto-approved without user consent.',
          remediation: 'Remove enableAllProjectMcpServers or set it to false.',
        });
      }

      // ANTHROPIC_BASE_URL override
      const env = settings.env || {};
      const baseUrl = env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_BASE || '';
      if (baseUrl && !baseUrl.includes('api.anthropic.com') && !baseUrl.includes('127.0.0.1') && !baseUrl.includes('localhost')) {
        findings.push({
          findingId: 'claude-settings/anthropic-base-url-redirected',
          severity: 'critical',
          title: `ANTHROPIC_BASE_URL redirected in ${rel}`,
          detail: `API calls redirected to ${baseUrl.slice(0, 60)} — this can exfiltrate API keys (CVE-2026-21852).`,
          remediation: 'Remove ANTHROPIC_BASE_URL override or set it to https://api.anthropic.com.',
          learnMore: 'https://research.checkpoint.com/2026/rce-and-api-token-exfiltration-through-claude-code-project-files-cve-2025-59536/',
        });
      }

      // Permission mode — read from both shapes (see readPermissionKey above).
      const mode = readPermissionKey(settings, 'defaultMode');
      const skipsDangerPrompt = readPermissionKey(settings, 'skipDangerousModePermissionPrompt') === true;
      const isBypass = mode === 'bypassPermissions';

      if (isBypass && skipsDangerPrompt) {
        // Both flags: not even the one-time dangerous-mode confirmation is shown.
        findings.push({
          findingId: 'claude-settings/bypass-plus-skip-prompt',
          severity: 'critical',
          title: `bypassPermissions + skipDangerousModePermissionPrompt in ${rel}`,
          detail: 'Both flags set together eliminate all user confirmation — the deny list is the sole defense. Any command not explicitly denied executes automatically.',
          remediation: 'Remove skipDangerousModePermissionPrompt or change defaultMode to "acceptEdits".',
        });
      } else if (isBypass) {
        // Bypass ALONE is already a finding — it removes the per-tool-call approval
        // prompt outright. WARNING, not CRITICAL: the mode still costs the operator a
        // one-time dangerous-mode confirmation, so a human opened the gate on purpose.
        // That matches the file's convention — CRITICAL is reserved for settings that
        // take the human out of the loop entirely (MCP auto-approve, base-URL redirect,
        // the bypass+skip combo); WARNING covers a blast radius a human widened
        // knowingly (wildcard tools, dangerous allow-list entries). WARNING also
        // suppresses the "Claude settings look secure" pass line, which is the bug.
        findings.push({
          findingId: 'claude-settings/bypass-permissions-mode',
          severity: 'warning',
          title: `defaultMode is "bypassPermissions" in ${rel}`,
          detail: 'Every tool call runs without an approval prompt — the deny list is the only thing between an injected instruction and execution.',
          remediation: 'Set defaultMode to "acceptEdits" (or "default"), or set permissions.disableBypassPermissionsMode to "disable" to forbid the mode outright.',
        });
      }

      // Track bypass mode for data export
      if (isBypass) {
        hasBypassPermissions = true;
        defaultMode = mode;
      } else if (mode && !defaultMode) {
        defaultMode = mode;
      }

      // Dangerous hooks
      if (settings.hooks && typeof settings.hooks === 'object') {
        for (const [hookName, hookList] of Object.entries(settings.hooks)) {
          allConfiguredHooks.add(hookName);
          for (const cmd of extractHookCommands(hookList)) {
            // Dangerous pattern check
            for (const pattern of DANGEROUS_HOOK_RE) {
              if (pattern.test(cmd)) {
                findings.push({
                  findingId: 'claude-settings/dangerous-hook-command',
                  severity: 'critical',
                  title: `Dangerous hook in ${rel} (${hookName})`,
                  detail: `Hook runs: ${cmd.slice(0, 80)}`,
                  remediation: 'Remove dangerous hook commands. Repo-level hooks execute on every collaborator.',
                });
                break;
              }
            }

            // Hook script existence check: if first token is a file path, verify it exists
            const firstToken = cmd.trim().split(/\s+/)[0];
            if (firstToken && /^[/~.]/.test(firstToken)) {
              const resolved = firstToken.replace(/^~/, homedir);
              const exists = await fs.promises.access(resolved).then(() => true).catch(() => false);
              if (!exists) {
                findings.push({
                  findingId: 'claude-settings/hook-script-missing',
                  severity: 'warning',
                  title: `Hook script not found in ${rel} (${hookName})`,
                  detail: `Hook references '${firstToken}' which does not exist on disk. The hook will silently fail.`,
                  remediation: `Create the script at '${firstToken}' or update the hook command path.`,
                });
              }
            }
          }
        }
      }

      // allowedTools wildcard
      const allowed = settings.allowedTools || settings.permissions?.allow || [];
      if (Array.isArray(allowed) && allowed.includes('*')) {
        findings.push({
          findingId: 'claude-settings/wildcard-tool-permission',
          severity: 'warning',
          title: `Wildcard tool permissions in ${rel}`,
          detail: 'allowedTools contains "*" which permits all tools without approval.',
          remediation: 'Specify individual tool names instead of wildcard.',
        });
      }

      // Dangerous allow-list entries
      if (Array.isArray(allowed)) {
        allAllowListEntries.push(...allowed);
        for (const entry of allowed) {
          for (const { re, msg } of DANGEROUS_ALLOW_PATTERNS) {
            if (re.test(entry)) {
              findings.push({
                findingId: 'claude-settings/dangerous-allow-list-entry',
                severity: 'warning',
                title: `Dangerous allow list entry in ${rel}`,
                detail: `Entry '${entry.slice(0, 80)}' ${msg}.`,
                remediation: 'Remove this allow list entry. Under bypassPermissions mode it is redundant; under other modes it bypasses safety checks.',
              });
              break; // one finding per entry
            }
          }
        }
      }
    }

    if (!foundAny) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{ severity: 'info', title: 'No Claude settings found' }],
        data: { filesScanned: 0, configuredHooks: [], missingLifecycleHooks: CLAUDE_LIFECYCLE_HOOKS, hasBypassPermissions: false, defaultMode: null, allowListEntries: [] },
      };
    }

    // Hook coverage check: which lifecycle events are missing?
    const configuredHooks = [...allConfiguredHooks];
    const missingLifecycleHooks = CLAUDE_LIFECYCLE_HOOKS.filter(h => !allConfiguredHooks.has(h));

    if (allConfiguredHooks.size > 0 && missingLifecycleHooks.length > 0) {
      // ONE rollup INFO for partial coverage — never one INFO per missing hook.
      // Per-hook deductions made partial adoption score *worse* than zero
      // adoption (one hook = 3 missing = -6 → 94; no hooks = one rollup = -2 →
      // 98), i.e. the score punished the first step toward coverage and paid
      // out only at four. Adding a hook must never lower the score.
      findings.push({
        findingId: 'claude-settings/lifecycle-hook-missing',
        severity: 'info',
        title: `Claude Code lifecycle hooks not configured: ${missingLifecycleHooks.join(', ')}`,
        detail: `Configured: ${configuredHooks.join(', ')}. The remaining lifecycle events are unmonitored — tool calls, stops, or prompts in those phases execute without any hook interception.`,
        remediation: `Add ${missingLifecycleHooks.join(' / ')} hook(s) to settings.json to monitor or enforce rules at those lifecycle stages.`,
      });
    } else if (allConfiguredHooks.size === 0) {
      findings.push({
        findingId: 'claude-settings/no-lifecycle-hooks',
        severity: 'info',
        title: 'No Claude Code lifecycle hooks configured',
        detail: 'No hooks defined in settings.json. PreToolUse, PostToolUse, Stop, and UserPromptSubmit hooks enable enforcement of governance rules at runtime.',
        remediation: 'Add lifecycle hooks to .claude/settings.json to enforce runtime governance.',
      });
    }

    if (!findings.some(f => f.severity === 'critical' || f.severity === 'warning')) {
      findings.push({ severity: 'pass', title: 'Claude settings look secure' });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: {
        filesScanned: paths.length,
        configuredHooks,
        missingLifecycleHooks,
        hasBypassPermissions,
        defaultMode,
        allowListEntries: allAllowListEntries,
      },
    };
  },
};
