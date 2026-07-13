import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/mcp-config.js';
import { computeServerHash, loadState, saveState, verifyState, STATE_FILENAME } from '../src/state.js';
import { withTmpDir } from './helpers.js';

const defaultConfig = { paths: { mcpConfig: [] }, network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] } };

function writeMcp(tmpDir, mcpServers) {
  fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({ mcpServers }));
}

function readState(tmpDir) {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, STATE_FILENAME), 'utf-8'));
}

describe('MCP tool hash pinning (state file)', () => {
  it('hash function is stable: same input → same hash', () => {
    const a = computeServerHash({ command: 'node', args: ['-e', 'x'], env: { FOO: 'bar', BAZ: 'qux' } });
    const b = computeServerHash({ command: 'node', args: ['-e', 'x'], env: { BAZ: 'different-value', FOO: 'other-value' } });
    // Same command + args + env keys (values ignored, order-independent for keys)
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('env VALUE change does not change hash (values excluded)', () => {
    const a = computeServerHash({ command: 'node', args: [], env: { TOKEN: 'secret1' } });
    const b = computeServerHash({ command: 'node', args: [], env: { TOKEN: 'secret2' } });
    expect(a).toBe(b);
  });

  it('command change produces different hash', () => {
    const a = computeServerHash({ command: 'node', args: [], env: {} });
    const b = computeServerHash({ command: 'deno', args: [], env: {} });
    expect(a).not.toBe(b);
  });

  it('args change produces different hash (including reorder)', () => {
    const a = computeServerHash({ command: 'node', args: ['a', 'b'], env: {} });
    const b = computeServerHash({ command: 'node', args: ['b', 'a'], env: {} });
    const c = computeServerHash({ command: 'node', args: ['a', 'b', 'c'], env: {} });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('env key set change produces different hash', () => {
    const a = computeServerHash({ command: 'node', args: [], env: { FOO: 'x' } });
    const b = computeServerHash({ command: 'node', args: [], env: { FOO: 'x', BAR: 'y' } });
    expect(a).not.toBe(b);
  });

  it('first scan creates .rigscore-state.json with version:1 and mcpServers map; no warnings', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, {
        'my-server': { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } },
      });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const rugPull = result.findings.find((f) => /rug-pull|hash|changed shape/i.test(f.title || ''));
      expect(rugPull).toBeUndefined();

      const state = readState(tmpDir);
      expect(state.version).toBe(1);
      expect(state.mcpServers).toBeDefined();
      expect(typeof state.mcpServers['my-server']).toBe('string');
      expect(state.mcpServers['my-server']).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it('second scan with unchanged config: hashes match, no warnings', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, {
        'my-server': { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } },
      });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const first = readState(tmpDir);

      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const rugPull = result.findings.find((f) => /rug-pull|hash|changed shape/i.test(f.title || ''));
      expect(rugPull).toBeUndefined();
      const second = readState(tmpDir);
      expect(second.mcpServers['my-server']).toBe(first.mcpServers['my-server']);
    });
  });

  it('WARN when server command changes between scans', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'my-server': { command: 'node', args: [], env: {} } });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });

      writeMcp(tmpDir, { 'my-server': { command: 'deno', args: [], env: {} } });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warn = result.findings.find(
        (f) => f.severity === 'warning' && /my-server/.test(f.title) && /rug-pull|hash|changed shape/i.test(f.title)
      );
      expect(warn).toBeDefined();
    });
  });

  it('WARN when server args change between scans', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'my-server': { command: 'node', args: ['a'], env: {} } });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });

      writeMcp(tmpDir, { 'my-server': { command: 'node', args: ['a', 'b'], env: {} } });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warn = result.findings.find(
        (f) => f.severity === 'warning' && /my-server/.test(f.title) && /rug-pull|hash|changed shape/i.test(f.title)
      );
      expect(warn).toBeDefined();
    });
  });

  it('WARN when env key set changes between scans', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'my-server': { command: 'node', args: [], env: { A: '1' } } });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });

      writeMcp(tmpDir, { 'my-server': { command: 'node', args: [], env: { A: '1', B: '2' } } });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warn = result.findings.find(
        (f) => f.severity === 'warning' && /my-server/.test(f.title) && /rug-pull|hash|changed shape/i.test(f.title)
      );
      expect(warn).toBeDefined();
    });
  });

  it('does NOT warn when only env VALUE changes (values not hashed)', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'my-server': { command: 'node', args: [], env: { TOKEN: 'secret-a' } } });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });

      writeMcp(tmpDir, { 'my-server': { command: 'node', args: [], env: { TOKEN: 'secret-b' } } });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warn = result.findings.find(
        (f) => f.severity === 'warning' && /rug-pull|hash|changed shape/i.test(f.title || '')
      );
      expect(warn).toBeUndefined();
    });
  });

  it('adding a new server records it without warning', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'server-a': { command: 'node', args: [], env: {} } });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });

      writeMcp(tmpDir, {
        'server-a': { command: 'node', args: [], env: {} },
        'server-b': { command: 'python', args: [], env: {} },
      });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warn = result.findings.find(
        (f) => f.severity === 'warning' && /rug-pull|hash|changed shape/i.test(f.title || '')
      );
      expect(warn).toBeUndefined();
      const state = readState(tmpDir);
      expect(state.mcpServers['server-a']).toBeDefined();
      expect(state.mcpServers['server-b']).toBeDefined();
    });
  });

  it('removing a server drops it from state without warning', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, {
        'server-a': { command: 'node', args: [], env: {} },
        'server-b': { command: 'python', args: [], env: {} },
      });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });

      writeMcp(tmpDir, { 'server-a': { command: 'node', args: [], env: {} } });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warn = result.findings.find(
        (f) => f.severity === 'warning' && /rug-pull|hash|changed shape/i.test(f.title || '')
      );
      expect(warn).toBeUndefined();
      const state = readState(tmpDir);
      expect(state.mcpServers['server-b']).toBeUndefined();
      expect(state.mcpServers['server-a']).toBeDefined();
    });
  });

  it('missing .rigscore-state.json is treated as first scan (no warnings)', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'x': { command: 'node', args: [], env: {} } });
      // No pre-existing state file
      expect(fs.existsSync(path.join(tmpDir, STATE_FILENAME))).toBe(false);
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warn = result.findings.find(
        (f) => f.severity === 'warning' && /rug-pull|hash|changed shape/i.test(f.title || '')
      );
      expect(warn).toBeUndefined();
      expect(fs.existsSync(path.join(tmpDir, STATE_FILENAME))).toBe(true);
    });
  });

  // Severity is keyed on the OUTCOME — WARNING here because this tmpdir is not a git repo,
  // so the runtime tool pins the corrupt file may have held cannot be recovered from HEAD.
  // The INFO (recovered) arm lives in test/mcp-corrupt-state-pins.test.js.
  it('corrupted state file produces a finding and resets', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'x': { command: 'node', args: [], env: {} } });
      fs.writeFileSync(path.join(tmpDir, STATE_FILENAME), '{ not valid json ::: ');
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const corrupt = result.findings.find((f) => f.findingId === 'mcp-config/state-file-corrupted');
      expect(corrupt).toBeDefined();
      expect(corrupt.severity).toBe('warning');
      // State file should now be valid
      const state = readState(tmpDir);
      expect(state.version).toBe(1);
      expect(state.mcpServers['x']).toBeDefined();
    });
  });

  it('state file shape is versioned and pretty-printed', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'x': { command: 'node', args: [], env: {} } });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const raw = fs.readFileSync(path.join(tmpDir, STATE_FILENAME), 'utf-8');
      expect(raw).toContain('\n');
      expect(raw).toMatch(/^\{\n {2}"version": 1/);
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
    });
  });
});

