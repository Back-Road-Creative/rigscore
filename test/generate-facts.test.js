import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateFacts } from '../scripts/generate-facts.js';
import { WEIGHTS, FRAMEWORKS } from '../src/constants.js';
import { CLIENTS } from '../src/clients.js';

// Self-gate: the emitted facts MUST equal the live registry. If a check is
// added/renamed/removed and the facts drift, this goes red — the whole point of
// the emitter is that hand-maintained counts can no longer silently rot.
describe('generate-facts', () => {
  const facts = generateFacts();

  it('check count equals WEIGHTS entries', async () => {
    expect((await facts).checkCount).toBe(Object.keys(WEIGHTS).length);
  });

  it('every WEIGHTS id is present in the emitted checks', async () => {
    const ids = new Set((await facts).checks.map((c) => c.id));
    for (const id of Object.keys(WEIGHTS)) {
      expect(ids.has(id), `facts missing check id: ${id}`).toBe(true);
    }
  });

  it('scored count equals the number of non-zero-weight checks', async () => {
    const scored = Object.values(WEIGHTS).filter((w) => w > 0).length;
    expect((await facts).scoredCount).toBe(scored);
  });

  it('advisory count equals the number of zero-weight checks', async () => {
    const advisory = Object.values(WEIGHTS).filter((w) => w === 0).length;
    expect((await facts).advisoryCount).toBe(advisory);
  });

  it('per-check weight matches WEIGHTS for every emitted check', async () => {
    for (const c of (await facts).checks) {
      expect(c.weight, `weight mismatch for ${c.id}`).toBe(WEIGHTS[c.id] ?? 0);
    }
  });

  it('enforcement-grade split sums to the check count', async () => {
    const f = await facts;
    const sum = Object.values(f.enforcementGrades).reduce((a, b) => a + b, 0);
    expect(sum).toBe(f.checkCount);
  });

  it('version equals package.json and frameworks match FRAMEWORKS', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const f = await facts;
    expect(f.version).toBe(pkg.version);
    expect(f.frameworks.map((x) => x.id).sort()).toEqual(Object.keys(FRAMEWORKS).sort());
  });
  it('nodeFloor is the minimum version in package.json engines.node', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const floor = pkg.engines.node.match(/(\d+(?:\.\d+){0,2})/)[1];
    const f = await facts;
    expect(f.nodeFloor).toBe(floor);
    expect(f.nodeFloor).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('clientCount equals the CLIENTS registry length', async () => {
    const f = await facts;
    expect(f.clientCount).toBe(CLIENTS.length);
    expect(f.clientCount).toBeGreaterThan(0);
  });
});
