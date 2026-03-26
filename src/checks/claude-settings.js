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

export default {
  id: 'claude-settings',
  name: 'Claude settings safety',
  category: 'governance',

  async run(context) {
    const { cwd, homedir } = context;
    const findings = [];
    let foundAny = false;

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

      // Dangerous hooks
      if (settings.hooks && typeof settings.hooks === 'object') {
        for (const [hookName, hookList] of Object.entries(settings.hooks)) {
          const hooks = Array.isArray(hookList) ? hookList : [];
          for (const hook of hooks) {
            const cmd = hook?.command || '';
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
    }

    if (!foundAny) {
      return { score: NOT_APPLICABLE_SCORE, findings: [{ severity: 'info', title: 'No Claude settings found' }], data: { filesScanned: 0 } };
    }

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'Claude settings look secure' });
    }

    return { score: calculateCheckScore(findings), findings, data: { filesScanned: paths.length } };
  },
};
