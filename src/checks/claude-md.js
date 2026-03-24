import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe, execSafe } from '../utils.js';

const QUALITY_CHECKS = [
  {
    name: 'forbidden actions',
    pattern: /\b(never|forbidden|must not|do not|prohibited)\b/i,
    points: 4,
  },
  {
    name: 'approval gates',
    pattern: /\b(approv(al|e)|human.in.the.loop|confirm|permission)\b/i,
    points: 4,
  },
  {
    name: 'path restrictions',
    pattern: /\b(restrict|allowed?.?(path|dir)|boundar|working.?dir|path.?rule|paths?.must)/i,
    points: 3,
  },
  {
    name: 'network restrictions',
    pattern: /\b(no external|network|api.?access|external.?(call|request|fetch))/i,
    points: 3,
  },
  {
    name: 'anti-injection',
    pattern: /\b(ignore previous|prompt.?injection|instruction.?override|injection)\b/i,
    points: 3,
  },
  {
    name: 'shell restrictions',
    pattern: /\b(no.?shell|no.?bash|shell.?restrict|forbid.?shell|forbid.?bash.?command|disable.?shell|reserve.?bash|bash.?restrict)/i,
    points: 2,
  },
];

const LENGTH_THRESHOLD = 50;

const NEGATION_RE = /\b(never|not|no|don't|doesn't|isn't|without|lack|none|nothing)\b/i;

/**
 * Check whether a regex match at `matchIndex` inside `content` is negated
 * by a preceding negation word within the same sentence, up to 150 chars back.
 */
function isNegatedMatch(content, matchIndex) {
  const start = Math.max(0, matchIndex - 150);
  const region = content.slice(start, matchIndex);
  // Find last sentence boundary to scope negation check to current sentence
  const sentenceBreak = Math.max(
    region.lastIndexOf('.'),
    region.lastIndexOf('!'),
    region.lastIndexOf('?'),
    region.lastIndexOf('\n'),
  );
  const sentence = sentenceBreak >= 0 ? region.slice(sentenceBreak + 1) : region;
  return NEGATION_RE.test(sentence);
}

export default {
  id: 'claude-md',
  name: 'CLAUDE.md governance',
  category: 'governance',

  async run(context) {
    const { cwd, homedir, config } = context;
    const findings = [];

    // Collect all candidate paths — CLAUDE.md + all known AI client governance files
    const candidatePaths = [
      // CLAUDE.md locations (project, homedir .claude, homedir root)
      path.join(cwd, 'CLAUDE.md'),
      path.join(homedir, '.claude', 'CLAUDE.md'),
      path.join(homedir, 'CLAUDE.md'),
      // All other AI client governance files in cwd
      ...GOVERNANCE_FILES.filter((f) => f !== 'CLAUDE.md').map((f) => path.join(cwd, f)),
    ];

    // Add config-specified paths
    if (config?.paths?.claudeMd) {
      for (const p of config.paths.claudeMd) {
        candidatePaths.push(p);
      }
    }

    // Read all files, collect contents
    const contents = [];
    for (const p of candidatePaths) {
      const content = await readFileSafe(p);
      if (content) {
        contents.push(content);
      }
    }

    if (contents.length === 0) {
      findings.push({
        severity: 'critical',
        title: 'No governance file found',
        detail: 'No CLAUDE.md, .cursorrules, .windsurfrules, .continuerules, AGENTS.md, or other AI governance file found. AI agents operate without explicit boundaries.',
        remediation: 'Create a governance file (CLAUDE.md, .cursorrules, etc.) with execution boundaries, forbidden actions, and approval gates.',
        learnMore: 'https://headlessmode.com/tools/rigscore/#why-claude-md-matters',
      });
      return { score: calculateCheckScore(findings), findings };
    }

    // Union content for quality checks
    const combined = contents.join('\n');
    const longestContent = contents.reduce((a, b) => (a.length > b.length ? a : b));
    const lines = longestContent.split('\n');

    if (contents.length > 1) {
      findings.push({
        severity: 'pass',
        title: 'Multiple governance layers detected',
      });
    }

    // Check content length (based on longest file)
    if (lines.length < LENGTH_THRESHOLD) {
      findings.push({
        severity: 'warning',
        title: 'Governance file is short (under 50 lines)',
        detail: 'A short governance file may not provide sufficient boundaries for AI agent behavior.',
        remediation: 'Add forbidden actions, approval gates, path restrictions, and anti-injection rules.',
      });
    }

    // Check quality patterns against combined content (with negation detection)
    const matchedPatterns = [];
    for (const check of QUALITY_CHECKS) {
      // Create a global copy of the pattern so we can iterate all matches
      const globalPattern = new RegExp(check.pattern.source, check.pattern.flags.includes('g') ? check.pattern.flags : check.pattern.flags + 'g');
      let match;
      let hasGenuineMatch = false;

      while ((match = globalPattern.exec(combined)) !== null) {
        if (!isNegatedMatch(combined, match.index)) {
          hasGenuineMatch = true;
          break;
        }
      }

      if (hasGenuineMatch) {
        matchedPatterns.push(check.name);
      } else {
        findings.push({
          severity: 'warning',
          title: `Governance file missing: ${check.name}`,
          detail: `No ${check.name} rules detected in your governance file(s).`,
          remediation: `Add ${check.name} instructions to your governance file.`,
          learnMore: 'https://headlessmode.com/tools/rigscore/#claude-md-hardening',
        });
      }
    }

    // Check governance file git tracking status
    const gitDir = path.join(cwd, '.git');
    const gitignorePath = path.join(cwd, '.gitignore');
    const gitignoreContent = await readFileSafe(gitignorePath);

    // Check if governance file is in .gitignore
    if (gitignoreContent) {
      const gitignoreLines = gitignoreContent.split('\n').map(l => l.trim());
      for (const govFile of GOVERNANCE_FILES) {
        const govPath = path.join(cwd, govFile);
        const govContent = await readFileSafe(govPath);
        if (!govContent) continue;

        if (gitignoreLines.includes(govFile)) {
          findings.push({
            severity: 'critical',
            title: `Governance file ${govFile} is in .gitignore`,
            detail: 'Gitignored governance files are ephemeral — they leave no audit trail and can be silently modified.',
            remediation: `Remove ${govFile} from .gitignore and commit it to version control.`,
          });
        }
      }
    }

    // Check if governance files are tracked by git
    const hasGit = await import('node:fs').then(fs => fs.promises.access(gitDir).then(() => true).catch(() => false));
    if (hasGit) {
      for (const govFile of GOVERNANCE_FILES) {
        const govPath = path.join(cwd, govFile);
        const govContent = await readFileSafe(govPath);
        if (!govContent) continue;

        const tracked = await execSafe('git', ['ls-files', govFile], { cwd });
        if (tracked !== null && tracked.trim() === '') {
          // File exists but is not tracked
          findings.push({
            severity: 'warning',
            title: `Governance file ${govFile} is not tracked in git`,
            detail: 'Untracked governance files can be silently modified without audit trail.',
            remediation: `Run: git add ${govFile}`,
          });
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'Governance file contains comprehensive rules',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: { matchedPatterns },
    };
  },
};
