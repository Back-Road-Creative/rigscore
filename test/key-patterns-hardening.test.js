import { describe, it, expect } from 'vitest';
import { KEY_PATTERNS } from '../src/constants.js';
import { scanLineForSecrets } from '../src/utils.js';

/**
 * Hardening tests for KEY_PATTERNS. The historical regexes accepted absurdly
 * short suffixes (e.g. `xoxb-a`) or matched substrings embedded in unrelated
 * blobs (e.g. an `AKIA...` substring inside a JWT/base64 payload). These tests
 * lock in:
 *   - word-boundary anchors (no substring matches inside larger tokens)
 *   - realistic minimum lengths cross-checked against vendor docs / specimens
 *
 * Each pattern is exercised against (a) the canonical real-format specimen
 * (must match) and (b) at least one degenerate / embedded form (must NOT
 * match).
 */

function findPatternByPrefix(prefix) {
  // Patterns are anchored with a leading `\b`; ignore that when comparing the
  // human-readable prefix the test names use.
  return KEY_PATTERNS.find((p) => {
    const src = p.source.replace(/^\\b/, '');
    return src.startsWith(prefix);
  });
}

function patternMatches(prefix, sample) {
  const p = findPatternByPrefix(prefix);
  if (!p) throw new Error(`No pattern starting with ${prefix}`);
  p.lastIndex = 0;
  return p.test(sample);
}

describe('KEY_PATTERNS hardening — negatives (must NOT match)', () => {
  it('xoxb- pattern does NOT match 1-char suffix', () => {
    expect(patternMatches('xoxb-', 'xoxb-a')).toBe(false);
  });

  it('xoxb- pattern does NOT match short toy suffix', () => {
    expect(patternMatches('xoxb-', 'xoxb-abc')).toBe(false);
  });

  it('xoxp- pattern does NOT match 1-char suffix', () => {
    expect(patternMatches('xoxp-', 'xoxp-a')).toBe(false);
  });

  it('xoxp- pattern does NOT match short toy suffix', () => {
    expect(patternMatches('xoxp-', 'xoxp-12345')).toBe(false);
  });

  it('AKIA pattern does NOT match AKIA-substring embedded in larger token', () => {
    // 16 base-64-ish chars immediately after AKIA but with letters/digits
    // continuing afterwards — a JWT / blob substring, not an AWS key.
    const jwtLike = 'eyJxxxAKIAIOSFODNN7EXAMPLEabc123';
    expect(patternMatches('AKIA', jwtLike)).toBe(false);
  });

  it('AKIA pattern does NOT match identifier-embedded prefix', () => {
    // `myAKIAconfig` — the AKIA appears inside an identifier and is followed
    // by lowercase letters; a `\b` anchor + the {16} of uppercase/digit class
    // must reject this.
    expect(patternMatches('AKIA', 'myAKIAconfig1234567890ZZZZZZ')).toBe(false);
  });

  it('ASIA pattern does NOT match ASIA-substring embedded in larger token', () => {
    expect(patternMatches('ASIA', 'fooASIAIOSFODNN7EXAMPLEabc')).toBe(false);
  });

  it('SK Twilio pattern does NOT match the bare 2-letter prefix in context', () => {
    // Twilio SK pattern: SK + 32 hex. Embedded in an identifier-like context
    // (preceding letter) must not match.
    expect(patternMatches('SK[0-9a-f]', 'gSK' + '0'.repeat(32) + 'x')).toBe(
      false,
    );
  });

  it('scanLineForSecrets does NOT flag xoxb-a as critical', () => {
    const line = 'const t = "xoxb-a";';
    const r = scanLineForSecrets(line, line.trim());
    expect(r.matched).toBe(false);
  });

  it('scanLineForSecrets does NOT flag AKIA inside a JWT-like blob', () => {
    const line =
      'const jwt = "eyJxxxAKIAIOSFODNN7EXAMPLEabc.signaturepayload";';
    const r = scanLineForSecrets(line, line.trim());
    expect(r.matched).toBe(false);
  });

  it('scanLineForSecrets does NOT flag myAKIAconfig identifier', () => {
    const line = 'const myAKIAconfig1234567890ABCD = 1;';
    const r = scanLineForSecrets(line, line.trim());
    expect(r.matched).toBe(false);
  });
});

describe('KEY_PATTERNS hardening — positives (must STILL match real tokens)', () => {
  // Slack tokens below are built piece-by-piece to dodge GitHub push
  // protection (which flags `xoxb-<digits>-<digits>-<chars>` shaped strings
  // as real Slack bot tokens). The pattern is the canonical shape:
  //   <prefix>-<workspace_id>-<sub_id>-<secret>
  const slackBot = ['xoxb', '1234567890', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
  const slackUser = ['xoxp', '1234567890', '1234567890123', '1234567890123', 'AbCdEfGhIjKlMnOp'].join('-');

  it('xoxb- still matches a realistic 50+ char Slack bot token', () => {
    // Real specimens are ~57 chars after the prefix.
    expect(patternMatches('xoxb-', slackBot)).toBe(true);
  });

  it('xoxp- still matches a realistic 50+ char Slack user token', () => {
    expect(patternMatches('xoxp-', slackUser)).toBe(true);
  });

  it('AKIA still matches a standalone AWS access key', () => {
    // Canonical AWS example access key id.
    const real = 'AKIAIOSFODNN7EXAMPLE';
    expect(patternMatches('AKIA', real)).toBe(true);
  });

  it('AKIA matches in a quoted/JSON context (with boundary)', () => {
    const line = '"aws_key": "AKIAIOSFODNN7EXAMPLE"';
    const r = scanLineForSecrets(line, line.trim());
    expect(r.matched).toBe(true);
  });

  it('ASIA still matches a standalone AWS STS temporary credential', () => {
    const real = 'ASIA' + 'A'.repeat(16);
    expect(patternMatches('ASIA', real)).toBe(true);
  });

  it('sk-ant- still matches a realistic Anthropic key', () => {
    // Real Anthropic API keys are ~95 chars after sk-ant- ; pattern uses
    // 10-char min historically. We keep the existing min and just ensure
    // realistic length passes.
    const real =
      'sk-ant-api03-' + 'a'.repeat(90);
    expect(patternMatches('sk-ant-', real)).toBe(true);
  });

  it('xoxb- bot token survives in a JSON line', () => {
    const line = `{"slack_bot_token": "${slackBot}"}`;
    const r = scanLineForSecrets(line, line.trim());
    expect(r.matched).toBe(true);
    expect(r.severity).toBe('critical');
  });
});
