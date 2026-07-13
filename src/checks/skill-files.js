import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe, statSafe, walkDirSafe } from '../utils.js';

// Skill file paths = governance files minus CLAUDE.md (handled by claude-md check)
const SKILL_FILE_PATHS = GOVERNANCE_FILES.filter((f) => f !== 'CLAUDE.md');

const SKILL_DIRS = [
  '.claude/commands',
  '.claude/skills',
];

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?prior\s+instructions/i,
  /you\s+are\s+now/i,
  /disregard\s+(all\s+)?previous/i,
  /override\s+(all\s+)?instructions/i,
  /forget\s+(all\s+)?(previous|prior)/i,
  /your\s+new\s+system\s+prompt/i,
  /act\s+as\s+if\s+you\s+(?:are|were|have|had|can)/i,
  /pretend\s+you\s+are/i,
  /from\s+now\s+on\s+you/i,
];

const EXFILTRATION_PATTERNS = [
  /\bsend\s+.*\s+to\s+https?/i,
  /\bpost\s+.*\s+to\s+https?/i,
  // Require tight proximity (≤6 words between upload and to) so noun-form
  // mentions like "Drive upload errors, … run again to resume" don't trip.
  /\bupload\s+\S+(?:\s+\S+){0,5}\s+to\b/i,
  /\bcurl\s+.*-d\b/i,
  /\bcurl\s+.*--data\b/i,
  /\bpipe\s+.*\s+to\s+external/i,
  /\bredirect\s+.*output\s+.*to\b/i,
];

/**
 * Escalation patterns paired with the stable id used for the allowlist and the
 * `skill-files/escalation-<id>` finding id. One row = one pattern + its id, so a
 * pattern CANNOT be declared without an id. The previous shape (a bare regex array
 * plus a function that recovered the id by substring-matching the regex's source
 * text, falling back to a generic catch-all id) let a newly-added pattern silently
 * collapse into that catch-all and collide with every other unmapped pattern under
 * one meaningless id. Add a pattern here and it brings its id with it.
 *
 * Every id below is documented as a ruleId in `docs/checks/skill-files.md`, and
 * `EXPANDERS['skill-files']` in `src/lib/verify-docs.js` reads this table to gate
 * that page — keep the rows single-line `{ id: '…', pattern: … }` so it can.
 */
export const ESCALATION_RULES = [
  { id: 'sudo', pattern: /\bsudo\b/ },
  { id: 'run-as-root', pattern: /\brun\s+as\s+root\b/i },
  { id: 'run-as-admin', pattern: /\brun\s+as\s+admin\b/i },
  { id: 'elevated-privilege', pattern: /\belevat(?:e|ed)\s+privileg/i },
  { id: 'chmod-777', pattern: /\bchmod\s+777\b/ },
  { id: 'chmod-plus-x', pattern: /\bchmod\s+\+x\b/ },
  { id: 'chmod-a-plus', pattern: /\bchmod\s+.*a\+/ },
  { id: 'disable-security', pattern: /\bdisable\s+.*security\b/i },
  { id: 'disable-firewall', pattern: /\bturn\s+off\s+.*firewall\b/i },
  { id: 'disable-antivirus', pattern: /\bdisable\s+.*antivirus\b/i },
];

// Derived — never a second hand-maintained list, or a pattern could exist with no id.
const ESCALATION_PATTERNS = ESCALATION_RULES.map((r) => r.pattern);
const ESCALATION_ID_BY_PATTERN = new Map(ESCALATION_RULES.map((r) => [r.pattern, r.id]));

const PERSISTENCE_PATTERNS = [
  /\bcrontab\b/i,
  /\bsystemctl\s+enable\b/i,
  /\bstartup\s+script\b/i,
  /\bboot\s+.*script\b/i,
  /\badd\s+.*to\s+.*PATH\b/i,
  /\bmodify\s+.*bashrc\b/i,
  /\bmodify\s+.*profile\b/i,
  /\bwrite\s+.*to\s+.*rc\b/i,
  /\binstall\s+.*globally\b/i,
  /\bnpm\s+.*-g\b/,
];

