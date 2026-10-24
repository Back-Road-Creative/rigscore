import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashTools } from '../src/mcp-hash.js';
import { STATE_FILENAME } from '../src/state.js';
import { withTmpDir } from './helpers.js';
import { describePlan } from '../src/cli/mcp-subcommands.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'rigscore.js');

// A stdio MCP stub: records that it was launched (marker file in its cwd) and
// answers initialize + tools/list over newline-delimited JSON-RPC.
const STUB = `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync('spawned.marker', JSON.stringify({ desc: process.env.STUB_DESC || null, leak: process.env.RIGSCORE_TEST_SECRET || null }));
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: process.env.STUB_DESC || 'echo', inputSchema: { type: 'object' } }] } });
  }
});
`;

function setup(tmpDir, { desc = 'one', command = process.execPath, args } = {}) {
  const stubPath = path.join(tmpDir, 'stub.cjs');
  fs.writeFileSync(stubPath, STUB);
  fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
    mcpServers: { stub: { command, args: args || [stubPath], env: { STUB_DESC: desc } } },
  }));
  return stubPath;
}

function run(tmpDir, args, extraEnv = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf-8',
    input: '',
    timeout: 30000,
    env: { ...process.env, NO_COLOR: '1', ...extraEnv },
  });
}

const expectedHash = (desc) => hashTools({
  result: { tools: [{ name: 'echo', description: desc, inputSchema: { type: 'object' } }] },
});
const marker = (tmpDir) => path.join(tmpDir, 'spawned.marker');

describe('mcp --connect: consent gate (nothing spawns without it)', () => {
  it('refuses without --yes when stdin is not a terminal, and spawns nothing', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir);
      const res = run(tmpDir, ['mcp-pin', 'stub', '--connect']);
      expect(res.status).toBe(2);
      expect(fs.existsSync(marker(tmpDir))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, STATE_FILENAME))).toBe(false);
      expect(res.stderr).toMatch(/consent/i);
    });
  });

  it('shows the exact argv before refusing', async () => {
    await withTmpDir(async (tmpDir) => {
      const stubPath = setup(tmpDir);
      const res = run(tmpDir, ['mcp-hash', '--connect', 'stub']);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain(process.execPath);
      expect(res.stderr).toContain(stubPath);
      expect(res.stderr).toContain('STUB_DESC');
      expect(res.stderr).not.toContain('=one');
    });
  });

  it('prints a Windows path as the user would type it, backslashes not doubled', () => {
    const command = 'C:\\hostedtoolcache\\windows\\node\\22.23.4\\x64\\node.exe';
    const script = 'C:\\Users\\RUNNER~1\\Temp\\new dir\\stub.cjs';
    const text = describePlan('stub', { source: '.mcp.json', command, args: [script], cwd: 'C:\\Users\\RUNNER~1\\Temp', envKeys: [] });
    expect(text).toContain(command);
    expect(text).toContain(script);
    expect(text).not.toContain('\\\\');
  });

  it('keeps the argv line one unambiguous line: control characters and quotes are made visible', () => {
    const text = describePlan('stub', { source: '.mcp.json', command: 'node', args: ['a\nenv:     forged', 'say "hi"', 'dir\\'], cwd: '/p', envKeys: [] });
    const argvLine = text.split('\n').filter((l) => l.startsWith('  argv:'));
    expect(argvLine).toHaveLength(1);
    expect(text.split('\n').filter((l) => l.startsWith('  env:'))).toHaveLength(1);
    expect(argvLine[0]).toContain('"say \\"hi\\""');
    expect(argvLine[0]).toContain('"dir\\\\"');
  });

  it('a project .rigscorerc.json cannot grant consent', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir);
      fs.writeFileSync(path.join(tmpDir, '.rigscorerc.json'), JSON.stringify({ mcpConfig: { connect: true, yes: true } }));
      const res = run(tmpDir, ['mcp-hash', '--connect', 'stub']);
      expect(res.status).toBe(2);
      expect(fs.existsSync(marker(tmpDir))).toBe(false);
    });
  });

  it('a default scan never spawns a configured server', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir);
      run(tmpDir, ['--json', '--no-state-write', tmpDir]);
      expect(fs.existsSync(marker(tmpDir))).toBe(false);
    });
  });
});

