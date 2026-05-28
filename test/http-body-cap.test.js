import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { fetchBody, MAX_RESPONSE_BYTES } from '../src/http.js';
import { fetchRegistry } from '../src/mcp-registry.js';

// Test against a tiny localhost server so we exercise the real Node http
// streaming path (where the cap matters) — not a mock.
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('http.fetchBody response cap (Wave 5)', () => {
  it('aborts mid-stream when the body exceeds MAX_RESPONSE_BYTES', async () => {
    const oversize = MAX_RESPONSE_BYTES + 1024;
    const server = await startServer((req, res) => {
      // No Content-Length so the cap kicks in only via streaming.
      res.writeHead(200);
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const sendChunk = () => {
        if (!res.writable) return;
        if (!res.write(chunk)) {
          res.once('drain', sendChunk);
        } else {
          // Keep going past the cap; the destroy() will land here.
          setImmediate(sendChunk);
        }
      };
      sendChunk();
    });
    try {
      const { port } = server.address();
      const result = await fetchBody(`http://127.0.0.1:${port}/`);
      // Either null (overflow detected) or a string capped near the limit.
      // The contract is: don't blow up; either bail to null or return ≤ cap.
      expect(result === null || result.length <= MAX_RESPONSE_BYTES).toBe(true);
    } finally {
      server.close();
    }
    expect(oversize).toBeGreaterThan(MAX_RESPONSE_BYTES);
  }, 20_000);

  it('rejects oversize Content-Length upfront', async () => {
    const server = await startServer((req, res) => {
      const body = 'x'; // body is tiny — we lie about Content-Length
      res.writeHead(200, { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) });
      res.end(body);
    });
    try {
      const { port } = server.address();
      const result = await fetchBody(`http://127.0.0.1:${port}/`);
      expect(result).toBeNull();
    } finally {
      server.close();
    }
  });
});

describe('mcp-registry response cap (Wave 5)', () => {
  it('rejects oversize Content-Length without parsing JSON', async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          if (name.toLowerCase() === 'content-length') {
            return String(MAX_RESPONSE_BYTES + 1);
          }
          return null;
        },
      },
      json: () => { throw new Error('json() should not be called when body is over cap'); },
    };
    const result = await fetchRegistry({
      cachePath: '/tmp/rigscore-cap-' + Date.now() + '.json',
      fetchImpl: () => Promise.resolve(fakeResponse),
      timeoutMs: 1000,
    });
    expect(result.servers).toEqual([]);
    expect(result.warning).toMatch(/exceeds .* bytes/);
  });
});
