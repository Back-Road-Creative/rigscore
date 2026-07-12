import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import check, { readCodexKeys } from '../src/checks/sandbox-posture.js';
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
