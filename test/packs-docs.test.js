import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Validates the `docs` pack as pure data. It deliberately does NOT import the
// init pack framework (src/cli/packs.js) — the pack is inert data that the
// framework auto-discovers, and it must be verifiable on its own terms.
const PACK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'docs');
const manifest = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf-8'));
const read = (f) => fs.readFileSync(path.join(PACK_DIR, f), 'utf-8');

describe('docs pack manifest', () => {
  it('has the required top-level keys', () => {
    for (const key of ['name', 'description', 'checks', 'files', 'vars']) {
      expect(manifest, `missing key: ${key}`).toHaveProperty(key);
    }
    expect(manifest.name).toBe('docs');
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  it('claims only checks it actually turns green', () => {
    // instruction-effectiveness is NOT claimed: on a repo where it is genuinely
    // red it measured 83 -> 83 (the pack fixes nothing it did not author), and it
    // is weight 0. skill-files / unicode-steganography / coherence only flip N/A
    // -> 100 because AGENTS.md lands in their scan set. See README.md.
    expect(manifest.checks).toEqual(['claude-md']);
  });

  it('ships every file it declares, to a safe relative dest', () => {
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const { src, dest } of manifest.files) {
      expect(fs.existsSync(path.join(PACK_DIR, src)), `missing src: ${src}`).toBe(true);
      expect(path.isAbsolute(dest), `dest must be relative: ${dest}`).toBe(false);
      expect(dest.includes('..'), `dest must not escape the repo: ${dest}`).toBe(false);
    }
  });

  it('declares only the variable the installer can substitute', () => {
    expect(Object.keys(manifest.vars)).toEqual(['PROJECT_NAME']);
    for (const { src } of manifest.files) {
      for (const [, key] of read(src).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
        expect(manifest.vars, `undeclared placeholder: ${key}`).toHaveProperty(key);
      }
    }
  });
});

describe('docs pack templates', () => {
  const agents = read('AGENTS.md');

  it('AGENTS.md is the substantive contract and CLAUDE.md defers to it', () => {
    // claude-md flags a governance file under 50 lines as too short.
    expect(agents.split('\n').length).toBeGreaterThanOrEqual(50);
    expect(read('CLAUDE.md')).toMatch(/AGENTS\.md/);
  });

  it('AGENTS.md covers every category claude-md scores', () => {
    // Mirrors QUALITY_CHECKS in src/checks/claude-md.js — carried by real rules,
    // not keyword stuffing. Kept as a literal list so a reworded template that
    // silently drops a category fails here rather than at scan time.
    const categories = [
      /\b(never|forbidden|must not|do not|prohibited)\b/i,
      /\b(approv(al|e)|human.in.the.loop|confirm|permission)\b/i,
      /\b(restrict|allowed?.?(path|dir)|boundar|working.?dir|path.?rule|paths?.must)/i,
      /\b(no external|network|api.?access|external.?(call|request|fetch))/i,
      /\b(prompt.?injection|instruction.?override|injection.?attack)\b/i,
      /\b(no.?shell|no.?bash|shell.?restrict|reserve.?bash|bash.?restrict)/i,
      /\b(tdd|test.first|failing test|red.green|test.driven)\b/i,
      /\b(definition of done|done when|complete when)\b/i,
      /\b(feature branch|gh pr create|pr create)\b/i,
    ];
    for (const re of categories) {
      expect(agents, `no rule covering ${re}`).toMatch(re);
    }
  });

  it('does not quote attack payloads or spell out the destructive gadget', () => {
    // The injection + shell-exec checks are presence-based: they cannot tell an
    // example of an attack from an attack. A template that quotes one scores its
    // own installer 0. State the rule, never the payload.
    for (const { src } of manifest.files) {
      const body = read(src);
      expect(body).not.toMatch(/ignore\s+(all\s+)?(previous|prior)\s+instructions/i);
      expect(body).not.toMatch(/disregard\s+(all\s+)?previous|forget\s+(all\s+)?previous/i);
      expect(body).not.toMatch(/you\s+are\s+now|from\s+now\s+on\s+you|your\s+new\s+system\s+prompt/i);
      expect(body).not.toMatch(/override\s+(all\s+)?instructions/i);
      // skill-files scans AGENTS.md (it is in GOVERNANCE_FILES): no shell-exec,
      // escalation, persistence, or exfiltration gadgets, and no URLs.
      expect(body).not.toMatch(/\bsudo\b|\bchmod\s|\brun\s+as\s+root\b/i);
      expect(body).not.toMatch(/\bcurl\s+http|\bwget\s+http|\beval\s*\(/i);
      expect(body).not.toMatch(/\bcrontab\b|\bnpm\s+.*-g\b|install\s+.*globally/i);
      expect(body).not.toMatch(/https?:\/\//);
    }
  });

  it('states rules without dismantling them and without vague delegation', () => {
    // claude-md flags a governance header whose body reverses it (C7), and
    // instruction-effectiveness flags directives that delegate without criteria.
    expect(agents).not.toMatch(/no restrictions|skip (approval|review|verification)|bypass (approval|gates|checks)/i);
    expect(agents).not.toMatch(/feel free|just ship|ship fast|trust all|testing is optional/i);
    expect(agents).not.toMatch(/use your (best )?judgm?ent|as (you see fit|appropriate)|where applicable|up to you/i);
  });
});
