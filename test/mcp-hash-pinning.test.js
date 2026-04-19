import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import check from '../src/checks/mcp-config.js';
import { computeServerHash, loadState, saveState, STATE_FILENAME } from '../src/state.js';
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

  it('corrupted state file produces INFO and resets', async () => {
    await withTmpDir(async (tmpDir) => {
      writeMcp(tmpDir, { 'x': { command: 'node', args: [], env: {} } });
      fs.writeFileSync(path.join(tmpDir, STATE_FILENAME), '{ not valid json ::: ');
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const info = result.findings.find(
        (f) => f.severity === 'info' && /state/i.test(f.title || '')
      );
      expect(info).toBeDefined();
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
