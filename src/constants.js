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
  'claude-md': 20,
  'mcp-config': 15,
  'env-exposure': 20,
  'docker-security': 15,
  'git-hooks': 10,
  'skill-files': 10,
  'permissions-hygiene': 10,
};

// Sentinel score for checks that find nothing to scan
export const NOT_APPLICABLE_SCORE = -1;

// Severity multipliers for score calculation
export const SEVERITY_MULTIPLIERS = {
  [SEVERITY.CRITICAL]: 0,
  [SEVERITY.WARNING]: 0.5,
  [SEVERITY.INFO]: 0.95,
  [SEVERITY.SKIPPED]: 1,
  [SEVERITY.PASS]: 1,
};
