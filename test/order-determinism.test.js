import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugify } from '../src/findings.js';
import { withTmpDir } from './helpers.js';
import deepSecrets from '../src/checks/deep-secrets.js';
import loopGovernance from '../src/checks/loop-governance.js';
import memoryHygiene from '../src/checks/memory-hygiene.js';
import sandboxPosture from '../src/checks/sandbox-posture.js';

// Regression harness for a bug class that has now shipped twice: a check whose
// verdict depends on the order the filesystem handed back entries. `walkDirSafe`
// truncates mid-walk at `maxFiles`, so WHICH files survived the cap was decided by
// readdir order — a coin-flip false PASS over a live secret (deep-secrets scored 98
// "clean") and a false NOT_APPLICABLE over a live unbounded agent loop.
//
// Two properties, BOTH load-bearing: (1) DETERMINISM — identical verdict under
// natural/reversed/shuffled readdir; (2) LOUD TRUNCATION — determinism alone would
// only make a false PASS *reproducible*, so a scan that stopped looking must never
// look clean. The permutation preserves the entry SET and changes only its ORDER, so
// any verdict difference between orderings is real order-dependence, not new input.

const realReaddir = fs.promises.readdir;
afterEach(() => { fs.promises.readdir = realReaddir; });

/** Deterministic PRNG — a shuffle failure must be reproducible, never flaky. */
function mulberry32(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nameOf = (e) => (typeof e === 'string' ? e : e.name);

/** Permute every readdir listing. The probe lets a test PROVE the permutation
 *  reordered something — a shuffle that silently no-ops would report "stable"
 *  for every check and be worthless. */
function patchReaddir(mode, seed = 1337) {
  let reordered = 0;
  const rand = mulberry32(seed);
  fs.promises.readdir = async (dir, opts) => {
    const entries = await realReaddir(dir, opts);
    if (!Array.isArray(entries) || entries.length < 2 || mode === 'natural') return entries;
    const out = [...entries];
    if (mode === 'reversed') out.reverse();
    else for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    if (out.some((e, i) => nameOf(e) !== nameOf(entries[i]))) reordered++;
    return out;
  };
  return { reorderedCount: () => reordered };
}

/** The verdict a consumer actually sees. findingIds are derived the way the product
 *  derives them (`assignFindingIds`): an explicit `findingId` wins, and only an id-less
 *  finding falls back to slugify(title) — slugifying the title of a finding that sets an
 *  explicit id would fabricate an id that never ships. A different finding ORDER is fine;
 *  only a different SET or score is a bug — hence the sort. */
function verdict(result, checkId) {
  return {
    score: result.score,
    findingIds: result.findings
      .map((f) => f.findingId || `${checkId}/${slugify(f.title || 'unknown')}`)
      .sort(),
  };
}

const ORDERINGS = ['natural', 'reversed', 'shuffle'];

async function runUnderEachOrdering(check, context) {
  const out = {};
  let totalReordered = 0;
  for (const mode of ORDERINGS) {
    const probe = patchReaddir(mode);
    try {
      out[mode] = verdict(await check.run(context), check.id);
    } finally {
      totalReordered += probe.reorderedCount();
      fs.promises.readdir = realReaddir;
    }
  }
  return { out, totalReordered };
}

// Matches the shipped KEY_PATTERNS regex (/\bsk-ant-[a-zA-Z0-9_-]{10,}\b/), on a
// non-comment line, not placeholder-shaped.
const LIVE_SECRET = 'const CLIENT_KEY = "sk-ant-api03-Xk92LmQp4RtYw8ZnB6VcHs3JdF7Ga1Ue0Oi5";';

/** Filler + one secret file that sorts LAST, so a walk capped before the tail never
 *  reaches it under a natural/sorted ordering. */
function buildSecretFixture(tmp, fillerCount) {
  for (let i = 0; i < fillerCount; i++) {
    fs.writeFileSync(path.join(tmp, `filler-${String(i).padStart(4, '0')}.js`), `export const v${i} = ${i};\n`);
  }
  fs.writeFileSync(path.join(tmp, 'z-secret.js'), `${LIVE_SECRET}\n`);
}

describe('order-determinism — verdicts must not depend on readdir order', () => {
  it('HARNESS SELF-TEST: the permutation genuinely reorders entries', async () => {
    await withTmpDir(async (tmp) => {
      for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(tmp, `f-${i}.js`), 'x\n');
      const natList = await realReaddir(tmp);
      for (const mode of ['reversed', 'shuffle']) {
        const probe = patchReaddir(mode);
        const list = await fs.promises.readdir(tmp);
        fs.promises.readdir = realReaddir;
        expect([...list].sort()).toEqual([...natList].sort()); // same SET
        expect(list).not.toEqual(natList);                     // different ORDER
        expect(probe.reorderedCount()).toBeGreaterThan(0);
      }
    });
  });

  it('deep-secrets: a capped walk NEVER reports clean, under any ordering', async () => {
    await withTmpDir(async (tmp) => {
      buildSecretFixture(tmp, 30); // 31 candidates > cap ⇒ the walk truncates
      const context = { cwd: tmp, deep: true, config: { deepScan: { maxFiles: 20 } } };
      const { out, totalReordered } = await runUnderEachOrdering(deepSecrets, context);
      expect(totalReordered).toBeGreaterThan(0); // the harness really permuted

      expect(out.reversed).toEqual(out.natural); // determinism
      expect(out.shuffle).toEqual(out.natural);
      // The cap physically prevents reading every file, so the honest verdict is a
      // disclosed, score-denting truncation — never a silent pass.
      for (const mode of ORDERINGS) {
        expect(out[mode].findingIds).toContain('deep-secrets/file-cap-reached');
        expect(out[mode].findingIds.some((id) => id.includes('clean'))).toBe(false);
        expect(out[mode].score).toBeLessThan(100);
      }
    });
  });

  it('deep-secrets: an untruncated walk finds the secret under every ordering', async () => {
    await withTmpDir(async (tmp) => {
      buildSecretFixture(tmp, 30);
      const context = { cwd: tmp, deep: true, config: { deepScan: { maxFiles: 1000 } } };
      const { out, totalReordered } = await runUnderEachOrdering(deepSecrets, context);
      expect(totalReordered).toBeGreaterThan(0);
      for (const mode of ORDERINGS) {
        expect(out[mode].findingIds).toContain('deep-secrets/hardcoded-secret');
        expect(out[mode].score).toBe(0);
      }
    });
  });

  it('loop-governance: a truncated walk is never NOT_APPLICABLE', async () => {
    await withTmpDir(async (tmp) => {
      // MAX_FILES (2000) is not configurable — overshoot it with cheap filler, then
      // hide a live unbounded agent loop in a file that sorts last.
      for (let i = 0; i < 2100; i++) {
        fs.writeFileSync(path.join(tmp, `f-${String(i).padStart(5, '0')}.sh`), '#!/bin/sh\necho hi\n');
      }
      fs.writeFileSync(path.join(tmp, 'zz-agent-loop.sh'), '#!/bin/sh\nwhile true; do\n  claude -p "go"\ndone\n');
      const { out, totalReordered } = await runUnderEachOrdering(loopGovernance, { cwd: tmp, config: {} });
      expect(totalReordered).toBeGreaterThan(0);

      // Absence of evidence is not evidence of absence: the walk was cut short, so
      // "this repo runs no agent loops" (NOT_APPLICABLE, -1) is a lie.
      for (const mode of ORDERINGS) {
        expect(out[mode].score).not.toBe(-1);
        expect(out[mode].findingIds).toContain('loop-governance/file-cap-reached');
      }
      expect(out.reversed).toEqual(out.natural);
      expect(out.shuffle).toEqual(out.natural);
    });
  }, 30000);

  // ── memory-hygiene: the governance walk (MAX_GOVERNANCE_FILES = 100) ──────────
  //
  // NOTE the cap counts *included* files, not files walked: `walkDirSafe` gates on
  // `files.length`, which is the post-`shouldInclude` list. So this truncates at 100
  // GOVERNANCE files (a monorepo's `packages/<pkg>/CLAUDE.md`), not 100 files.
  //
  // The walk feeds exactly one finding — `duplicate-rule` — so truncation cannot make
  // this check N/A (the N/A gate is `memFiles.length === 0`, decided by `discoverMemory`
  // before the walk ever runs). What it CAN do is let the check print its PASS,
  // "Agent memory is within budget and free of stale files", over a rule whose other
  // home sat in a governance file the walk never reached.

  const SHARED_RULE =
    '- Never merge a pull request yourself — always emit the merge command for the operator to run.';

  /** A memory file restating a rule whose ONLY governance home is `zz-pkg/CLAUDE.md`,
   *  which sorts last and so falls past the cap once `pkgCount` >= 100. */
  function buildGovernanceFixture(tmp, pkgCount) {
    fs.mkdirSync(path.join(tmp, '.claude', 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'memory', 'merge.md'),
      `# Merge policy\n\n${SHARED_RULE}\n\nThe operator merges by hand: an agent that merges its own PR bypasses review entirely.\n`,
    );
    for (let i = 0; i < pkgCount; i++) {
      const dir = path.join(tmp, `pkg-${String(i).padStart(4, '0')}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'CLAUDE.md'),
        `# pkg ${i}\n\n- Package ${i} builds with the workspace toolchain and ships nothing on its own.\n`,
      );
    }
    const last = path.join(tmp, 'zz-pkg');
    fs.mkdirSync(last, { recursive: true });
    fs.writeFileSync(path.join(last, 'CLAUDE.md'), `# zz\n\n${SHARED_RULE}\n`);
  }

  const memoryContext = (tmp) => ({
    cwd: tmp,
    homedir: fs.mkdtempSync(path.join(os.tmpdir(), 'rs-mem-home-')),
    config: {},
    includeHomeSkills: false,
  });

  const PASS_ID = 'memory-hygiene/agent-memory-is-within-budget-and-free-of-stale-files';

  it('memory-hygiene: a truncated governance walk NEVER reports clean, under any ordering', async () => {
    await withTmpDir(async (tmp) => {
      buildGovernanceFixture(tmp, 105); // 105 + zz-pkg > the 100-governance-file cap
      const { out, totalReordered } = await runUnderEachOrdering(memoryHygiene, memoryContext(tmp));
      expect(totalReordered).toBeGreaterThan(0); // the harness really permuted

      expect(out.reversed).toEqual(out.natural); // determinism
      expect(out.shuffle).toEqual(out.natural);

      for (const mode of ORDERINGS) {
        // It must SAY it stopped looking...
        expect(out[mode].findingIds).toContain('memory-hygiene/governance-file-cap-reached');
        // ...and it must not certify memory it never finished reading.
        expect(out[mode].findingIds).not.toContain(PASS_ID);
        expect(out[mode].score).toBeLessThan(100);
      }
    });
  }, 30000);

  it('memory-hygiene: an untruncated walk finds the duplicate rule under every ordering', async () => {
    await withTmpDir(async (tmp) => {
      // Same fixture, same duplicate rule, same `zz-pkg` home — only now the walk
      // reaches it. This is what proves the capped run above is hiding something real.
      buildGovernanceFixture(tmp, 10);
      const { out, totalReordered } = await runUnderEachOrdering(memoryHygiene, memoryContext(tmp));
      expect(totalReordered).toBeGreaterThan(0);
      for (const mode of ORDERINGS) {
        expect(out[mode].findingIds).toContain('memory-hygiene/duplicate-rule');
        expect(out[mode].findingIds).not.toContain('memory-hygiene/governance-file-cap-reached');
        expect(out[mode].score).toBe(98); // one INFO duplicate-rule
      }
    });
  }, 30000);

  // ── sandbox-posture: the .devcontainer walk (maxFiles: 200) ───────────────────
  //
  // This walk passes NO `shouldInclude` and NO `skipDirs`, so every file under
  // `.devcontainer/` counts against the 200 cap. Truncation here is the loud one: the
  // file naming the agent install can fall past the cap, `AGENT_INSTALL` then never
  // matches, `scanDevcontainer` returns null, `surfacesScanned` stays 0 — and the check
  // returns NOT_APPLICABLE, i.e. "this repo configures no sandbox surface at all",
  // over a container that runs an agent with no egress boundary whatsoever.

  /** Filler + the one file that installs an agent CLI and carries no egress control.
   *  It sorts last, so a walk capped before the tail never reads it. */
  function buildDevcontainerFixture(tmp, fillerCount) {
    const dc = path.join(tmp, '.devcontainer');
    fs.mkdirSync(dc, { recursive: true });
    for (let i = 0; i < fillerCount; i++) {
      fs.writeFileSync(path.join(dc, `filler-${String(i).padStart(4, '0')}.txt`), `note ${i}\n`);
    }
    fs.writeFileSync(
      path.join(dc, 'zz-devcontainer.json'),
      JSON.stringify({ name: 'agent', postCreateCommand: 'npm i -g @anthropic-ai/claude-code' }, null, 2),
    );
  }

  const sandboxContext = (tmp) => ({
    cwd: tmp,
    homedir: fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sandbox-home-')),
    config: {},
  });

  it('sandbox-posture: a truncated devcontainer walk is never NOT_APPLICABLE', async () => {
    await withTmpDir(async (tmp) => {
      buildDevcontainerFixture(tmp, 205); // 206 files > the 200 cap
      const { out, totalReordered } = await runUnderEachOrdering(sandboxPosture, sandboxContext(tmp));
      expect(totalReordered).toBeGreaterThan(0);

      expect(out.reversed).toEqual(out.natural); // determinism
      expect(out.shuffle).toEqual(out.natural);

      for (const mode of ORDERINGS) {
        // "I did not read the container" must never render as "there is no container".
        expect(out[mode].score).not.toBe(-1);
        expect(out[mode].findingIds).toContain('sandbox-posture/devcontainer-file-cap-reached');
      }
    });
  }, 30000);

  it('sandbox-posture: an untruncated walk finds the containment gap under every ordering', async () => {
    await withTmpDir(async (tmp) => {
      // Same container, same missing egress boundary — only now the walk reaches the
      // file that declares the agent install.
      buildDevcontainerFixture(tmp, 10);
      const { out, totalReordered } = await runUnderEachOrdering(sandboxPosture, sandboxContext(tmp));
      expect(totalReordered).toBeGreaterThan(0);
      for (const mode of ORDERINGS) {
        expect(out[mode].findingIds).toContain('sandbox-posture/devcontainer-no-egress-control');
        expect(out[mode].findingIds).not.toContain('sandbox-posture/devcontainer-file-cap-reached');
        expect(out[mode].score).toBe(85); // one WARNING
      }
    });
  }, 30000);
});
