import { describe, it, expect } from 'vitest';
import { fetchRegistry, DEFAULT_NETWORK_TIMEOUT_MS } from '../src/mcp-registry.js';

describe('A5: MCP registry network timeout', () => {
  it('aborts a hung fetch with a network-timeout warning', async () => {
    // Injected fetch that never resolves until the signal aborts. We pass a
    // tiny timeoutMs so the test is fast; the defaultFetch wires up the
    // AbortController.
    const slowFetch = (url, init) => {
      return new Promise((_resolve, reject) => {
        if (!init || !init.signal) {
          // caller didn't wire an AbortController — test would hang. Fail fast.
          reject(new Error('fetchImpl received no AbortSignal'));
          return;
        }
        init.signal.addEventListener('abort', () => {
          const err = new Error('network-timeout');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    // Use a non-existent cache so no stale fallback is used.
    const result = await fetchRegistry({
      cachePath: '/tmp/rigscore-nope-' + Date.now() + '.json',
      fetchImpl: slowFetch,
      timeoutMs: 50,
    });

    expect(result.servers).toEqual([]);
    expect(result.errorKind).toBe('network-timeout');
    expect(result.warning).toMatch(/timeout/i);
  });

  it('falls back to stale cache on timeout, not empty result', async () => {
    // Seed a stale cache.
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-cache-'));
    const cachePath = path.join(tmpDir, 'cache.json');
    const staleTs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify({
      fetchedAt: staleTs,
      data: { servers: [{ name: 'io.example/fallback' }] },
    }));

    try {
      const slowFetch = (url, init) => new Promise((_r, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

      const result = await fetchRegistry({
        cachePath,
        fetchImpl: slowFetch,
        timeoutMs: 25,
      });

      expect(result.stale).toBe(true);
      expect(result.errorKind).toBe('network-timeout');
      expect(result.warning).toMatch(/timeout/i);
      expect(result.servers.length).toBe(1);
      expect(result.servers[0].name).toBe('io.example/fallback');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('exposes DEFAULT_NETWORK_TIMEOUT_MS = 5000', () => {
    expect(DEFAULT_NETWORK_TIMEOUT_MS).toBe(5000);
  });
});
