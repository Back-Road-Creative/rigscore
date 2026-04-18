import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe, statSafe, fileExists } from '../utils.js';

// Context budget thresholds
const REFERENCE_CONTEXT = 200_000;
const BUDGET_INFO_PCT = 0.10;
const BUDGET_WARN_PCT = 0.20;
const SINGLE_FILE_TOKEN_WARN = 5000;

// Bloat thresholds (lines)
const BLOAT_WARN = 500;
const BLOAT_INFO = 300;

// Max file size to read (1MB)
const MAX_FILE_SIZE = 1_048_576;

// Max redundancy findings to report
const MAX_REDUNDANCY_FINDINGS = 10;

// Skill/command directories to scan
const SKILL_DIRS = ['.claude/commands', '.claude/skills'];

// Vague instruction patterns — phrases that delegate decisions without criteria
const VAGUE_PATTERNS = [
  /\buse your (best )?judgm?ent\b/i,
  /\bas (you see fit|appropriate)\b/i,
  /\bfigure (it )?out\b/i,
  /\bbe smart about\b/i,
  /\bwhen it makes sense\b/i,
  /\bwhere applicable\b/i,
  /\bas necessary\b/i,
  /\bdo what(ever)? you think\b/i,
  /\bup to you\b/i,
];

// Contradiction directive patterns
// ALWAYS_RE: match "always" or "must" but NOT "must not" (negative lookahead)
const ALWAYS_RE = /\b(always|must(?!\s+not\b))\s+(.{5,60}?)(?:\.|$)/gim;
const NEVER_RE = /\b(never|must not|do not|don't)\s+(.{5,60}?)(?:\.|$)/gim;

// File reference extraction patterns
const BACKTICK_PATH_RE = /`([^`]{3,120})`/g;
const MARKDOWN_LINK_RE = /\[.*?\]\(([^)]{3,200})\)/g;

// Patterns that indicate a path is not a real file reference
const NOT_A_PATH_RE = /^(http|mailto:|#|<|{|\$\{|__|\*|\.{3}|~\/)/;
const PLACEHOLDER_RE = /\b(example|your|placeholder|foo|bar|baz|path\/to)\b/i;
const GLOB_RE = /[*?{]/;

/**
 * Discover all instruction-bearing files in the project and homedir.
 * Returns array of { relPath, fullPath, content, category }.
 */
async function discoverFiles(cwd, homedir, config) {
  const files = [];
  const seen = new Set();

  async function addFile(fullPath, relPath, category) {
    if (seen.has(fullPath)) return;
    const stat = await statSafe(fullPath);
    if (!stat || stat.isDirectory() || stat.size > MAX_FILE_SIZE || stat.size === 0) return;
    const content = await readFileSafe(fullPath);
    if (!content) return;
    // Skip binary files (null byte in first 1024 chars)
    if (content.slice(0, 1024).includes('\0')) return;
    seen.add(fullPath);
    files.push({ relPath, fullPath, content, category });
  }

  // 1. Governance chain — project-level
  for (const f of GOVERNANCE_FILES) {
    const full = path.join(cwd, f);
    await addFile(full, f, 'governance');
  }

  // Governance chain — homedir
  await addFile(path.join(homedir, '.claude', 'CLAUDE.md'), '~/.claude/CLAUDE.md', 'governance');
  await addFile(path.join(homedir, 'CLAUDE.md'), '~/CLAUDE.md', 'governance');

  // Config-specified governance paths
  if (config?.paths?.claudeMd) {
    for (const p of config.paths.claudeMd) {
      await addFile(p, p, 'governance');
    }
  }

  // 2. Governance subdirectory
  const govSubDir = path.join(cwd, '_governance');
  try {
    const entries = await fs.promises.readdir(govSubDir, { recursive: true });
    for (const entry of entries) {
      if (entry.startsWith('.') || !entry.endsWith('.md')) continue;
      const full = path.join(govSubDir, entry);
      await addFile(full, path.join('_governance', entry), 'governance');
    }
  } catch { /* directory doesn't exist */ }

  // 3. Skill/command directories (project + homedir)
  const searchRoots = [cwd];
  if (homedir && homedir !== cwd) searchRoots.push(homedir);

  for (const root of searchRoots) {
    for (const dir of SKILL_DIRS) {
      const dirPath = path.join(root, dir);
      try {
        const entries = await fs.promises.readdir(dirPath, { recursive: true });
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const full = path.join(dirPath, entry);
          const relLabel = root === cwd ? path.join(dir, entry) : path.join('~', dir, entry);
          await addFile(full, relLabel, 'skill');
        }
      } catch { /* directory doesn't exist */ }
    }
  }

  // 4. Memory files — project-level memory index
  const memoryLocations = [
    path.join(cwd, 'MEMORY.md'),
    path.join(cwd, '.claude', 'MEMORY.md'),
  ];

  // Also check homedir project-specific memory
  if (homedir) {
    const projectSlug = path.basename(cwd);
    const projectMemDir = path.join(homedir, '.claude', 'projects');
    try {
      const projectDirs = await fs.promises.readdir(projectMemDir);
      for (const d of projectDirs) {
        const memPath = path.join(projectMemDir, d, 'memory', 'MEMORY.md');
        memoryLocations.push(memPath);
      }
    } catch { /* no project memory dirs */ }
  }

  for (const memPath of memoryLocations) {
    const content = await readFileSafe(memPath);
    if (!content) continue;
    const rel = memPath.startsWith(cwd)
      ? path.relative(cwd, memPath)
      : memPath.replace(homedir, '~');
    await addFile(memPath, rel, 'memory');

    // Parse MEMORY.md for linked .md files
    const linkRe = /\[.*?\]\(([^)]+\.md)\)/g;
    let match;
    while ((match = linkRe.exec(content)) !== null) {
      const linkedPath = match[1];
      if (linkedPath.startsWith('http')) continue;
      const resolvedPath = path.resolve(path.dirname(memPath), linkedPath);
      const linkedRel = resolvedPath.startsWith(cwd)
        ? path.relative(cwd, resolvedPath)
        : resolvedPath.replace(homedir, '~');
      await addFile(resolvedPath, linkedRel, 'memory');
    }
  }

  return files;
}

/**
 * Estimate token count from character count.
 * Heuristic: ~4 chars per token for English text (conservative for Claude/GPT).
 */
function estimateTokens(charCount) {
  return Math.ceil(charCount / 4);
}

/**
 * Analyze context budget across all instruction files.
 */
function analyzeContextBudget(files) {
  const findings = [];
  const breakdown = [];

  for (const file of files) {
    const lineCount = file.content.split('\n').length;
    const charCount = file.content.length;
    const tokens = estimateTokens(charCount);
    breakdown.push({ relPath: file.relPath, lineCount, charCount, estimatedTokens: tokens });

    if (tokens > SINGLE_FILE_TOKEN_WARN) {
      findings.push({
        severity: 'warning',
        title: `Large instruction file: ${file.relPath}`,
        detail: `${file.relPath} is ~${tokens.toLocaleString()} estimated tokens. Large instruction files consume context budget and may reduce effective working memory.`,
        remediation: `Review ${file.relPath} for sections that can be condensed or moved to on-demand references. Run /instruction-audit for deep analysis.`,
      });
    }
  }

  const totalTokens = breakdown.reduce((sum, b) => sum + b.estimatedTokens, 0);
  const pctOfContext = totalTokens / REFERENCE_CONTEXT;

  if (pctOfContext > BUDGET_WARN_PCT) {
    findings.push({
      severity: 'warning',
      title: `Instruction files consume ${(pctOfContext * 100).toFixed(1)}% of context window`,
      detail: `${files.length} instruction files total ~${totalTokens.toLocaleString()} estimated tokens (${(pctOfContext * 100).toFixed(1)}% of ${(REFERENCE_CONTEXT / 1000)}K reference window). This leaves less room for code, tool output, and conversation.`,
      remediation: 'Consolidate redundant instructions, compress verbose sections, or split rarely-needed instructions into on-demand references.',
    });
  } else if (pctOfContext > BUDGET_INFO_PCT) {
    findings.push({
      severity: 'info',
      title: `Instruction files consume ${(pctOfContext * 100).toFixed(1)}% of context window`,
      detail: `${files.length} instruction files total ~${totalTokens.toLocaleString()} estimated tokens (${(pctOfContext * 100).toFixed(1)}% of ${(REFERENCE_CONTEXT / 1000)}K reference window).`,
      remediation: 'Consider reviewing large instruction files for optimization opportunities.',
    });
  }

  return { findings, totalTokens, pctOfContext, breakdown };
}

/**
 * Check if a line is inside a code block.
 * Tracks triple-backtick fences.
 */
function buildCodeBlockSet(content) {
  const lines = content.split('\n');
  const inCodeBlock = new Set();
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('```')) {
      inside = !inside;
    }
    if (inside) inCodeBlock.add(i);
  }
  return inCodeBlock;
}

