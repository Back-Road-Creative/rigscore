import fs from 'node:fs';
import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, statSafe } from '../utils.js';

// Thresholds and the reasoning behind them: docs/checks/memory-hygiene.md.
// 40 KB ≈ 10k tokens ≈ 5% of a 200k-token window. Hardcoded — src/config.js
// merges user config key-by-key, so a `memoryHygiene` key is dropped today.
const BUDGET_BYTES = 40_000;
const MIN_BODY_CHARS = 20; // non-whitespace body chars; below this it's a stub

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
    const { cwd, homedir, includeHomeSkills } = context;
    const findings = [];
    const memFiles = await discoverMemory(cwd, homedir, includeHomeSkills);
    const totalBytes = memFiles.reduce((sum, f) => sum + f.bytes, 0);
    const data = {
      memoryFiles: memFiles.length, totalBytes, budgetBytes: BUDGET_BYTES,
      emptyFiles: 0, stubFiles: 0, homeScanned: Boolean(includeHomeSkills),
    };

    // No memory surface at all — most repos. N/A, not zero.
    if (memFiles.length === 0) {
      const skipped = { severity: 'skipped', title: 'No agent memory files found' };
      return { score: NOT_APPLICABLE_SCORE, findings: [skipped], data };
    }

    // 1. Budget — memory is re-injected every turn, so the overage is billed per request.
    const kb = (n) => `${(n / 1000).toFixed(1)} KB`;
    if (totalBytes > BUDGET_BYTES) {
      findings.push({
        findingId: 'memory-hygiene/bundle-over-budget',
        severity: 'warning',
        title: `Memory bundle is ${kb(totalBytes)} — over the ${kb(BUDGET_BYTES)} budget`,
        detail: `${memFiles.length} memory files total ${totalBytes.toLocaleString()} bytes against a ${BUDGET_BYTES.toLocaleString()}-byte budget. Auto-loaded memory is re-injected on every turn, so the overage is billed on every request.`,
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

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'Agent memory is within budget and free of stale files' });
    }
    return { score: calculateCheckScore(findings), findings, data };
  },
};