describe('mcp --connect: with consent', () => {
  it('mcp-hash --connect <server> --yes prints the hash of the live tools/list', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir, { desc: 'one' });
      const res = run(tmpDir, ['mcp-hash', '--connect', 'stub', '--yes']);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(expectedHash('one'));
      expect(fs.existsSync(marker(tmpDir))).toBe(true);
    });
  });

  it('mcp-pin <server> --connect --yes pins the stub tools hash', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir, { desc: 'one' });
      const res = run(tmpDir, ['mcp-pin', 'stub', '--connect', '--yes']);
      expect(res.status).toBe(0);
      const state = JSON.parse(fs.readFileSync(path.join(tmpDir, STATE_FILENAME), 'utf-8'));
      expect(state.servers.stub.runtimeToolHash).toBe(expectedHash('one'));
    });
  });

  it('mcp-verify --connect --yes exits 0 on a match and 4 on drift', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir, { desc: 'one' });
      expect(run(tmpDir, ['mcp-pin', 'stub', '--connect', '--yes']).status).toBe(0);
      expect(run(tmpDir, ['mcp-verify', 'stub', '--connect', '--yes']).status).toBe(0);
      setup(tmpDir, { desc: 'two' });
      const drift = run(tmpDir, ['mcp-verify', 'stub', '--connect', '--yes']);
      expect(drift.status).toBe(4);
      expect(drift.stderr).toMatch(/drift/i);
    });
  });

  it('does not hand the operator environment to the server', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir);
      run(tmpDir, ['mcp-hash', '--connect', 'stub', '--yes'], { RIGSCORE_TEST_SECRET: 'hunter2' });
      const seen = JSON.parse(fs.readFileSync(marker(tmpDir), 'utf-8'));
      expect(seen.leak).toBeNull();
      expect(seen.desc).toBe('one');
    });
  });

  it('exits non-zero when the server never answers (timeout), without hanging', async () => {
    await withTmpDir(async (tmpDir) => {
      const silent = path.join(tmpDir, 'silent.cjs');
      fs.writeFileSync(silent, 'setInterval(() => {}, 1000);');
      setup(tmpDir, { args: [silent] });
      const res = run(tmpDir, ['mcp-hash', '--connect', 'stub', '--yes'], { RIGSCORE_CONNECT_TIMEOUT_MS: '500' });
      expect(res.status).toBe(5);
      expect(res.stderr).toMatch(/timed out|did not respond/i);
    });
  });
});

describe('mcp --connect: refusals', () => {
  it('rejects an unknown server name without spawning', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir);
      const res = run(tmpDir, ['mcp-hash', '--connect', 'nope', '--yes']);
      expect(res.status).toBe(2);
      expect(fs.existsSync(marker(tmpDir))).toBe(false);
    });
  });

  it('rejects a remote (url) server: only local stdio servers are launched', async () => {
    await withTmpDir(async (tmpDir) => {
      fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
        mcpServers: { remote: { url: 'https://example.com/mcp' } },
      }));
      const res = run(tmpDir, ['mcp-hash', '--connect', 'remote', '--yes']);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/stdio/i);
    });
  });

  it.skipIf(process.platform === 'win32')('refuses a relative command that resolves through a symlink outside the project', async () => {
    await withTmpDir(async (tmpDir) => {
      await withTmpDir(async (outside) => {
        const project = path.join(tmpDir, 'project');
        fs.mkdirSync(project);
        const outsideScript = path.join(outside, 'srv.cjs');
        fs.writeFileSync(outsideScript, STUB);
        fs.symlinkSync(outsideScript, path.join(project, 'srv.cjs'));
        fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
          mcpServers: { stub: { command: './srv.cjs' } },
        }));
        const res = run(project, ['mcp-hash', '--connect', 'stub', '--yes']);
        expect(res.status).toBe(2);
        expect(res.stderr).toMatch(/outside/i);
        expect(fs.existsSync(path.join(project, 'spawned.marker'))).toBe(false);
        expect(fs.existsSync(path.join(outside, 'spawned.marker'))).toBe(false);
      });
    });
  });

  it('rejects --connect combined with a pasted hash', async () => {
    await withTmpDir(async (tmpDir) => {
      setup(tmpDir);
      const res = run(tmpDir, ['mcp-pin', 'stub', 'a'.repeat(64), '--connect', '--yes']);
      expect(res.status).toBe(2);
      expect(fs.existsSync(marker(tmpDir))).toBe(false);
    });
  });
});

