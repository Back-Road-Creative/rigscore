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

// Weights must sum to 100
export const WEIGHTS = {
  'claude-md': 15,
  'mcp-config': 12,
  'env-exposure': 13,
  'docker-security': 10,
  'git-hooks': 8,
  'skill-files': 8,
  'permissions-hygiene': 7,
  'coherence': 15,
  'deep-secrets': 12,
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
export const COVERAGE_PENALTY_THRESHOLD = 60;

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
];
