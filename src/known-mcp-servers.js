/**
 * Known official MCP server packages.
 * Used for typosquatting detection.
 */
export const KNOWN_MCP_SERVERS = [
  // Official Anthropic
  '@anthropic-ai/mcp-proxy',
  // Official MCP reference servers
  '@modelcontextprotocol/server-memory',
  '@modelcontextprotocol/server-filesystem',
  '@modelcontextprotocol/server-brave-search',
  '@modelcontextprotocol/server-github',
  '@modelcontextprotocol/server-gitlab',
  '@modelcontextprotocol/server-google-maps',
  '@modelcontextprotocol/server-slack',
  '@modelcontextprotocol/server-sqlite',
  '@modelcontextprotocol/server-postgres',
  '@modelcontextprotocol/server-puppeteer',
  '@modelcontextprotocol/server-sequential-thinking',
  '@modelcontextprotocol/server-everything',
  '@modelcontextprotocol/server-fetch',
  '@modelcontextprotocol/server-gdrive',
  '@modelcontextprotocol/server-sentry',
  '@modelcontextprotocol/server-bluesky',
  '@modelcontextprotocol/server-redis',
  '@modelcontextprotocol/server-raygun',
  '@modelcontextprotocol/server-aws-kb-retrieval',
  '@modelcontextprotocol/server-everart',
  // Major community servers
  '@modelcontextprotocol/server-docker',
  '@modelcontextprotocol/server-kubernetes',
  '@modelcontextprotocol/server-linear',
  '@modelcontextprotocol/server-notion',
  '@modelcontextprotocol/server-playwright',
  '@modelcontextprotocol/server-vercel',
  '@modelcontextprotocol/server-cloudflare',
  '@modelcontextprotocol/server-supabase',
  '@modelcontextprotocol/server-stripe',
  '@modelcontextprotocol/server-mysql',
  '@modelcontextprotocol/server-mongodb',
  '@modelcontextprotocol/server-elasticsearch',
  '@modelcontextprotocol/server-azure',
  '@modelcontextprotocol/server-gcp',
  '@modelcontextprotocol/server-youtube',
  '@modelcontextprotocol/server-discord',
  '@modelcontextprotocol/server-jira',
  '@modelcontextprotocol/server-confluence',
  '@modelcontextprotocol/server-airtable',
  '@modelcontextprotocol/server-shopify',
  '@modelcontextprotocol/server-twilio',
  '@modelcontextprotocol/server-sendgrid',
  '@modelcontextprotocol/server-figma',
  '@modelcontextprotocol/server-graphql',
  '@modelcontextprotocol/server-openapi',
  '@modelcontextprotocol/server-ssh',
  '@modelcontextprotocol/server-time',
  '@modelcontextprotocol/server-git',
  '@modelcontextprotocol/server-s3',
  '@modelcontextprotocol/server-pinecone',
  '@modelcontextprotocol/server-chromadb',
];

/**
 * Levenshtein distance between two strings.
 */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Extract the package name portion (after the last /) for comparison.
 * '@modelcontextprotocol/server-github' → 'server-github'
 * 'some-package' → 'some-package'
 */
function extractBaseName(pkg) {
  const slashIdx = pkg.lastIndexOf('/');
  return slashIdx >= 0 ? pkg.slice(slashIdx + 1) : pkg;
}

/**
 * Check if a package name is suspiciously close to a known MCP server.
 * Compares only the base name (after last /). Rejects if length
 * difference > 3 chars. Uses distance=1 for short names (≤12 chars),
 * distance≤2 for longer names.
 */
export function findTyposquatMatch(packageName) {
  const inputBase = extractBaseName(packageName);

  for (const known of KNOWN_MCP_SERVERS) {
    const knownBase = extractBaseName(known);

    // Skip if length difference is too large
    if (Math.abs(inputBase.length - knownBase.length) > 3) continue;

    const dist = levenshtein(inputBase, knownBase);
    // Stricter threshold for short names to reduce false positives
    const maxDist = knownBase.length <= 12 ? 1 : 2;

    if (dist >= 1 && dist <= maxDist) {
      return known;
    }
  }
  return null;
}
