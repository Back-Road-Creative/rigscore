import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import check, { readCodexKeys } from '../src/checks/sandbox-posture.js';
import { CLIENTS } from '../src/clients.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name) => path.join(__dirname, 'fixtures', name);

// Throwaway empty $HOME — the developer's real ~/.codex or ~/.claude must never
// leak into a fixture's verdict.
const run = (cwd) =>
  check.run({ cwd, homedir: fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sandbox-')), config: {} });
const ids = (r) => r.findings.map((f) => f.findingId);
const sev = (r, id) => r.findings.find((f) => f.findingId === id)?.severity;

describe('sandbox-posture: targeted TOML key reader', () => {
  it('reads root scalars + the [sandbox_workspace_write] boolean, ignoring comments', () => {
    const keys = readCodexKeys(
      '# comment\napproval_policy = "never"\nsandbox_mode = "read-only" # trailing\n' +
        '\n[sandbox_workspace_write]\nnetwork_access = true\n',
    );
    expect(keys).toEqual({
      approval_policy: 'never', sandbox_mode: 'read-only', network_access: true,
    });
  });

  it('is conservative: unrelated tables and unparseable values stay undefined', () => {
    // `[profiles.*]` keys must not be harvested, and the inline-table (granular)
    // approval form is legal TOML but out of scope — unknown, never "dangerous".
    const scoped = readCodexKeys('[profiles.yolo]\nnetwork_access = true\nsandbox_mode = "x"\n');
    expect(scoped.network_access).toBeUndefined();
    expect(scoped.sandbox_mode).toBeUndefined();
    expect(readCodexKeys('approval_policy = { granular = { rules = true } }\n').approval_policy)
      .toBeUndefined();
  });
});

describe('sandbox-posture: verdicts', () => {
  it('flags Codex danger-full-access + approval_policy never as CRITICAL / unrestricted', async () => {
    const r = await run(FIX('sandbox-codex-danger'));
    expect(ids(r)).toContain('sandbox-posture/codex-no-sandbox');
    expect(sev(r, 'sandbox-posture/codex-no-sandbox')).toBe('critical');
    expect(r.data.postures.codex).toBe('unrestricted');
    expect(r.score).toBe(0);
  });

  it('passes a locked-down Codex config and normalizes it to restricted', async () => {
    const r = await run(FIX('sandbox-codex-locked'));
    expect(r.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning'))
      .toHaveLength(0);
    expect(r.data.postures.codex).toBe('restricted');
    expect(r.score).toBe(100);
  });

  it('returns N/A (not zero) on a repo with no sandbox surface at all', async () => {
    const r = await run(FIX('vanilla-nextjs'));
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
    expect(r.findings).toHaveLength(0);
    expect(r.data.surfacesScanned).toBe(0);
  });
});

// A locked-down, minimal config per format — enough for the check to see the surface.
const MINIMAL = {
  toml: 'sandbox_mode = "read-only"\n',
  json: JSON.stringify({ permissions: { deny: ['Bash(curl:*)'] } }),
};

describe('sandbox-posture: the client registry is the surface list', () => {
  it('scans every client the registry says has a sandbox surface — no local table', async () => {
    // The criterion: a client that declares `sandbox` in src/clients.js is picked up
    // with NO change to this check's logic. This test enumerates the registry, so a
    // new entry is scanned here the day it lands (or fails loudly on a new format).
    const declared = CLIENTS.filter((c) => (c.sandbox || []).some((e) => e.base === 'cwd'));
    expect(declared.map((c) => c.id)).toEqual(expect.arrayContaining(['codex', 'claude-code']));

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-registry-'));
    for (const client of declared) {
      for (const entry of client.sandbox.filter((e) => e.base === 'cwd')) {
        const file = path.join(cwd, entry.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, MINIMAL[entry.format]);
      }
    }

    const r = await run(cwd);
    expect(Object.keys(r.data.postures).sort()).toEqual(declared.map((c) => c.id).sort());
    expect(r.data.surfacesScanned).toBe(declared.length);
  });
});

describe('sandbox-posture: Claude Code deny-rule posture', () => {
  it('flags a settings file that exists but declares zero permissions.deny entries', async () => {
    // Fixture: settings.json with allow entries only + settings.local.json in
    // bypassPermissions — nothing denied, nothing prompted.
    const r = await run(FIX('sandbox-claude-nodeny'));
    expect(ids(r)).toContain('sandbox-posture/claude-no-deny-rules');
    expect(sev(r, 'sandbox-posture/claude-no-deny-rules')).toBe('warning');
    expect(r.data.postures['claude-code']).toBe('unrestricted');
    expect(r.score).toBeLessThan(100);
  });

  it('passes on deny rules and never grades allow entries — claude-settings owns those', async () => {
    const r = await run(FIX('sandbox-claude-deny'));
    expect(ids(r)).not.toContain('sandbox-posture/claude-no-deny-rules');
    expect(r.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning'))
      .toHaveLength(0);
    expect(r.data.postures['claude-code']).toBe('partial');
    expect(r.score).toBe(100);
  });

  it('reads an absent settings file as no surface, never as zero deny rules', async () => {
    // claude-empty ships CLAUDE.md and no .claude/settings*.json: a missing settings
    // file is claude-settings' finding, not a posture finding.
    const r = await run(FIX('claude-empty'));
    expect(ids(r)).not.toContain('sandbox-posture/claude-no-deny-rules');
    expect(r.data.postures['claude-code']).toBeUndefined();
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
  });
});
