import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  fetchRegistry,
  normalizeRegistryServerName,
  loadRegistryCache,
  saveRegistryCache,
} from '../src/mcp-registry.js';
import mcpCheck from '../src/checks/mcp-config.js';
import { parseArgs } from '../src/index.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, '..', 'README.md');

function makeTmpDir(prefix = 'rigscore-mcp-reg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const defaultConfig = { paths: { mcpConfig: [] }, network: {} };

// ---------- mock fetch helpers ----------

function makeOkFetch(body, status = 200) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
      async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
  };
  fn.calls = calls;
  return fn;
}

function makeTextFetch(text, status = 200) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return JSON.parse(text); },
      async text() { return text; },
    };
  };
  fn.calls = calls;
  return fn;
}

function makeFailingFetch(err = new Error('ENETUNREACH')) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    throw err;
  };
  fn.calls = calls;
  return fn;
}

function make404Fetch() {
  return makeOkFetch({ error: 'not found' }, 404);
}

// Sample registry payload — official-ish shape.
const SAMPLE_REGISTRY = {
  servers: [
    {
      name: 'io.modelcontextprotocol/filesystem',
      description: 'Reference filesystem server',
      repository: { url: 'https://github.com/modelcontextprotocol/servers' },
      version: '1.0.0',
    },
    {
      name: 'io.modelcontextprotocol/github',
      description: 'GitHub server',
      version: '1.2.0',
    },
    {
      name: 'io.github.someone/my-server',
      description: 'Community server',
    },
  ],
};

// ---------- T1 tests ----------

