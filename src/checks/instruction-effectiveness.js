import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe, statSafe, fileExists, collectGovernanceDirFiles, relPosix, toPosix } from '../utils.js';

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
const PLACEHOLDER_RE = /\b(example|your|placeholder|foo|bar|baz|path\/to|YYYY|MM|DD|<[a-z-]+>)\b/i;
const GLOB_RE = /[*?{]/;

// File-line-range suffix: strip `:123` or `:123-456` (and `#L123-L456`) before existence check.
// Captured group keeps the bare path portion.
const FILE_LINE_RANGE_RE = /^([^:#\s]+?)(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/;

/**
 * Strip a trailing `:line` / `:line-line` / `#L123-L456` suffix so the filesystem
 * existence check only sees the bare path. Preserves the original ref when no
 * suffix is present.
 */
function stripLineRange(ref) {
  const m = ref.match(FILE_LINE_RANGE_RE);
  return m ? m[1] : ref;
}

/**
 * Build a cross-repo ref matcher from config. Returns a predicate that
 * returns true for any ref matching a glob in `crossRepoRefs`. Globs support
 * `*` (segment) and `**` (any) — pragmatic, not full glob syntax.
 */
function buildCrossRepoMatcher(config) {
  const globs = Array.isArray(config?.instructionEffectiveness?.crossRepoRefs)
    ? config.instructionEffectiveness.crossRepoRefs
    : [];
  if (globs.length === 0) return () => false;

  const regexes = globs.map((g) => {
    // Escape regex specials, then turn ** and * into regex
    const escaped = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const withStars = escaped
      .replace(/\*\*/g, '::DOUBLESTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::DOUBLESTAR::/g, '.*');
    return new RegExp(`^${withStars}$`);
  });
  return (ref) => regexes.some((re) => re.test(ref));
}

// Governance: top-level CLAUDE.md / .cursorrules / homedir variants /
// config-listed paths / built-in directory-form rule sets (default) /
// opt-in governanceDirs recursive walks.
async function collectGovernanceFiles(cwd, homedir, config, addFile) {
  for (const f of GOVERNANCE_FILES) {
    await addFile(path.join(cwd, f), f, 'governance');
  }
  if (homedir) {
    await addFile(path.join(homedir, '.claude', 'CLAUDE.md'), '~/.claude/CLAUDE.md', 'governance');
    await addFile(path.join(homedir, 'CLAUDE.md'), '~/CLAUDE.md', 'governance');
  }

  if (config?.paths?.claudeMd) {
    for (const p of config.paths.claudeMd) {
      await addFile(p, p, 'governance');
    }
  }

  // Directory-form rule sets (.cursor/rules/*.mdc, .windsurf/rules, .clinerules
  // dir, .github/instructions/*.instructions.md) scanned by DEFAULT — a repo
  // using only these was previously invisible to the instruction-quality scan.
  for (const { full, rel } of await collectGovernanceDirFiles(cwd)) {
    await addFile(full, rel, 'governance');
  }

  const extraGovDirs = Array.isArray(config?.paths?.governanceDirs) ? config.paths.governanceDirs : [];
  for (const govSubDir of extraGovDirs) {
    try {
      const entries = await fs.promises.readdir(govSubDir, { recursive: true });
      for (const entry of entries) {
        if (entry.startsWith('.') || !entry.endsWith('.md')) continue;
        const full = path.join(govSubDir, entry);
        const relName = relPosix(cwd, full) || full;
        await addFile(full, relName, 'governance');
      }
    } catch { /* directory doesn't exist or unreadable */ }
  }
}

// Skill/command directories under project + homedir, recursively.
async function collectSkillFiles(cwd, homedir, addFile) {
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
}

// MEMORY.md at project root + .claude/, plus homedir per-project memory
// dirs. Each MEMORY.md is also scanned for markdown links to other .md
// files which are pulled in as additional memory entries.
async function collectMemoryFiles(cwd, homedir, addFile) {
  const memoryLocations = [
    path.join(cwd, 'MEMORY.md'),
    path.join(cwd, '.claude', 'MEMORY.md'),
  ];
  if (homedir) {
    const projectMemDir = path.join(homedir, '.claude', 'projects');
    try {
      const projectDirs = await fs.promises.readdir(projectMemDir);
      for (const d of projectDirs) {
        memoryLocations.push(path.join(projectMemDir, d, 'memory', 'MEMORY.md'));
      }
    } catch { /* no project memory dirs */ }
  }

  for (const memPath of memoryLocations) {
    const content = await readFileSafe(memPath);
    if (!content) continue;
    const rel = toPosix(memPath.startsWith(cwd)
      ? path.relative(cwd, memPath)
      : memPath.replace(homedir, '~'));
    await addFile(memPath, rel, 'memory');

    for (const match of content.matchAll(/\[.*?\]\(([^)]+\.md)\)/g)) {
      const linkedPath = match[1];
      if (linkedPath.startsWith('http')) continue;
      const resolvedPath = path.resolve(path.dirname(memPath), linkedPath);
      const linkedRel = toPosix(resolvedPath.startsWith(cwd)
        ? path.relative(cwd, resolvedPath)
        : resolvedPath.replace(homedir, '~'));
      await addFile(resolvedPath, linkedRel, 'memory');
    }
  }
}

/**
 * Discover all instruction-bearing files in the project and homedir.
 * Returns array of { relPath, fullPath, content, category }.
 *
 * Orchestrator only — the three collectGovernance/Skill/Memory helpers
 * share the addFile closure via parameter, which handles dedup + size
 * cap + binary-detection + content read in one place.
 *
 * `homedir` is suppressed (set to null) when --include-home-skills is
 * off, matching the documented CLI default ("scan cwd only; home
 * findings do not affect project scores unless this flag is set") and
 * the same gate skill-files.js applies. Without this, the check
 * reports dead refs / vague-instructions / bloat findings in
 * ~/.claude/skills/** that the user explicitly opted out of seeing.
 */
async function discoverFiles(cwd, homedir, config, includeHomeSkills) {
  const effectiveHomedir = includeHomeSkills ? homedir : null;
  const files = [];
  const seen = new Set();

  async function addFile(fullPath, relPath, category) {
    if (seen.has(fullPath)) return;
    // RS-16: skip agent-worktree clones. A parallel-agent run leaves transient
    // full-project copies under `.claude/worktrees/**` that the harness never
    // auto-unlocks; their stale/relative refs would storm the self-scan with
    // dead-file-reference findings. They are never the project's real instruction
    // surface — drop them here, the one chokepoint all discovery funnels through.
    const normPath = String(fullPath).split(path.sep).join('/');
    if (normPath.includes('/.claude/worktrees/') || normPath.startsWith('.claude/worktrees/')) return;
    const stat = await statSafe(fullPath);
    if (!stat || stat.isDirectory() || stat.size > MAX_FILE_SIZE || stat.size === 0) return;
    const content = await readFileSafe(fullPath);
    if (!content) return;
    if (content.slice(0, 1024).includes('\0')) return; // binary
    seen.add(fullPath);
    files.push({ relPath, fullPath, content, category });
  }

  await collectGovernanceFiles(cwd, effectiveHomedir, config, addFile);
  await collectSkillFiles(cwd, effectiveHomedir, addFile);
  await collectMemoryFiles(cwd, effectiveHomedir, addFile);

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
        findingId: 'instruction-effectiveness/single-file-over-budget',
        severity: 'warning',
        title: `Large instruction file: ${file.relPath}`,
        detail: `${file.relPath} is ~${tokens.toLocaleString()} estimated tokens. Large instruction files consume context budget and may reduce effective working memory.`,
        remediation: `Review ${file.relPath} for sections that can be condensed or moved to on-demand references.`,
        context: { file: file.relPath, tokens },
      });
    }
  }

  const totalTokens = breakdown.reduce((sum, b) => sum + b.estimatedTokens, 0);
  const pctOfContext = totalTokens / REFERENCE_CONTEXT;

  if (pctOfContext > BUDGET_WARN_PCT) {
    findings.push({
      findingId: 'instruction-effectiveness/context-budget-warn',
      severity: 'warning',
      title: `Instruction files consume ${(pctOfContext * 100).toFixed(1)}% of context window`,
      detail: `${files.length} instruction files total ~${totalTokens.toLocaleString()} estimated tokens (${(pctOfContext * 100).toFixed(1)}% of ${(REFERENCE_CONTEXT / 1000)}K reference window). This leaves less room for code, tool output, and conversation.`,
      remediation: 'Consolidate redundant instructions, compress verbose sections, or split rarely-needed instructions into on-demand references.',
      context: { totalTokens, pctOfContext },
    });
  } else if (pctOfContext > BUDGET_INFO_PCT) {
    findings.push({
      findingId: 'instruction-effectiveness/context-budget-info',
      severity: 'info',
      title: `Instruction files consume ${(pctOfContext * 100).toFixed(1)}% of context window`,
      detail: `${files.length} instruction files total ~${totalTokens.toLocaleString()} estimated tokens (${(pctOfContext * 100).toFixed(1)}% of ${(REFERENCE_CONTEXT / 1000)}K reference window).`,
      remediation: 'Consider reviewing large instruction files for optimization opportunities.',
      context: { totalTokens, pctOfContext },
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
          findingId: 'instruction-effectiveness/contradiction',
          severity: 'info',
          title: `Possible contradiction in ${file.relPath}`,
          detail: `Line ${a.line}: "${a.text}" may contradict line ${n.line}: "${n.text}" (${intersection.size} overlapping terms).`,
          remediation: `Review these directives for consistency and reconcile the conflicting language.`,
          context: { file: file.relPath, alwaysLine: a.line, neverLine: n.line },
        });
        break; // one finding per always-claim
      }
    }
  }

  return findings;
}

