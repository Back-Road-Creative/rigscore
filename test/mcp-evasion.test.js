import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/mcp-config.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-mcp-'));
}

const defaultConfig = { paths: { mcpConfig: [] }, network: {} };

describe('MCP filesystem scope evasion', () => {
  it('detects --directory=/ flag-style root access', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '--directory=/'] },
      },
    }));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('filesystem'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects --root /home flag-style access', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['server-fs', '--root', '/home'] },
      },
    }));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('filesystem'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects standalone / path arg', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['server-fs', '/'] },
      },
    }));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('filesystem'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects /etc path in --allowed-directories', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['server-fs', '--allowed-directories', '/etc,/tmp'] },
      },
    }));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('filesystem'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('allows project-scoped paths', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['server-fs', '--directory=/home/user/project'] },
      },
    }));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('filesystem'));
      expect(critical).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects /var sensitive path', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['server-fs', '/var'] },
      },
    }));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('filesystem'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