const INDIRECT_INJECTION_PATTERNS = [
  /\bread\s+.*from\s+.*url\s+.*and\s+.*execute\b/i,
  /\bfetch\s+.*and\s+.*run\b/i,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bdownload\s+.*and\s+.*run\b/i,
  /\bdownload\s+.*and\s+.*execute\b/i,
];

// CVE-2025-54136: Trust exploitation patterns — instructions that bypass verification
// by telling the agent to implicitly trust tool outputs or approve without checking
const TRUST_EXPLOITATION_PATTERNS = [
  /\btrust\s+(?:the\s+)?(?:output|result|response)s?\s+from\b/i,
  /\balways\s+(?:accept|trust|approve)\s+(?:tool|server|mcp|command)\b/i,
  /\bapprove\s+(?:all\s+)?(?:tool|server)?\s*(?:calls?\s+)?without\s+(?:check|verif|review)/i,
  /\bskip\s+(?:verification|validation|review)\s+(?:for|of|on)\s+(?:tool|server|mcp)\b/i,
  /\bdo\s+not\s+(?:verify|validate|check|review)\s+(?:tool|server|mcp)\b/i,
  /\bauto-?approve\s+(?:all\s+)?(?:tool|server|mcp)\b/i,
];

const SHELL_EXEC_PATTERNS = [
  // Only flag `run \`<cmd>\`` when the backticked command contains dangerous
  // content — pipes/redirects, network fetches, eval, sudo, rm -rf, or
  // world-writable chmod. Benign "Run `git status`" style docs don't trip.
  /\brun\s+`[^`]*(?:\||>|\bcurl\s|\bwget\s|\beval\s|\bsudo\s|\brm\s+-rf|\bchmod\s+[0-9]*[2367])[^`]*`/i,
  /\bexecute\s+(the\s+)?(shell|bash|command)/i,
  /\bcurl\s+http/i,
  /\bwget\s+http/i,
];

