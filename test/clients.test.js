import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  CLIENTS, governanceFiles, mcpConfigPaths, credentialClients, networkMcpPaths, mcpServersIn,
} from '../src/clients.js';

const CWD = '/proj';
const HOME = '/home/u';

// The literals the four consumers hardcoded before the registry existed. Every one MUST
// still be produced — the registry is a superset of the old lists, never a subset.
const LEGACY_GOVERNANCE = [
  'CLAUDE.md', '.cursorrules', '.windsurfrules', '.clinerules', '.continuerules',
  'copilot-instructions.md', '.github/copilot-instructions.md', 'AGENTS.md', '.aider.conf.yml',
];
const LEGACY_MCP = [
  [CWD, '.mcp.json'], [CWD, '.vscode/mcp.json'],
  [HOME, '.claude/claude_desktop_config.json'], [HOME, '.cursor/mcp.json'],
  [HOME, '.cline/mcp_settings.json'], [HOME, '.continue/config.json'],
  [HOME, '.windsurf/mcp.json'], [HOME, '.config/zed/settings.json'], [HOME, '.amp/mcp.json'],
];
const LEGACY_CREDENTIALS = [
  ['.claude', 'claude_desktop_config.json'], ['.cursor', 'mcp.json'],
  ['.cline', 'mcp_settings.json'], ['.continue', 'config.json'],
  ['.windsurf', 'mcp.json'], ['.amp', 'mcp.json'],
];

describe('client registry invariants', () => {
  it('has unique ids and a name for every client', () => {
    const ids = CLIENTS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CLIENTS) expect(c.name).toBeTruthy();
  });

  it('declares only cwd/home bases and non-empty paths', () => {
    for (const c of CLIENTS) {
      for (const e of [...(c.mcp || []), ...(c.sandbox || [])]) {
        expect(['cwd', 'home']).toContain(e.base);
        expect(e.path.length).toBeGreaterThan(0);
      }
      for (const f of c.governance || []) expect(f.length).toBeGreaterThan(0);
      for (const cr of c.credentials || []) {
        expect(cr.dir.length).toBeGreaterThan(0);
        expect(cr.file.length).toBeGreaterThan(0);
      }
    }
  });

  it('emits governance files with no duplicates', () => {
    const files = governanceFiles();
    expect(new Set(files).size).toBe(files.length);
  });

  it('covers the new clients (Codex CLI, Gemini CLI, opencode)', () => {
    for (const id of ['codex', 'gemini', 'opencode']) {
      expect(CLIENTS.find(c => c.id === id), id).toBeTruthy();
    }
    const paths = mcpConfigPaths(CWD, HOME);
    expect(paths).toContain(path.join(HOME, '.gemini/settings.json'));
    expect(paths).toContain(path.join(HOME, '.config/opencode/opencode.json'));
    const codex = CLIENTS.find(c => c.id === 'codex');
    expect(codex.sandbox.some(s => s.path === '.codex/config.toml' && s.format === 'toml')).toBe(true);
  });
});

describe('no regression vs the old hardcoded lists', () => {
  it('produces every legacy governance file', () => {
    for (const f of LEGACY_GOVERNANCE) expect(governanceFiles(), f).toContain(f);
  });

  it('produces every legacy MCP path (mcp-config and network-exposure)', () => {
    const mcp = mcpConfigPaths(CWD, HOME);
    const net = networkMcpPaths(CWD, HOME);
    for (const [base, rel] of LEGACY_MCP) {
      expect(mcp, rel).toContain(path.join(base, rel));
      expect(net, rel).toContain(path.join(base, rel));
    }
  });

  it('produces every legacy credential client', () => {
    const clients = credentialClients();
    for (const [dir, file] of LEGACY_CREDENTIALS) {
      expect(clients.some(c => c.dir === dir && c.file === file && c.name), file).toBe(true);
    }
  });
});

describe('mcpServersIn', () => {
  it('reads mcpServers by default and opencode\'s "mcp" key', () => {
    const servers = { a: { command: 'x' } };
    expect(mcpServersIn(path.join(CWD, '.mcp.json'), { mcpServers: servers })).toEqual(servers);
    expect(mcpServersIn(path.join(CWD, 'opencode.json'), { mcp: servers })).toEqual(servers);
    // A gemini settings.json `mcp` block holds discovery settings, not servers — never read as servers.
    expect(mcpServersIn(path.join(HOME, '.gemini/settings.json'), { mcp: { allowed: [] } })).toEqual({});
  });

  it('returns {} for missing or non-object servers; unknown paths default to mcpServers', () => {
    expect(mcpServersIn(path.join(CWD, '.mcp.json'), null)).toEqual({});
    expect(mcpServersIn(path.join(CWD, '.mcp.json'), { mcpServers: 'nope' })).toEqual({});
    expect(mcpServersIn('/custom/user/path.json', { mcpServers: { a: {} } })).toEqual({ a: {} });
  });
});
