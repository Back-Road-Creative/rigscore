import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/mcp-config.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-mcp-exp-'));
}

const defaultConfig = { paths: { mcpConfig: [] }, network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] } };

describe('MCP check expansion', () => {
  it('WARNING for unsafe permission flags', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'bad-server': {
          command: 'node',
          args: ['server.js', '--allow-all'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const finding = result.findings.find(f => f.title?.includes('unsafe permission'));
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('warning');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('cross-client drift detection: divergent configs', async () => {
    const tmpDir = makeTmpDir();
    const homedir = makeTmpDir();

    // Two different configs for same server
    const config1 = {
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js', '--port', '3000'] },
      },
    };
    const config2 = {
      mcpServers: {
        'my-server': { command: 'node', args: ['server.js', '--port', '4000'] },
      },
    };

    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(config1));
    fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.vscode', 'mcp.json'), JSON.stringify(config2));

    try {
      const result = await check.run({ cwd: tmpDir, homedir, config: defaultConfig });
      const drift = result.findings.find(f => f.title?.includes('drift'));
      expect(drift).toBeDefined();
      expect(drift.severity).toBe('warning');
      expect(result.data.driftDetected).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(homedir, { recursive: true });
    }
  });

  it('returns enriched data exports', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'server-a': { command: 'node', args: ['a.js'] },
        'server-b': { command: 'node', args: ['b.js'] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      expect(result.data.serverCount).toBe(2);
      expect(result.data.clientCount).toBe(1);
      expect(typeof result.data.driftDetected).toBe('boolean');
      expect(typeof result.data.hasNetworkTransport).toBe('boolean');
      expect(typeof result.data.hasBroadFilesystemAccess).toBe('boolean');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('N/A data exports when no config found', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      expect(result.data.serverCount).toBe(0);
      expect(result.data.clientCount).toBe(0);
      expect(result.data.driftDetected).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
