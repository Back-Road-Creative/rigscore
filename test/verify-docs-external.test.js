import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  relativeLinkTargets,
  checkCountSentences,
  deriveRegistryCounts,
  verifyExternalDocs,
} from '../src/lib/verify-docs.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('relativeLinkTargets', () => {
  it('captures relative file links, strips fragments, skips external + pure anchors', () => {
    const body =
      '[a](src/x.js) [b](../THREAT-MODEL.md#sec) [c](https://x.com/y) [d](#anchor) [e](mailto:x@y.z)';
    expect(relativeLinkTargets(body)).toEqual(['src/x.js', '../THREAT-MODEL.md']);
  });
});

describe('checkCountSentences', () => {
  const counts = { clients: 24, mcpClients: 21, credentialClients: 18, credentialFiles: 19 };

  it('passes when the registry sentence matches derived counts', () => {
    const texts = {
      'THREAT-MODEL.md':
        'registry of 24 known agent clients (21 with MCP config paths, 18 holding 19 credential files)',
    };
    expect(checkCountSentences(texts, counts)).toEqual([]);
  });

  it('flags drift when the sentence disagrees with source', () => {
    const texts = {
      'THREAT-MODEL.md':
        'registry of 22 known agent clients (19 with MCP config paths, 16 holding 17 credential files)',
    };
    const off = checkCountSentences(texts, counts);
    expect(off).toHaveLength(1);
    expect(off[0].reason).toBe('count-drift');
  });

  it('flags a vanished anchor sentence so a reword cannot silently disable the guard', () => {
    const off = checkCountSentences({ 'THREAT-MODEL.md': 'no counts here at all' }, counts);
    expect(off[0].reason).toBe('count-anchor-missing');
  });

  it('guards the credential-storage doc against credentialClients() drift', () => {
    const texts = { 'docs/checks/credential-storage.md': 'currently 17 credential-file entries' };
    const off = checkCountSentences(texts, counts);
    expect(off.some((o) => o.doc === 'docs/checks/credential-storage.md')).toBe(true);
  });
});

describe('deriveRegistryCounts — real source', () => {
  it('reads the live client registry', async () => {
    const c = await deriveRegistryCounts(REPO_ROOT);
    expect(c.clients).toBeGreaterThan(0);
    expect(c.mcpClients).toBeGreaterThan(0);
    expect(c.credentialClients).toBeGreaterThan(0);
    expect(c.credentialFiles).toBeGreaterThanOrEqual(c.credentialClients);
  });
});

describe('verifyExternalDocs — shipped docs are clean', () => {
  it('passes link + count checks against THREAT-MODEL.md and known-limits.md', async () => {
    const r = await verifyExternalDocs({ root: REPO_ROOT });
    expect(r.linkOffenders).toEqual([]);
    expect(r.countOffenders).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('verifyExternalDocs — negative fixtures', () => {
  it('flags a dead relative link but not a live one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-extdoc-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'THREAT-MODEL.md'),
        'see [ghost](src/checks/ghost.js) and [self](THREAT-MODEL.md)\n',
      );
      const r = await verifyExternalDocs({ root: dir, importCounts: async () => null });
      const targets = r.linkOffenders.map((o) => o.target);
      expect(targets).toContain('src/checks/ghost.js');
      expect(targets).not.toContain('THREAT-MODEL.md');
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a registry-count drift against injected counts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-extdoc-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'THREAT-MODEL.md'),
        'registry of 99 known agent clients (99 with MCP config paths, 99 holding 99 credential files)\n',
      );
      const r = await verifyExternalDocs({
        root: dir,
        importCounts: async () => ({
          clients: 24,
          mcpClients: 21,
          credentialClients: 18,
          credentialFiles: 19,
        }),
      });
      expect(r.countOffenders.some((o) => o.reason === 'count-drift')).toBe(true);
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
