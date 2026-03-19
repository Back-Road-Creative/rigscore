/**
 * Known official MCP server packages.
 * Used for typosquatting detection.
 */
export const KNOWN_MCP_SERVERS = [
  '@anthropic-ai/mcp-proxy',
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
 * Check if a package name is suspiciously close to a known MCP server.
 * Returns the known server name if distance is 1-2, else null.
 */
export function findTyposquatMatch(packageName) {
  for (const known of KNOWN_MCP_SERVERS) {
    const dist = levenshtein(packageName, known);
    if (dist >= 1 && dist <= 2) {
      return known;
    }
  }
  return null;
}
