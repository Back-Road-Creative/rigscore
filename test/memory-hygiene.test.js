import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/memory-hygiene.js';
import { loadConfig } from '../src/config.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

// Home scanning is opt-in (same gate as instruction-effectiveness / skill-files),
// so the default context leaves includeHomeSkills off.
const run = (cwd, opts = {}) =>
  check.run({ cwd, homedir: os.tmpdir(), config: {}, includeHomeSkills: false, ...opts });

function tmpMemoryDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-mem-'));
  fs.mkdirSync(path.join(dir, '.claude', 'memory'), { recursive: true });
  return dir;
}

describe('memory-hygiene', () => {
  it('passes a clean indexed memory set', async () => {
    const r = await run(fixture('memory-clean'));
    expect(r.data.memoryFiles).toBe(2);
    expect(r.findings.map((f) => f.severity)).toEqual(['pass']);
    expect(r.score).toBe(100);
  });

  it('flags an empty file (warning) and a frontmatter-only stub (info)', async () => {
    const r = await run(fixture('memory-messy'));
    const stale = r.findings.filter((f) => f.findingId === 'memory-hygiene/stale-memory-file');
    expect(stale.map((f) => f.severity).sort()).toEqual(['info', 'warning']);
    expect(r.data.emptyFiles).toBe(1);
    expect(r.data.stubFiles).toBe(1);
    expect(r.score).toBe(83); // 100 − 15 (warning) − 2 (info)
  });

  it('flags a memory bundle over the byte budget', async () => {
    // Padding is generated at runtime — committing a >40 KB fixture would bloat the repo.
    const dir = tmpMemoryDir();
    const para = 'Long-lived operational note about the deploy pipeline and its rollback. ';
    fs.writeFileSync(path.join(dir, '.claude/memory/MEMORY.md'), '# Index\n- [Big](big.md)\n');
    fs.writeFileSync(path.join(dir, '.claude/memory/big.md'), `# Big\n\n${para.repeat(700)}\n`);
    try {
      const r = await run(dir);
      const over = r.findings.find((f) => f.findingId === 'memory-hygiene/bundle-over-budget');
      expect(over).toBeDefined();
      expect(over.severity).toBe('warning');
      expect(r.data.totalBytes).toBeGreaterThan(r.data.budgetBytes);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the unindexed-memory signal to workflow-maturity (no duplicate finding)', async () => {
    const r = await run(fixture('memory-unindexed'));
    expect(r.score).not.toBe(NOT_APPLICABLE_SCORE);
    const ids = r.findings.map((f) => f.findingId || f.severity);
    expect(ids.some((id) => /orphan|index/i.test(id))).toBe(false);
  });

  it('reads the budget from config.memoryHygiene.budgetBytes', async () => {
    const dir = tmpMemoryDir();
    const note = `# Deploy\n\n${'Roll back with the previous tag when the smoke test fails. '.repeat(20)}\n`;
    fs.writeFileSync(path.join(dir, '.claude/memory/deploy.md'), note);
    try {
      // Well under the 40,000-byte default — silent unless the budget is lowered.
      const dflt = await run(dir);
      expect(dflt.findings.find((f) => f.findingId === 'memory-hygiene/bundle-over-budget')).toBeUndefined();
      expect(dflt.data.budgetBytes).toBe(40_000);

      const tight = await run(dir, { config: { memoryHygiene: { budgetBytes: 500 } } });
      const over = tight.findings.find((f) => f.findingId === 'memory-hygiene/bundle-over-budget');
      expect(over).toBeDefined();
      expect(over.severity).toBe('warning');
      expect(tight.data.budgetBytes).toBe(500);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges a memoryHygiene budget from .rigscorerc.json instead of dropping it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-cfg-'));
    try {
      fs.writeFileSync(
        path.join(dir, '.rigscorerc.json'),
        JSON.stringify({ memoryHygiene: { budgetBytes: 80_000 } }),
      );
      const config = await loadConfig(dir, null);
      expect(config.memoryHygiene.budgetBytes).toBe(80_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('memory-hygiene: single home per rule', () => {
  // A project with a governance file and a memory dir. `rules` is written into
  // CLAUDE.md, `memory` into .claude/memory/notes.md.
  function tmpGoverned(claudeMd, memoryMd) {
    const dir = tmpMemoryDir();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
    fs.writeFileSync(path.join(dir, '.claude/memory/notes.md'), memoryMd);
    return dir;
  }

  const dupes = (r) => r.findings.filter((f) => f.findingId === 'memory-hygiene/duplicate-rule');

  it('flags a rule stated in both a governance file and a memory file', async () => {
    const rule = 'Never merge a pull request yourself — emit the merge command for the operator.';
    const dir = tmpGoverned(
      `# CLAUDE.md\n\n## Git\n\n- **${rule}**\n`,
      `# Merge policy\n\nThe 2026-03 incident: an agent self-merged a red-CI PR.\n\n${rule}\n`,
    );
    try {
      const r = await run(dir);
      const found = dupes(r);
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('info');
      expect(found[0].detail).toContain('CLAUDE.md');
      expect(found[0].detail).toContain('notes.md');
      expect(r.data.duplicateRules).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent on paraphrases — the bar is near-exact, not fuzzy', async () => {
    const dir = tmpGoverned(
      '# CLAUDE.md\n\n- Never merge a pull request yourself; emit the merge command for the operator.\n',
      '# Merge policy\n\nThe operator merges every pull request by hand, so the agent must not merge one.\n',
    );
    try {
      expect(dupes(await run(dir))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores headings, code fences, link-only lines, and short boilerplate', async () => {
    const shared = [
      '## Rules',
      '',
      '- Never.',
      '- [Merge policy](merge.md)',
      '',
      '```bash',
      'gh pr create --base main --title "fix: the thing that broke the deploy pipeline"',
      '```',
      '',
    ].join('\n');
    const dir = tmpGoverned(`# CLAUDE.md\n\n${shared}`, `# Notes\n\n${shared}`);
    try {
      expect(dupes(await run(dir))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches through bullet, emphasis, and punctuation differences', async () => {
    const dir = tmpGoverned(
      '# CLAUDE.md\n\n1. **Staging never lives on `/tmp`** — tmpfs is wiped on reboot, and a run loses hours of encode.\n',
      '# Staging\n\n- Staging never lives on /tmp: tmpfs is wiped on reboot and a run loses hours of encode\n',
    );
    try {
      expect(dupes(await run(dir))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a rule duplicated in a nested governance file, not just the root set', async () => {
    const rule = 'Every pull request stays under three hundred changed lines, insertions plus deletions.';
    const dir = tmpMemoryDir();
    fs.mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages/api/CLAUDE.md'), `# API rules\n\n- ${rule}\n`);
    fs.writeFileSync(
      path.join(dir, '.claude/memory/notes.md'),
      `# Diff cap\n\nThe 2026-04 revert: a 900-line PR shipped a regression nobody could bisect.\n\n${rule}\n`,
    );
    try {
      const found = dupes(await run(dir));
      expect(found).toHaveLength(1);
      expect(found[0].detail).toContain(path.join('packages', 'api', 'CLAUDE.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A governance file nested past the walk's depth cap is a SILENT give-up unless
  // depthTruncated is honoured — the same sibling-cap gap the file cap already
  // discloses. Fires the SAME finding id, never a silent "clean bill of health".
  it('discloses a depth-truncated governance walk (same finding id)', async () => {
    const dir = tmpMemoryDir();
    // A memory file keeps the check out of N/A so the walk actually runs.
    fs.writeFileSync(
      path.join(dir, '.claude/memory/notes.md'),
      '# Notes\n\nAn operational note worth keeping across sessions.\n',
    );
    // Nest a governance CLAUDE.md deeper than the default maxDepth of 50.
    let deep = dir;
    for (let i = 0; i < 55; i++) deep = path.join(deep, `lvl${i}`);
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'CLAUDE.md'), '# Deep gov\n\n- a rule past the depth cap\n');
    try {
      const r = await run(dir);
      const capped = r.findings.find((f) => f.findingId === 'memory-hygiene/governance-file-cap-reached');
      expect(capped, 'a governance file past the depth cap must surface the truncation finding').toBeDefined();
      expect(capped.severity).toBe('info');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sees a rule duplicated in home governance only when home is opted in', async () => {
    const rule = 'Never merge a pull request yourself — emit the merge command for the operator.';
    const home = tmpMemoryDir();
    fs.writeFileSync(path.join(home, '.claude/CLAUDE.md'), `# Global\n\n- ${rule}\n`);
    const dir = tmpMemoryDir();
    fs.writeFileSync(
      path.join(dir, '.claude/memory/notes.md'),
      `# Merge policy\n\nThe 2026-03 incident: an agent self-merged a red-CI PR.\n\n${rule}\n`,
    );
    try {
      expect(dupes(await run(dir, { homedir: home }))).toHaveLength(0);
      const on = dupes(await run(dir, { homedir: home, includeHomeSkills: true }));
      expect(on).toHaveLength(1);
      expect(on[0].detail).toContain('~/.claude/CLAUDE.md');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores governance files inside dependency and fixture trees', async () => {
    const rule = 'Every pull request stays under three hundred changed lines, insertions plus deletions.';
    const dir = tmpMemoryDir();
    for (const sub of ['node_modules/some-pkg', 'test/fixtures/demo']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
      fs.writeFileSync(path.join(dir, sub, 'CLAUDE.md'), `# Vendored\n\n- ${rule}\n`);
    }
    fs.writeFileSync(path.join(dir, '.claude/memory/notes.md'), `# Diff cap\n\nWhy: the 2026-04 revert.\n\n${rule}\n`);
    try {
      expect(dupes(await run(dir))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches a rule hard-wrapped across two lines against its single-line home', async () => {
    const dir = tmpGoverned(
      '# CLAUDE.md\n\n- Never merge a pull request yourself — emit the merge command for the operator.\n',
      '# Merge policy\n\nThe 2026-03 incident.\n\n- Never merge a pull request yourself — emit the merge\n  command for the operator.\n',
    );
    try {
      expect(dupes(await run(dir))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never glues two separate bullets into one rule', async () => {
    const dir = tmpGoverned(
      '# CLAUDE.md\n\n- Run the full test suite before you push, and never merge a pull request yourself.\n',
      '# Notes\n\n- Run the full test suite before you push, and\n- never merge a pull request yourself.\n',
    );
    try {
      expect(dupes(await run(dir))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is N/A with no memory surface, and ignores home memory unless opted in', async () => {
    const home = tmpMemoryDir();
    const note = '# Note\n\nA home memory file the project scan must not reach by default.\n';
    fs.writeFileSync(path.join(home, '.claude/memory/note.md'), note);
    try {
      const off = await run(fixture('claude-none'), { homedir: home });
      expect(off.score).toBe(NOT_APPLICABLE_SCORE);
      expect(off.data.memoryFiles).toBe(0);
      expect(off.data.homeScanned).toBe(false);
      const on = await run(fixture('claude-none'), { homedir: home, includeHomeSkills: true });
      expect(on.data.memoryFiles).toBe(1);
      expect(on.data.homeScanned).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('memory-hygiene: unresolvable index entries', () => {
  // Writes MEMORY.md into `.claude/memory/`, plus any extra files given as
  // { relative/path.md: content } against the project root.
  function tmpIndexed(index, extra = {}) {
    const dir = tmpMemoryDir();
    fs.writeFileSync(path.join(dir, '.claude/memory/MEMORY.md'), index);
    for (const [rel, body] of Object.entries(extra)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    return dir;
  }

  const NOTE = '# Deploy\n\nStaging rolls out before production; roll back with the previous tag.\n';
  const bad = (r) => r.findings.filter((f) => f.findingId === 'memory-hygiene/unresolvable-index-entry');

  it('flags an index entry whose target escapes the memory directory', async () => {
    const dir = tmpIndexed('# Index\n- [Deploy](../../notes/deploy.md) — rollout order.\n', {
      'notes/deploy.md': NOTE,
    });
    try {
      const found = bad(await run(dir));
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('info'); // the file exists, it is just never bundled
      expect(found[0].evidence).toContain('../../notes/deploy.md');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags an absolute-path index entry as outside the memory directory', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-out-'));
    const abs = path.join(outside, 'deploy.md');
    fs.writeFileSync(abs, NOTE);
    const dir = tmpIndexed(`# Index\n- [Deploy](${abs})\n`);
    try {
      expect(bad(await run(dir))).toHaveLength(1);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a dead index entry — the memory it names does not exist', async () => {
    const dir = tmpIndexed('# Index\n- [Rollback](rollback.md) — the incident.\n');
    try {
      const found = bad(await run(dir));
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning'); // nothing to load at all
      expect(found[0].detail).toContain('rollback.md');
      expect(found[0].title).not.toContain('outside');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent on a live in-dir link, an anchored link, and an external URL', async () => {
    const dir = tmpIndexed(
      [
        '# Index',
        '- [Deploy](deploy.md) — rollout order.',
        '- [Section](deploy.md#rollback) — anchored into the same file.',
        '- [Upstream docs](https://example.com/memory.md) — an external reference.',
        '- [Runbook](../../ops/run.sh) — not a markdown topic file.',
        '',
        '```markdown',
        '- [Template](TEMPLATE.md) — an example inside a fence, not an entry.',
        '```',
        '',
      ].join('\n'),
      { '.claude/memory/deploy.md': NOTE },
    );
    try {
      expect(bad(await run(dir))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays silent on a [[wikilink]] forward-reference to a memory not yet written', async () => {
    // Agent-memory prose legitimately forward-references a memory that has no file
    // yet ([[feedback_x]] in CLAUDE.md/MEMORY.md). Calling that a dead entry is a
    // false positive on a convention the ecosystem allows, so wikilinks are not
    // index entries at all — only markdown links are.
    const dir = tmpIndexed('# Index\n- [Deploy](deploy.md)\n- See also [[not_written_yet]].\n', {
      '.claude/memory/deploy.md': NOTE,
    });
    try {
      expect(bad(await run(dir))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a root MEMORY.md that indexes files beside it or in the memory dir', async () => {
    const dir = tmpMemoryDir();
    fs.writeFileSync(path.join(dir, '.claude/memory/deploy.md'), NOTE);
    fs.writeFileSync(path.join(dir, 'rollback.md'), NOTE);
    fs.writeFileSync(
      path.join(dir, 'MEMORY.md'),
      '# Index\n- [Deploy](.claude/memory/deploy.md)\n- [Rollback](rollback.md)\n',
    );
    try {
      expect(bad(await run(dir))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
