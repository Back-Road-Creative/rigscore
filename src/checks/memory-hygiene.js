import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, GOVERNANCE_FILES } from '../constants.js';
import { readFileSafe, statSafe } from '../utils.js';

// Thresholds and the reasoning behind them: docs/checks/memory-hygiene.md.
// 40 KB ≈ 10k tokens ≈ 5% of a 200k-token window. Override per-repo with
// `memoryHygiene.budgetBytes` in .rigscorerc.json (DEFAULTS in src/config.js).
const BUDGET_BYTES = 40_000;
const MIN_BODY_CHARS = 20; // non-whitespace body chars; below this it's a stub

// Duplicate-rule detection is deliberately conservative: a false "these are the
// same rule" is worse than a miss. Only near-exact normalized equality counts,
// and a line must carry this many normalized chars before it can match at all —
// boilerplate ("never.", "run the tests") can't collide by accident.
const MIN_RULE_CHARS = 40;
const MAX_DUPLICATE_FINDINGS = 10;
const MAX_GOVERNANCE_BYTES = 1_048_576;

const readdirSafe = async (dir) => {
  try { return await fs.promises.readdir(dir); } catch { return []; }
};

/**
 * The auto-loaded bundle: every `.md` under a memory dir, plus a project-level
 * `MEMORY.md` index. Home (`~/.claude/memory`, `~/.claude/projects/<slug>/memory`) is
 * scanned only under --include-home-skills — the opt-in gate instruction-effectiveness
 * and skill-files use.
 */
async function discoverMemory(cwd, homedir, includeHomeSkills) {
  const roots = [path.join(cwd, '.claude', 'memory')];
  if (includeHomeSkills && homedir && homedir !== cwd) {
    roots.push(path.join(homedir, '.claude', 'memory'));
    const projects = path.join(homedir, '.claude', 'projects');
    for (const slug of await readdirSafe(projects)) {
      roots.push(path.join(projects, slug, 'memory'));
    }
  }

  const files = new Map();
  const add = async (full) => {
    if (files.has(full)) return;
    const stat = await statSafe(full);
    if (!stat || !stat.isFile()) return;
    const content = stat.size === 0 ? '' : (await readFileSafe(full)) ?? '';
    files.set(full, { rel: path.relative(cwd, full) || full, content, bytes: stat.size });
  };
  for (const root of roots) {
    for (const e of await readdirSafe(root)) {
      if (e.endsWith('.md')) await add(path.join(root, e));
    }
  }
  await add(path.join(cwd, 'MEMORY.md'));
  await add(path.join(cwd, '.claude', 'MEMORY.md'));
  return [...files.values()];
}

/**
 * Normalize one line to a comparable rule: drop the list marker, markdown
 * emphasis/backticks, and all punctuation; lowercase; collapse whitespace.
 * `- **Staging never on `/tmp`** — tmpfs.` → `staging never on tmp tmpfs`.
 */
function normalizeRule(line) {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every line of a markdown file that could carry a rule, normalized. Headings,
 * fenced code, table rows, and link-only lines are skipped — they duplicate for
 * structural reasons, not because a rule has two homes. Returns a Map of
 * normalized text → first raw line, so a repeat within one file counts once.
 */
function ruleLines(content) {
  const rules = new Map();
  let inFence = false;
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (trimmed === '' || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith('|')) continue;
    const body = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    if (/^!?\[[^\]]*\]\([^)]*\)$/.test(body) || /^https?:\/\/\S+$/.test(body)) continue;
    const norm = normalizeRule(raw);
    if (norm.length < MIN_RULE_CHARS) continue;
    if (!rules.has(norm)) rules.set(norm, trimmed);
  }
  return rules;
}

/** Normalized rule → set of governance files stating it (project root only). */
async function collectGovernanceRules(cwd) {
  const byRule = new Map();
  for (const rel of GOVERNANCE_FILES) {
    const full = path.join(cwd, rel);
    const stat = await statSafe(full);
    if (!stat || !stat.isFile() || stat.size > MAX_GOVERNANCE_BYTES) continue;
    const content = (await readFileSafe(full)) ?? '';
    for (const norm of ruleLines(content).keys()) {
      if (!byRule.has(norm)) byRule.set(norm, new Set());
      byRule.get(norm).add(rel);
    }
  }
  return byRule;
}

