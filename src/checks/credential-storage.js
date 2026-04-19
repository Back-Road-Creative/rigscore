import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, KEY_PATTERNS } from '../constants.js';
import { readJsonSafe } from '../utils.js';

const CLIENT_CONFIGS = [
  { name: 'Claude Desktop', file: 'claude_desktop_config.json', dir: '.claude' },
  { name: 'Cursor', file: 'mcp.json', dir: '.cursor' },
  { name: 'Cline', file: 'mcp_settings.json', dir: '.cline' },
  { name: 'Continue', file: 'config.json', dir: '.continue' },
  { name: 'Windsurf', file: 'mcp.json', dir: '.windsurf' },
  { name: 'Amp', file: 'mcp.json', dir: '.amp' },
];

const EXAMPLE_RE = /\b(example|placeholder|demo|sample|template|your_?key|xxx|changeme|replace_?me)\b/i;

function matchesSecretPattern(value) {
  if (typeof value !== 'string') return false;
  // 1Password CLI references (op://vault/item/field) and shell template
  // placeholders (${VAR}) are secure — the real secret is resolved at runtime.
  // Exclude here in credential-storage only; KEY_PATTERNS (shared) continues to
  // match these for other checks (e.g., env-exposure) where the reference
  // itself may still be mildly leaky in public config.
  if (value.startsWith('op://')) return false;
  if (/^\$\{[^}]+\}$/.test(value)) return false;
  for (const pattern of KEY_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

export default {
  id: 'credential-storage',
  name: 'Credential storage hygiene',
  category: 'secrets',

  async run(context) {
    const { homedir } = context;
    const findings = [];
    let filesScanned = 0;
    let secretsFound = 0;

    for (const client of CLIENT_CONFIGS) {
      const configPath = path.join(homedir, client.dir, client.file);
      const config = await readJsonSafe(configPath);
      if (!config) continue;
      filesScanned++;

      const servers = config.mcpServers || {};
      for (const [serverName, server] of Object.entries(servers)) {
        const env = server?.env || {};
        for (const [key, value] of Object.entries(env)) {
          if (matchesSecretPattern(value)) {
            secretsFound++;
            const isExample = EXAMPLE_RE.test(value);
            findings.push({
              severity: isExample ? 'info' : 'critical',
              title: isExample
                ? `Example credential in ${client.name} config (${serverName})`
                : `Plaintext credential in ${client.name} config (${serverName})`,
              detail: isExample
                ? `env.${key} contains an example/placeholder secret pattern.`
                : `env.${key} contains a plaintext secret. Credentials in config files are stored world-readable.`,
              remediation: isExample
                ? 'Replace example credentials before use.'
                : 'Use environment variables or OS keychain instead of plaintext config values.',
            });
          }
        }
      }
    }

    if (filesScanned === 0) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{ severity: 'info', title: 'No AI client config files found' }],
        data: { filesScanned: 0, secretsFound: 0 },
      };
    }

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'No plaintext credentials in AI client configs' });
    }

    return { score: calculateCheckScore(findings), findings, data: { filesScanned, secretsFound } };
  },
};
