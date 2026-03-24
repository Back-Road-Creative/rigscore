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

    const skillResult = priorResults.find(r => r.id === 'skill-files');
    const envResult = priorResults.find(r => r.id === 'env-exposure');

    const matchedPatterns = claudeMdResult?.data?.matchedPatterns || [];
    const hasNetworkTransport = mcpResult?.data?.hasNetworkTransport || false;
    const hasBroadFilesystemAccess = mcpResult?.data?.hasBroadFilesystemAccess || false;
    const hasPrivilegedContainer = dockerResult?.data?.hasPrivilegedContainer || false;
    const driftDetected = mcpResult?.data?.driftDetected || false;
    const mcpClientCount = mcpResult?.data?.clientCount || 0;
    const skillInjectionFindings = skillResult?.data?.injectionFindings || 0;
    const skillExfiltrationFindings = skillResult?.data?.exfiltrationFindings || 0;
    const skillShellFindings = skillResult?.data?.shellFindings || 0;

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

    // Check: multi-client MCP drift detected — governance should mention multi-client management
    if (driftDetected && mcpClientCount >= 2) {
      findings.push({
        severity: 'warning',
        title: 'MCP configuration drifts across AI clients without governance guidance',
        detail: `${mcpClientCount} AI clients have divergent MCP configs, but governance does not address multi-client alignment.`,
        remediation: 'Add multi-client MCP management rules to your governance file, or align configurations.',
      });
    }

    // Check: governance claims shell restrictions but skill files have shell execution findings
    if (matchedPatterns.includes('shell restrictions') && skillShellFindings > 0) {
      findings.push({
        severity: 'warning',
        title: 'Governance claims shell restrictions but skill files contain shell execution instructions',
        detail: `Governance file restricts shell/bash usage, but ${skillShellFindings} shell execution pattern(s) were found in skill files.`,
        remediation: 'Remove shell execution instructions from skill files or adjust governance documentation.',
      });
    }

    // Check: governance claims anti-injection but skill files have injection findings
    if (matchedPatterns.includes('anti-injection') && skillInjectionFindings > 0) {
      findings.push({
        severity: 'critical',
        title: 'Governance claims anti-injection rules but skill files contain injection patterns',
        detail: `Governance file includes anti-injection rules, but ${skillInjectionFindings} injection pattern(s) were found in skill files.`,
        remediation: 'Remove injection patterns from skill files or review for false positives.',
      });
    }

    // Check: skill files have exfiltration patterns — escalate if broad filesystem also
    if (skillExfiltrationFindings > 0 && hasBroadFilesystemAccess) {
      findings.push({
        severity: 'critical',
        title: 'Compound risk: data exfiltration patterns + broad filesystem access',
        detail: 'Skill files contain data exfiltration instructions AND MCP servers have broad filesystem access — a high-risk combination.',
        remediation: 'Remove exfiltration patterns from skill files and scope MCP filesystem access.',
      });
    }

    // Check: governance file in .gitignore — already scored by claude-md,
    // so emit as info here to avoid double-counting the deduction.
    if (claudeMdResult) {
      const gitignoreFinding = claudeMdResult.findings?.find(
        f => f.severity === 'critical' && f.title?.includes('.gitignore')
      );
      if (gitignoreFinding) {
        findings.push({
          severity: 'info',
          title: 'Governance file is gitignored — ephemeral governance',
          detail: 'A governance file listed in .gitignore has no audit trail and can be silently modified or removed. (Scored by claude-md check.)',
          remediation: 'Remove governance files from .gitignore and commit them to version control.',
        });
      }
    }

    // Check: governance file not tracked in git — already scored by claude-md
    if (claudeMdResult) {
      const untrackedFinding = claudeMdResult.findings?.find(
        f => f.severity === 'warning' && f.title?.includes('not tracked in git')
      );
      if (untrackedFinding) {
        findings.push({
          severity: 'info',
          title: 'Governance file exists but is not version-controlled',
          detail: 'Untracked governance files can be silently modified without an audit trail. (Scored by claude-md check.)',
          remediation: 'Track governance files in git for change history.',
        });
      }
    }

    if (findings.length === 0) {
      // No contradictions found — but only if we had enough data to check
      const hasGovernance = claudeMdResult && claudeMdResult.score !== NOT_APPLICABLE_SCORE;
      const hasConfig = (mcpResult && mcpResult.score !== NOT_APPLICABLE_SCORE) ||
                       (dockerResult && dockerResult.score !== NOT_APPLICABLE_SCORE) ||
                       (skillResult && skillResult.score !== NOT_APPLICABLE_SCORE);

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
