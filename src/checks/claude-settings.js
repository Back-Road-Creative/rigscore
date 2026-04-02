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

export default {
  id: 'claude-settings',
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
          severity: 'critical',
          title: `ANTHROPIC_BASE_URL redirected in ${rel}`,
          detail: `API calls redirected to ${baseUrl.slice(0, 60)} — this can exfiltrate API keys (CVE-2026-21852).`,
          remediation: 'Remove ANTHROPIC_BASE_URL override or set it to https://api.anthropic.com.',
        });
      }

      // bypassPermissions + skipDangerousModePermissionPrompt combo
      if (settings.defaultMode === 'bypassPermissions' && settings.skipDangerousModePermissionPrompt === true) {
        findings.push({
          severity: 'critical',
          title: `bypassPermissions + skipDangerousModePermissionPrompt in ${rel}`,
          detail: 'Both flags set together eliminate all user confirmation — the deny list is the sole defense. Any command not explicitly denied executes automatically.',
          remediation: 'Remove skipDangerousModePermissionPrompt or change defaultMode to "acceptEdits".',
        });
      }

      // Track bypass mode for data export
      if (settings.defaultMode === 'bypassPermissions') {
        hasBypassPermissions = true;
        defaultMode = settings.defaultMode;
      } else if (settings.defaultMode && !defaultMode) {
        defaultMode = settings.defaultMode;
      }

      // Dangerous hooks
      if (settings.hooks && typeof settings.hooks === 'object') {
        for (const [hookName, hookList] of Object.entries(settings.hooks)) {
          allConfiguredHooks.add(hookName);
          const hooks = Array.isArray(hookList) ? hookList : [];
          for (const hook of hooks) {
            const cmd = hook?.command || '';

            // Dangerous pattern check
            for (const pattern of DANGEROUS_HOOK_RE) {
              if (pattern.test(cmd)) {
                findings.push({
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
      // Hooks exist but some lifecycle events are uncovered
      for (const missing of missingLifecycleHooks) {
        findings.push({
          severity: 'info',
          title: `Claude Code lifecycle hook not configured: ${missing}`,
          detail: `No ${missing} hook found. This lifecycle event is unmonitored — tool calls, stops, or prompts in this phase execute without any hook interception.`,
          remediation: `Add a ${missing} hook to settings.json to monitor or enforce rules at this lifecycle stage.`,
        });
      }
    } else if (allConfiguredHooks.size === 0) {
      findings.push({
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
