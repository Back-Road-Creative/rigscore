import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';

const BROAD_CAPABILITY_NAMES = ['filesystem', 'browser', 'database', 'shell', 'terminal', 'code', 'exec'];

/**
 * Coerce a user-supplied regex spec (string, RegExp, or {source, flags})
 * into a RegExp. Returns null if the spec is unusable.
 */
function toRegex(spec) {
  if (!spec) return null;
  if (spec instanceof RegExp) return spec;
  if (typeof spec === 'string') {
    try { return new RegExp(spec, 'i'); } catch { return null; }
  }
  if (typeof spec === 'object' && typeof spec.source === 'string') {
    try { return new RegExp(spec.source, spec.flags || 'i'); } catch { return null; }
  }
  return null;
}

/**
 * Reverse coherence: for each MCP server in config, verify governance declares it.
 * Forward coherence checks governance→config; this checks config→governance.
 *
 * @param {string} governanceContent - concatenated text from CLAUDE.md and governance files
 * @param {string[]} serverNames - discovered MCP server names (from mcp-config data)
 * @returns {Array<{severity: string, title: string, detail: string, remediation: string}>}
 */
function checkReverseCoherence(governanceContent, serverNames) {
  const findings = [];

  for (const serverName of serverNames) {
    const mentioned = governanceContent.toLowerCase().includes(serverName.toLowerCase());
    if (!mentioned) {
      findings.push({
        severity: 'warning',
        title: `Undeclared MCP server: ${serverName}`,
        detail: `Server '${serverName}' is configured but not mentioned in any governance document. Undeclared capabilities create hidden exposure that static reviews miss.`,
        remediation: `Add a section to CLAUDE.md declaring '${serverName}' purpose, approved use cases, and scope restrictions.`,
      });
    }
  }

  const hasBroadCapability = serverNames.some(name =>
    BROAD_CAPABILITY_NAMES.some(cap => name.toLowerCase().includes(cap))
  );
  if (hasBroadCapability) {
    const hasApprovedToolsSection = /approved\s+tools|allowed\s+tools|permitted\s+tools/i.test(governanceContent);
    if (!hasApprovedToolsSection) {
      findings.push({
        severity: 'info',
        title: 'No approved-tools declaration for broad-capability MCP server',
        detail: 'One or more MCP servers with filesystem, browser, shell, or code-execution capabilities are configured without an approved-tools governance declaration.',
        remediation: 'Add an "Approved Tools" section to CLAUDE.md listing permitted MCP capabilities and their scope restrictions.',
      });
    }
  }

  return findings;
}

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
    const { priorResults, config } = context;
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
    const settingsCheckResult = priorResults.find(r => r.id === 'claude-settings');

    const matchedPatterns = claudeMdResult?.data?.matchedPatterns || [];
    const governanceText = claudeMdResult?.data?.governanceText || '';
    const hasNetworkTransport = mcpResult?.data?.hasNetworkTransport || false;
    const hasBroadFilesystemAccess = mcpResult?.data?.hasBroadFilesystemAccess || false;
    const hasPrivilegedContainer = dockerResult?.data?.hasPrivilegedContainer || false;
    const driftDetected = mcpResult?.data?.driftDetected || false;
    const mcpClientCount = mcpResult?.data?.clientCount || 0;
    const skillInjectionFindings = skillResult?.data?.injectionFindings || 0;
    const skillExfiltrationFindings = skillResult?.data?.exfiltrationFindings || 0;
    const skillShellFindings = skillResult?.data?.shellFindings || 0;
    const mcpServerNames = mcpResult?.data?.serverNames || [];
    const hasBypassPermissions = settingsCheckResult?.data?.hasBypassPermissions || false;
    const missingLifecycleHooks = settingsCheckResult?.data?.missingLifecycleHooks || [];
    const allowListEntries = settingsCheckResult?.data?.allowListEntries || [];

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

    // Reverse coherence: check config→governance direction.
    // Only run when both governance text and server names are available.
    if (governanceText && mcpServerNames.length > 0) {
      const reverseFindings = checkReverseCoherence(governanceText, mcpServerNames);
      findings.push(...reverseFindings);
    }

    // Settings vs. governance coherence checks
    // Only run when settings data is available
    if (settingsCheckResult) {
      // Check: bypassPermissions + approval-gates claim + no PreToolUse hook
      // Governance says "require approval" but settings skip all confirmation without a PreToolUse hook
      if (hasBypassPermissions && matchedPatterns.includes('approval gates') && missingLifecycleHooks.includes('PreToolUse')) {
        findings.push({
          severity: 'warning',
          title: 'Governance claims approval gates but bypassPermissions has no PreToolUse hook',
          detail: 'bypassPermissions mode with no PreToolUse hook means all tool calls execute automatically — governance approval-gate rules have no enforcement mechanism.',
          remediation: 'Add a PreToolUse hook to .claude/settings.json to enforce approval gates, or change defaultMode to "acceptEdits".',
        });
      }

      // Check: allow list contains entries that governance explicitly forbids.
      // Pairings are opt-in via config.coherence.allowGovernanceContradictions.
      // Default: empty array — no author-specific pairings fire by default.
      const configPairings = config?.coherence?.allowGovernanceContradictions || [];

      for (const pairing of configPairings) {
        const allowRe = toRegex(pairing.allowRe);
        const govRe = toRegex(pairing.govRe);
        if (!allowRe || !govRe) continue;
        const inAllowList = allowListEntries.some(e => allowRe.test(e));
        const forbiddenInGovernance = governanceText && govRe.test(governanceText);
        if (inAllowList && forbiddenInGovernance) {
          findings.push({
            severity: 'warning',
            title: pairing.title || 'Allow list entry contradicts governance',
            detail: pairing.detail || 'settings.json allow-list entry is forbidden by governance.',
            remediation: pairing.remediation || 'Remove the offending allow-list entry or update governance.',
          });
        }
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
