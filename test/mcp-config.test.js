import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import check from '../src/checks/mcp-config.js';
import { WEIGHTS } from '../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-mcp-'));
}

const defaultConfig = { paths: { mcpConfig: [] }, network: { safeHosts: ['127.0.0.1', 'localhost', '::1'] } };

describe('mcp-config check', () => {
  it('has required shape', () => {
    expect(check.id).toBe('mcp-config');
    expect(WEIGHTS[check.id]).toBe(14);
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

  it('WARNING when wildcard env passthrough via process.env', async () => {
    const tmpDir = makeTmpDir();
    const raw = '{"mcpServers": {"test": {"command": "node", "args": [], "env": {"ALL": "...process.env"}}}}';
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), raw);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warning = result.findings.find((f) => f.severity === 'warning' && f.title.includes('Wildcard env'));
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('parses JSONC config files with comments', async () => {
    const tmpDir = makeTmpDir();
    const jsonc = `{
  // This is a comment
  "mcpServers": {
    "test-server": {
      "command": "node",
      "args": ["server.js", "/"],
      /* block comment */
    }
  }
}`;
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), jsonc);
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      // Should parse successfully and find the root filesystem access
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('filesystem'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING when npx server has no pinned version', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'unpinned-server': {
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', '--directory', './data'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('unpinned'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING when npx server uses unstable tag @next', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'next-server': {
          command: 'npx',
          args: ['some-mcp-server@next'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('unpinned'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING when npx server uses unstable tag @dev', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'dev-server': {
          command: 'npx',
          args: ['some-mcp-server@dev'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('unpinned'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING for scoped package with @latest tag', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'scoped-latest': {
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem@latest', '--directory', './data'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('unpinned'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING for scoped package with @nightly tag', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'scoped-nightly': {
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem@nightly'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('unpinned'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('NO warning for scoped package with semver pin', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'pinned-scoped': {
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem@1.2.3', '--directory', './data'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('unpinned'),
      );
      expect(warning).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('NO warning for unscoped package with semver pin', async () => {
    const tmpDir = makeTmpDir();
    const mcpConfig = {
      mcpServers: {
        'pinned-unscoped': {
          command: 'npx',
          args: ['some-mcp-server@2.0.1'],
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
    try {
      const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('unpinned'),
      );
      expect(warning).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('WARNING for all unstable distribution tags', async () => {
    const unstableTags = ['latest', 'next', 'main', 'dev', 'nightly', 'canary', 'beta', 'alpha', 'rc'];
    for (const tag of unstableTags) {
      const tmpDir = makeTmpDir();
      const mcpConfig = {
        mcpServers: {
          'test-server': {
            command: 'npx',
            args: [`some-mcp-server@${tag}`],
          },
        },
      };
      fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(mcpConfig));
      try {
        const result = await check.run({ cwd: tmpDir, homedir: '/tmp/nonexistent', config: defaultConfig });
        const warning = result.findings.find(
          (f) => f.severity === 'warning' && f.title.includes('unpinned'),
        );
        expect(warning, `Expected warning for unstable tag @${tag}`).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
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