/**
 * Detect contradictions within a single file.
 * Matches "always/must X" against "never/must not X" with word overlap.
 */
function detectContradictions(file) {
  const findings = [];
  const codeBlocks = buildCodeBlockSet(file.content);
  const lines = file.content.split('\n');

  const alwaysClaims = [];
  const neverClaims = [];

  for (let i = 0; i < lines.length; i++) {
    if (codeBlocks.has(i)) continue;
    const line = lines[i];

    let match;
    const alwaysRe = new RegExp(ALWAYS_RE.source, ALWAYS_RE.flags);
    while ((match = alwaysRe.exec(line)) !== null) {
      const phrase = match[2].trim().toLowerCase();
      const words = phrase.split(/\s+/).filter(w => w.length > 2);
      if (words.length >= 2) {
        alwaysClaims.push({ words: new Set(words), line: i + 1, text: match[0].trim() });
      }
    }

    const neverRe = new RegExp(NEVER_RE.source, NEVER_RE.flags);
    while ((match = neverRe.exec(line)) !== null) {
      const phrase = match[2].trim().toLowerCase();
      const words = phrase.split(/\s+/).filter(w => w.length > 2);
      if (words.length >= 2) {
        neverClaims.push({ words: new Set(words), line: i + 1, text: match[0].trim() });
      }
    }
  }

  // Compare always vs never claims for word overlap
  for (const a of alwaysClaims) {
    for (const n of neverClaims) {
      const intersection = new Set([...a.words].filter(w => n.words.has(w)));
      const union = new Set([...a.words, ...n.words]);
      const jaccard = intersection.size / union.size;
      if (jaccard >= 0.5 && intersection.size >= 2) {
        findings.push({
          severity: 'info',
          title: `Possible contradiction in ${file.relPath}`,
          detail: `Line ${a.line}: "${a.text}" may contradict line ${n.line}: "${n.text}" (${intersection.size} overlapping terms).`,
          remediation: `Review these directives for consistency. Run /instruction-audit for semantic analysis.`,
        });
        break; // one finding per always-claim
      }
    }
  }

  return findings;
}

