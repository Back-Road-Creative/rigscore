import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, KEY_PATTERNS } from '../constants.js';
import { readJsonSafe } from '../utils.js';
import { credentialClients, mcpServersIn } from '../clients.js';

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
  enforcementGrade: 'mechanical',
  name: 'Credential storage hygiene',
  category: 'secrets',

  async run(context) {
    const { homedir } = context;
    const findings = [];
    let filesScanned = 0;
    let secretsFound = 0;

    for (const client of credentialClients()) {
      const configPath = path.join(homedir, client.dir, client.file);
      const config = await readJsonSafe(configPath);
      if (!config) continue;
      filesScanned++;

      // Per-client server key (Zed: `context_servers`, opencode: `mcp`) and env key
      // (opencode: `environment`) come from the registry — never hardcode `mcpServers`/`env`.
      const servers = mcpServersIn(configPath, config);
      for (const [serverName, server] of Object.entries(servers)) {
        const env = server?.[client.envKey || 'env'] || {};
        for (const [key, value] of Object.entries(env)) {
          if (matchesSecretPattern(value)) {
            secretsFound++;
            const isExample = EXAMPLE_RE.test(value);
            findings.push({
              findingId: isExample ? 'credential-storage/example-credential-in-client-config' : 'credential-storage/plaintext-credential-in-client-config',
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
        findings: [{
          findingId: 'credential-storage/no-client-configs-found',
          severity: 'info',
          title: 'No AI client config files found',
        }],
        data: { filesScanned: 0, secretsFound: 0 },
      };
    }

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'No plaintext credentials in AI client configs' });
    }

    return { score: calculateCheckScore(findings), findings, data: { filesScanned, secretsFound } };
  },
};
