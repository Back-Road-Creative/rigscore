import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check, { checkInlineCredentials } from '../src/checks/mcp-config.js';
import { mcpServersIn } from '../src/clients.js';

// Zed stores MCP servers under `context_servers`, not `mcpServers`.
// Source: github.com/zed-industries/zed/blob/main/docs/src/ai/mcp.md
// (rendered at zed.dev/docs/ai/mcp), verified 2026-07-12.

const defaultConfig = { paths: { mcpConfig: [] }, network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] } };

let tmpHome;
let tmpCwd;

function writeZedSettings(settings) {
  const dir = path.join(tmpHome, '.config', 'zed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-zed-home-'));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-zed-cwd-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('Zed uses context_servers, not mcpServers', () => {
  it('mcpServersIn reads Zed servers out of context_servers', () => {
    const servers = { linear: { command: 'npx', args: ['-y', 'linear-mcp@1.0.0'] } };
    const zedPath = path.join(tmpHome, '.config', 'zed', 'settings.json');
    expect(mcpServersIn(zedPath, { context_servers: servers })).toEqual(servers);
    // Zed itself ignores an `mcpServers` key, so rigscore must not read one there.
    expect(mcpServersIn(zedPath, { mcpServers: servers })).toEqual({});
  });

  it('scans a Zed local server (command/args/env) declared under context_servers', async () => {
    writeZedSettings({
      context_servers: {
        'fs-server': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/'],
          env: { GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', OPENAI_API_KEY: 'z' },
        },
      },
    });

    const result = await check.run({ cwd: tmpCwd, homedir: tmpHome, config: defaultConfig, writeState: false });

    expect(result.data.serverCount).toBe(1);
    expect(result.data.serverNames).toContain('fs-server');
    expect(result.data.hasBroadFilesystemAccess).toBe(true);
    expect(result.findings.some(f => f.findingId === 'mcp-config/broad-filesystem-access')).toBe(true);
    expect(result.findings.some(f => f.findingId === 'mcp-config/no-config-found')).toBe(false);
  });

  it('flags a network transport on a Zed remote server (url/headers shape)', async () => {
    writeZedSettings({
      context_servers: { remote: { url: 'https://mcp.example.com/mcp' } },
    });

    const result = await check.run({ cwd: tmpCwd, homedir: tmpHome, config: defaultConfig, writeState: false });

    expect(result.data.hasNetworkTransport).toBe(true);
    expect(result.findings.some(f => f.findingId === 'mcp-config/network-transport')).toBe(true);
  });

  it('flags an inline credential in a remote server`s headers', () => {
    const server = { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' } };
    const findings = checkInlineCredentials(server, 'remote', '.config/zed/settings.json');
    expect(findings).toHaveLength(1);
    expect(findings[0].findingId).toBe('mcp-config/inline-credentials');
    expect(findings[0].severity).toBe('critical');
  });

  it('does not flag a headerless or placeholder-header remote server', () => {
    expect(checkInlineCredentials({ url: 'https://mcp.example.com/mcp' }, 'a', 'p')).toEqual([]);
    expect(checkInlineCredentials(
      { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer <token>' } }, 'b', 'p',
    )).toEqual([]);
  });
});