/**
 * Detect references to files that don't exist.
 */
async function detectDeadReferences(file, cwd) {
  const findings = [];
  const codeBlocks = buildCodeBlockSet(file.content);
  const lines = file.content.split('\n');
  const checked = new Set();

  const extractedPaths = [];

  for (let i = 0; i < lines.length; i++) {
    if (codeBlocks.has(i)) continue;
    const line = lines[i];

    // Backtick references
    let match;
    const btRe = new RegExp(BACKTICK_PATH_RE.source, BACKTICK_PATH_RE.flags);
    while ((match = btRe.exec(line)) !== null) {
      const ref = match[1].trim();
      if (looksLikeFilePath(ref)) {
        extractedPaths.push({ ref, line: i + 1 });
      }
    }

    // Markdown link references
    const mlRe = new RegExp(MARKDOWN_LINK_RE.source, MARKDOWN_LINK_RE.flags);
    while ((match = mlRe.exec(line)) !== null) {
      const ref = match[1].trim();
      if (looksLikeFilePath(ref)) {
        extractedPaths.push({ ref, line: i + 1 });
      }
    }
  }

  for (const { ref, line } of extractedPaths) {
    if (checked.has(ref)) continue;
    checked.add(ref);

    // Resolve relative to CWD and file's directory
    const candidates = [
      path.resolve(cwd, ref),
      path.resolve(path.dirname(file.fullPath), ref),
    ];

    // Also try without leading ./ or /
    const stripped = ref.replace(/^\.\//, '').replace(/^\//, '');
    if (stripped !== ref) {
      candidates.push(path.resolve(cwd, stripped));
    }

    let found = false;
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        found = true;
        break;
      }
    }

    if (!found) {
      findings.push({
        severity: 'warning',
        title: `Dead file reference in ${file.relPath}`,
        detail: `Line ${line}: "${ref}" — referenced file not found.`,
        remediation: `Update or remove the reference to "${ref}" in ${file.relPath}.`,
      });
    }
  }

  return findings;
}

