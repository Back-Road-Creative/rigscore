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
  'mcp-config': 18,
  'coherence': 18,
  'skill-files': 12,
  'claude-md': 12,
  'deep-secrets': 10,
  'env-exposure': 10,
  'docker-security': 8,
  'git-hooks': 6,
  'permissions-hygiene': 6,
  'windows-security': 0,
  'network-exposure': 0,
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

// All known AI client governance/instruction files
export const GOVERNANCE_FILES = [
  'CLAUDE.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.continuerules',
  'copilot-instructions.md',
  '.github/copilot-instructions.md',
  'AGENTS.md',
  '.aider.conf.yml',
];

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
  [18789, 'OpenClaw Gateway'],
  [4000, 'LiteLLM'],
  [5001, 'LocalAI'],
  [9090, 'vLLM'],
  [8000, 'FastChat'],
]);

// Heuristic port range for MCP SSE servers
export const MCP_SSE_PORT_RANGE = [3000, 3999];

// Common secret key patterns
export const KEY_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]{10,}/,         // Anthropic
  /AKIA[0-9A-Z]{16}/,                   // AWS access key
  /ghp_[a-zA-Z0-9]{36}/,               // GitHub PAT
  /gho_[a-zA-Z0-9]{36}/,               // GitHub OAuth
  /xoxb-[a-zA-Z0-9-]+/,               // Slack bot token
  /xoxp-[a-zA-Z0-9-]+/,               // Slack user token
  /sk-(?:proj|svcacct)-[a-zA-Z0-9_-]{20,}/, // OpenAI (current format)
  /glpat-[a-zA-Z0-9_-]{20,}/,          // GitLab PAT
  /sk_live_[a-zA-Z0-9]{24,}/,          // Stripe secret key
  /sk_test_[a-zA-Z0-9]{24,}/,          // Stripe test secret key
  /rk_live_[a-zA-Z0-9]{24,}/,          // Stripe restricted key
  /pk_live_[a-zA-Z0-9]{24,}/,          // Stripe publishable key
  /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{22,}/, // SendGrid
  /SK[0-9a-f]{32}/,                     // Twilio
  /AIzaSy[a-zA-Z0-9_-]{33}/,           // Firebase/Google
  /dop_v1_[a-f0-9]{64}/,               // DigitalOcean
  /key-[a-f0-9]{32}/,                   // Mailgun
  /npm_[a-zA-Z0-9]{36}/,                // npm access token
  /pypi-[a-zA-Z0-9_-]{16,}/,            // PyPI API token
  /hf_[a-zA-Z0-9]{34}/,                 // Hugging Face token
  /mongodb\+srv:\/\/[^\s"']+/,          // MongoDB connection string
  /vercel_[a-zA-Z0-9_-]{24,}/,          // Vercel token
  /sbp_[a-f0-9]{40}/,                    // Supabase service role key
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[a-zA-Z0-9_-]{50,}/, // Supabase JWT (anon/service)
  /cf_[a-zA-Z0-9_-]{37,}/,              // Cloudflare API token
  /railway_[a-zA-Z0-9_-]{24,}/,         // Railway token
  /pscale_tkn_[a-zA-Z0-9_-]{30,}/,      // PlanetScale token
  /neon_[a-zA-Z0-9_-]{30,}/,            // Neon API key
  /lin_api_[a-zA-Z0-9]{40,}/,           // Linear API key
  /r8_[a-zA-Z0-9]{37,}/,               // Replicate API token
  /tvly-[a-zA-Z0-9]{32,}/,             // Tavily API key
  /whsec_[a-zA-Z0-9_-]{24,}/,           // Webhook signing secret (Svix/Clerk)
  /AGE-SECRET-KEY-1[A-Z0-9]{58}/,       // AGE encryption key
  /dd[a-z]*_[a-f0-9]{32,40}/i,          // Datadog API/app key
  /op:\/\/[^\s"']+/,                     // 1Password CLI reference
];
