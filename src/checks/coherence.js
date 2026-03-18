import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';

/**
 * Cross-config coherence check.
 * Examines prior check results for contradictions between governance claims
 * and actual configuration.
 */
export default {
  id: 'coherence',
  name: 'Cross-config coherence',
  category: 'governance',
  weight: 15,

  async run(context) {
    const { priorResults } = context;
    const findings = [];

    if (!priorResults || priorResults.length === 0) {
      return { score: NOT_APPLICABLE_SCORE, findings: [] };
    }

    // Extract data from prior results
    const claudeMdResult = priorResults.find(r => r.id === 'claude-md');
    const mcpResult = priorResults.find(r => r.id === 'mcp-config');
    const dockerResult = priorResults.find(r => r.id === 'docker-security');

    const matchedPatterns = claudeMdResult?.data?.matchedPatterns || [];
    const hasNetworkTransport = mcpResult?.data?.hasNetworkTransport || false;
    const hasBroadFilesystemAccess = mcpResult?.data?.hasBroadFilesystemAccess || false;
    const hasPrivilegedContainer = dockerResult?.data?.hasPrivilegedContainer || false;

    // Check: governance claims "no external network" but MCP uses network transport
    if (matchedPatterns.includes('network restrictions') && hasNetworkTransport) {
      findings.push({
        severity: 'warning',
        title: 'Governance claims network restrictions but MCP uses network transport',
        detail: 'Your governance file restricts external network access, but an MCP server uses SSE/HTTP transport to a non-localhost host.',
        remediation: 'Either update MCP servers to use stdio transport or adjust governance documentation to reflect actual network usage.',
      });
    }

    // Check: governance claims "path restrictions" but MCP has broad filesystem access
    if (matchedPatterns.includes('path restrictions') && hasBroadFilesystemAccess) {
      findings.push({
        severity: 'warning',
        title: 'Governance claims path restrictions but MCP has broad filesystem access',
        detail: 'Your governance file restricts paths, but an MCP server has access to sensitive paths (/, /home, /etc, etc.).',
        remediation: 'Scope MCP server filesystem access to your project directory.',
      });
    }

    // Check: governance claims "forbidden actions" but Docker is privileged
    if (matchedPatterns.includes('forbidden actions') && hasPrivilegedContainer) {
      findings.push({
        severity: 'warning',
        title: 'Governance claims forbidden actions but Docker container is privileged',
        detail: 'Your governance file defines forbidden actions, but a container runs in privileged mode with full host access.',
        remediation: 'Remove privileged: true from container configuration.',
      });
    }

    // Check: governance file in .gitignore (CRITICAL)
    // This is detected by the claude-md check — look for the finding
    if (claudeMdResult) {
      const gitignoreFinding = claudeMdResult.findings?.find(
        f => f.severity === 'critical' && f.title?.includes('.gitignore')
      );
      if (gitignoreFinding) {
        findings.push({
          severity: 'critical',
          title: 'Governance file is gitignored — ephemeral governance',
          detail: 'A governance file listed in .gitignore has no audit trail and can be silently modified or removed.',
          remediation: 'Remove governance files from .gitignore and commit them to version control.',
        });
      }
    }

    // Check: governance file not tracked in git (WARNING)
    if (claudeMdResult) {
      const untrackedFinding = claudeMdResult.findings?.find(
        f => f.severity === 'warning' && f.title?.includes('not tracked in git')
      );
      if (untrackedFinding) {
        findings.push({
          severity: 'warning',
          title: 'Governance file exists but is not version-controlled',
          detail: 'Untracked governance files can be silently modified without an audit trail.',
          remediation: 'Track governance files in git for change history.',
        });
      }
    }

    if (findings.length === 0) {
      // No contradictions found — but only if we had enough data to check
      const hasGovernance = claudeMdResult && claudeMdResult.score !== NOT_APPLICABLE_SCORE;
      const hasConfig = (mcpResult && mcpResult.score !== NOT_APPLICABLE_SCORE) ||
                       (dockerResult && dockerResult.score !== NOT_APPLICABLE_SCORE);

      if (!hasGovernance || !hasConfig) {
        return { score: NOT_APPLICABLE_SCORE, findings: [] };
      }

      findings.push({
        severity: 'pass',
        title: 'Configuration is coherent with governance claims',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
