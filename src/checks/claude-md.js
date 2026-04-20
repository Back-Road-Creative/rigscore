import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { GOVERNANCE_FILES, NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, execSafe, hasAnyAITooling } from '../utils.js';

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
    // C2: narrowed from bare `injection` to require security-domain
    // qualifiers. Previously `injection` alone matched "dependency injection"
    // in a DI-framework README, giving it credit for anti-injection
    // governance.
    pattern: /\b(prompt.?injection|instruction.?override|injection.?attack|ignore previous|disregard.?instructions?)\b/i,
    points: 3,
  },
  {
    name: 'shell restrictions',
    pattern: /\b(no.?shell|no.?bash|shell.?restrict|forbid.?shell|forbid.?bash.?command|disable.?shell|reserve.?bash|bash.?restrict)/i,
    points: 2,
  },
  {
    name: 'test-driven development',
    pattern: /\b(tdd|test.before|test.first|failing test|red.green|test.driven|write.*test.*before|pipeline.*lock|write.*fail.*test)\b/i,
    points: 3,
  },
  {
    name: 'definition of done',
    pattern: /\b(definition of done|dod|task is not (done|complete)|not complete until|complete when|done when|must.*pass.*before.*done)\b/i,
    points: 3,
  },
  {
    name: 'git workflow rules',
    pattern: /\b(feature branch|feat\/|branch.*only|never push.*main|never.*push.*master|pr create|gh pr create|push.*origin.*feat)\b/i,
    points: 2,
  },
];

// Injection patterns meaningful in a governance file context.
// Defined locally — do not import from skill-files.js to avoid cross-module coupling.
const CLAUDE_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /override\s+(all\s+)?instructions/i,
  /forget\s+(all\s+)?(previous|prior)/i,
  /you\s+are\s+now/i,
  /your\s+new\s+system\s+prompt/i,
  /from\s+now\s+on\s+you/i,
];

// Strong defensive phrases that indicate the injection reference is about prevention
const INJECTION_DEFENSIVE_RE = /\b(defend against|prevent .{0,30}(attack|injection)|guard against|block .{0,20}injection|reject .{0,20}instruction|refuse .{0,20}(injection|attempts?)|protect against|disallow .{0,20}injection|must be (blocked|rejected|refused|prevented)|overrides? must be|should not be followed)\b/i;

