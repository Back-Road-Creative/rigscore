import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import check from '../src/checks/mcp-config.js';
import { levenshtein, findTyposquatMatch, KNOWN_MCP_SERVERS } from '../src/known-mcp-servers.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-mcp-sc-'));
}

const defaultConfig = { paths: { mcpConfig: [] }, network: {} };

describe('Levenshtein distance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('returns 1 for single char difference', () => {
    expect(levenshtein('abc', 'abx')).toBe(1);
  });

  it('returns 2 for two char differences', () => {
    expect(levenshtein('abc', 'axx')).toBe(2);
  });

  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
});

describe('findTyposquatMatch', () => {
  it('returns null for exact match (distance 0)', () => {
    expect(findTyposquatMatch('@modelcontextprotocol/server-memory')).toBeNull();
  });

  it('returns known server for distance 1', () => {
    // "memorx" is 1 edit from "memory"
    const result = findTyposquatMatch('@modelcontextprotocol/server-memorx');
    expect(result).toBe('@modelcontextprotocol/server-memory');
  });

  it('returns known server for distance 2', () => {
    const result = findTyposquatMatch('@modelcontextprotocol/server-memori');
    expect(result).toBe('@modelcontextprotocol/server-memory');
  });

  it('returns null for distance > 2', () => {
    expect(findTyposquatMatch('@modelcontextprotocol/server-totally-different')).toBeNull();
  });

  it('returns null for unrelated packages', () => {
    expect(findTyposquatMatch('express')).toBeNull();
  });
});

describe('MCP supply chain - offline tier', () => {
  it('WARNING for typosquat-like package name', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
        mcpServers: {
          suspect: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-memorx'],
          },
        },
      }));
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig, online: false });
      const warning = result.findings.find(f => f.severity === 'warning' && f.title.includes('similar to known'));
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('no typosquat warning for exact known package', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
        mcpServers: {
          mem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'],
          },
        },
      }));
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig, online: false });
      const warning = result.findings.find(f => f.title.includes('similar to known'));
      expect(warning).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns data.hasNetworkTransport and data.hasBroadFilesystemAccess', async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
        mcpServers: {
          safe: {
            command: 'node',
            args: ['server.js'],
          },
        },
      }));
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig, online: false });
      expect(result.data).toBeDefined();
      expect(result.data.hasNetworkTransport).toBe(false);
      expect(result.data.hasBroadFilesystemAccess).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
