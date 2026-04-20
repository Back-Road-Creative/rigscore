import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { USER_AGENT } from '../src/http.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

describe('http User-Agent', () => {
  it('advertises the installed package.json version', () => {
    expect(USER_AGENT).toContain(`rigscore/${pkg.version}`);
  });

  it('includes the project URL for host operators', () => {
    expect(USER_AGENT).toContain('https://github.com/Back-Road-Creative/rigscore');
  });

  it('is not pinned to a stale hardcoded version string', () => {
    // Guard against regressions to the old `rigscore/0.8.0` hardcoded UA.
    // If the real version happens to be 0.8.0, drop this assertion — for now
    // package.json is 1.0.0, so any occurrence of 0.8.0 is a bug.
    expect(USER_AGENT).not.toContain('rigscore/0.8.0');
  });
});
