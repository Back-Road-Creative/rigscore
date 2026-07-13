import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  verifyCheckDocs, formatVerifyResult, extractRuleIds, extractDocumentedRuleIds, REQUIRED_SECTIONS,
} from '../src/lib/verify-docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKS = path.resolve(__dirname, '..', 'src', 'checks');
const realCheck = (id) => fs.readFileSync(path.join(CHECKS, `${id}.js`), 'utf8');

const roots = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

/** Build a fixture repo with one check + its doc page, and run the gate on it. */
function gate(id, source, triggers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-ruleids-'));
  roots.push(root);
  const checksDir = path.join(root, 'src', 'checks');
  const docsDir = path.join(root, 'docs', 'checks');
  fs.mkdirSync(checksDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(checksDir, `${id}.js`), source);
  const page = [`# ${id}`, ''];
  for (const s of REQUIRED_SECTIONS) {
    page.push(`## ${s}`, s === 'Triggers' ? triggers : `Body for ${s}. Weight 8.`, '');
  }
  fs.writeFileSync(path.join(docsDir, `${id}.md`), page.join('\n'));
  return verifyCheckDocs({ root, checksDir, docsDir, weights: {} });
}

const reasons = (r) => r.ruleIdOffenders.map((o) => `${o.reason}:${o.ruleId}`);

describe('extractRuleIds() — every findingId shape the real checks use', () => {
  it.each([
    ['plain literal', `findingId: 'foo/plain',`, ['foo/plain']],
    ['inline ternary (credential-storage)', `findingId: x ? 'foo/a' : 'foo/b',`, ['foo/a', 'foo/b']],
    ['nested ternary on a const (env-exposure)', `const findingId = c ? 'foo/x' : e ? 'foo/y' : 'foo/z';`, ['foo/x', 'foo/y', 'foo/z']],
    ['lookup table (spec-goals)', `const T = [{ findingId: 'foo/t', severity: 'info' }];`, ['foo/t']],
    ['|| fallback (coherence)', `findingId: p.findingId || 'foo/fb',`, ['foo/fb']],
    ['fixer findingIds array', `const fixes = [{ findingIds: ['foo/fix'] }];`, ['foo/fix']],
    ['ignores comments + foreign prefixes', `// findingId: 'foo/g'\n/* findingId: 'foo/b' */\nfindingId: 'foo/real', p: 'docs/checks/foo.md',`, ['foo/real']],
  ])('%s', (_n, src, expected) => {
    expect(extractRuleIds(src, 'foo').literals).toEqual(expected);
  });

  it('interpolated template becomes a prefix, not a literal', () => {
    expect(extractRuleIds('findingId: `foo/esc-${id}`,', 'foo')).toEqual({ literals: [], prefixes: ['foo/esc-'] });
  });

  it('is blind to no real check module', () => {
    const blind = fs
      .readdirSync(CHECKS)
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .map((f) => path.basename(f, '.js'))
      .filter((id) => {
        const { literals, prefixes } = extractRuleIds(realCheck(id), id);
        return !literals.length && !prefixes.length;
      });
    expect(blind, `extractor sees no ids in: ${blind.join(', ')}`).toEqual([]);
  });

  it('documented ids: own-namespace backticks only; a row with no id yields none', () => {
    expect(extractDocumentedRuleIds('`foo/one` `foo/two` `bar/x` `docs/checks/foo.md`', 'foo')).toEqual(['foo/one', 'foo/two']);
    expect(extractDocumentedRuleIds('| skipped on Windows | N/A | — (no ruleId) |', 'foo')).toEqual([]);
  });
});

describe('verifyCheckDocs() — ruleId gate', () => {
  it('clean page passes', async () => {
    const r = await gate('foo', `findingId: 'foo/only',`, '| c | CRITICAL | `foo/only` | fix |');
    expect(r.ruleIdOffenders).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['ghost — docs invented an id the source never emits', `findingId: 'foo/real',`,
      '`foo/real` `foo/fake`', ['ruleid-ghost:foo/fake'], 'RULEID-GHOST'],
    ['undocumented — source emits a literal the page never lists', `findingId: 'foo/a', findingId: 'foo/b',`,
      '`foo/a`', ['ruleid-undocumented:foo/b'], 'RULEID-UNDOCUMENTED'],
    ['bare `<check-id>/` prefix is a hard error, never a vacuous pass', 'findingId: `foo/${rule.id}`,',
      '`foo/anything-at-all`', ['ruleid-unexpandable:foo/${...}', 'ruleid-ghost:foo/anything-at-all'], 'pass vacuously'],
    ['un-expandable non-bare prefix is UNVERIFIED, not silently passed', 'findingId: `foo/esc-${p}`,',
      '`foo/esc-whatever`', ['ruleid-unverified:foo/esc-whatever'], 'NOT verified'],
  ])('%s', async (_n, source, triggers, expected, text) => {
    const r = await gate('foo', source, `| c | W | ${triggers} | fix |`);
    expect(r.ok).toBe(false);
    expect(reasons(r).sort()).toEqual(expected.sort());
    expect(formatVerifyResult(r)).toContain(text);
  });
});

describe('dynamic ids expand to their real value set (the missing-tdd bug class)', () => {
  const row = (id) => `| c | WARNING | \`${id}\` | fix |`;
  // A real id vs. a fake one that shares its dynamic prefix. Prefix-matching alone
  // would pass every "fake" here — that is the hole these expanders close.
  it.each([
    ['claude-md', 'missing-test-driven-development', 'missing-tdd'],
    ['sandbox-posture', 'codex-no-sandbox', 'not-a-rule'],
    ['ci-agent-caps', 'agent-job-missing-turn-cap', 'agent-job-missing-everything'],
    ['skill-files', 'escalation-chmod-777', 'escalation-nope'],
    ['documentation', 'docs-gate-weight-drift', 'docs-gate-nonsense'],
  ])('%s: accepts the emitted id, rejects the prefix-only impostor', async (check, real, fake) => {
    const src = realCheck(check);
    const ok = await gate(check, src, row(`${check}/${real}`));
    expect(reasons(ok)).not.toContain(`ruleid-ghost:${check}/${real}`);
    expect(reasons(ok).some((x) => x.startsWith('ruleid-unexpandable'))).toBe(false);

    const bad = await gate(check, src, row(`${check}/${fake}`));
    expect(reasons(bad)).toContain(`ruleid-ghost:${check}/${fake}`);
  });
});
