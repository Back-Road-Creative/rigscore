import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, KEY_PATTERNS } from '../constants.js';
import { readJsonSafe, readFileSafe } from '../utils.js';
import { credentialClients, mcpServersForConfig, readMcpConfig } from '../clients.js';
import { homeScopeEnabled } from '../lib/home-scope.js';

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
    const { homedir, cwd } = context;
    const findings = [];
    let filesScanned = 0;
    let secretsFound = 0;

    // Every credential surface here is a $HOME config (the operator's, not the
    // project's). Scanning it in a normal project scan would let one operator's
    // stored secrets change another's project score — so it is gated behind
    // --include-home-skills. Without the flag the check is N/A (nothing scanned).
    for (const client of homeScopeEnabled(context) ? credentialClients() : []) {
      const configPath = path.join(homedir, client.dir, client.file);
      // Registry-driven read: the declared format picks the parser, so Goose's YAML and
      // Codex's TOML credential surfaces are scanned rather than skipped as "not JSON".
      const config = await readMcpConfig(configPath, { readJson: readJsonSafe, readText: readFileSafe });
      if (!config) continue;
      filesScanned++;

      // Per-client server key (Zed: `context_servers`, opencode: `mcp`) and env key
      // (opencode: `environment`) come from the registry — never hardcode `mcpServers`/`env`.
      // mcpServersForConfig also resolves `~/.claude.json`'s per-project (local-scope) servers.
      // A `flat` surface (Goose's secrets.yaml) has no server layer at all — the document IS
      // the secret map — so it is scanned as one pseudo-server named after the file.
      const servers = client.flat
        ? { [client.file]: { [client.envKey || 'env']: config } }
        : mcpServersForConfig(configPath, config, cwd);
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
