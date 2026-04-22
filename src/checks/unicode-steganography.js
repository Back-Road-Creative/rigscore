import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe } from '../utils.js';

// Classic homoglyph ranges (detected AFTER NFKC normalization):
// Greek, Cyrillic, Armenian, Georgian, Cherokee (U+13A0-13FF has Latin A/D/E/G/H lookalikes)
const HOMOGLYPH_RE = /[\u0370-\u03FF\u0400-\u052F\u0530-\u058F\u10A0-\u10FF\u13A0-\u13FF]/;
// Modern prompt-injection ranges that NFKC-normalize to ASCII — detect on raw text.
const MATH_ALPHA_RE = /[\u{1D400}-\u{1D7FF}]/u;
const FULLWIDTH_LATIN_RE = /[\uFF00-\uFF5E]/;
const CHEROKEE_RE = /[\u13A0-\u13FF]/;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/;
const TAG_CHARS_RE = /[\u{E0001}-\u{E007F}]/u;

function detectModernHomoglyphRanges(text) {
  const ranges = [];
  if (MATH_ALPHA_RE.test(text)) ranges.push('Mathematical Bold/Italic Latin');
  if (FULLWIDTH_LATIN_RE.test(text)) ranges.push('Fullwidth Latin');
  if (CHEROKEE_RE.test(text)) ranges.push('Cherokee');
  return ranges;
}

const CONFIG_FILES = [
  '.mcp.json',
  '.vscode/mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
];

export default {
  id: 'unicode-steganography',
  name: 'Unicode steganography detection',
  category: 'governance',

  async run(context) {
    const { cwd } = context;
    const findings = [];
    let filesScanned = 0;
    let filesWithIssues = 0;

    const filePaths = [
      ...GOVERNANCE_FILES.map(f => ({ rel: f, full: path.join(cwd, f) })),
      ...CONFIG_FILES.map(f => ({ rel: f, full: path.join(cwd, f) })),
    ];

    for (const { rel, full } of filePaths) {
      const content = await readFileSafe(full);
      if (!content) continue;
      filesScanned++;

      let hasIssue = false;

      // Bidi overrides — CRITICAL (renders text differently than stored)
      if (BIDI_RE.test(content)) {
        hasIssue = true;
        findings.push({
          findingId: 'unicode-steganography/bidi-override',
          severity: 'critical',
          title: `Bidirectional override characters in ${rel}`,
          detail: 'File contains bidi override characters (U+202A-202E, U+2066-2069) that can make text appear different from what is stored.',
          remediation: 'Remove all bidirectional override characters.',
        });
      }

      // Zero-width characters — WARNING
      if (ZERO_WIDTH_RE.test(content)) {
        hasIssue = true;
        findings.push({
          findingId: 'unicode-steganography/zero-width',
          severity: 'warning',
          title: `Zero-width characters in ${rel}`,
          detail: 'File contains invisible zero-width characters that could hide malicious content.',
          remediation: 'Remove zero-width characters. Run: cat -v <file> to reveal them.',
        });
      }

      // Homoglyphs — WARNING
      // Check classic ranges (post-NFKC) and modern ranges (raw text).
      // Modern ranges like Mathematical Alphanumeric Symbols and Fullwidth Latin
      // NFKC-normalize to ASCII, so they must be detected before normalization.
      const classicMatch = HOMOGLYPH_RE.test(content.normalize('NFKC'));
      const modernRanges = detectModernHomoglyphRanges(content);
      if (classicMatch || modernRanges.length > 0) {
        hasIssue = true;
        const parts = [];
        if (classicMatch) {
          parts.push('non-Latin characters (Greek, Cyrillic, Armenian, Georgian, Cherokee)');
        }
        if (modernRanges.length > 0) {
          parts.push(`characters from ${modernRanges.join(', ')} ranges`);
        }
        findings.push({
          findingId: 'unicode-steganography/homoglyph',
          severity: 'warning',
          title: `Homoglyph characters in ${rel}`,
          detail: `File contains ${parts.join(' and ')} that visually resemble Latin letters.`,
          remediation: 'Replace homoglyph characters with ASCII equivalents.',
        });
      }

      // Tag characters — WARNING (language tag steganography)
      if (TAG_CHARS_RE.test(content)) {
        hasIssue = true;
        findings.push({
          findingId: 'unicode-steganography/tag-chars',
          severity: 'warning',
          title: `Unicode tag characters in ${rel}`,
          detail: 'File contains Unicode tag characters (U+E0001-E007F) used for steganographic encoding.',
          remediation: 'Remove tag characters from the file.',
        });
      }

      if (hasIssue) filesWithIssues++;
    }

    if (filesScanned === 0) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{ severity: 'info', title: 'No governance or config files found' }],
        data: { filesScanned: 0, filesWithIssues: 0 },
      };
    }

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'No hidden Unicode characters detected' });
    }

    return { score: calculateCheckScore(findings), findings, data: { filesScanned, filesWithIssues } };
  },
};
