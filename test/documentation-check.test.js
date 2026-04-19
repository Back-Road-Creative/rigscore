import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { verifyCheckDocs, formatVerifyResult, REQUIRED_SECTIONS } from '../src/lib/verify-docs.js';

/**
 * Create an isolated fixture with `src/checks/` and `docs/checks/` subdirs.
 * Returns { root, checksDir, docsDir, cleanup }.
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-docs-'));
  const checksDir = path.join(root, 'src', 'checks');
  const docsDir = path.join(root, 'docs', 'checks');
  fs.mkdirSync(checksDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  return {
    root,
    checksDir,
    docsDir,
    writeCheck(id, body = 'export default {};\n') {
      fs.writeFileSync(path.join(checksDir, `${id}.js`), body);
    },
    writeDoc(id, body) {
      fs.writeFileSync(path.join(docsDir, `${id}.md`), body);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Build a doc body with all required H2 sections filled in.
 * @param {string} id
 * @param {object} opts
 * @param {string} [opts.weightLine] - line inserted under "## Weight rationale"
 * @param {string[]} [opts.omit]     - section names to omit entirely
 * @param {string[]} [opts.empty]    - section names to leave empty (heading only)
 * @param {string}   [opts.h1]       - override the H1 (default `# <id>`)
 */
