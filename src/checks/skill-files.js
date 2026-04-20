import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe, statSafe } from '../utils.js';

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

const ESCALATION_PATTERNS = [
  /\bsudo\b/,
  /\brun\s+as\s+root\b/i,
  /\brun\s+as\s+admin\b/i,
  /\belevat(?:e|ed)\s+privileg/i,
  /\bchmod\s+777\b/,
  /\bchmod\s+\+x\b/,
  /\bchmod\s+.*a\+/,
  /\bdisable\s+.*security\b/i,
  /\bturn\s+off\s+.*firewall\b/i,
  /\bdisable\s+.*antivirus\b/i,
];

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

export default {
  id: 'skill-files',
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

    for (const root of searchRoots) {
      for (const dir of SKILL_DIRS) {
        const dirPath = path.join(root, dir);
        try {
          const entries = await fs.promises.readdir(dirPath, { recursive: true });
          for (const entry of entries) {
            if (entry.startsWith('.')) continue;
            const fullPath = path.join(dirPath, entry);
            const stat = await statSafe(fullPath);
            if (!stat || stat.isDirectory()) continue;
            const content = await readFileSafe(fullPath);
            if (content) {
              const relLabel = root === cwd ? path.join(dir, entry) : path.join('~', dir, entry);
              filesToScan.push({ path: relLabel, fullPath, content });
            }
          }
        } catch {
          // Directory doesn't exist, skip
        }
      }
    }

    if (filesToScan.length === 0) {
      findings.push({
        severity: 'info',
        title: 'No skill files found',
        detail: 'No AI agent instruction files detected.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings, data: { filesScanned: 0, injectionFindings: 0, exfiltrationFindings: 0 } };
    }

    for (const file of filesToScan) {
      const lines = file.content.split('\n');

      // Check injection patterns — line by line with defensive word downgrade
      let injectionFound = false;
      for (const line of lines) {
        const normalizedLine = normalizeText(line);
        for (const pattern of INJECTION_PATTERNS) {
          if (pattern.test(normalizedLine)) {
            const isDefensive = isDefensiveContext(normalizedLine);
            findings.push({
              severity: isDefensive ? 'info' : 'critical',
              title: isDefensive
                ? `Defensive injection reference in ${file.path}`
                : `Injection pattern found in ${file.path}`,
              detail: isDefensive
                ? 'File references injection patterns in a defensive context.'
                : 'File contains instruction override patterns that could hijack AI agent behavior.',
              remediation: isDefensive
                ? 'No action needed — this appears to be a defensive rule.'
                : 'Remove instruction override patterns. If this is a legitimate rule, rephrase it.',
            });
            injectionFound = true;
            break;
          }
        }
        if (injectionFound) break; // one finding per file for injection
      }

      // Multi-line injection detection: 2-line sliding windows
      if (!injectionFound) {
        for (let i = 0; i < lines.length - 1; i++) {
          const twoLines = normalizeText(lines[i] + ' ' + lines[i + 1]);
          for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(twoLines)) {
              const isDefensive = isDefensiveContext(twoLines);
              findings.push({
                severity: isDefensive ? 'info' : 'critical',
                title: isDefensive
                  ? `Defensive injection reference in ${file.path}`
                  : `Injection pattern found in ${file.path}`,
                detail: isDefensive
                  ? 'File references injection patterns in a defensive context.'
                  : 'File contains instruction override patterns that could hijack AI agent behavior.',
                remediation: isDefensive
                  ? 'No action needed — this appears to be a defensive rule.'
                  : 'Remove instruction override patterns. If this is a legitimate rule, rephrase it.',
              });
              injectionFound = true;
              break;
            }
          }
          if (injectionFound) break;
        }
      }

      // Check shell execution patterns
      for (const pattern of SHELL_EXEC_PATTERNS) {
        if (pattern.test(file.content)) {
          findings.push({
            severity: 'warning',
            title: `Shell execution instructions in ${file.path}`,
            detail: 'File contains instructions to execute shell commands.',
            remediation: 'Review shell execution instructions carefully for security.',
          });
          break;
        }
      }

      // Check exfiltration patterns
      for (const pattern of EXFILTRATION_PATTERNS) {
        if (pattern.test(file.content)) {
          const isDefensive = isDefensiveContext(file.content.split('\n').find(l => pattern.test(l)) || '');
          if (!isDefensive) {
            findings.push({
              severity: 'warning',
              title: `Data exfiltration pattern in ${file.path}`,
              detail: 'File contains instructions that could exfiltrate data to external services.',
              remediation: 'Remove or restrict data transfer instructions.',
            });
          }
          break;
        }
      }

      // Check privilege escalation patterns
      for (const pattern of ESCALATION_PATTERNS) {
        if (pattern.test(file.content)) {
          const isDefensive = isDefensiveContext(file.content.split('\n').find(l => pattern.test(l)) || '');
          if (!isDefensive) {
            findings.push({
              severity: 'warning',
              title: `Privilege escalation pattern in ${file.path}`,
              detail: 'File contains instructions that could escalate privileges.',
              remediation: 'Remove privilege escalation instructions from skill files.',
            });
          }
          break;
        }
      }

      // Check persistence patterns
      for (const pattern of PERSISTENCE_PATTERNS) {
        if (pattern.test(file.content)) {
          const isDefensive = isDefensiveContext(file.content.split('\n').find(l => pattern.test(l)) || '');
          if (!isDefensive) {
            findings.push({
              severity: 'warning',
              title: `Persistence pattern in ${file.path}`,
              detail: 'File contains instructions that could establish persistent access.',
              remediation: 'Remove persistence instructions from skill files.',
            });
          }
          break;
        }
      }

      // Check indirect injection patterns (CRITICAL severity)
      for (const pattern of INDIRECT_INJECTION_PATTERNS) {
        if (pattern.test(file.content)) {
          const isDefensive = isDefensiveContext(file.content.split('\n').find(l => pattern.test(l)) || '');
          if (!isDefensive) {
            findings.push({
              severity: 'critical',
              title: `Indirect injection pattern in ${file.path}`,
              detail: 'File contains instructions to fetch and execute remote code.',
              remediation: 'Remove dynamic code execution instructions.',
            });
          }
          break;
        }
      }

      // CVE-2025-54136: Trust exploitation — instructions to bypass tool output verification
      for (const pattern of TRUST_EXPLOITATION_PATTERNS) {
        if (pattern.test(file.content)) {
          const matchLine = file.content.split('\n').find(l => pattern.test(l)) || '';
          const isDefensive = isDefensiveContext(matchLine);
          if (!isDefensive) {
            findings.push({
              severity: 'warning',
              title: `Trust exploitation pattern in ${file.path}`,
              detail: 'File contains instructions to blindly trust tool outputs without verification, which can be exploited via name-based trust attacks (CVE-2025-54136).',
              remediation: 'Remove instructions to skip verification. Always validate tool outputs before acting on them.',
              learnMore: 'https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/',
            });
          }
          break;
        }
      }

      // Bidi override detection — CRITICAL (can make text render differently)
      if (hasBidiOverrides(file.content)) {
        findings.push({
          severity: 'critical',
          title: `Bidirectional override characters in ${file.path}`,
          detail: 'File contains Unicode bidi override characters (U+202A-202E, U+2066-2069) that can make text render differently than stored, hiding malicious instructions.',
          remediation: 'Remove all bidirectional override characters from the file.',
        });
      }

      // Zero-width character detection — WARNING (invisible content)
      if (hasZeroWidthChars(file.content)) {
        findings.push({
          severity: 'warning',
          title: `Zero-width characters detected in ${file.path}`,
          detail: 'File contains invisible zero-width characters (ZWJ, ZWNJ, ZWS, BOM, ZWNBS) that could hide malicious content between visible text.',
          remediation: 'Remove zero-width characters. Run: cat -v <file> to reveal hidden characters.',
        });
      }

      // Homoglyph detection (classic ranges: Greek, Cyrillic, Armenian, Georgian, Cherokee)
      if (hasHomoglyphs(file.content)) {
        const modernRanges = detectModernHomoglyphRanges(file.content);
        const classicDetail = 'File contains characters from non-Latin scripts (Greek, Cyrillic, Armenian, Georgian, Cherokee) that visually resemble Latin letters. This could be used to disguise malicious instructions.';
        const detail = modernRanges.length
          ? `${classicDetail} Detected ranges: ${modernRanges.join(', ')}.`
          : classicDetail;
        findings.push({
          severity: 'warning',
          title: `Homoglyph characters detected in ${file.path}`,
          detail,
          remediation: 'Replace homoglyph characters with their ASCII equivalents.',
        });
      } else {
        // Modern prompt-injection ranges that NFKC-normalize to ASCII — must be detected
        // on raw text. Skill/governance files are dev-control surfaces where Mathematical
        // Bold or Fullwidth text is extremely unlikely to be legitimate.
        const modernRanges = detectModernHomoglyphRanges(file.content);
        if (modernRanges.length > 0) {
          findings.push({
            severity: 'warning',
            title: `Homoglyph characters detected in ${file.path}`,
            detail: `File contains Unicode characters from ranges used in prompt-injection attacks: ${modernRanges.join(', ')}. These visually resemble Latin letters and can disguise malicious instructions.`,
            remediation: 'Replace homoglyph characters with their ASCII equivalents.',
          });
        }
      }

      // Check external URLs — only WARNING for HTTP (non-TLS)
      const urls = file.content.match(URL_PATTERN);
      if (urls && urls.length > 0) {
        const httpUrls = urls.filter((u) => u.startsWith('http://'));
        const httpsUrls = urls.filter((u) => u.startsWith('https://'));
        if (httpUrls.length > 0) {
          findings.push({
            severity: 'warning',
            title: `Non-TLS URLs found in ${file.path}`,
            detail: `${httpUrls.length} HTTP URL(s) found. Non-TLS URLs could be intercepted.`,
            remediation: 'Use HTTPS for all external URLs.',
          });
        }
        if (httpsUrls.length > 0) {
          findings.push({
            severity: 'info',
            title: `HTTPS URLs found in ${file.path}`,
            detail: `${httpsUrls.length} HTTPS URL(s) found.`,
            remediation: 'Verify all URLs are legitimate and necessary.',
          });
        }
      }

      // Check base64 content
      if (BASE64_PATTERN.test(file.content)) {
        findings.push({
          severity: 'warning',
          title: `Possible encoded content in ${file.path}`,
          detail: 'File contains what appears to be base64-encoded content.',
          remediation: 'Decode and review the content. Remove if not needed.',
        });
      }

      // Check file permissions (Linux only)
      if (process.platform !== 'win32') {
        const fileStat = await statSafe(file.fullPath);
        if (fileStat) {
          const mode = fileStat.mode & 0o777;
          // World-writable check: "others" write bit
          if (mode & 0o002) {
            findings.push({
              severity: 'warning',
              title: `Skill file ${file.path} is world-writable`,
              detail: `${file.path} has mode ${mode.toString(8)}. World-writable skill files can be tampered with.`,
              remediation: `Run: chmod 644 ${file.path}`,
            });
          }
        }
      }
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