// A scan is a *read-only* security scan everywhere else. The one file it writes
// is the TOFU pin — and that write must only ever ESTABLISH or EXTEND the pin,
// never destroy it. Two ways the old unconditional rewrite destroyed it:
//   1. drift → the same scan that reported the rug-pull re-pinned the attacker's
//      hash, so the WARNING fired exactly once and `--verify-state` went green.
//   2. no-op → an identical-content rewrite reformatted / touched a committed
//      pin, dirtying every checkout the scan ran in.
describe('a scan never overwrites an existing pin', () => {
  const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

  it('drift keeps the ORIGINAL pin on disk and keeps re-reporting', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'my-server': { command: 'npx', args: [], env: {} } });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const originalPin = readState(tmpDir).mcpServers['my-server'];

      // Rug-pull: same server name, new command.
      writeMcp(tmpDir, { 'my-server': { command: 'node', args: [], env: {} } });
      const second = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      expect(second.findings.find((f) => f.findingId === 'mcp-config/server-hash-drift')).toBeDefined();
      expect(readState(tmpDir).mcpServers['my-server']).toBe(originalPin);

      // The evidence survives: a third scan still reports it, and the CI gate still fails.
      const third = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      expect(third.findings.find((f) => f.findingId === 'mcp-config/server-hash-drift')).toBeDefined();
      expect((await verifyState(tmpDir)).status).toBe('drift');
    });
  });

  it('an unchanged scan leaves a committed pin byte-for-byte identical', async () => {
    await withTmpDir(async (tmpDir) => {
      const server = { command: 'node', args: [], env: {} };
      writeMcp(tmpDir, { 'my-server': server });
      // Compact, hand-committed pin — the shape the verify-state fixtures ship.
      const committed = JSON.stringify({ version: 1, mcpServers: { 'my-server': computeServerHash(server) } });
      fs.writeFileSync(path.join(tmpDir, STATE_FILENAME), committed);

      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      expect(fs.readFileSync(path.join(tmpDir, STATE_FILENAME), 'utf-8')).toBe(committed);
    });
  });

  it.each(['verify-state-clean', 'verify-state-drift'])(
    'scanning a copy of the tracked %s fixture does not mutate its pin',
    async (name) => {
      await withTmpDir(async (tmpDir) => {
        const src = path.join(FIXTURES, name);
        for (const f of ['.mcp.json', STATE_FILENAME]) {
          fs.copyFileSync(path.join(src, f), path.join(tmpDir, f));
        }
        const before = fs.readFileSync(path.join(tmpDir, STATE_FILENAME), 'utf-8');
        const gateBefore = (await verifyState(tmpDir)).status;

        await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });

        expect(fs.readFileSync(path.join(tmpDir, STATE_FILENAME), 'utf-8')).toBe(before);
        expect((await verifyState(tmpDir)).status).toBe(gateBefore);
      });
    },
  );

  it('accepting drift: drop the entry from mcpServers, re-scan, and it re-pins', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'my-server': { command: 'npx', args: [], env: {} } });
      await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      await saveState(tmpDir, { version: 1, mcpServers: {}, servers: { 'my-server': { runtimeToolHash: 'abc' } } });

      writeMcp(tmpDir, { 'my-server': { command: 'node', args: [], env: {} } });
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      expect(result.findings.find((f) => f.findingId === 'mcp-config/server-hash-drift')).toBeUndefined();

      const state = readState(tmpDir);
      expect(state.mcpServers['my-server']).toBe(computeServerHash({ command: 'node', args: [], env: {} }));
      // The runtime tool-hash pins written by `rigscore mcp-pin` survive the re-pin.
      expect(state.servers['my-server'].runtimeToolHash).toBe('abc');
    });
  });
});

describe('state.js helpers', () => {
  it('loadState returns null when file missing', async () => {
    await withTmpDir(async (tmpDir) => {
      const result = await loadState(tmpDir);
      expect(result.state).toBeNull();
      expect(result.corrupt).toBe(false);
    });
  });

  it('loadState returns corrupt=true for invalid JSON', async () => {
    await withTmpDir(async (tmpDir) => {
      fs.writeFileSync(path.join(tmpDir, STATE_FILENAME), 'not-json');
      const result = await loadState(tmpDir);
      expect(result.state).toBeNull();
      expect(result.corrupt).toBe(true);
    });
  });

  it('saveState writes pretty-printed JSON', async () => {
    await withTmpDir(async (tmpDir) => {
      await saveState(tmpDir, { version: 1, mcpServers: { a: 'hash' } });
      const raw = fs.readFileSync(path.join(tmpDir, STATE_FILENAME), 'utf-8');
      expect(raw).toMatch(/\n {2}"version": 1/);
    });
  });
});