function buildDoc(id, opts = {}) {
  const { weightLine = 'This is weight 8.', omit = [], empty = [], h1 = `# ${id}` } = opts;
  const parts = [h1, ''];
  for (const section of REQUIRED_SECTIONS) {
    if (omit.includes(section)) continue;
    parts.push(`## ${section}`);
    if (empty.includes(section)) {
      parts.push('');
      continue;
    }
    if (section === 'Weight rationale') {
      parts.push(weightLine);
    } else {
      parts.push(`Body text for ${section}.`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

describe('verifyCheckDocs() — pure library', () => {
  it('1. clean fixture passes', async () => {
    const fx = makeFixture();
    try {
      fx.writeCheck('foo');
      fx.writeDoc('foo', buildDoc('foo', { weightLine: 'This check carries weight 8.' }));

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: { foo: 8 },
      });

      expect(result.ok).toBe(true);
      expect(result.offenders.length).toBe(0);
      expect(result.orphans.length).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('2. missing doc is flagged', async () => {
    const fx = makeFixture();
    try {
      fx.writeCheck('bar');

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: { bar: 6 },
      });

      expect(result.ok).toBe(false);
      const miss = result.offenders.find((o) => o.id === 'bar');
      expect(miss).toBeDefined();
      expect(miss.reason).toBe('missing');
    } finally {
      fx.cleanup();
    }
  });

  it('3. incomplete doc (missing section) is flagged', async () => {
    const fx = makeFixture();
    try {
      fx.writeCheck('baz');
      fx.writeDoc('baz', buildDoc('baz', { omit: ['Fix semantics'] }));

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: { baz: 8 },
      });

      const inc = result.offenders.find((o) => o.id === 'baz' && o.reason === 'incomplete');
      expect(inc).toBeDefined();
      expect(inc.missingSections).toContain('Fix semantics');
    } finally {
      fx.cleanup();
    }
  });

  it('4. empty section body is flagged as incomplete', async () => {
    const fx = makeFixture();
    try {
      fx.writeCheck('qux');
      fx.writeDoc('qux', buildDoc('qux', { empty: ['Purpose'] }));

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: { qux: 8 },
      });

      const inc = result.offenders.find((o) => o.id === 'qux' && o.reason === 'incomplete');
      expect(inc).toBeDefined();
      expect(inc.missingSections).toContain('Purpose');
    } finally {
      fx.cleanup();
    }
  });

  it('5. H1 mismatch is flagged', async () => {
    const fx = makeFixture();
    try {
      fx.writeCheck('qux');
      fx.writeDoc('qux', buildDoc('qux', { h1: '# wrong' }));

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: { qux: 8 },
      });

      const mis = result.offenders.find((o) => o.id === 'qux' && o.reason === 'h1-mismatch');
      expect(mis).toBeDefined();
      expect(mis.got).toBe('wrong');
    } finally {
      fx.cleanup();
    }
  });

  it('6. weight drift is flagged', async () => {
    const fx = makeFixture();
    try {
      fx.writeCheck('foo');
      // Doc states weight 8, but registered weight is 14
      fx.writeDoc('foo', buildDoc('foo', { weightLine: 'This check carries weight 8.' }));

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: { foo: 14 },
      });

      const drift = result.offenders.find((o) => o.id === 'foo' && o.reason === 'weight-drift');
      expect(drift).toBeDefined();
      expect(drift.expectedWeight).toBe(14);
    } finally {
      fx.cleanup();
    }
  });

  it('7. advisory (weight 0) accepts "advisory" phrasing', async () => {
    const fx = makeFixture();
    try {
      fx.writeCheck('adv');
      fx.writeDoc('adv', buildDoc('adv', { weightLine: 'This is advisory — weight 0.' }));

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: { adv: 0 },
      });

      expect(result.ok).toBe(true);
      expect(result.offenders.length).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('8. orphan doc is listed in orphans', async () => {
    const fx = makeFixture();
    try {
      // no zombie.js, but zombie.md exists
      fx.writeDoc('zombie', buildDoc('zombie'));

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: {},
      });

      expect(result.orphans).toContain('zombie');
      expect(result.ok).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it('9. src/checks/index.js is excluded', async () => {
    const fx = makeFixture();
    try {
      fs.writeFileSync(path.join(fx.checksDir, 'index.js'), 'export default {};\n');

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: {},
      });

      // index should not trigger a "missing" offender
      expect(result.offenders.find((o) => o.id === 'index')).toBeUndefined();
      expect(result.ok).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('10. docs starting with `_` are excluded from orphans', async () => {
    const fx = makeFixture();
    try {
      fx.writeDoc('_template', '# _template\n\nTemplate body.\n');

      const result = await verifyCheckDocs({
        root: fx.root,
        checksDir: fx.checksDir,
        docsDir: fx.docsDir,
        weights: {},
      });

      expect(result.orphans).not.toContain('_template');
      expect(result.ok).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

describe('formatVerifyResult()', () => {
  it('11. OK result renders "docs-gate: OK"', () => {
    const result = {
      ok: true,
      offenders: [],
      orphans: [],
      counts: { checks: 3, docs: 3, offenders: 0, orphans: 0 },
    };
    const out = formatVerifyResult(result, { scriptName: 'verify:docs' });
    expect(out).toContain('docs-gate: OK');
  });

  it('12. missing offender renders MISSING and a stub hint with the id', () => {
    const result = {
      ok: false,
      offenders: [{ id: 'bar', reason: 'missing', docPath: '/x/docs/checks/bar.md' }],
      orphans: [],
      counts: { checks: 1, docs: 0, offenders: 1, orphans: 0 },
    };
    const out = formatVerifyResult(result, { scriptName: 'verify:docs' });
    expect(out).toContain('MISSING');
    expect(out).toContain('bar');
    expect(out).toMatch(/--stub bar/);
  });

  it('13. orphan renders ORPHAN', () => {
    const result = {
      ok: false,
      offenders: [],
      orphans: ['zombie'],
      counts: { checks: 0, docs: 1, offenders: 0, orphans: 1 },
    };
    const out = formatVerifyResult(result, { scriptName: 'verify:docs' });
    expect(out).toContain('ORPHAN');
    expect(out).toContain('zombie');
  });
});

describe('CLI script (scripts/verify-docs.js) — smoke', () => {
  // E2's scripts/verify-docs.js hardcodes REPO_ROOT from its own file path
  // (see scripts/verify-docs.js line 14) and exposes no --cwd / --root flag.
  // Running it against a synthetic tmp fixture is therefore not possible
  // without copying or patching the script, which is out of scope for E3.
  // The main session will swap these skips for real tests (or fold into an
  // integration suite) once a portable invocation path exists.

  it.skip('14. dirty fixture exits 1 — TODO: needs --cwd/--root on scripts/verify-docs.js', () => {
    // Intentionally skipped. See describe block comment.
  });

  it.skip('15. --stub <id> creates doc from template — TODO: needs --cwd/--root on scripts/verify-docs.js', () => {
    // Intentionally skipped. See describe block comment.
  });
});
