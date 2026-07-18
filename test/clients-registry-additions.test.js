import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  CLIENTS, governanceFiles, mcpConfigPaths, credentialClients, networkMcpPaths,
  repoMcpRelPaths, skillDirsForBase, governanceDirDefaults, mcpServersIn,
} from '../src/clients.js';

const CWD = '/proj';
const HOME = '/home/u';
const mcp = () => mcpConfigPaths(CWD, HOME);
const creds = () => credentialClients();
const hasCred = (dir, file) => creds().some((c) => c.dir === dir && c.file === file && c.name);

// RS-9: three entries scanned paths no real install writes to — a silent no-op the registry's own
// comment already documented. Corrected to vendor locations; the OLD paths must be GONE.
describe('RS-9: vendor-documented MCP/credential paths (were silent no-ops)', () => {
  it('Windsurf: ~/.codeium/windsurf/mcp_config.json (not ~/.windsurf/mcp.json)', () => {
    expect(mcp()).toContain(path.join(HOME, '.codeium/windsurf/mcp_config.json'));
    expect(mcp()).not.toContain(path.join(HOME, '.windsurf/mcp.json'));
    expect(hasCred('.codeium/windsurf', 'mcp_config.json')).toBe(true);
  });
  it('Cline: ~/.cline/data/settings/cline_mcp_settings.json (not ~/.cline/mcp_settings.json)', () => {
    expect(mcp()).toContain(path.join(HOME, '.cline/data/settings/cline_mcp_settings.json'));
    expect(mcp()).not.toContain(path.join(HOME, '.cline/mcp_settings.json'));
    expect(hasCred('.cline/data/settings', 'cline_mcp_settings.json')).toBe(true);
  });
  it('Claude Desktop: ~/.config/Claude/claude_desktop_config.json (not ~/.claude/…)', () => {
    expect(mcp()).toContain(path.join(HOME, '.config/Claude/claude_desktop_config.json'));
    expect(mcp()).not.toContain(path.join(HOME, '.claude/claude_desktop_config.json'));
    expect(hasCred('.config/Claude', 'claude_desktop_config.json')).toBe(true);
  });
});

describe('RS-20: new real-world clients', () => {
  it('registers OpenHands / Kilo Code / Trae / Augment Code / Replit', () => {
    for (const id of ['openhands', 'kilo-code', 'trae', 'augment', 'replit']) {
      expect(CLIENTS.find((c) => c.id === id), id).toBeTruthy();
    }
  });
  it('governance files: OpenHands repo microagent, Trae, Augment, Replit', () => {
    for (const f of ['.openhands/microagents/repo.md', '.trae/rules/project_rules.md', '.augment-guidelines', 'replit.md']) {
      expect(governanceFiles(), f).toContain(f);
    }
  });
  it('Kilo Code: committed .kilocode/mcp.json (mcpServers) is a rug-pull surface', () => {
    expect(mcp()).toContain(path.join(CWD, '.kilocode/mcp.json'));
    expect(repoMcpRelPaths()).toContain('.kilocode/mcp.json');
    const servers = { s: { command: 'node' } };
    expect(mcpServersIn(path.join(CWD, '.kilocode/mcp.json'), { mcpServers: servers })).toEqual(servers);
  });
  it('Copilot CLI MCP folds into the GitHub Copilot client (home mcpServers + creds, unpinned)', () => {
    expect(mcp()).toContain(path.join(HOME, '.copilot/mcp-config.json'));
    expect(networkMcpPaths(CWD, HOME)).toContain(path.join(HOME, '.copilot/mcp-config.json'));
    const servers = { s: { command: 'node', env: { TOKEN: 'x' } } };
    expect(mcpServersIn(path.join(HOME, '.copilot/mcp-config.json'), { mcpServers: servers })).toEqual(servers);
    expect(hasCred('.copilot', 'mcp-config.json')).toBe(true);
    expect(repoMcpRelPaths()).not.toContain('.copilot/mcp-config.json');
  });
  it('JetBrains AI Assistant + Augment rules are directory-form governance defaults', () => {
    expect(governanceDirDefaults()).toContain('.aiassistant/rules');
    expect(governanceDirDefaults()).toContain('.augment/rules');
  });
});

describe('RS-22 / RS-41 / RS-21: Aider convention, agents + workflows skill dirs', () => {
  it('RS-22: Aider CONVENTIONS.md registered alongside .aider.conf.yml', () => {
    const aider = CLIENTS.find((c) => c.id === 'aider');
    expect(aider.governance).toContain('.aider.conf.yml');
    expect(aider.governance).toContain('CONVENTIONS.md');
  });
  it('RS-41: .claude/agents in claude-code skillDirs (cwd + home)', () => {
    expect(skillDirsForBase('cwd')).toContain('.claude/agents');
    expect(skillDirsForBase('home')).toContain('.claude/agents');
  });
  it('RS-21: Windsurf .windsurf/workflows registered as a cwd skillDir', () => {
    expect(skillDirsForBase('cwd')).toContain('.windsurf/workflows');
    expect(CLIENTS.find((c) => c.id === 'windsurf').skillDirs).toBeTruthy();
  });
});