/** 'empty' (no content), 'stub' (frontmatter/heading, no body), or null. */
function staleKind(content) {
  if (content.trim() === '') return 'empty';
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^#{1,6}\s.*$/gm, '');
  return body.replace(/\s/g, '').length < MIN_BODY_CHARS ? 'stub' : null;
}

export default {
  id: 'memory-hygiene',
  enforcementGrade: 'mechanical',
  name: 'Agent memory hygiene',
  category: 'governance',

  async run(context) {
    const { cwd, homedir, config, includeHomeSkills } = context;
    const findings = [];
    const configured = config?.memoryHygiene?.budgetBytes;
    const budgetBytes = Number.isInteger(configured) && configured > 0 ? configured : BUDGET_BYTES;
    const memFiles = await discoverMemory(cwd, homedir, includeHomeSkills);
    const totalBytes = memFiles.reduce((sum, f) => sum + f.bytes, 0);
    const data = {
      memoryFiles: memFiles.length, totalBytes, budgetBytes,
      emptyFiles: 0, stubFiles: 0, duplicateRules: 0,
      homeScanned: Boolean(includeHomeSkills),
    };

    // No memory surface at all — most repos. N/A, not zero.
    if (memFiles.length === 0) {
      const skipped = { severity: 'skipped', title: 'No agent memory files found' };
      return { score: NOT_APPLICABLE_SCORE, findings: [skipped], data };
    }

    // 1. Budget — memory is re-injected every turn, so the overage is billed per request.
    const kb = (n) => `${(n / 1000).toFixed(1)} KB`;
    if (totalBytes > budgetBytes) {
      findings.push({
        findingId: 'memory-hygiene/bundle-over-budget',
        severity: 'warning',
        title: `Memory bundle is ${kb(totalBytes)} — over the ${kb(budgetBytes)} budget`,
        detail: `${memFiles.length} memory files total ${totalBytes.toLocaleString()} bytes against a ${budgetBytes.toLocaleString()}-byte budget. Auto-loaded memory is re-injected on every turn, so the overage is billed on every request.`,
        evidence: `${memFiles.length} files, ${totalBytes.toLocaleString()} bytes`,
        remediation: 'Consolidate overlapping files, delete resolved incidents, move rarely-needed detail into on-demand docs.',
      });
    }

    // 2. Stale content — an empty or stub file is dead weight, still loaded every session.
    for (const file of memFiles) {
      const kind = staleKind(file.content);
      if (!kind) continue;
      const empty = kind === 'empty';
      data[empty ? 'emptyFiles' : 'stubFiles']++;
      findings.push({
        findingId: 'memory-hygiene/stale-memory-file',
        severity: empty ? 'warning' : 'info',
        title: `${empty ? 'Empty' : 'Stub'} memory file: ${file.rel}`,
        detail: `${file.rel} is ${empty ? 'empty' : 'a bare stub — frontmatter and/or a heading, no body'}. It teaches the agent nothing but is still loaded every session.`,
        evidence: `${file.rel} (${file.bytes} bytes)`,
        remediation: `Write it out, or delete ${file.rel} and its index entry.`,
      });
    }

    // 3. Single home per rule — a rule stated in both a governance file and a
    // memory file has two homes, so editing one silently fails to take effect.
    const govRules = await collectGovernanceRules(cwd);
    if (govRules.size > 0) {
      for (const file of memFiles) {
        for (const [norm, raw] of ruleLines(file.content)) {
          const govFiles = govRules.get(norm);
          if (!govFiles) continue;
          data.duplicateRules++;
          if (data.duplicateRules > MAX_DUPLICATE_FINDINGS) continue;
          const homes = [...govFiles].join(', ');
          const snippet = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
          findings.push({
            findingId: 'memory-hygiene/duplicate-rule',
            severity: 'info',
            title: `Rule has two homes: ${file.rel} restates ${homes}`,
            detail: `"${snippet}" is stated in ${homes} and again in ${file.rel}. One rule, two homes: an edit to one copy silently fails to take effect, and both are loaded every session.`,
            evidence: `${file.rel} ↔ ${homes}`,
            remediation: `Keep the rule in ${homes} and let ${file.rel} carry only what governance can't — the incident, the evidence, the why.`,
          });
        }
      }
    }

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'Agent memory is within budget and free of stale files' });
    }
    return { score: calculateCheckScore(findings), findings, data };
  },
};
