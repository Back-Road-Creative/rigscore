import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/env-exposure.js';
import { scanLineForSecrets } from '../src/utils.js';

/**
 * Breadth expansion for KEY_PATTERNS — provider token formats added under the
 * existing secret finding. Each positive specimen uses the canonical shape so
 * the pattern's `\b` end-anchor + fixed quantifiers match; each negative is a
 * benign lookalike (UUID, base64 blob, too-short prefix) that a tight,
 * length-bounded pattern must NOT flag. Specimens are assembled piece-by-piece
 * from repeated chars to avoid tripping GitHub push protection.
 */

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-breadth-'));
}

async function criticalFor(value) {
  const tmpDir = makeTmpDir();
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: value }));
  try {
    const result = await check.run({ cwd: tmpDir });
    return result.findings.find(
      (f) => f.severity === 'critical' && f.title.includes('config.json'),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

// --- newly-added formats: canonical specimens ---
const ghFineGrained = ['github', 'pat', 'A'.repeat(82)].join('_'); // github_pat_ + 82
const ghServer = ['ghs', 'A'.repeat(36)].join('_'); // ghs_ + 36
const ghUser = ['ghu', 'B'.repeat(36)].join('_'); // ghu_ + 36
const ghRefresh = ['ghr', 'C'.repeat(36)].join('_'); // ghr_ + 36
const googleOAuth = 'GOCSPX' + '-' + 'A'.repeat(28); // GOCSPX- + 28
const openaiLegacy = 'sk' + '-' + 'A'.repeat(48); // sk- + 48
const shopifyAdmin = ['shpat', 'a'.repeat(32)].join('_'); // shpat_ + 32 hex
const shopifyShared = ['shpss', 'b'.repeat(32)].join('_'); // shpss_ + 32 hex
const databricks = 'dapi' + 'a'.repeat(32); // dapi + 32 hex

describe('broadened provider token patterns — positives (must be CRITICAL)', () => {
  it('detects GitHub fine-grained PAT (github_pat_)', async () => {
    expect(await criticalFor(ghFineGrained)).toBeDefined();
  });

  it('detects GitHub server-to-server token (ghs_)', async () => {
    expect(await criticalFor(ghServer)).toBeDefined();
  });

  it('detects GitHub user-to-server token (ghu_)', async () => {
    expect(await criticalFor(ghUser)).toBeDefined();
  });

  it('detects GitHub refresh token (ghr_)', async () => {
    expect(await criticalFor(ghRefresh)).toBeDefined();
  });

  it('detects Google OAuth client secret (GOCSPX-)', async () => {
    expect(await criticalFor(googleOAuth)).toBeDefined();
  });

  it('detects legacy OpenAI API key (sk- + 48)', async () => {
    expect(await criticalFor(openaiLegacy)).toBeDefined();
  });

  it('detects Shopify admin API access token (shpat_)', async () => {
    expect(await criticalFor(shopifyAdmin)).toBeDefined();
  });

  it('detects Shopify shared secret (shpss_)', async () => {
    expect(await criticalFor(shopifyShared)).toBeDefined();
  });

  it('detects Databricks PAT (dapi)', async () => {
    expect(await criticalFor(databricks)).toBeDefined();
  });
});

describe('broadened provider token patterns — negatives (benign lookalikes, must NOT match)', () => {
  const notMatched = (line) => {
    const r = scanLineForSecrets(line, line.trim());
    return r.matched;
  };

  it('does NOT flag a bare UUID (Postmark-shaped token intentionally skipped)', () => {
    expect(notMatched('token: 550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('does NOT flag a random base64 blob', () => {
    expect(notMatched('blob: dGhpcyBpcyBhIHRlc3Qgc3RyaW5nIHRoYXQgaXMgbG9uZ2Vy==')).toBe(false);
  });

  it('does NOT flag a short sk- string that is not a real key shape', () => {
    expect(notMatched('const x = "sk-not-a-real-key";')).toBe(false);
  });

  it('does NOT flag github_pat_ with a too-short suffix', () => {
    expect(notMatched('pat = "' + ['github', 'pat', 'short'].join('_') + '"')).toBe(false);
  });

  it('does NOT flag ghs_ with a too-short suffix', () => {
    expect(notMatched('t = "' + ['ghs', 'abc'].join('_') + '"')).toBe(false);
  });

  it('does NOT flag GOCSPX- with a too-short suffix', () => {
    expect(notMatched('s = "GOCSPX-short"')).toBe(false);
  });

  it('does NOT flag dapi followed by non-hex / wrong length', () => {
    expect(notMatched('v = "dapisomething-not-hex"')).toBe(false);
  });
});
