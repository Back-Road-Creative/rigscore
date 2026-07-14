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
  gemini: JSON.stringify({ general: { defaultApprovalMode: 'plan' } }),
  opencode: JSON.stringify({ permission: { '*': 'deny' } }),
  cursor: JSON.stringify({ terminalAllowlist: ['git'] }),
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

// A devcontainer tree written to a throwaway cwd — no repo fixture needed.
const tree = (files) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-devc-'));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return cwd;
};
const DEVC_NO_EGRESS = JSON.stringify({
  name: 'agent-box',
  image: 'mcr.microsoft.com/devcontainers/base:ubuntu-24.04',
  features: { 'ghcr.io/anthropics/devcontainer-features/claude-code:1': {} },
  postCreateCommand: 'npm install -g @anthropic-ai/claude-code',
});

describe('sandbox-posture: devcontainer egress (presence-only)', () => {
  it('flags a devcontainer that installs an agent and attempts no egress control at all', async () => {
    const r = await run(tree({ '.devcontainer/devcontainer.json': DEVC_NO_EGRESS }));
    expect(ids(r)).toContain('sandbox-posture/devcontainer-no-egress-control');
    expect(sev(r, 'sandbox-posture/devcontainer-no-egress-control')).toBe('warning');
    expect(r.data.surfacesScanned).toBe(1);
    expect(r.score).toBeLessThan(100);
  });

  it('goes silent on evidence of an attempt — and claims NO posture from that evidence', async () => {
    // The honesty ceiling: a proxy env + --cap-drop prove someone TRIED to contain this
    // container. They never prove it IS contained (the proxy may be bypassable, the rule may
    // not load), so the check may only fall silent — it must not grade the devcontainer.
    const r = await run(tree({
      '.devcontainer/devcontainer.json': JSON.stringify({
        postCreateCommand: 'npm i -g @anthropic-ai/claude-code',
        runArgs: ['--cap-drop=ALL', '--security-opt=no-new-privileges:true'],
        containerEnv: { HTTPS_PROXY: 'http://egress-proxy:8888' },
      }),
      '.devcontainer/egress/init-firewall.sh': '#!/bin/sh\niptables -P OUTPUT DROP\n',
    }));
    expect(ids(r)).not.toContain('sandbox-posture/devcontainer-no-egress-control');
    expect(r.data.devcontainer.controls).toEqual(
      expect.arrayContaining(['firewall', 'proxy', 'cap-drop']),
    );
    expect(r.data.postures.devcontainer).toBeUndefined(); // presence ≠ containment
    expect(r.score).toBe(100);
  });

  it('reads a devcontainer that runs no agent as no surface at all — N/A, never zero', async () => {
    const r = await run(tree({
      '.devcontainer/devcontainer.json': JSON.stringify({ image: 'node:22' }),
    }));
    expect(ids(r)).not.toContain('sandbox-posture/devcontainer-no-egress-control');
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
    expect(r.data.surfacesScanned).toBe(0);
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

  it('sees bypassPermissions at its REAL home, permissions.defaultMode (not just top-level)', async () => {
    // Claude Code writes the approval mode nested under `permissions`; the top-level key is the
    // legacy shape. Reading only the top level graded a fully permission-bypassing config as if it
    // had no bypass at all — `unrestricted` never fired on a real-world settings.json. The existing
    // nodeny fixture happens to use the legacy shape, which is exactly why nothing caught this.
    const r = await run(tree({
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: ['Bash(npm test:*)'], defaultMode: 'bypassPermissions' },
      }),
    }));
    expect(r.data.postures['claude-code']).toBe('unrestricted');
    expect(r.findings.find((f) => f.findingId === 'sandbox-posture/claude-no-deny-rules').detail)
      .toContain('bypassPermissions');
  });

  it('still honors the legacy top-level defaultMode — the fallback, not the primary read', async () => {
    const r = await run(tree({
      '.claude/settings.json': JSON.stringify({ defaultMode: 'bypassPermissions' }),
    }));
    expect(r.data.postures['claude-code']).toBe('unrestricted');
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

describe('sandbox-posture: Gemini CLI approval mode', () => {
  it('flags general.defaultApprovalMode "yolo" as unrestricted (auto-approves every tool call)', async () => {
    const r = await run(tree({ '.gemini/settings.json': JSON.stringify({ general: { defaultApprovalMode: 'yolo' } }) }));
    expect(ids(r)).toContain('sandbox-posture/gemini-yolo-approval');
    expect(sev(r, 'sandbox-posture/gemini-yolo-approval')).toBe('warning');
    expect(r.data.postures.gemini).toBe('unrestricted');
    expect(r.score).toBeLessThan(100);
  });

  it('flags "auto_edit" as auto-approving edits without prompting (partial posture, still a warning)', async () => {
    const r = await run(tree({ '.gemini/settings.json': JSON.stringify({ general: { defaultApprovalMode: 'auto_edit' } }) }));
    expect(ids(r)).toContain('sandbox-posture/gemini-auto-edit');
    expect(sev(r, 'sandbox-posture/gemini-auto-edit')).toBe('warning');
    expect(r.data.postures.gemini).toBe('partial');
    expect(r.score).toBeLessThan(100);
  });

  it('passes read-only "plan" mode and normalizes it to restricted', async () => {
    const r = await run(tree({ '.gemini/settings.json': JSON.stringify({ general: { defaultApprovalMode: 'plan' } }) }));
    expect(r.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning')).toHaveLength(0);
    expect(r.data.postures.gemini).toBe('restricted');
    expect(r.score).toBe(100);
  });

  it('passes the interactive "default" mode with no finding (partial — prompts every call)', async () => {
    const r = await run(tree({ '.gemini/settings.json': JSON.stringify({ general: { defaultApprovalMode: 'default' } }) }));
    expect(r.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning')).toHaveLength(0);
    expect(r.data.postures.gemini).toBe('partial');
  });
});

describe('sandbox-posture: opencode permission block', () => {
  it('flags permission.bash "allow" as unrestricted (auto-runs shell)', async () => {
    const r = await run(tree({ 'opencode.json': JSON.stringify({ permission: { bash: 'allow' } }) }));
    expect(ids(r)).toContain('sandbox-posture/opencode-auto-run-shell');
    expect(sev(r, 'sandbox-posture/opencode-auto-run-shell')).toBe('warning');
    expect(r.data.postures.opencode).toBe('unrestricted');
    expect(r.score).toBeLessThan(100);
  });

  it('flags a "*": "allow" catch-all the same way', async () => {
    const r = await run(tree({ 'opencode.json': JSON.stringify({ permission: { '*': 'allow' } }) }));
    expect(ids(r)).toContain('sandbox-posture/opencode-auto-run-shell');
    expect(r.data.postures.opencode).toBe('unrestricted');
  });

  it('passes when bash is "deny" and normalizes it to restricted', async () => {
    const r = await run(tree({ 'opencode.json': JSON.stringify({ permission: { bash: 'deny' } }) }));
    expect(ids(r)).not.toContain('sandbox-posture/opencode-auto-run-shell');
    expect(r.data.postures.opencode).toBe('restricted');
    expect(r.score).toBe(100);
  });

  it('an opencode.json with no permission block is not a sandbox surface (N/A, never zero)', async () => {
    const r = await run(tree({ 'opencode.json': JSON.stringify({ mcp: { foo: { type: 'local' } } }) }));
    expect(r.data.postures.opencode).toBeUndefined();
    expect(r.score).toBe(NOT_APPLICABLE_SCORE);
    expect(r.data.surfacesScanned).toBe(0);
  });
});

describe('sandbox-posture: Cursor permissions.json allowlist', () => {
  it('flags a "*" terminalAllowlist wildcard as unrestricted (auto-runs any command)', async () => {
    const r = await run(tree({ '.cursor/permissions.json': JSON.stringify({ terminalAllowlist: ['*'] }) }));
    expect(ids(r)).toContain('sandbox-posture/cursor-wildcard-autorun');
    expect(sev(r, 'sandbox-posture/cursor-wildcard-autorun')).toBe('warning');
    expect(r.data.postures.cursor).toBe('unrestricted');
    expect(r.score).toBeLessThan(100);
  });

  it('flags a "*:*" mcpAllowlist wildcard the same way', async () => {
    const r = await run(tree({ '.cursor/permissions.json': JSON.stringify({ mcpAllowlist: ['*:*'] }) }));
    expect(ids(r)).toContain('sandbox-posture/cursor-wildcard-autorun');
    expect(r.data.postures.cursor).toBe('unrestricted');
  });

  it('passes a narrow allowlist (partial posture, no wildcard) — Cursor has no restricted ceiling here', async () => {
    const r = await run(tree({ '.cursor/permissions.json': JSON.stringify({ terminalAllowlist: ['git', 'npm'], mcpAllowlist: ['github:*'] }) }));
    expect(ids(r)).not.toContain('sandbox-posture/cursor-wildcard-autorun');
    expect(r.data.postures.cursor).toBe('partial');
    expect(r.score).toBe(100);
  });
});

describe('sandbox-posture: new clients — absent config is not-applicable (no false positive)', () => {
  it.each([
    ['gemini', 'sandbox-posture/gemini-yolo-approval'],
    ['opencode', 'sandbox-posture/opencode-auto-run-shell'],
    ['cursor', 'sandbox-posture/cursor-wildcard-autorun'],
  ])('%s absent → no posture, no finding, even with another client present', async (clientId, findingId) => {
    // A locked Codex config makes the check applicable; the target client's file is absent,
    // so its reader must neither crash nor fabricate a posture/finding.
    const r = await run(tree({ '.codex/config.toml': 'sandbox_mode = "read-only"\n' }));
    expect(r.data.postures[clientId]).toBeUndefined();
    expect(ids(r)).not.toContain(findingId);
  });
});