const URL_PATTERN = /https?:\/\/[^\s"')\]]+/g;
// Anchored base64 pattern — requires whitespace boundary to reduce false positives
const BASE64_PATTERN = /(?:^|\s)[A-Za-z0-9+/]{50,}={0,2}(?:\s|$)/m;

// Strong defensive phrases — clearly about security, always suppress
const STRONG_DEFENSIVE_RE = /\b(defend against|prevent .{0,30}(attack|injection|escalat|exfiltrat|use of|access)|guard against|block .{0,20}(injection|attack|use of)|reject .{0,20}instruction|refuse .{0,20}(to|attempt|request)|protect against|disallow .{0,20}(sudo|curl|wget|shell)|prohibit .{0,20}(sudo|curl|wget|shell)|never .{0,10}(use|run|allow|execute) .{0,20}(sudo|curl|wget|rm )|no\s+(sudo|curl|wget|shell|root\s+access|force\s+push)|(sudo|curl|wget|shell|force\s+push)\s+is\s+(forbidden|banned|prohibited|disallowed|not\s+allowed)|(do\s+not|don'?t)\s+(use|run|allow|execute|call)\s+(sudo|curl|wget|shell|rm))\b/i;

// Weak single words — only suppress when combined with a strong phrase
// Words like "detect", "flag", "catch", "stop" are too common in non-security contexts
const WEAK_DEFENSIVE_WORDS = /\b(detect|flag|catch|stop|halt|alert|warn|counter|resist)\b/i;

// Combined check: strong phrases always suppress, weak words alone do NOT
function isDefensiveContext(text) {
  return STRONG_DEFENSIVE_RE.test(text);
}

/**
 * Iterate every (pattern, match-line) pair across a content blob.
 * Handles the regex-with-g-flag dance, line extraction around match.index,
 * and the defensive-context skip so callers don't repeat the boilerplate.
 *
 * @param {string} content      The file body to scan.
 * @param {RegExp[]} patterns   Patterns to test (g flag added if missing).
 * @param {(line: string) => boolean} isDefensive  Lines for which this
 *                              returns true are skipped (e.g., a security
 *                              README that names the attack to defend
 *                              against shouldn't itself trip the check).
 * @param {(pattern: RegExp, line: string) => void} onMatch  Called once per
 *                              non-defensive match.
 */
export function forEachPatternMatch(content, patterns, isDefensive, onMatch) {
  for (const pattern of patterns) {
    const globalPattern = pattern.flags.includes('g')
      ? pattern
      : new RegExp(pattern.source, pattern.flags + 'g');
    let match;
    while ((match = globalPattern.exec(content)) !== null) {
      const lineStart = content.lastIndexOf('\n', match.index) + 1;
      const lineEnd = content.indexOf('\n', match.index);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (isDefensive(line)) continue;
      onMatch(pattern, line);
    }
  }
}

/**
 * Convenience wrapper around forEachPatternMatch for the simple aggregation
 * shape: collect a trimmed, capped sample of every non-defensive line, plus
 * the set of distinct pattern sources that triggered. Used by persistence
 * and indirect-injection detection; escalation handling needs the lower-
 * level forEachPatternMatch directly because its accumulator is keyed by
 * patternId rather than pattern.source.
 *
 * @returns {{ lines: string[], patternSources: Set<string> }}
 */
export function accumulatePatternMatches(content, patterns, isDefensive) {
  const lines = [];
  const patternSources = new Set();
  forEachPatternMatch(content, patterns, isDefensive, (pattern, line) => {
    lines.push(line.trim().slice(0, 120));
    patternSources.add(pattern.source);
  });
  return { lines, patternSources };
}

/**
 * Extract the skill directory name from a file path under `.claude/skills/`.
 * Returns e.g. "sops-status" for `.claude/skills/sops-status/SKILL.md` or
 * `~/.claude/skills/sops-status/evals/acceptance.md`. Returns null for files
 * outside a skills directory.
 */
function extractSkillDir(relPath) {
  const m = relPath.match(/\.claude\/skills\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Check whether a finding should be suppressed by the `skillFiles.allowlist`
 * config. Match criteria: (skill directory name === entry.skill) AND
 * (patternId === entry.pattern). Returns the matching entry or null.
 *
 * Allowlist shape (from `.rigscorerc.json`):
 *   skillFiles.allowlist: [
 *     { skill: "sops-status", pattern: "sudo", reason: "operator skill" },
 *     ...
 *   ]
 */
function findAllowlistMatch(allowlist, filePath, patternId) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return null;
  const skill = extractSkillDir(filePath);
  if (!skill) return null;
  for (const entry of allowlist) {
    if (entry && entry.skill === skill && entry.pattern === patternId) {
      return entry;
    }
  }
  return null;
}

// Characters from non-Latin scripts that look like Latin — check AFTER NFKC normalization
// Covers: Greek, Cyrillic, Cyrillic Supplement, Armenian, Georgian, Cherokee
// (Cherokee U+13A0-13FF has letterforms matching Latin A/D/E/G/H/etc.)
const HOMOGLYPH_RE = /[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u0530-\u058F\u10A0-\u10FF\u13A0-\u13FF]/;

// Ranges that NFKC-normalize to ASCII Latin — must be checked BEFORE normalization.
// Mathematical Alphanumeric Symbols (U+1D400-1D7FF) — "𝐀𝐁𝐂" bold/italic/etc. lookalikes
// Fullwidth Latin (U+FF00-FF5E) — "ＡＢＣ" Asian-width Latin
const MATH_ALPHA_RE = /[\u{1D400}-\u{1D7FF}]/u;
const FULLWIDTH_LATIN_RE = /[\uFF00-\uFF5E]/;
const CHEROKEE_RE = /[\u13A0-\u13FF]/;

// Zero-width and invisible characters (used to hide malicious content)
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;

// Bidirectional override characters (can make text render differently than stored)
// LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI
const BIDI_OVERRIDE_RE = /[\u202A-\u202E\u2066-\u2069]/;

function normalizeText(text) {
  return text
    .normalize('NFKC')
    // Strip zero-width characters (for pattern matching — they're detected separately)
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u2060]/g, '')
    // Strip bidi overrides (for pattern matching — detected separately)
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    // Strip markdown formatting chars
    .replace(/[*_`~]/g, '');
}

function hasHomoglyphs(text) {
  return HOMOGLYPH_RE.test(text.normalize('NFKC'));
}

// Detect modern prompt-injection homoglyph ranges that either NFKC-normalize to ASCII
// (Mathematical Alphanumeric Symbols, Fullwidth Latin) or aren't in the classic range
// set (Cherokee). Returns an array of matched range names for diagnostic messages.
function detectModernHomoglyphRanges(text) {
  const ranges = [];
  if (MATH_ALPHA_RE.test(text)) ranges.push('Mathematical Bold/Italic Latin');
  if (FULLWIDTH_LATIN_RE.test(text)) ranges.push('Fullwidth Latin');
  if (CHEROKEE_RE.test(text)) ranges.push('Cherokee');
  return ranges;
}

function hasZeroWidthChars(text) {
  return ZERO_WIDTH_RE.test(text);
}

function hasBidiOverrides(text) {
  return BIDI_OVERRIDE_RE.test(text);
}

export const fixes = [
  {
    id: 'skill-file-world-writable',
    findingIds: ['skill-files/world-writable'],
    match: (f) => f.severity === 'warning' && f.title?.includes('world-writable') && f.title?.includes('Skill file'),
    description: 'chmod 644 on world-writable skill files',
    async apply(cwd) {
      if (process.platform === 'win32') return false;
      const skillDirs = ['.claude/commands', '.claude/skills'];
      let fixed = false;
      for (const dir of skillDirs) {
        const dirPath = path.join(cwd, dir);
        let entries;
        try { entries = await fs.promises.readdir(dirPath); } catch { continue; }
        for (const entry of entries) {
          const filePath = path.join(dirPath, entry);
          try {
            const stat = await fs.promises.stat(filePath);
            if (stat.mode & 0o002) {
              await fs.promises.chmod(filePath, 0o644);
              fixed = true;
            }
          } catch { /* skip */ }
        }
      }
      return fixed;
    },
  },
];

/**
 * Per-pattern-family helpers extracted from run() so the file loop in run()
 * reads as a sequence of "check X, push findings" calls rather than a
 * 300-line straight-line body. Each helper takes the `file` shape used by
 * run() — `{ path, fullPath, content }` — plus any extra dependencies
 * (allowlist) and returns a finding array (possibly empty).
 *
 * The helpers retain their original branching behavior; this is a pure
 * extraction, no semantic change.
 */

/**
 * Injection-pattern detection. Single-line pass first, then a 2-line
 * sliding window (catches templates that split "ignore previous" /
 * "instructions" across two lines). One finding per file.
 */
// Shared finding shape so the single-line + 2-line-window passes don't
// drift apart. Whoever finds the match owns the `evidence` slice; the
// rest is mechanical.
function buildInjectionFinding(file, evidence, isDefensive) {
  return {
    findingId: isDefensive ? 'skill-files/injection-defensive' : 'skill-files/injection',
    severity: isDefensive ? 'info' : 'critical',
    title: isDefensive
      ? `Defensive injection reference in ${file.path}`
      : `Injection pattern found in ${file.path}`,
    detail: isDefensive
      ? 'File references injection patterns in a defensive context.'
      : 'File contains instruction override patterns that could hijack AI agent behavior.',
    evidence: evidence.trim().slice(0, 120),
    remediation: isDefensive
      ? 'No action needed — this appears to be a defensive rule.'
      : 'Remove instruction override patterns. If this is a legitimate rule, rephrase it.',
    context: { file: file.path, patternId: 'injection', skill: extractSkillDir(file.path), defensive: isDefensive },
  };
}

export function checkInjection(file) {
  const findings = [];
  const lines = file.content.split('\n');

  for (const line of lines) {
    const normalized = normalizeText(line);
    const hit = INJECTION_PATTERNS.find((p) => p.test(normalized));
    if (hit) {
      findings.push(buildInjectionFinding(file, line, isDefensiveContext(normalized)));
      return findings;
    }
  }

  // 2-line sliding window catches injection phrases split across a wrap.
  for (let i = 0; i < lines.length - 1; i++) {
    const joined = lines[i] + ' ' + lines[i + 1];
    const normalized = normalizeText(joined);
    const hit = INJECTION_PATTERNS.find((p) => p.test(normalized));
    if (hit) {
      findings.push(buildInjectionFinding(file, joined, isDefensiveContext(normalized)));
      return findings;
    }
  }

  return findings;
}

/**
 * Shell-execution-pattern detection. Aggregated finding (one per file)
 * with a `matches` count and severity escalating to CRITICAL at 3+
 * distinct patterns. Honors the per-file shell-exec allowlist.
 */
export function checkShellExec(file, allowlist) {
  if (findAllowlistMatch(allowlist, file.path, 'shell-exec')) return [];

  const { lines: matchedLines, patternSources: matchedPatternSources } =
    accumulatePatternMatches(file.content, SHELL_EXEC_PATTERNS, isDefensiveContext);

  if (matchedPatternSources.size === 0) return [];

  const matches = matchedLines.length;
  const distinctPatterns = matchedPatternSources.size;
  const severity = distinctPatterns >= 3 ? 'critical' : 'warning';
  return [{
    findingId: 'skill-files/shell-exec',
    severity,
    title: `Shell execution instructions in ${file.path}`,
    detail: `File contains ${matches} shell-execution match(es) across ${distinctPatterns} distinct pattern(s).`,
    evidence: matchedLines[0],
    matches,
    remediation: 'Review shell execution instructions carefully for security.',
    context: { file: file.path, patternId: 'shell-exec', skill: extractSkillDir(file.path), matches, distinctPatterns },
  }];
}

/**
 * Data-exfiltration-pattern detection. First-match-wins (one finding per
 * file). Suppresses defensive references and allowlisted files.
 */
export function checkExfiltration(file, allowlist) {
  for (const pattern of EXFILTRATION_PATTERNS) {
    if (pattern.test(file.content)) {
      const matchLine = file.content.split('\n').find((l) => pattern.test(l)) || '';
      const isDefensive = isDefensiveContext(matchLine);
      const allowed = findAllowlistMatch(allowlist, file.path, 'exfiltration');
      if (!isDefensive && !allowed) {
        return [{
          findingId: 'skill-files/exfiltration',
          severity: 'warning',
          title: `Data exfiltration pattern in ${file.path}`,
          detail: 'File contains instructions that could exfiltrate data to external services.',
          evidence: matchLine.trim().slice(0, 120),
          remediation: 'Remove or restrict data transfer instructions.',
          context: { file: file.path, patternId: 'exfiltration', skill: extractSkillDir(file.path) },
        }];
      }
      return [];
    }
  }
  return [];
}

/**
 * Unicode-steganography detection: bidi overrides (CRITICAL), zero-width
 * characters (WARNING), and homoglyphs from classic non-Latin scripts plus
 * modern prompt-injection ranges that NFKC-normalize to ASCII (WARNING).
 */
export function checkUnicode(file) {
  const findings = [];

  if (hasBidiOverrides(file.content)) {
    findings.push({
      findingId: 'skill-files/bidi-override',
      severity: 'critical',
      title: `Bidirectional override characters in ${file.path}`,
      detail: 'File contains Unicode bidi override characters (U+202A-202E, U+2066-2069) that can make text render differently than stored, hiding malicious instructions.',
      remediation: 'Remove all bidirectional override characters from the file.',
      context: { file: file.path },
    });
  }

  if (hasZeroWidthChars(file.content)) {
    findings.push({
      findingId: 'skill-files/zero-width',
      severity: 'warning',
      title: `Zero-width characters detected in ${file.path}`,
      detail: 'File contains invisible zero-width characters (ZWJ, ZWNJ, ZWS, BOM, ZWNBS) that could hide malicious content between visible text.',
      remediation: 'Remove zero-width characters. Run: cat -v <file> to reveal hidden characters.',
      context: { file: file.path },
    });
  }

  if (hasHomoglyphs(file.content)) {
    const modernRanges = detectModernHomoglyphRanges(file.content);
    const classicDetail = 'File contains characters from non-Latin scripts (Greek, Cyrillic, Armenian, Georgian, Cherokee) that visually resemble Latin letters. This could be used to disguise malicious instructions.';
    const detail = modernRanges.length
      ? `${classicDetail} Detected ranges: ${modernRanges.join(', ')}.`
      : classicDetail;
    findings.push({
      findingId: 'skill-files/homoglyph',
      severity: 'warning',
      title: `Homoglyph characters detected in ${file.path}`,
      detail,
      remediation: 'Replace homoglyph characters with their ASCII equivalents.',
      context: { file: file.path, modernRanges },
    });
  } else {
    // Modern prompt-injection ranges that NFKC-normalize to ASCII — must be detected
    // on raw text. Skill/governance files are dev-control surfaces where Mathematical
    // Bold or Fullwidth text is extremely unlikely to be legitimate.
    const modernRanges = detectModernHomoglyphRanges(file.content);
    if (modernRanges.length > 0) {
      findings.push({
        findingId: 'skill-files/homoglyph',
        severity: 'warning',
        title: `Homoglyph characters detected in ${file.path}`,
        detail: `File contains Unicode characters from ranges used in prompt-injection attacks: ${modernRanges.join(', ')}. These visually resemble Latin letters and can disguise malicious instructions.`,
        remediation: 'Replace homoglyph characters with their ASCII equivalents.',
        context: { file: file.path, modernRanges },
      });
    }
  }

  return findings;
}

/**
 * Privilege-escalation pattern detection (Wave 8 extraction).
 *
 * Behavior preserved from the inline Wave 12 implementation:
 *  - Accumulate matches per patternId (sudo, chmod-777, disable-firewall …).
 *  - Allowlist entries are checked per patternId (so an operator skill can
 *    permit `sudo` without permitting `chmod 777` in the same skill).
 *  - Severity is WARNING for 1-2 distinct patternIds in the file and
 *    CRITICAL once the file hits ≥3 distinct escalation patterns. One
 *    finding emitted per surviving patternId.
 */
export function checkEscalation(file, allowlist) {
  const findings = [];
  const escalationAcc = new Map(); // patternId → { matches, firstLine }
  forEachPatternMatch(file.content, ESCALATION_PATTERNS, isDefensiveContext, (pattern, line) => {
    const patternId = ESCALATION_ID_BY_PATTERN.get(pattern);
    if (findAllowlistMatch(allowlist, file.path, patternId)) return;
    const existing = escalationAcc.get(patternId);
    if (existing) {
      existing.matches++;
    } else {
      escalationAcc.set(patternId, { matches: 1, firstLine: line.trim().slice(0, 120) });
    }
  });
  const distinctEscalationIds = escalationAcc.size;
  for (const [patternId, entry] of escalationAcc) {
    const severity = distinctEscalationIds >= 3 ? 'critical' : 'warning';
    findings.push({
      findingId: `skill-files/escalation-${patternId}`,
      severity,
      title: `Privilege escalation pattern in ${file.path}`,
      detail: `File contains ${entry.matches} escalation match(es) for pattern "${patternId}". File matches ${distinctEscalationIds} distinct escalation pattern(s) in total.`,
      evidence: entry.firstLine,
      matches: entry.matches,
      remediation: 'Remove privilege escalation instructions from skill files.',
      context: { file: file.path, patternId, skill: extractSkillDir(file.path), matches: entry.matches, distinctPatterns: distinctEscalationIds },
    });
  }
  return findings;
}

/**
 * POSIX file-mode check. Skill files that are world-writable can be
 * tampered with by any local user — emit a WARNING. Linux/macOS only;
 * Windows file permissions are checked separately by windows-security.
 */
export async function checkPosixPermissions(file) {
  if (process.platform === 'win32') return [];
  const fileStat = await statSafe(file.fullPath);
  if (!fileStat) return [];
  const mode = fileStat.mode & 0o777;
  if (!(mode & 0o002)) return [];
  return [{
    findingId: 'skill-files/world-writable',
    severity: 'warning',
    title: `Skill file ${file.path} is world-writable`,
    detail: `${file.path} has mode ${mode.toString(8)}. World-writable skill files can be tampered with.`,
    evidence: `${file.path} mode ${mode.toString(8)}`,
    remediation: `Run: chmod 644 ${file.path}`,
    context: { file: file.path },
  }];
}

export default {
  id: 'skill-files',
  enforcementGrade: 'pattern',
  name: 'Skill file safety',
  category: 'supply-chain',

  async run(context) {
    const { cwd, homedir, config, includeHomeSkills } = context;
    const findings = [];
    const filesToScan = [];

    // Collect individual skill files
    for (const relPath of SKILL_FILE_PATHS) {
      const fullPath = path.join(cwd, relPath);
      const content = await readFileSafe(fullPath);
      if (content) {
        filesToScan.push({ path: relPath, fullPath, content });
      }
    }

    // Add config-specified skill files
    if (config?.paths?.skillFiles) {
      for (const p of config.paths.skillFiles) {
        const content = await readFileSafe(p);
        if (content) {
          filesToScan.push({ path: p, fullPath: p, content });
        }
      }
    }

    // Collect files from skill directories.
    // Default: cwd only (home-level skills belong to the home profile, not the project).
    // --include-home-skills opts in to scanning ~/.claude/** as well.
    const searchRoots = [cwd];
    if (includeHomeSkills && homedir && homedir !== cwd) searchRoots.push(homedir);

    // A4: symlink-loop-safe walk (was readdir({recursive:true}) which follows
    // symlinks and recurses forever on `ln -s . self`).
    const maxDepth = config?.limits?.maxWalkDepth || 50;
    let skillLoopDetected = false;
    for (const root of searchRoots) {
      for (const dir of SKILL_DIRS) {
        const dirPath = path.join(root, dir);
        const exists = await statSafe(dirPath);
        if (!exists || !exists.isDirectory()) continue;
        const { files, loopDetected } = await walkDirSafe(dirPath, {
          maxDepth,
          skipHidden: true,
          shouldInclude: (_full, dirent) => !dirent.name.startsWith('.'),
        });
        if (loopDetected) skillLoopDetected = true;
        for (const fullPath of files) {
          const entryRel = path.relative(dirPath, fullPath);
          const content = await readFileSafe(fullPath);
          if (content) {
            const relLabel = root === cwd
              ? path.join(dir, entryRel)
              : path.join('~', dir, entryRel);
            filesToScan.push({ path: relLabel, fullPath, content });
          }
        }
      }
    }
    if (skillLoopDetected) {
      findings.push({
        findingId: 'skill-files/symlink-loop-skipped',
        severity: 'info',
        title: 'Symlink loop detected in skill directory — safely skipped',
        detail: 'A symlink cycle was encountered during skill-file traversal and skipped.',
      });
    }

    if (filesToScan.length === 0) {
      findings.push({
        findingId: 'skill-files/no-skill-files',
        severity: 'info',
        title: 'No skill files found',
        detail: 'No AI agent instruction files detected.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings, data: { filesScanned: 0, injectionFindings: 0, exfiltrationFindings: 0 } };
    }

    const allowlist = config?.skillFiles?.allowlist || [];

    for (const file of filesToScan) {
      // Per-pattern-family helpers extracted in Wave 12 Phase 2. The per-
      // file body used to be ~300 lines of inline scanning; these calls
      // preserve the exact behavior (same severities, evidence, context).
      findings.push(...checkInjection(file));
      findings.push(...checkShellExec(file, allowlist));
      findings.push(...checkExfiltration(file, allowlist));

      // Privilege escalation patterns — see checkEscalation().
      findings.push(...checkEscalation(file, allowlist));

      // Check persistence patterns — C4 aggregation
      if (!findAllowlistMatch(allowlist, file.path, 'persistence')) {
        const { lines: persistenceLines, patternSources: persistencePatterns } =
          accumulatePatternMatches(file.content, PERSISTENCE_PATTERNS, isDefensiveContext);
        if (persistencePatterns.size > 0) {
          const matches = persistenceLines.length;
          const distinctPatterns = persistencePatterns.size;
          const severity = distinctPatterns >= 3 ? 'critical' : 'warning';
          findings.push({
            findingId: 'skill-files/persistence',
            severity,
            title: `Persistence pattern in ${file.path}`,
            detail: `File contains ${matches} persistence match(es) across ${distinctPatterns} distinct pattern(s).`,
            evidence: persistenceLines[0],
            matches,
            remediation: 'Remove persistence instructions from skill files.',
            context: { file: file.path, patternId: 'persistence', skill: extractSkillDir(file.path), matches, distinctPatterns },
          });
        }
      }

      // Check indirect injection patterns — C4 aggregation (CRITICAL severity
      // at any match; escalate detail when multiple distinct patterns present)
      if (!findAllowlistMatch(allowlist, file.path, 'indirect-injection')) {
        const { lines: indirectLines, patternSources: indirectPatterns } =
          accumulatePatternMatches(file.content, INDIRECT_INJECTION_PATTERNS, isDefensiveContext);
        if (indirectPatterns.size > 0) {
          findings.push({
            findingId: 'skill-files/indirect-injection',
            severity: 'critical',
            title: `Indirect injection pattern in ${file.path}`,
            detail: `File contains ${indirectLines.length} indirect-injection match(es) across ${indirectPatterns.size} distinct pattern(s).`,
            evidence: indirectLines[0],
            matches: indirectLines.length,
            remediation: 'Remove dynamic code execution instructions.',
            context: { file: file.path, patternId: 'indirect-injection', skill: extractSkillDir(file.path), matches: indirectLines.length, distinctPatterns: indirectPatterns.size },
          });
        }
      }

      // CVE-2025-54136: Trust exploitation — instructions to bypass tool output verification
      for (const pattern of TRUST_EXPLOITATION_PATTERNS) {
        if (pattern.test(file.content)) {
          const matchLine = file.content.split('\n').find(l => pattern.test(l)) || '';
          const isDefensive = isDefensiveContext(matchLine);
          const allowed = findAllowlistMatch(allowlist, file.path, 'trust-exploitation');
          if (!isDefensive && !allowed) {
            findings.push({
              findingId: 'skill-files/trust-exploitation',
              severity: 'warning',
              title: `Trust exploitation pattern in ${file.path}`,
              detail: 'File contains instructions to blindly trust tool outputs without verification, which can be exploited via name-based trust attacks (CVE-2025-54136).',
              evidence: matchLine.trim().slice(0, 120),
              remediation: 'Remove instructions to skip verification. Always validate tool outputs before acting on them.',
              learnMore: 'https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/',
              context: { file: file.path, patternId: 'trust-exploitation', skill: extractSkillDir(file.path) },
            });
          }
          break;
        }
      }

      // Unicode steganography (bidi / zero-width / homoglyph) — see checkUnicode().
      findings.push(...checkUnicode(file));

      // Check external URLs — only WARNING for HTTP (non-TLS)
      const urls = file.content.match(URL_PATTERN);
      if (urls && urls.length > 0) {
        const httpUrls = urls.filter((u) => u.startsWith('http://'));
        const httpsUrls = urls.filter((u) => u.startsWith('https://'));
        if (httpUrls.length > 0) {
          findings.push({
            findingId: 'skill-files/non-tls-urls',
            severity: 'warning',
            title: `Non-TLS URLs found in ${file.path}`,
            detail: `${httpUrls.length} HTTP URL(s) found. Non-TLS URLs could be intercepted.`,
            remediation: 'Use HTTPS for all external URLs.',
            context: { file: file.path, count: httpUrls.length },
          });
        }
        if (httpsUrls.length > 0) {
          findings.push({
            findingId: 'skill-files/https-urls',
            severity: 'info',
            title: `HTTPS URLs found in ${file.path}`,
            detail: `${httpsUrls.length} HTTPS URL(s) found.`,
            remediation: 'Verify all URLs are legitimate and necessary.',
            context: { file: file.path, count: httpsUrls.length },
          });
        }
      }

      // Check base64 content
      if (BASE64_PATTERN.test(file.content)) {
        findings.push({
          findingId: 'skill-files/possible-base64',
          severity: 'warning',
          title: `Possible encoded content in ${file.path}`,
          detail: 'File contains what appears to be base64-encoded content.',
          remediation: 'Decode and review the content. Remove if not needed.',
          context: { file: file.path },
        });
      }

      // POSIX world-writable permission check — see checkPosixPermissions().
      findings.push(...(await checkPosixPermissions(file)));
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'All skill files appear clean',
      });
    }

    const injectionFindings = findings.filter(f =>
      f.title?.includes('Injection') || f.title?.includes('injection') || f.title?.includes('Indirect injection'),
    ).length;
    const exfiltrationFindings = findings.filter(f =>
      f.title?.includes('exfiltration') || f.title?.includes('Exfiltration'),
    ).length;
    const shellFindings = findings.filter(f =>
      f.title?.includes('Shell execution'),
    ).length;

    return {
      score: calculateCheckScore(findings),
      findings,
      data: { filesScanned: filesToScan.length, injectionFindings, exfiltrationFindings, shellFindings },
    };
  },
};