/**
 * Detect references to files that don't exist.
 *
 * Noise controls (added Moat & Ship Agent A):
 *   - Strips `foo.py:123` / `foo.py:123-456` / `foo.md#L10-L20` line-range
 *     suffixes before the existence check (so a valid file with a cited line
 *     range isn't flagged).
 *   - Honours `config.instructionEffectiveness.crossRepoRefs: [glob, ...]`
 *     which exempts refs that point at sibling repos / external projects the
 *     current scan can't see.
 *   - Skips dead-ref scanning entirely for project-scoped memory files
 *     (`~/.claude/projects/<slug>/memory/*.md`) — those describe OTHER projects
 *     by design and their references live outside the scanned cwd.
 */
// Resolve a referenced path against cwd, the referring file's dir, and a
// bare-relative form. Returns true if any candidate exists on disk.
async function resolveRef(bareRef, cwd, fullPath) {
  const candidates = [
    path.resolve(cwd, bareRef),
    path.resolve(path.dirname(fullPath), bareRef),
  ];
  const stripped = bareRef.replace(/^\.\//, '').replace(/^\//, '');
  if (stripped !== bareRef) {
    candidates.push(path.resolve(cwd, stripped));
  }
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return true;
  }
  return false;
}

async function detectDeadReferences(file, cwd, config) {
  const findings = [];

  // Project-scoped memory files describe other projects; their paths are
  // inherently cross-repo and can't be validated from the current cwd.
  if (file.relPath.includes('.claude/projects/') && file.category === 'memory') {
    return findings;
  }

  // Slash-command files (`.claude/commands/*`) and skill acceptance-criteria
  // files (`.claude/skills/*/evals/*`) describe operations over arbitrary
  // target projects — their path refs (`pyproject.toml`, `lib-skill-utils/*.sh`,
  // `SKILL.md`) exist in invocation context, not the scanner's cwd. Skipping
  // dead-ref for these keeps the signal focused on author-authored governance.
  if (/\.claude\/commands\//.test(file.relPath)) return findings;
  if (/\.claude\/skills\/.*\/evals\//.test(file.relPath)) return findings;

  const codeBlocks = buildCodeBlockSet(file.content);
  const lines = file.content.split('\n');
  const checked = new Set();
  const crossRepoMatch = buildCrossRepoMatcher(config);

  const extractedPaths = [];

  for (let i = 0; i < lines.length; i++) {
    if (codeBlocks.has(i)) continue;
    const line = lines[i];
    // matchAll over the shared module-level regexes — no per-iteration
    // RegExp allocation, no lastIndex state to reset.
    for (const re of [BACKTICK_PATH_RE, MARKDOWN_LINK_RE]) {
      for (const match of line.matchAll(re)) {
        const ref = match[1].trim();
        if (looksLikeFilePath(ref)) {
          extractedPaths.push({ ref, line: i + 1 });
        }
      }
    }
  }

  for (const { ref, line } of extractedPaths) {
    if (checked.has(ref)) continue;
    checked.add(ref);

    // Strip `:123`, `:123-456`, and `#L123-L456` before existence check.
    const bareRef = stripLineRange(ref);

    // Exempt configured cross-repo refs (both the suffixed and bare form).
    if (crossRepoMatch(ref) || crossRepoMatch(bareRef)) continue;

    const found = await resolveRef(bareRef, cwd, file.fullPath);

    if (!found) {
      const findingId = 'instruction-effectiveness/dead-file-reference';
      findings.push({
        findingId,
        severity: 'warning',
        title: `Dead file reference in ${file.relPath}`,
        detail: `Line ${line}: "${ref}" — referenced file not found.`,
        evidence: `${file.relPath}:${line} \`${ref.slice(0, 80)}\``,
        remediation: `Update or remove the reference, or add "${bareRef}" to \`instructionEffectiveness.crossRepoRefs\` in .rigscorerc.json if it points to a sibling repo.`,
        context: { file: file.relPath, line, ref, bareRef },
      });
    }
  }

  return findings;
}

// Recognised file extensions — a bare "word.ext" without `/` must use one of
// these to count as a file reference. Keeps `data.filesDiscovered`,
// `r.findings`, `err.message` style property-access strings from registering
// as dead refs.
const KNOWN_FILE_EXTS = new Set([
  'md', 'sh', 'py', 'js', 'ts', 'tsx', 'jsx', 'json', 'jsonl',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'txt', 'log', 'csv', 'tsv', 'sql', 'html', 'css', 'scss',
  'lock', 'bak', 'env', 'gitignore', 'gitmodules', 'gitkeep',
  'rs', 'go', 'java', 'rb', 'c', 'cpp', 'h', 'hpp',
  'png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'ico',
  'pdf', 'zip', 'tar', 'gz', 'tgz',
  'dockerfile', 'makefile',
]);

/**
 * Check if a string looks like a file path (not a URL, command, etc.).
 */
function looksLikeFilePath(str) {
  // Normalise line-range suffix up front so the heuristics below see the
  // bare path. "missing.py:42" → "missing.py" for pattern-matching purposes;
  // detectDeadReferences also strips it before filesystem lookup.
  str = stripLineRange(str);
  if (NOT_A_PATH_RE.test(str)) return false;
  if (PLACEHOLDER_RE.test(str)) return false;
  if (GLOB_RE.test(str)) return false;
  // Numeric literals / semver: "1.0.0", "-1.5", "2.4.1"
  if (/^-?\d+(\.\d+)*$/.test(str)) return false;
  // Method-call syntax: ".get()", "path.mkdir(parents=True)"
  if (/\([^)]*\)\s*$/.test(str)) return false;
  // Angle-bracket placeholders anywhere (NOT_A_PATH catches only leading <)
  if (/<[A-Za-z_][A-Za-z0-9_-]*>/.test(str)) return false;
  // Config/key=value assignments, not paths
  if (str.includes('=')) return false;
  // Trailing whitespace → shell fragment like "grep ", "grep -c "
  if (/\s$/.test(str)) return false;
  // Shell-command prefix: "git -C ...", "find ~/path", "grep -E pattern".
  // \d? catches trailing version digits (python3, node22, bash5).
  if (/^(git|bash|sh|zsh|node\d*|npm|npx|pnpm|yarn|pip\d*|python\d*|cargo|make|find|grep|sed|awk|cat|head|tail|less|more|echo|ls|cd|rm|cp|mv|sudo|curl|wget|chmod|chown|kill|ps|top)\s/.test(str)) return false;
  if (str.includes(' ') && !str.includes('/')) return false;
  // Must contain a path separator or file extension
  if (!str.includes('/') && !str.includes('.')) return false;
  // Must have a file extension or end with /
  if (!str.includes('.') && !str.endsWith('/')) return false;

  // Bare extension reference ("Files ending in `.md`") — not a path.
  if (/^\.[a-zA-Z0-9]{1,10}$/.test(str)) return false;

  // "word.ext" style: if there's no path separator AND the extension isn't
  // a known file type, assume it's a JS/Python property access (data.foo,
  // err.message, r.findings) rather than a filename.
  if (!str.includes('/')) {
    const lastDot = str.lastIndexOf('.');
    const ext = str.slice(lastDot + 1).toLowerCase();
    if (!KNOWN_FILE_EXTS.has(ext)) return false;
  }

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
            findingId: 'instruction-effectiveness/vague-instruction',
            severity: 'info',
            title: `Vague instruction in ${file.relPath}`,
            detail: `Line ${i + 1}: "${line.trim().slice(0, 100)}" — delegates decision without specifying criteria.`,
            remediation: 'Add specific criteria, examples, or decision rules after vague directives.',
            context: { file: file.relPath, line: i + 1 },
          });
        }
      }
      break; // one pattern match per line
    }
  }

  if (vagueCount > 3) {
    findings.push({
      findingId: 'instruction-effectiveness/vague-instruction-summary',
      severity: 'info',
      title: `${vagueCount} vague instructions in ${file.relPath}`,
      detail: `${file.relPath} contains ${vagueCount} directives that delegate decisions without criteria (showing first 3).`,
      remediation: 'Rewrite vague directives with concrete criteria, examples, or decision rules.',
      context: { file: file.relPath, count: vagueCount },
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
      findingId: 'instruction-effectiveness/file-bloat',
      severity: 'warning',
      title: `Bloated instruction file: ${file.relPath} (${lineCount} lines)`,
      detail: `${file.relPath} exceeds ${BLOAT_WARN} lines. Large instruction files are harder to maintain and consume excessive context.`,
      remediation: `Split ${file.relPath} into focused files or archive completed/obsolete sections.`,
      context: { file: file.relPath, lineCount },
    });
  } else if (lineCount > BLOAT_INFO) {
    findings.push({
      findingId: 'instruction-effectiveness/file-bloat-info',
      severity: 'info',
      title: `Large instruction file: ${file.relPath} (${lineCount} lines)`,
      detail: `${file.relPath} is approaching the ${BLOAT_WARN}-line bloat threshold.`,
      remediation: `Review ${file.relPath} for sections that can be condensed.`,
      context: { file: file.relPath, lineCount },
    });
  }

  return findings;
}