describe('mcp --connect: launch robustness', () => {
  it('accepts a server that answers tools/list and exits immediately', async () => {
    await withTmpDir(async (tmpDir) => {
      const quick = path.join(tmpDir, 'quick.cjs');
      fs.writeFileSync(quick, `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'q', version: '1' } } }) + '\\n');
  } else if (m.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'quick', inputSchema: { type: 'object' } }] } }) + '\\n', () => process.exit(0));
  }
});
`);
      setup(tmpDir, { args: [quick] });
      const res = run(tmpDir, ['mcp-hash', '--connect', 'stub', '--yes']);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(expectedHash('quick'));
    });
  });

  it.skipIf(process.platform === 'win32')('kills the whole process group, not only the direct child', async () => {
    await withTmpDir(async (tmpDir) => {
      const wrapper = path.join(tmpDir, 'wrapper.cjs');
      fs.writeFileSync(wrapper, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
// Like an npx wrapper: a long-lived grandchild that ignores stdin closing.
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(__dirname, 'grandchild.pid'), String(g.pid));
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'w', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
});
`);
      setup(tmpDir, { args: [wrapper] });
      const res = run(tmpDir, ['mcp-hash', '--connect', 'stub', '--yes']);
      expect(res.status).toBe(0);
      const pid = Number(fs.readFileSync(path.join(tmpDir, 'grandchild.pid'), 'utf-8'));
      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
      }
      if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      expect(alive).toBe(false);
    });
  });
});

describe('mcp --connect: launch plan resolution', () => {
  it.skipIf(process.platform === 'win32')('refuses a relative script arg that is a symlink outside the project', async () => {
    await withTmpDir(async (tmpDir) => {
      await withTmpDir(async (outside) => {
        const project = path.join(tmpDir, 'project');
        fs.mkdirSync(project);
        const outsideScript = path.join(outside, 'srv.cjs');
        fs.writeFileSync(outsideScript, STUB);
        fs.symlinkSync(outsideScript, path.join(project, 'srv.cjs'));
        fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({
          mcpServers: { stub: { command: 'node', args: ['./srv.cjs'] } },
        }));
        const res = run(project, ['mcp-hash', '--connect', 'stub', '--yes']);
        expect(res.status).toBe(2);
        expect(res.stderr).toMatch(/outside/i);
        expect(fs.existsSync(path.join(project, 'spawned.marker'))).toBe(false);
        expect(fs.existsSync(path.join(outside, 'spawned.marker'))).toBe(false);
      });
    });
  });

  it('launches an opencode-style server (command array, environment key)', async () => {
    await withTmpDir(async (tmpDir) => {
      const stubPath = path.join(tmpDir, 'stub.cjs');
      fs.writeFileSync(stubPath, STUB);
      fs.writeFileSync(path.join(tmpDir, 'opencode.json'), JSON.stringify({
        mcp: { stub: { type: 'local', command: [process.execPath, stubPath], environment: { STUB_DESC: 'oc' } } },
      }));
      const res = run(tmpDir, ['mcp-hash', '--connect', 'stub', '--yes']);
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe(expectedHash('oc'));
    });
  });
});

describe('mcp --connect: spawn code stays out of the scan path', () => {
  it('only the mcp subcommands import src/lib/mcp-connect.js', () => {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const importers = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.js') && /mcp-connect(\.js)?['"]/.test(fs.readFileSync(p, 'utf-8'))) {
          importers.push(path.relative(srcDir, p).split(path.sep).join('/'));
        }
      }
    })(srcDir);
    expect(importers).toEqual(['cli/mcp-subcommands.js']);
  });
});
