import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import documentation from '../src/checks/documentation.js';
import { REQUIRED_SECTIONS, EXPANDERS } from '../src/lib/verify-docs.js';

/**
 * First coverage of the CHECK module (src/checks/documentation.js) — the library
 * behind it was tested, the shipped check never was, and that is exactly how the
 * bug below shipped: verifyCheckDocs() folds ruleIdOffenders into `ok`, but the
 * check module only looped `offenders` and `orphans`. `npm run verify:docs` (CI)
 * caught ruleId drift; the CLI, the GitHub Action and the Docker image — every
 * consumer surface — reported a serene "All N checks documented", 100/100.
 */

const roots = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

/** Fixture repo with one check module + its doc page; returns the check's run() result. */
function runCheck(id, source, triggers) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-doccheck-'));
  roots.push(cwd);
  const checksDir = path.join(cwd, 'src', 'checks');
  const docsDir = path.join(cwd, 'docs', 'checks');
  fs.mkdirSync(checksDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(checksDir, `${id}.js`), source);
  const page = [`# ${id}`, ''];
  for (const s of REQUIRED_SECTIONS) {
    page.push(`## ${s}`, s === 'Triggers' ? triggers : `Body for ${s}. Weight 8.`, '');
  }
  fs.writeFileSync(path.join(docsDir, `${id}.md`), page.join('\n'));
  return documentation.run({ cwd });
}

const ids = (r) => r.findings.map((f) => f.findingId);
const passes = (r) => r.findings.filter((f) => f.severity === 'pass');

describe('documentation check — ruleId drift reaches the user-visible surface', () => {
  it('a ghost ruleId does NOT produce a false PASS', async () => {
    const r = await runCheck('foo', "findingId: 'foo/real',", '| c | WARNING | `foo/fake` | fix |');

    // Load-bearing: the bug's signature is a false PASS, not merely a missing warning.
    expect(passes(r), 'check reported "All N checks documented" despite ruleId drift').toEqual([]);
    expect(ids(r)).toContain('documentation/docs-gate-ruleid-ghost');
    expect(r.score).toBeLessThan(100);
  });

  it.each([
    ['ruleid-ghost', "findingId: 'foo/real',", '`foo/real` `foo/fake`', 'warning', 'foo/fake'],
    ['ruleid-undocumented', "findingId: 'foo/a', findingId: 'foo/b',", '`foo/a`', 'warning', 'foo/b'],
    ['ruleid-unexpandable', 'findingId: `foo/${rule.id}`,', 'no ids here', 'warning', 'foo/${...}'],
    ['ruleid-unverified', 'findingId: `foo/esc-${p}`,', '`foo/esc-whatever`', 'info', 'foo/esc-whatever'],
  ])('%s → a finding, never a pass', async (reason, source, triggers, severity, ruleId) => {
    const r = await runCheck('foo', source, `| c | W | ${triggers} | fix |`);

    const f = r.findings.find((x) => x.findingId === `documentation/docs-gate-${reason}`);
    expect(f, `no ${reason} finding; got ${JSON.stringify(ids(r))}`).toBeDefined();
    expect(f.severity).toBe(severity);
    expect(f.detail).toContain(ruleId);
    expect(passes(r)).toEqual([]);
  });

  it('a page whose ids match the module still PASSes (the fix must not over-fire)', async () => {
    const r = await runCheck('foo', "findingId: 'foo/only',", '| c | WARNING | `foo/only` | fix |');

    expect(r.findings.map((f) => f.severity)).toEqual(['pass']);
    expect(r.score).toBe(100);
  });

  /**
   * The trap in the naive fix. EXPANDERS.documentation enumerates this check's own
   * legal ruleIds by scraping `case '…':` labels out of `function reasonLabel`. Add the
   * loop without the case labels and the new ids are unenumerable: documenting them is
   * rejected as a ghost, and NOT documenting them leaves the gate vacuously green.
   */
  it('every reason ruleIdDrift emits is enumerable via reasonLabel (self-hosting)', () => {
    const src = fs.readFileSync(new URL('../src/checks/documentation.js', import.meta.url), 'utf8');
    // The expander yields bare reason labels; the `documentation/docs-gate-` half of the
    // id comes from the findingId template, so a label IS the enumerable suffix.
    const enumerable = EXPANDERS.documentation(src);

    for (const reason of ['ruleid-ghost', 'ruleid-undocumented', 'ruleid-unexpandable', 'ruleid-unverified']) {
      expect(enumerable, `reasonLabel has no case '${reason}:' — its findingId is unenumerable`)
        .toContain(reason);
    }
  });
});
