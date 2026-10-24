import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  relativeLinkTargets,
  checkCountSentences,
  checkClaudeMd,
  EXTERNAL_DOC_RELPATHS,
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

describe('README lead — any-client + client count guard', () => {
  const counts = { clients: 29, mcpClients: 21, credentialClients: 18, credentialFiles: 19 };
  const lead = (line) => ({ 'README.md': `# rigscore\n\n**A checker.**\n\n${line}\n\n## Body\n` });

  it('passes when the lead says any-client and the live client count', () => {
    const texts = lead('Works with any AI coding client: 29 known agent clients are scanned. 29 checks.');
    expect(checkCountSentences(texts, counts)).toEqual([]);
  });

  it('flags a stale client count in the lead', () => {
    const off = checkCountSentences(lead('Works with any AI coding client: 24 known agent clients.'), counts);
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ doc: 'README.md', reason: 'count-drift' });
  });

  it('flags a lead with no client count at all', () => {
    const off = checkCountSentences(lead('One command. 28 checks. A hygiene score.'), counts);
    expect(off.map((o) => o.reason)).toContain('count-anchor-missing');
  });

  it('flags a lead that does not say any-client', () => {
    const off = checkCountSentences(lead('Scans 29 known agent clients.'), counts);
    expect(off.map((o) => o.reason)).toContain('lead-any-client-missing');
  });

  it('ignores a client-count sentence that only appears below the lead', () => {
    const texts = { 'README.md': '# rigscore\n\nOne command.\n\n' + '\n'.repeat(20) + '29 known agent clients any AI client\n' };
    expect(checkCountSentences(texts, counts).length).toBeGreaterThan(0);
  });

  it('link-checks the README too', () => {
    expect(EXTERNAL_DOC_RELPATHS).toContain('README.md');
  });
});

describe('checkClaudeMd — title and check roster', () => {
  const ids = ['mcp-config', 'staged-copy-drift'];
  const good = '# rigscore\n\nScored: `mcp-config`. Advisory: `staged-copy-drift`.\n';

  it('passes a correctly titled doc that names every check', () => {
    expect(checkClaudeMd(good, ids)).toEqual([]);
  });

  it('flags the old workspace-style title', () => {
    const off = checkClaudeMd(good.replace('# rigscore', '# pkg-rigscore'), ids);
    expect(off.map((o) => o.reason)).toContain('claude-md-title');
  });

  it('flags a check that CLAUDE.md never names', () => {
    const off = checkClaudeMd('# rigscore\n\n`mcp-config`\n', ids);
    expect(off).toEqual([expect.objectContaining({ reason: 'claude-md-check-missing', detail: expect.stringContaining('staged-copy-drift') })]);
  });

  it('flags a doc with no H1', () => {
    expect(checkClaudeMd('no heading `mcp-config` `staged-copy-drift`', ids).map((o) => o.reason)).toContain('claude-md-title');
  });
});

describe('verifyExternalDocs — CLAUDE.md fixture', () => {
  it('reports the old title and a missing check from a fixture tree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-claudemd-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'checks'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'checks', 'alpha.js'), '');
      fs.writeFileSync(path.join(dir, 'src', 'checks', 'beta.js'), '');
      fs.writeFileSync(path.join(dir, 'src', 'checks', 'index.js'), '');
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# pkg-rigscore\n\n`alpha`\n');
      const r = await verifyExternalDocs({ root: dir, importCounts: async () => null });
      const reasons = r.countOffenders.map((o) => o.reason);
      expect(reasons).toContain('claude-md-title');
      expect(reasons).toContain('claude-md-check-missing');
      expect(r.countOffenders.some((o) => /index/.test(o.detail || ''))).toBe(false);
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
