import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/mcp-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-mcp-'));
}

const defaultConfig = { paths: { mcpConfig: [] }, network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] } };

describe('mcp-config check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('mcp-config');
    expect(check.weight).toBe(15);
  });

  it('PASS with clean stdio config', async () => {
    const result = await check.run({ cwd: fixture('mcp-clean'), homedir: '/tmp/nonexistent', config: defaultConfig });
    const critical = result.findings.find((f) => f.severity === 'critical');
    expect(critical).toBeUndefined();
  });

  it('CRITICAL when root filesystem access', async () => {
    const result = await check.run({ cwd: fixture('mcp-root'), homedir: '/tmp/nonexistent', config: defaultConfig });
    const critical = result.findings.find((f) => f.severity === 'critical');
    expect(critical).toBeDefined();
    expect(critical.title).toMatch(/root|filesystem/i);
  });

  it('CRITICAL/WARNING for env passthrough and SSE transport', async () => {
    const result = await check.run({ cwd: fixture('mcp-passthrough'), homedir: '/tmp/nonexistent', config: defaultConfig });
    const issues = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning');
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it('INFO when no MCP config found', async () => {
    const result = await check.run({ cwd: fixture('mcp-none'), homedir: '/tmp/nonexistent', config: defaultConfig });
    const info = result.findings.find((f) => f.severity === 'info');
    expect(info).toBeDefined();
    expect(result.score).toBe(-1);
  });

  it('downgrades localhost MCP server from WARNING to INFO', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'local-server': {
          transport: 'http',
          url: 'http://127.0.0.1:8080/mcp',
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const info = result.findings.find((f) => f.severity === 'info' && f.title.includes('localhost'));
      expect(info).toBeDefined();
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('network transport'));
      expect(warning).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('reads additional MCP config paths from config', async () => {
    const tmpDir = makeTmpDir();
    const externalDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'risky-server': {
          command: 'npx',
          args: ['@some/mcp-server', '/'],
        },
      },
    };
    fs.writeFileSync(path.join(externalDir, 'mcp.json'), JSON.stringify(mcpConfig));
    const cfg = { ...defaultConfig, paths: { mcpConfig: [path.join(externalDir, 'mcp.json')] } };
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: cfg });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('filesystem'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
      fs.rmSync(externalDir, { recursive: true });
    }
  });
});