/**
 * Check if a string looks like a file path (not a URL, command, etc.).
 */
function looksLikeFilePath(str) {
  if (NOT_A_PATH_RE.test(str)) return false;
  if (PLACEHOLDER_RE.test(str)) return false;
  if (GLOB_RE.test(str)) return false;
  if (str.includes(' ') && !str.includes('/')) return false;
  // Must contain a path separator or file extension
  if (!str.includes('/') && !str.includes('.')) return false;
  // Must have a file extension or end with /
  if (!str.includes('.') && !str.endsWith('/')) return false;
  return true;
}

/**
 * Detect vague instructions without follow-up criteria.
 */
function detectVagueInstructions(file) {
  const findings = [];
  const codeBlocks = buildCodeBlockSet(file.content);
  const lines = file.content.split('\n');
  let vagueCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (codeBlocks.has(i)) continue;
    const line = lines[i];

    for (const pattern of VAGUE_PATTERNS) {
      if (!pattern.test(line)) continue;

      // Check if followed by criteria (colon on same line, or bullet/dash on next line)
      const hasCriteria = line.includes(':') && line.indexOf(':') > line.search(pattern);
      const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
      const nextHasCriteria = /^[-*\d]/.test(nextLine);

      if (!hasCriteria && !nextHasCriteria) {
        vagueCount++;
        if (vagueCount <= 3) { // cap individual findings
          findings.push({
            severity: 'info',
            title: `Vague instruction in ${file.relPath}`,
            detail: `Line ${i + 1}: "${line.trim().slice(0, 100)}" — delegates decision without specifying criteria.`,
            remediation: 'Add specific criteria, examples, or decision rules after vague directives.',
          });
        }
      }
      break; // one pattern match per line
    }
  }

  if (vagueCount > 3) {
    findings.push({
      severity: 'info',
      title: `${vagueCount} vague instructions in ${file.relPath}`,
      detail: `${file.relPath} contains ${vagueCount} directives that delegate decisions without criteria (showing first 3).`,
      remediation: 'Run /instruction-audit for a detailed review of instruction specificity.',
    });
  }

  return findings;
}

/**
 * Detect file bloat.
 */
function detectBloat(file) {
  const findings = [];
  // Only check governance and skill files (memory files are expected to grow)
  if (file.category === 'memory') return findings;

  const lineCount = file.content.split('\n').length;
  if (lineCount > BLOAT_WARN) {
    findings.push({
      severity: 'warning',
      title: `Bloated instruction file: ${file.relPath} (${lineCount} lines)`,
      detail: `${file.relPath} exceeds ${BLOAT_WARN} lines. Large instruction files are harder to maintain and consume excessive context.`,
      remediation: `Split ${file.relPath} into focused files or archive completed/obsolete sections.`,
    });
  } else if (lineCount > BLOAT_INFO) {
    findings.push({
      severity: 'info',
      title: `Large instruction file: ${file.relPath} (${lineCount} lines)`,
      detail: `${file.relPath} is approaching the ${BLOAT_WARN}-line bloat threshold.`,
      remediation: `Review ${file.relPath} for sections that can be condensed.`,
    });
  }

  return findings;
}