/**
 * Analyze instruction quality across all files.
 */
async function analyzeInstructionQuality(files, cwd, config) {
  const findings = [];

  for (const file of files) {
    // Contradictions (within same file)
    findings.push(...detectContradictions(file));

    // Dead file references
    findings.push(...await detectDeadReferences(file, cwd, config));

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
/**
 * Find the line range [start, end) covered by a leading YAML frontmatter
 * block (`---` … `---`). Frontmatter keys legitimately repeat across files
 * (e.g. `status: graduated-code`) and would otherwise inflate redundancy
 * findings. Returns [0, 0) when no frontmatter is present.
 */
function frontmatterRange(lines) {
  if (lines.length < 2 || lines[0].trim() !== '---') return [0, 0];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return [0, i + 1];
  }
  return [0, 0];
}

function analyzeRedundancy(files) {
  const findings = [];
  const lineMap = new Map(); // normalized line → [{ relPath, lineNumber }]

  for (const file of files) {
    const lines = file.content.split('\n');
    const codeBlocks = buildCodeBlockSet(file.content);
    const [fmStart, fmEnd] = frontmatterRange(lines);

    for (let i = 0; i < lines.length; i++) {
      if (i >= fmStart && i < fmEnd) continue;
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
        findingId: 'instruction-effectiveness/redundant-instruction',
        severity: 'info',
        title: `Redundant instruction (${distinctFiles.size} files): "${titleSnippet}"`,
        detail: `"${truncated}" appears in: ${fileList}. Redundant instructions waste context budget.`,
        remediation: 'Consolidate into a single governance file or use includes/references.',
        context: { files: [...distinctFiles] },
      });
    }
  }

  if (count > MAX_REDUNDANCY_FINDINGS) {
    findings.push({
      findingId: 'instruction-effectiveness/redundant-instruction-summary',
      severity: 'info',
      title: `${count} redundant instructions detected (showing ${MAX_REDUNDANCY_FINDINGS})`,
      detail: `Found ${count} instruction lines duplicated across files.`,
      remediation: 'Consolidate overlapping governance and skill files to reduce context budget waste.',
      context: { count },
    });
  }

  return { findings, redundantLineCount: count };
}

export default {
  id: 'instruction-effectiveness',
  enforcementGrade: 'keyword',
  name: 'Instruction effectiveness',
  category: 'governance',

  async run(context) {
    const { cwd, homedir, config, includeHomeSkills } = context;
    const findings = [];

    // Discover all instruction-bearing files
    const files = await discoverFiles(cwd, homedir, config, includeHomeSkills);

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
    const qualityFindings = await analyzeInstructionQuality(files, cwd, config);
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
