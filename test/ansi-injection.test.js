import { describe, it, expect } from 'vitest';
import { formatTerminal, formatTerminalRecursive, stripAnsi } from '../src/reporter.js';
import { formatSarif } from '../src/sarif.js';

// Malicious payloads a skill file / docker-compose / config could embed.
// Each represents a terminal escape that would normally execute if printed
// raw to a reviewer's xterm-compatible terminal.
const PAYLOADS = {
  sgrColor: '\x1b[31mBLOODRED\x1b[0m',             // SGR (colour)
  clearScreen: '\x1b[2J',                           // CSI 2J — clear screen
  cursorHome: '\x1b[H',                             // CSI H — cursor home
  osc8Hyperlink: '\x1b]8;;https://evil.example/\x07CLICK\x1b]8;;\x07', // OSC 8
  oscSetTitle: '\x1b]0;PWNED\x07',                  // OSC 0 — window title
  bel: 'BELL\x07HERE',                              // BEL
  backspace: 'backspace\x08rewrite',                // BS
  c1Escape: '\x1bDdanger',                          // 7-bit C1 escape (IND)
  strCsiFinal: '\x1b[?25l',                         // hide cursor (private CSI)
};

function buildResultWithMaliciousFinding(payload) {
  return {
    score: 50,
    results: [
      {
        id: 'skill-files',
        name: 'Skill file safety',
        weight: 10,
        score: 40,
        findings: [
          {
            severity: 'critical',
            title: `bad skill ${payload}`,
            detail: `detail ${payload}`,
            evidence: `evidence ${payload}`,
            remediation: `fix ${payload}`,
            learnMore: `https://x/${payload}`,
          },
        ],
      },
    ],
  };
}

function assertNoEscapeSurvives(output) {
  // No raw ESC (0x1B) may remain. chalk wrap is fine (those are SGR sequences
  // applied by the reporter itself around our own tokens), so we assert the
  // INJECTED payload is gone — not that output is literally escape-free.
  // Concretely: no CSI private/final bytes we didn't emit, no OSC, no BEL,
  // no BS, no bare C1 escapes.
  expect(output).not.toMatch(/\x1b\[2J/);
  expect(output).not.toMatch(/\x1b\[H(?![0-9])/);
  expect(output).not.toMatch(/\x1b\][^\x07\x1b]*\x07/); // OSC + BEL terminator
  expect(output).not.toMatch(/\x07/);                     // bare BEL
  expect(output).not.toMatch(/\x08/);                     // bare BS
  expect(output).not.toMatch(/\x1b[DE]/);                 // IND / NEL
  expect(output).not.toMatch(/\x1b\[\?25l/);              // hide cursor
}

describe('ANSI injection in reporter', () => {
  describe('formatTerminal', () => {
    for (const [name, payload] of Object.entries(PAYLOADS)) {
      it(`strips ${name} from finding fields`, () => {
        const result = buildResultWithMaliciousFinding(payload);
        const output = formatTerminal(result, '/tmp/x', { noCta: true });
        assertNoEscapeSurvives(output);
      });
    }
  });

  describe('formatTerminalRecursive', () => {
    it('strips malicious escapes from per-project findings', () => {
      const result = {
        score: 30,
        projects: [
          {
            path: 'proj-a',
            score: 30,
            results: [
              {
                id: 'skill-files',
                name: 'Skill file safety',
                findings: [
                  {
                    severity: 'critical',
                    title: `evil ${PAYLOADS.clearScreen}${PAYLOADS.osc8Hyperlink}`,
                    remediation: `go ${PAYLOADS.oscSetTitle}`,
                  },
                ],
              },
            ],
          },
        ],
        worstProject: {
          path: 'proj-a',
          score: 30,
        },
      };
      const output = formatTerminalRecursive(result, '/tmp/root', { noCta: true });
      assertNoEscapeSurvives(output);
    });
  });

  describe('formatSarif', () => {
    it('sanitizes escapes before serializing to JSON', () => {
      const result = buildResultWithMaliciousFinding(PAYLOADS.osc8Hyperlink);
      const sarif = formatSarif(result);
      const json = JSON.stringify(sarif);
      // JSON.stringify encodes \x1b as \u001b — verify NO such escape leaked
      // (meaning the raw string had any ESC in it).
      expect(json).not.toMatch(/\\u001b/);
      expect(json).not.toMatch(/\\u0007/); // no BEL
    });
  });

  describe('stripAnsi helper', () => {
    it('handles CSI SGR', () => {
      expect(stripAnsi('\x1b[31mX\x1b[0m')).toBe('X');
    });
    it('handles CSI non-SGR (clear screen, cursor)', () => {
      expect(stripAnsi('a\x1b[2Jb\x1b[Hc')).toBe('abc');
    });
    it('handles OSC 8 hyperlinks with BEL terminator', () => {
      expect(stripAnsi('\x1b]8;;https://x/\x07LINK\x1b]8;;\x07')).toBe('LINK');
    });
    it('handles OSC with ST terminator', () => {
      expect(stripAnsi('\x1b]0;title\x1b\\rest')).toBe('rest');
    });
    it('strips bare BEL and BS', () => {
      expect(stripAnsi('hi\x07there')).toBe('hithere');
      expect(stripAnsi('ab\x08c')).toBe('abc');
    });
    it('strips 7-bit C1 escapes', () => {
      expect(stripAnsi('\x1bDtext')).toBe('text');
    });
    it('preserves printable text', () => {
      expect(stripAnsi('normal text')).toBe('normal text');
    });
    it('tolerates non-string input', () => {
      expect(stripAnsi(null)).toBe(null);
      expect(stripAnsi(undefined)).toBe(undefined);
      expect(stripAnsi(42)).toBe(42);
    });
  });
});
