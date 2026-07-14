import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listPacks, loadPack, installPack } from '../src/cli/packs.js';
import sandboxPosture from '../src/checks/sandbox-posture.js';
import { CLIENTS } from '../src/clients.js';

// The real templates/ dir — these packs are auto-discovered, no registry edit.
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-hardened-'));

// A throwaway empty $HOME so the developer's real ~/.cursor / ~/.gemini never
// leaks into the post-install posture verdict (mirrors sandbox-posture.test.js).
const runPosture = (cwd) =>
  sandboxPosture.run({ cwd, homedir: fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-home-')), config: {} });

// Each hardened-baseline pack, the client it hardens, the committed file it
// installs, and the normalized posture the sandbox-posture check should report
// once the file is on disk. The file/dest MUST equal the client's own base:'cwd'
// sandbox surface in src/clients.js — otherwise the check would never read it.
const CASES = [
  { pack: 'cursor-guards', clientId: 'cursor', dest: '.cursor/permissions.json', posture: 'partial' },
  { pack: 'opencode-guards', clientId: 'opencode', dest: 'opencode.json', posture: 'partial' },
  { pack: 'gemini-guards', clientId: 'gemini', dest: '.gemini/settings.json', posture: 'partial' },
];

describe('hardened-baseline packs (non-Claude clients)', () => {
  it('sandbox-posture is a real check id the packs can legitimately claim', () => {
    expect(sandboxPosture.id).toBe('sandbox-posture');
  });

  it.each(CASES)('$pack is auto-discovered by listPacks()', ({ pack }) => {
    expect(listPacks(TEMPLATES)).toContain(pack);
  });

  it.each(CASES)('$pack passes loadPack() validation and claims sandbox-posture', ({ pack, dest }) => {
    const manifest = loadPack(pack, TEMPLATES);
    expect(manifest.name).toBe(pack);
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.checks).toContain('sandbox-posture');
    // It installs exactly the client's committed sandbox surface.
    expect(manifest.files.map((f) => f.dest)).toContain(dest);
  });

  it.each(CASES)('$pack installs to the client\'s own committed sandbox path in src/clients.js', ({ clientId, dest }) => {
    const client = CLIENTS.find((c) => c.id === clientId);
    const committed = (client.sandbox || []).filter((e) => e.base === 'cwd').map((e) => e.path);
    expect(committed).toContain(dest);
  });

  it.each(CASES)('$pack installs its file into an empty repo', ({ pack, dest }) => {
    const target = tmp();
    const res = installPack(pack, target, { templatesDir: TEMPLATES });
    expect(res.results).toEqual([{ dest, status: 'written' }]);
    expect(res.unresolved).toEqual([]); // no unresolved {{VAR}} — fully generic
    const body = fs.readFileSync(path.join(target, dest), 'utf-8');
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it.each(CASES)('installing $pack turns the client\'s sandbox-posture GREEN', async ({ pack, clientId, posture }) => {
    const target = tmp();
    installPack(pack, target, { templatesDir: TEMPLATES });
    const r = await runPosture(target);
    // Green: no warning/critical finding, a perfect check score.
    expect(r.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning')).toHaveLength(0);
    expect(r.score).toBe(100);
    // The installed file is the ONLY sandbox surface, graded to a bounded posture.
    expect(r.data.surfacesScanned).toBe(1);
    expect(r.data.postures[clientId]).toBe(posture);
  });
});
