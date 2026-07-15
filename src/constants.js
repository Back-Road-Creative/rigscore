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
  // Practice-pillar checks. Reserved at 0 so each lands as an advisory on the
  // Security axis without shifting a single existing score (Security stays
  // frozen at 100). Their real weights live on the separate Practice axis.
  // A row here is not optional: test/scanner.test.js asserts every
  // auto-discovered check has a numeric WEIGHTS entry, so a check with no row
  // fails the suite regardless of what scoring.js would default it to.
  'loop-governance': 0,
  'spec-goals': 0,
  'ci-agent-caps': 0,
  'memory-hygiene': 0,
  'ai-disclosure': 0,
  'sandbox-posture': 0,
  // Opt-in `--semantic` tool-description judge — advisory, never moves the
  // Security score (it only runs when the operator asks for the external call).
  'semantic-tools': 0,
};

// OWASP Top 10 for Agentic Applications 2026 — official IDs are `ASIxx:2026`;
// the bare `ASIxx` stem is stored here. Final release (published 2025-12-09).
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

// Compliance standards mapping (see docs/compliance.md). Every control ID is transcribed
// from that framework's primary source (URL in FRAMEWORKS). A check is listed under a
// control ONLY where it genuinely evidences it: an honest sparse table beats a complete
// fictional one, because a wrong citation is what a customer forwards to their auditor.
const byControl = (control, ids) => Object.fromEntries(ids.map((id) => [id, control]));

// OWASP MCP Top 10 — official IDs are `MCPxx:2025`; the bare `MCPxx` stem is stored here.
// Upstream is BETA (Phase 3, "Beta Release and Pilot Testing"): IDs and rankings may still
// move, which is why the framework's `status` says so and the report prints it.
// Deliberately sparse: this list is scoped to MCP servers and the protocol, so a rigscore
// check earns a row here only when it inspects an MCP surface. Checks that scan agent prose
// with no MCP nexus — `claude-md`, `skill-files`, `git-hooks` — are left UNMAPPED rather than
// padded in, as are the containment checks (`docker-security`, `infrastructure-security`):
// see MCP05 below.
export const OWASP_MCP_MAP = {
  // Secret exposure: plaintext creds in MCP `env` maps, `.mcp.json`, source, or on disk.
  ...byControl('MCP01', ['credential-storage', 'env-exposure', 'deep-secrets',
    'permissions-hygiene']),
  'claude-settings': 'MCP02',        // auto-approve/bypass hands every server full scope
  'unicode-steganography': 'MCP03',  // hidden instruction chars in .mcp.json = the poisoning primitive
  'mcp-config': 'MCP04',             // unpinned npx, typosquats, rug-pull hash drift
  // MCP05 is intentionally absent (renders NOT EVIDENCED). Sandbox/container posture bounds
  // the blast radius of an injected command but never shows a tool sanitizes its input, and
  // rigscore cannot introspect a running server's tool implementations. Citing the containment
  // checks here would sell containment to an auditor as injection evidence. See `note`.
  'coherence': 'MCP09',              // a configured server undeclared in governance IS a shadow server
};

// NIST AI RMF 1.0 (NIST AI 100-1, Jan 2023). Subcategory IDs are space-separated.
export const NIST_AI_RMF_MAP = {
  'mcp-config': 'MANAGE 3.1',   // third-party resources monitored, controls applied
  ...byControl('GOVERN 1.2', ['coherence', 'skill-files', 'claude-md',
    'instruction-effectiveness', 'skill-coherence', 'workflow-maturity']),
  ...byControl('MAP 4.2', ['documentation', 'agent-output-schemas']),
  ...byControl('MEASURE 2.7', ['claude-settings', 'deep-secrets', 'env-exposure',
    'credential-storage', 'docker-security', 'infrastructure-security',
    'unicode-steganography', 'git-hooks', 'permissions-hygiene', 'network-exposure']),
};

