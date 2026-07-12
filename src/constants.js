import { governanceFiles } from './clients.js';

export const SEVERITY = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
  SKIPPED: 'skipped',
  PASS: 'pass',
};

export const CATEGORY = {
  GOVERNANCE: 'governance',
  SUPPLY_CHAIN: 'supply-chain',
  SECRETS: 'secrets',
  ISOLATION: 'isolation',
  PROCESS: 'process',
};

// Weights must sum to 100 — moat-heavy: AI-specific checks get ~63%
export const WEIGHTS = {
  'mcp-config': 14,
  'coherence': 14,
  'skill-files': 10,
  'claude-md': 10,
  'claude-settings': 8,
  'deep-secrets': 8,
  'env-exposure': 8,
  'credential-storage': 6,
  'docker-security': 6,
  'infrastructure-security': 6,
  'unicode-steganography': 4,
  'git-hooks': 2,
  'permissions-hygiene': 4,
  'windows-security': 0,
  'network-exposure': 0,
  'site-security': 0,
  'instruction-effectiveness': 0,
  'skill-coherence': 0,
  'workflow-maturity': 0,
  'documentation': 0,
  'agent-output-schemas': 0,
};

// OWASP Agentic Top 10 (2026) mapping for findings
export const OWASP_AGENTIC_MAP = {
  'mcp-config': 'ASI04',       // Agentic Supply Chain
  'coherence': 'ASI01',        // Agent Goal Hijack
  'skill-files': 'ASI01',      // Agent Goal Hijack
  'claude-md': 'ASI01',        // Agent Goal Hijack
  'claude-settings': 'ASI02',  // Tool Misuse & Exploitation
  'deep-secrets': 'ASI03',     // Identity & Privilege Abuse
  'env-exposure': 'ASI03',     // Identity & Privilege Abuse
  'credential-storage': 'ASI03', // Identity & Privilege Abuse
  'docker-security': 'ASI05',  // Unexpected Code Execution
  'unicode-steganography': 'ASI01', // Agent Goal Hijack
  'git-hooks': 'ASI02',        // Tool Misuse & Exploitation
  'permissions-hygiene': 'ASI03', // Identity & Privilege Abuse
  'network-exposure': 'ASI07', // Insecure Inter-Agent Communication
  'infrastructure-security': 'ASI02', // Tool Misuse & Exploitation
  'instruction-effectiveness': 'ASI01', // Agent Goal Hijack
  'skill-coherence': 'ASI01',          // Agent Goal Hijack
  'workflow-maturity': 'ASI01',        // Agent Goal Hijack — taxonomy misclassification causes goal drift
  'documentation': 'ASI02',            // Tool Misuse & Exploitation — undocumented check behavior
  'agent-output-schemas': 'ASI01',     // Agent Goal Hijack — undeclared JSON contract lets orchestrator-aggregated output drift silently
};

// Sentinel score for checks that find nothing to scan
export const NOT_APPLICABLE_SCORE = -1;

// Severity deductions for additive score calculation
// CRITICAL = null means zero the entire check score
export const SEVERITY_DEDUCTIONS = {
  [SEVERITY.CRITICAL]: null,
  [SEVERITY.WARNING]: -15,
  [SEVERITY.INFO]: -2,
  [SEVERITY.SKIPPED]: 0,
  [SEVERITY.PASS]: 0,
};

// INFO-only findings cannot push a check below this floor
export const INFO_ONLY_FLOOR = 50;

// Coverage penalty threshold — if total applicable weight is below this,
// the overall score is scaled down proportionally
export const COVERAGE_PENALTY_THRESHOLD = 50;

// All known AI client governance/instruction files — derived from the client
// registry (src/clients.js), the single source of truth for supported clients.
export const GOVERNANCE_FILES = governanceFiles();

// Superset of config files scanned for secrets and ownership
export const AI_CONFIG_FILES = [
  ...GOVERNANCE_FILES,
  '.claude/settings.json',
  '.mcp.json',
  'config.js',
  'config.ts',
  'config.json',
  'secrets.yaml',
  'secrets.json',
  'credentials.json',
  'application.yml',
  'settings.py',
  'settings.js',
];

// AI service ports — known defaults for local AI tools
export const AI_SERVICE_PORTS = new Map([
  [11434, 'Ollama'],
  [1234, 'LM Studio'],
  [1235, 'LM Studio (alt)'],
  [8080, 'Open WebUI'],
  [3001, 'MCP SSE (common)'],
  [4000, 'LiteLLM'],
  [5001, 'LocalAI'],
  [9090, 'vLLM'],
  [8000, 'FastChat'],
]);

// Heuristic port range for MCP SSE servers
export const MCP_SSE_PORT_RANGE = [3000, 3999];