describe('mcp-registry module', () => {
  describe('normalizeRegistryServerName', () => {
    it('strips reverse-DNS namespace and lowercases', () => {
      expect(normalizeRegistryServerName('io.modelcontextprotocol/filesystem'))
        .toBe('filesystem');
      expect(normalizeRegistryServerName('io.github.someone/My-Server'))
        .toBe('my-server');
    });

    it('returns empty string for unexpected shapes', () => {
      expect(normalizeRegistryServerName(undefined)).toBe('');
      expect(normalizeRegistryServerName(null)).toBe('');
      expect(normalizeRegistryServerName(123)).toBe('');
    });

    it('handles names with no slash (use whole string)', () => {
      expect(normalizeRegistryServerName('filesystem')).toBe('filesystem');
    });
  });

  describe('fetchRegistry — cache semantics', () => {
    let tmpDir;
    let cachePath;

    beforeEach(() => {
      tmpDir = makeTmpDir('rigscore-reg-cache-');
      cachePath = path.join(tmpDir, 'mcp-registry.json');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('T1.2: first run writes cache with fetchedAt ISO timestamp', async () => {
      const fetchImpl = makeOkFetch(SAMPLE_REGISTRY);
      const result = await fetchRegistry({ cachePath, fetchImpl });

      expect(result.servers.length).toBe(3);
      expect(result.fromCache).toBe(false);
      expect(result.fetchedAt).toBeTruthy();
      expect(new Date(result.fetchedAt).toString()).not.toBe('Invalid Date');

      // Cache file written
      expect(fs.existsSync(cachePath)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(onDisk.fetchedAt).toBe(result.fetchedAt);
      expect(onDisk.data).toBeDefined();

      // Fetch was called with the correct URL
      expect(fetchImpl.calls.length).toBe(1);
      expect(fetchImpl.calls[0]).toContain('registry.modelcontextprotocol.io');
      expect(fetchImpl.calls[0]).toContain('/v0/servers');
    });

    it('T1.3: cache hit within 24h — no network call', async () => {
      // Pre-populate cache with a fresh timestamp
      const fresh = new Date().toISOString();
      fs.writeFileSync(cachePath, JSON.stringify({
        fetchedAt: fresh,
        data: SAMPLE_REGISTRY,
      }));

      const fetchImpl = makeOkFetch(SAMPLE_REGISTRY);
      const result = await fetchRegistry({ cachePath, fetchImpl });

      expect(result.fromCache).toBe(true);
      expect(result.servers.length).toBe(3);
      expect(fetchImpl.calls.length).toBe(0); // no network
    });

    it('T1.4: cache expired (>24h) refetches; if refetch fails, uses stale cache with INFO', async () => {
      // Pre-populate cache with a stale timestamp (2 days ago)
      const staleDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(cachePath, JSON.stringify({
        fetchedAt: staleDate,
        data: SAMPLE_REGISTRY,
      }));

      const fetchImpl = makeFailingFetch();
      const result = await fetchRegistry({ cachePath, fetchImpl });

      expect(fetchImpl.calls.length).toBe(1); // attempted refetch
      expect(result.fromCache).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.servers.length).toBe(3);
      expect(result.warning).toBeTruthy();
      expect(result.warning).toMatch(/stale/i);
    });

    it('T1.4b: cache expired, refetch succeeds, overwrites cache', async () => {
      const staleDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(cachePath, JSON.stringify({
        fetchedAt: staleDate,
        data: { servers: [{ name: 'old/old-server' }] },
      }));

      const fetchImpl = makeOkFetch(SAMPLE_REGISTRY);
      const result = await fetchRegistry({ cachePath, fetchImpl });

      expect(fetchImpl.calls.length).toBe(1);
      expect(result.fromCache).toBe(false);
      expect(result.servers.length).toBe(3);

      // Cache updated
      const onDisk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(onDisk.fetchedAt).not.toBe(staleDate);
      expect(onDisk.data.servers.length).toBe(3);
    });

    it('T1.5: no cache + network fail — empty result with warning', async () => {
      const fetchImpl = makeFailingFetch();
      const result = await fetchRegistry({ cachePath, fetchImpl });

      expect(result.servers).toEqual([]);
      expect(result.fromCache).toBe(false);
      expect(result.warning).toBeTruthy();
      expect(result.warning).toMatch(/unreachable|failed/i);
      // Cache was not written because fetch failed
      expect(fs.existsSync(cachePath)).toBe(false);
    });

    it('T1.7: unknown fields are preserved in data; known fields extractable', async () => {
      const payload = {
        servers: [
          {
            name: 'io.modelcontextprotocol/filesystem',
            description: 'ok',
            // Unknown forward-compat fields:
            _futureField: { nested: 'ignore-me' },
            tags: ['community', 'verified'],
            xyz: 42,
          },
        ],
        // Top-level unknown keys too:
        pagination: { nextCursor: 'abc' },
      };
      const fetchImpl = makeOkFetch(payload);
      const result = await fetchRegistry({ cachePath, fetchImpl });

      expect(result.servers.length).toBe(1);
      expect(result.servers[0].name).toBe('io.modelcontextprotocol/filesystem');
      // Does not crash, extracts known fields
    });

    it('T1.7b: malformed JSON — falls back and emits warning', async () => {
      const fetchImpl = makeTextFetch('{"servers": [truncated');
      const result = await fetchRegistry({ cachePath, fetchImpl });

      expect(result.servers).toEqual([]);
      expect(result.warning).toBeTruthy();
      expect(result.warning).toMatch(/parse|malformed|invalid/i);
    });

    it('T1.8: 404 on endpoint — empty result with warning, no crash', async () => {
      const fetchImpl = make404Fetch();
      const result = await fetchRegistry({ cachePath, fetchImpl });

      expect(result.servers).toEqual([]);
      expect(result.warning).toBeTruthy();
    });

    it('force=true bypasses cache TTL and refetches', async () => {
      const fresh = new Date().toISOString();
      fs.writeFileSync(cachePath, JSON.stringify({
        fetchedAt: fresh,
        data: { servers: [{ name: 'cached/one' }] },
      }));

      const fetchImpl = makeOkFetch(SAMPLE_REGISTRY);
      const result = await fetchRegistry({ cachePath, fetchImpl, force: true });

      expect(fetchImpl.calls.length).toBe(1); // forced
      expect(result.fromCache).toBe(false);
      expect(result.servers.length).toBe(3);
    });

    it('loadRegistryCache / saveRegistryCache round-trip', async () => {
      await saveRegistryCache(cachePath, SAMPLE_REGISTRY);
      const loaded = await loadRegistryCache(cachePath);
      expect(loaded).toBeTruthy();
      expect(loaded.data.servers.length).toBe(3);
      expect(loaded.fetchedAt).toBeTruthy();
    });

    it('loadRegistryCache returns null when cache is missing', async () => {
      const loaded = await loadRegistryCache(cachePath);
      expect(loaded).toBeNull();
    });

    it('loadRegistryCache returns null when cache is corrupt JSON', async () => {
      fs.writeFileSync(cachePath, 'not-json');
      const loaded = await loadRegistryCache(cachePath);
      expect(loaded).toBeNull();
    });
  });
});

describe('README documentation (T1.10)', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('documents the MCP registry cache path', () => {
    expect(readme).toContain('~/.cache/rigscore/mcp-registry.json');
  });

  it('documents the 24h TTL and --refresh-mcp-registry flag', () => {
    expect(readme.toLowerCase()).toMatch(/24\s*h|24\s*hour/);
    expect(readme).toContain('--refresh-mcp-registry');
  });

  it('mentions air-gapped pre-populate guidance', () => {
    const lower = readme.toLowerCase();
    expect(lower).toMatch(/air.?gap|pre.?populate|offline/);
  });
});

describe('mcp-config integration with MCP registry', () => {
  let tmpDir;
  let cacheDir;
  let cachePath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cacheDir = makeTmpDir('rigscore-reg-cachedir-');
    cachePath = path.join(cacheDir, 'mcp-registry.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('T1.1: default mode (no --online) does NOT call fetch', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        suspect: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memorx'], // known hand-curated typosquat target
        },
      },
    }));
    const fetchImpl = makeOkFetch(SAMPLE_REGISTRY);

    const result = await mcpCheck.run({
      cwd: tmpDir,
      homedir: '/tmp/nonexistent',
      config: defaultConfig,
      online: false,
      writeState: false,
      registryCachePath: cachePath,
      registryFetch: fetchImpl,
    });

    // Still catches typosquat from hand-curated list
    const warning = result.findings.find(f => f.severity === 'warning' && f.title.includes('similar to known'));
    expect(warning).toBeDefined();
    // Critically: no fetch was called
    expect(fetchImpl.calls.length).toBe(0);
  });

  it('T1.6: --online catches typosquat of registry server not in hand-curated list', async () => {
    // "io.modelcontextprotocol/filesystem" is in registry. Use a 1-char typo of the
    // base name ("filesystym") that is NOT in the hand-curated list (which has
    // @modelcontextprotocol/server-filesystem, different base "server-filesystem").
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        fs: {
          command: 'npx',
          args: ['-y', '@some-unknown-vendor/filesystym'],
        },
      },
    }));
    const fetchImpl = makeOkFetch(SAMPLE_REGISTRY);

    const result = await mcpCheck.run({
      cwd: tmpDir,
      homedir: '/tmp/nonexistent',
      config: defaultConfig,
      online: true,
      writeState: false,
      registryCachePath: cachePath,
      registryFetch: fetchImpl,
    });

    const critical = result.findings.find(f =>
      f.severity === 'critical' &&
      (f.title.toLowerCase().includes('typosquat') || f.title.toLowerCase().includes('similar')) &&
      f.detail && f.detail.toLowerCase().includes('registry')
    );
    expect(critical).toBeDefined();
  });

  it('T1.5: --online but network down — INFO finding, score unchanged from offline', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        ok: {
          command: 'node',
          args: ['server.js'],
        },
      },
    }));
    const fetchImpl = makeFailingFetch();

    const result = await mcpCheck.run({
      cwd: tmpDir,
      homedir: '/tmp/nonexistent',
      config: defaultConfig,
      online: true,
      writeState: false,
      registryCachePath: cachePath,
      registryFetch: fetchImpl,
    });

    const info = result.findings.find(f =>
      f.severity === 'info' && f.title.toLowerCase().includes('registry')
    );
    expect(info).toBeDefined();
    // No criticals from registry path
    const registryCritical = result.findings.find(f =>
      f.severity === 'critical' && f.detail && f.detail.toLowerCase().includes('registry')
    );
    expect(registryCritical).toBeUndefined();
  });

  it('T1.11: --refresh-mcp-registry implies --online and sets refresh flag', () => {
    const opts = parseArgs(['--refresh-mcp-registry']);
    expect(opts.refreshMcpRegistry).toBe(true);
    expect(opts.online).toBe(true);
  });

  it('T1.11b: --refresh-mcp-registry alongside --online still works', () => {
    const opts = parseArgs(['--online', '--refresh-mcp-registry']);
    expect(opts.refreshMcpRegistry).toBe(true);
    expect(opts.online).toBe(true);
  });

  it('T1.11c: force=true wired through context triggers a refetch even with fresh cache', async () => {
    // Pre-populate cache that would otherwise be a hit
    const fresh = new Date().toISOString();
    fs.writeFileSync(cachePath, JSON.stringify({
      fetchedAt: fresh,
      data: { servers: [{ name: 'io.old/stale' }] },
    }));

    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: { ok: { command: 'node', args: ['server.js'] } },
    }));
    const fetchImpl = makeOkFetch(SAMPLE_REGISTRY);

    await mcpCheck.run({
      cwd: tmpDir,
      homedir: '/tmp/nonexistent',
      config: defaultConfig,
      online: true,
      refreshMcpRegistry: true,
      writeState: false,
      registryCachePath: cachePath,
      registryFetch: fetchImpl,
    });

    expect(fetchImpl.calls.length).toBe(1); // forced despite fresh cache
  });

  it('T1.4: --online with stale cache + refetch fail emits INFO about stale cache', async () => {
    // Pre-populate stale cache
    const staleDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify({
      fetchedAt: staleDate,
      data: SAMPLE_REGISTRY,
    }));

    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        ok: { command: 'node', args: ['server.js'] },
      },
    }));
    const fetchImpl = makeFailingFetch();

    const result = await mcpCheck.run({
      cwd: tmpDir,
      homedir: '/tmp/nonexistent',
      config: defaultConfig,
      online: true,
      writeState: false,
      registryCachePath: cachePath,
      registryFetch: fetchImpl,
    });

    const info = result.findings.find(f =>
      f.severity === 'info' && f.title.toLowerCase().includes('stale')
    );
    expect(info).toBeDefined();
  });
});