// EU AI Act — Regulation (EU) 2024/1689. Value = the Article the check evidences.
export const EU_AI_ACT_MAP = {
  'claude-settings': 'Article 14', // auto-approve/bypass removes the human from the loop
  'documentation': 'Article 11',   // technical documentation (Annex IV)
  ...byControl('Article 15', ['mcp-config', 'coherence', 'skill-files', 'claude-md',
    'deep-secrets', 'env-exposure', 'credential-storage', 'docker-security',
    'infrastructure-security', 'unicode-steganography', 'git-hooks',
    'permissions-hygiene', 'network-exposure', 'instruction-effectiveness',
    'skill-coherence', 'workflow-maturity', 'agent-output-schemas']),
};

// `status` is the UPSTREAM publication state — a beta list must never render to
// an auditor as settled. `coverage: full` = every scored check is mapped.
export const FRAMEWORKS = {
  'owasp-agentic': {
    name: 'OWASP Top 10 for Agentic Applications 2026',
    status: 'final (published 2025-12-09)',
    url: 'https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/',
    coverage: 'full',
    map: OWASP_AGENTIC_MAP,
    controls: {
      ASI01: 'Agent Goal Hijack',
      ASI02: 'Tool Misuse',
      ASI03: 'Identity & Privilege Abuse',
      ASI04: 'Agentic Supply Chain Vulnerabilities',
      ASI05: 'Unexpected Code Execution',
      ASI07: 'Insecure Inter-Agent Communication',
    },
  },
  'owasp-mcp': {
    name: 'OWASP MCP Top 10',
    status: 'BETA — upstream Phase 3 (Beta Release and Pilot Testing); IDs and rankings may still change. Do not cite as settled.',
    url: 'https://owasp.org/www-project-mcp-top-10/',
    coverage: 'partial',
    map: OWASP_MCP_MAP,
    note: 'rigscore inspects MCP configuration at rest; it never executes or introspects a running MCP server. So MCP05, MCP06, MCP07, MCP08 and MCP10 are NOT EVIDENCED by design — input sanitization, runtime intent, auth flows, audit telemetry and live context are all properties of a server in execution. Sandbox/container posture (docker-security, infrastructure-security) bounds the blast radius of an injected command but is never proof a tool sanitizes its input, so it is not cited as MCP05 evidence; it is scored on its own axes instead.',
    controls: {
      MCP01: 'Token Mismanagement & Secret Exposure',
      MCP02: 'Privilege Escalation via Scope Creep',
      MCP03: 'Tool Poisoning',
      MCP04: 'Software Supply Chain Attacks & Dependency Tampering',
      MCP05: 'Command Injection & Execution',
      MCP06: 'Intent Flow Subversion',
      MCP07: 'Insufficient Authentication & Authorization',
      MCP08: 'Lack of Audit and Telemetry',
      MCP09: 'Shadow MCP Servers',
      MCP10: 'Context Injection & Over-Sharing',
    },
  },
  'nist-ai-rmf': {
    name: 'NIST AI RMF 1.0 (NIST AI 100-1)',
    status: 'final (January 2023)',
    url: 'https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf',
    coverage: 'full',
    map: NIST_AI_RMF_MAP,
    controls: {
      'GOVERN 1.2': 'Trustworthy-AI characteristics are integrated into organizational policies, processes, procedures, and practices',
      'MAP 4.2': 'Internal risk controls for AI system components, including third-party technologies, are identified and documented',
      'MEASURE 2.7': 'AI system security and resilience are evaluated and documented',
      'MANAGE 3.1': 'AI risks and benefits from third-party resources are regularly monitored, and risk controls are applied and documented',
    },
  },
  'eu-ai-act': {
    name: 'EU AI Act — Regulation (EU) 2024/1689',
    status: 'in force, phased application',
    url: 'https://ai-act-service-desk.ec.europa.eu/en/ai-act/timeline/timeline-implementation-eu-ai-act',
    coverage: 'full',
    map: EU_AI_ACT_MAP,
    note: 'Dates are the in-force schedule. The proposed "Digital Omnibus" delay to the high-risk dates (Annex III -> 2027-12-02, Annex I -> 2028-08-02) is NOT in force: EP plenary approved it 2026-06-16, Council adoption + OJ publication still pending. Do not plan against the delay.',
    controls: {
      'Article 11': 'Technical documentation (Annex IV) — applies 2026-08-02 (Annex III high-risk), 2027-08-02 (Art. 6(1)/Annex I)',
      'Article 14': 'Human oversight — applies 2026-08-02 (Annex III high-risk), 2027-08-02 (Art. 6(1)/Annex I)',
      'Article 15': 'Accuracy, robustness and cybersecurity — applies 2026-08-02 (Annex III high-risk), 2027-08-02 (Art. 6(1)/Annex I)',
      'Article 50': 'Transparency for certain AI systems — applies 2026-08-02. NOT EVIDENCED: rigscore does not inspect end-user AI disclosure or synthetic-content marking.',
    },
  },
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

// Legacy coverage-penalty threshold. Coverage scaling is now continuous
// (scale = min(1, totalApplicableWeight / 100), applied unconditionally in
// src/scoring.js) — there is no threshold and no visible step. Retained as
// an export for backwards compatibility only; nothing in src/ reads it.
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
  /\bgh[usr]_[a-zA-Z0-9]{36}\b/,                      // GitHub user/server/refresh tokens (ghu_/ghs_/ghr_)
  /\bgithub_pat_[0-9a-zA-Z_]{82}\b/,                  // GitHub fine-grained PAT (11-char prefix + 82-char body)
  /\bxoxb-[a-zA-Z0-9-]{30,}\b/,                       // Slack bot token (real tokens are 50+ chars)
  /\bxoxp-[a-zA-Z0-9-]{30,}\b/,                       // Slack user token (real tokens are 50+ chars)
  /\bxox[aers]-[a-zA-Z0-9-]{30,}\b/,                  // Slack other tokens (app/refresh/etc.)
  /\bsk-(?:proj|svcacct)-[a-zA-Z0-9_-]{20,}\b/,       // OpenAI (current format)
  /\bsk-[a-zA-Z0-9]{48}\b/,                            // OpenAI API key (legacy 48-char body)
  /\bGOCSPX-[a-zA-Z0-9_-]{20,}\b/,                     // Google OAuth client secret
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
  /\bshp(?:at|ss|pa|ca)_[a-fA-F0-9]{32}\b/,          // Shopify admin/shared/private/custom app token
  /\bdapi[0-9a-f]{32}\b/,                             // Databricks personal access token
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

/**
 * PRACTICE_WEIGHTS — the second scoring axis.
 *
 * `WEIGHTS` above answers "is this rig safe?". This map answers a different
 * question: "does this team actually *drive* its agents well?" — bounded
 * loops, written goals, graduated workflows, sandboxed execution, capped CI
 * agents, tidy memory, honest disclosure.
 *
 * INVARIANTS
 *  - Must sum to exactly 100 (pinned by test/constants.test.js).
 *  - Every id here MUST stay weight-0 in `WEIGHTS`. The Security axis is
 *    frozen: no practice check may move an existing badge by a single point.
 *    The two maps are scored independently by the same scorer.
 */
export const PRACTICE_WEIGHTS = {
  'loop-governance': 25,     // unbounded agent loops = the top blast-radius + cost risk
  'spec-goals': 20,          // goal/spec-driven work is the strongest quality predictor
  'workflow-maturity': 20,   // the graduation ladder: ad-hoc prompt → skill → deterministic code
  'sandbox-posture': 15,     // cross-vendor posture normaliser — the loudest differentiator
  'ci-agent-caps': 10,       // agent jobs in CI need token/time caps (N/A when CI runs no agents)
  'memory-hygiene': 5,       // real, but slow-burn: stale memory degrades quality gradually
  'ai-disclosure': 5,        // trust/compliance hygiene — cheap, binary, increasingly required
};