/**
 * Common secret key patterns.
 * INVARIANT: No pattern may use the /g flag — scanLineForSecrets calls
 * pattern.test() which advances lastIndex on global regexes, causing
 * intermittent false negatives on subsequent calls.
 *
 * ANCHORING POLICY: Every pattern is anchored with `\b` (or an equivalent
 * non-word lookaround) on at least the side that begins/ends in word
 * characters. This prevents substring matches inside JWTs, base64 blobs, and
 * identifiers — e.g. an `AKIA...` substring buried in a JWT payload must not
 * trip the AWS access-key signature. Minimum-length quantifiers are taken
 * from vendor docs or canonical specimens; when in doubt the length is left
 * generous to avoid false negatives on real credentials.
 * @type {RegExp[]}
 */
export const KEY_PATTERNS = [
  /\bsk-ant-[a-zA-Z0-9_-]{10,}\b/,                    // Anthropic
  /\bAKIA[0-9A-Z]{16}\b/,                             // AWS access key
  /\bghp_[a-zA-Z0-9]{36}\b/,                          // GitHub PAT
  /\bgho_[a-zA-Z0-9]{36}\b/,                          // GitHub OAuth
  /\bxoxb-[a-zA-Z0-9-]{30,}\b/,                       // Slack bot token (real tokens are 50+ chars)
  /\bxoxp-[a-zA-Z0-9-]{30,}\b/,                       // Slack user token (real tokens are 50+ chars)
  /\bxox[aers]-[a-zA-Z0-9-]{30,}\b/,                  // Slack other tokens (app/refresh/etc.)
  /\bsk-(?:proj|svcacct)-[a-zA-Z0-9_-]{20,}\b/,       // OpenAI (current format)
  /\bglpat-[a-zA-Z0-9_-]{20,}\b/,                     // GitLab PAT
  /\bsk_live_[a-zA-Z0-9]{24,}\b/,                     // Stripe secret key
  /\bsk_test_[a-zA-Z0-9]{24,}\b/,                     // Stripe test secret key
  /\brk_live_[a-zA-Z0-9]{24,}\b/,                     // Stripe restricted key
  /\bpk_live_[a-zA-Z0-9]{24,}\b/,                     // Stripe publishable key
  /\bSG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}\b/,   // SendGrid
  /\bSK[0-9a-f]{32}\b/,                               // Twilio
  /\bAIzaSy[a-zA-Z0-9_-]{33}\b/,                      // Firebase/Google
  /\bdop_v1_[a-f0-9]{64}\b/,                          // DigitalOcean
  /\bkey-[a-f0-9]{32}\b/,                             // Mailgun
  /\bnpm_[a-zA-Z0-9]{36}\b/,                          // npm access token
  /\bpypi-[a-zA-Z0-9_-]{16,}\b/,                      // PyPI API token
  /\bhf_[a-zA-Z0-9]{34}\b/,                           // Hugging Face token
  /\bmongodb\+srv:\/\/[^\s"']+/,                      // MongoDB connection string (URL-shaped)
  /\bvercel_[a-zA-Z0-9_-]{24,}\b/,                    // Vercel token
  /\bsbp_[a-f0-9]{40}\b/,                             // Supabase service role key
  /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]{50,}\b/, // Supabase JWT (anon/service)
  /\bcf_[a-zA-Z0-9_-]{37,}\b/,                        // Cloudflare API token
  /\brailway_[a-zA-Z0-9_-]{24,}\b/,                   // Railway token
  /\bpscale_tkn_[a-zA-Z0-9_-]{30,}\b/,                // PlanetScale token
  /\bneon_[a-zA-Z0-9_-]{30,}\b/,                      // Neon API key
  /\blin_api_[a-zA-Z0-9]{40,}\b/,                     // Linear API key
  /\br8_[a-zA-Z0-9]{37,}\b/,                          // Replicate API token
  /\btvly-[a-zA-Z0-9]{32,}\b/,                        // Tavily API key
  /\bwhsec_[a-zA-Z0-9_-]{24,}\b/,                     // Webhook signing secret (Svix/Clerk)
  /\bAGE-SECRET-KEY-1[A-Z0-9]{58}\b/,                 // AGE encryption key
  /\bdd[a-z]*_[a-f0-9]{32,40}\b/i,                    // Datadog API/app key
  /\bop:\/\/[^\s"']+/,                                // 1Password CLI reference (URL-shaped)
  /\bASIA[0-9A-Z]{16}\b/,                             // AWS temporary credentials (STS)
  /\bhvs\.[a-zA-Z0-9_-]{24,}\b/,                      // HashiCorp Vault token
  /\bAKCp[a-zA-Z0-9]{10,}\b/,                         // JFrog Artifactory token
  /"auth"\s*:\s*"[A-Za-z0-9+/=]{20,}"/,               // Docker registry auth token (already anchored by quotes)
];