/**
 * Analyze instruction quality across all files.
 */
async function analyzeInstructionQuality(files, cwd) {
  const findings = [];

  for (const file of files) {
    // Contradictions (within same file)
    findings.push(...detectContradictions(file));

    // Dead file references
    findings.push(...await detectDeadReferences(file, cwd));

    // Vague instructions
    findings.push(...detectVagueInstructions(file));

    // Bloat
    findings.push(...detectBloat(file));
  }

  return findings;
}

/**
 * Detect redundant instructions across files.
 */
function analyzeRedundancy(files) {
  const findings = [];
  const lineMap = new Map(); // normalized line → [{ relPath, lineNumber }]

  for (const file of files) {
    const lines = file.content.split('\n');
    const codeBlocks = buildCodeBlockSet(file.content);

    for (let i = 0; i < lines.length; i++) {
      if (codeBlocks.has(i)) continue;
      const raw = lines[i];
      const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');

      // Skip short lines, headings, blank lines, list markers only
      if (normalized.length < 20) continue;
      if (normalized.startsWith('#')) continue;
      if (/^[-*]\s*$/.test(normalized)) continue;
      if (/^\d+\.\s*$/.test(normalized)) continue;

      if (!lineMap.has(normalized)) {
        lineMap.set(normalized, []);
      }
      lineMap.get(normalized).push({ relPath: file.relPath, lineNumber: i + 1 });
    }
  }

  // Find lines appearing in 2+ distinct files
  let count = 0;
  for (const [normalized, locations] of lineMap) {
    const distinctFiles = new Set(locations.map(l => l.relPath));
    if (distinctFiles.size < 2) continue;

    count++;
    if (count <= MAX_REDUNDANCY_FINDINGS) {
      const fileList = [...distinctFiles].join(', ');
      const truncated = normalized.length > 80 ? normalized.slice(0, 80) + '...' : normalized;
      const titleSnippet = normalized.length > 40 ? normalized.slice(0, 40) + '...' : normalized;
      findings.push({
        severity: 'info',
        title: `Redundant instruction (${distinctFiles.size} files): "${titleSnippet}"`,
        detail: `"${truncated}" appears in: ${fileList}. Redundant instructions waste context budget.`,
        remediation: 'Consolidate into a single governance file or use includes/references.',
      });
    }
  }

  if (count > MAX_REDUNDANCY_FINDINGS) {
    findings.push({
      severity: 'info',
      title: `${count} redundant instructions detected (showing ${MAX_REDUNDANCY_FINDINGS})`,
      detail: `Found ${count} instruction lines duplicated across files. Run /instruction-audit for full analysis.`,
      remediation: 'Consolidate overlapping governance and skill files to reduce context budget waste.',
    });
  }

  return { findings, redundantLineCount: count };
}

export default {
  id: 'instruction-effectiveness',
  name: 'Instruction effectiveness',
  category: 'governance',

  async run(context) {
    const { cwd, homedir, config } = context;
    const findings = [];

    // Discover all instruction-bearing files
    const files = await discoverFiles(cwd, homedir, config);

    if (files.length === 0) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{ severity: 'skipped', title: 'No instruction files found' }],
        data: { filesDiscovered: 0, totalEstimatedTokens: 0, contextPct: 0, breakdown: [], redundantLineCount: 0 },
      };
    }

    // 1. Context budget analysis
    const budget = analyzeContextBudget(files);
    findings.push(...budget.findings);

    // 2. Instruction quality analysis
    const qualityFindings = await analyzeInstructionQuality(files, cwd);
    findings.push(...qualityFindings);

    // 3. Redundancy analysis
    const redundancy = analyzeRedundancy(files);
    findings.push(...redundancy.findings);

    // If no issues found, emit a pass
    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'Instruction files are well-structured and within budget',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
      data: {
        filesDiscovered: files.length,
        totalEstimatedTokens: budget.totalTokens,
        contextPct: budget.pctOfContext,
        breakdown: budget.breakdown,
        redundantLineCount: redundancy.redundantLineCount,
      },
    };
  },
};