function normalizeForInjection(text) {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u2060]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[*_`~]/g, '');
}

const LENGTH_THRESHOLD = 50;

// C7: anti-patterns that dismantle a nearby governance header.
// Matched against a line within REVERSAL_WINDOW_LINES of a header that
// contains one of the QUALITY_CHECKS keywords.
const REVERSAL_ANTIPATTERN_RE = /\b(all (paths?|actions?|shells?) are (allowed|available|permitted|open|free)|no restrictions|no restriction|all paths are available|everything is (allowed|permitted)|removed (all )?(restrictions?|limits?|gates?)|skip (approval|review|verification|checks?)|bypass (approval|gates?|checks?)|override (default|safety|security)|feel free|go ahead|just ship|no shell commands are restricted|testing is optional|ship fast|trust all|streamlined — just|encouraged for)\b/i;

const REVERSAL_WINDOW_LINES = 5;
const HEADER_LINE_RE = /^#{1,6}\s+\S/;

/**
 * C7: detect governance header-only keyword stuffing. For each header line
 * whose text matches one of the QUALITY_CHECKS patterns (the keyword is
 * "present" under the stuffing bypass), inspect the next 5 lines for
 * anti-patterns that dismantle the claim. Returns an array of findings.
 */
function detectGovernanceReversals(contentLines) {
  const findings = [];
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    if (!HEADER_LINE_RE.test(line)) continue;
    // Does this header mention any quality-check keyword?
    let matchedCategory = null;
    for (const check of QUALITY_CHECKS) {
      if (check.pattern.test(line)) {
        matchedCategory = check.name;
        break;
      }
    }
    if (!matchedCategory) continue;
    // Look ahead up to REVERSAL_WINDOW_LINES for a dismantling statement.
    const windowEnd = Math.min(contentLines.length, i + 1 + REVERSAL_WINDOW_LINES);
    for (let j = i + 1; j < windowEnd; j++) {
      const body = contentLines[j];
      if (HEADER_LINE_RE.test(body)) break; // next header — end this section
      if (REVERSAL_ANTIPATTERN_RE.test(body)) {
        findings.push({
          findingId: 'claude-md/governance-reversal-detected',
          severity: 'warning',
          title: `Governance reversal detected near "${matchedCategory}"`,
          detail: `A "${matchedCategory}" governance header is followed within ${REVERSAL_WINDOW_LINES} lines by a statement that dismantles the protection.`,
          evidence: `${line.trim().slice(0, 60)} → ${body.trim().slice(0, 100)}`,
          remediation: 'Rewrite the section body so it enforces the rule instead of dismantling it, or remove the keyword-stuffed header.',
        });
        break; // one finding per header
      }
    }
  }
  return findings;
}

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
      // C1: if no AI tooling is detected project-wide, this check is
      // NOT_APPLICABLE. Returning CRITICAL here previously dragged vanilla
      // Next.js / FastAPI / Rust repos to Grade F even though they never
      // claimed to be AI-tooled — perfect screenshot fodder for hostile
      // reviewers ("look, rigscore roasts create-react-app").
      if (!(await hasAnyAITooling(cwd))) {
        return {
          score: NOT_APPLICABLE_SCORE,
          findings: [{
            severity: 'info',
            title: 'No AI tooling detected — governance check skipped',
            detail: 'No CLAUDE.md, .cursorrules, .claude/, .cursor/, MCP config, or other AI tooling markers found in cwd. Governance rules are evaluated only when AI tooling is actually in use.',
          }],
        };
      }
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

    // C7: detect header-only keyword stuffing where the body dismantles the
    // protection. Scan each governance content block independently so that
    // a reversal in file A isn't falsely associated with a header in file B.
    for (const content of contents) {
      const reversalFindings = detectGovernanceReversals(content.split('\n'));
      findings.push(...reversalFindings);
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
        // Distinguish: keyword present-but-negated (adversarial) vs. simply absent (incomplete)
        const globalPattern2 = new RegExp(check.pattern.source, check.pattern.flags.replace('g', '') + 'g');
        let hasNegatedMatch = false;
        let match2;
        while ((match2 = globalPattern2.exec(combined)) !== null) {
          if (isNegatedMatch(combined, match2.index)) {
            hasNegatedMatch = true;
            break;
          }
        }

        if (hasNegatedMatch) {
          findings.push({
            severity: 'critical',
            title: `Governance file actively negates: ${check.name}`,
            detail: `Governance contains ${check.name} keywords in a negated context — actively contradicts best practices.`,
            remediation: `Remove negated ${check.name} statements and replace with genuine enforcement rules.`,
            learnMore: 'https://headlessmode.com/tools/rigscore/#claude-md-hardening',
          });
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
    }

    // Scan governance file contents for injection patterns (single-line + 2-line sliding window)
    for (const content of contents) {
      const contentLines = content.split('\n');
      let injectionFound = false;

      // Single-line scan
      for (const line of contentLines) {
        const normalized = normalizeForInjection(line);
        for (const pattern of CLAUDE_INJECTION_PATTERNS) {
          if (pattern.test(normalized) && !INJECTION_DEFENSIVE_RE.test(normalized)) {
            findings.push({
              severity: 'critical',
              title: 'Injection pattern found in governance file',
              detail: 'Governance file contains instruction-override patterns that could hijack AI agent behavior.',
              remediation: 'Remove instruction override patterns from the governance file. If this is a defensive rule, rephrase it to reference injection defense explicitly.',
            });
            injectionFound = true;
            break;
          }
        }
        if (injectionFound) break;
      }

      // 2-line sliding window (catches split patterns)
      if (!injectionFound) {
        for (let i = 0; i < contentLines.length - 1; i++) {
          const twoLines = normalizeForInjection(contentLines[i] + ' ' + contentLines[i + 1]);
          for (const pattern of CLAUDE_INJECTION_PATTERNS) {
            if (pattern.test(twoLines) && !INJECTION_DEFENSIVE_RE.test(twoLines)) {
              findings.push({
                severity: 'critical',
                title: 'Injection pattern found in governance file',
                detail: 'Governance file contains instruction-override patterns split across lines that could hijack AI agent behavior.',
                remediation: 'Remove instruction override patterns from the governance file.',
              });
              injectionFound = true;
              break;
            }
          }
          if (injectionFound) break;
        }
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
      data: { matchedPatterns, governanceText: combined },
    };
  },
};
