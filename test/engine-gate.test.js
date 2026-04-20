import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, '..', 'package.json');

/**
 * E6 (Track E): guard the Node engine floor established by Track B
 * (distribution integrity). Track B bumped engines.node to 18.17+ to
 * unlock `fs.cp`, `structuredClone`, top-level async iterators in
 * streams, and stable test-runner APIs. A future "fix a CI weirdness by
 * dropping the bump" is exactly the kind of regression this gate exists
 * to catch.
 */
describe('E6: Node engine gate', () => {
  it('package.json declares engines.node starting with ">=18.17"', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    expect(pkg.engines, 'package.json missing engines field').toBeDefined();
    expect(pkg.engines.node, 'engines.node missing').toBeDefined();
    expect(
      pkg.engines.node.startsWith('>=18.17'),
      `expected engines.node to start with ">=18.17", got "${pkg.engines.node}"`,
    ).toBe(true);
  });

  it('the Node process running the tests satisfies engines.node', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const declared = pkg.engines?.node || '';
    // Parse the minimum major/minor from the declared range. We accept any
    // leading ">=" or ">" bound. Minor defaults to 0.
    const m = declared.match(/^\s*>=?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    expect(m, `could not parse engines.node="${declared}"`).not.toBeNull();
    const minMajor = parseInt(m[1], 10);
    const minMinor = m[2] ? parseInt(m[2], 10) : 0;
    const minPatch = m[3] ? parseInt(m[3], 10) : 0;

    const v = process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)/);
    expect(v, `could not parse process.versions.node="${process.versions.node}"`).not.toBeNull();
    const [curMajor, curMinor, curPatch] = [
      parseInt(v[1], 10), parseInt(v[2], 10), parseInt(v[3], 10),
    ];

    const satisfies =
      curMajor > minMajor ||
      (curMajor === minMajor && curMinor > minMinor) ||
      (curMajor === minMajor && curMinor === minMinor && curPatch >= minPatch);

    expect(
      satisfies,
      `Node ${process.versions.node} does not satisfy engines.node ${declared}`,
    ).toBe(true);
  });
});
