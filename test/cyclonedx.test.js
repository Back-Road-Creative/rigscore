import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Validation } from '@cyclonedx/cyclonedx-library';
import { formatCycloneDx } from '../src/cyclonedx.js';
import { parseArgs } from '../src/index.js';
import { withTmpDir } from './helpers.js';

// The real CycloneDX 1.6 JSON schema, run by the upstream library's strict
// validator — not a hand-transcribed restatement of it. `validate()` resolves
// to `null` when the document conforms, or to an array of ajv errors when it
// does not.
const validator = new Validation.JsonStrictValidator('1.6');

const schemaErrors = (bom) => validator.validate(JSON.stringify(bom));

function fixture(tmp) {
  const github = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@1.2.3'],
    env: { GITHUB_TOKEN: 'ghp_supersecretvalue', LOG_LEVEL: 'debug' } };
  const remote = { transport: 'sse', url: 'https://mcp.example.com/sse' };
  fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { github, remote } }));
  fs.writeFileSync(path.join(tmp, '.rigscore-state.json'),
    JSON.stringify({ version: 1, servers: { github: { runtimeToolHash: 'a'.repeat(64) } } }));
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Governance\n');
}

describe('CycloneDX 1.6 AI-BOM export', () => {
  it('validates against the real CycloneDX 1.6 JSON schema', async () => {
    await withTmpDir(async (tmp) => {
      fixture(tmp);
      const bom = await formatCycloneDx({ score: 88, config: { profile: 'default' } }, { cwd: tmp });
      await expect(schemaErrors(bom)).resolves.toBeNull();
      expect(bom.$schema).toBe('http://cyclonedx.org/schema/bom-1.6.schema.json');
      expect(bom.metadata.properties).toContainEqual({ name: 'rigscore:score', value: '88' });
    });
  });

  it('validates with no AI wiring, and the schema rejects an off-spec BOM', async () => {
    await withTmpDir(async (tmp) => {
      const bom = await formatCycloneDx({ score: 0 }, { cwd: tmp });
      expect(bom.components).toEqual([]);
      await expect(schemaErrors(bom)).resolves.toBeNull();

      // Guard against a vacuous pass: a validator that silently no-opped would
      // still "pass" every assertion above. Feed it a component whose `type` is
      // outside the closed 1.6 enum and require it to bite — at that exact path,
      // for that exact reason, so a merely-incidental error cannot satisfy this.
      bom.components.push({ type: 'not-a-cyclonedx-type', name: 'bogus' });
      const errors = await schemaErrors(bom);
      expect(errors).not.toBeNull();
      expect(errors).toContainEqual(expect.objectContaining({
        instancePath: '/components/0/type',
        keyword: 'enum',
      }));
    });
  });

  it('models each MCP server as an application component carrying its AI facts', async () => {
    await withTmpDir(async (tmp) => {
      fixture(tmp);
      const bom = await formatCycloneDx({ score: 70 }, { cwd: tmp });
      const vals = (c, n) => c.properties.filter((p) => p.name === n).map((p) => p.value);
      const github = bom.components.find((c) => c['bom-ref'] === 'mcp-server:github');
      expect(github.version).toBe('1.2.3');
      expect(github.purl).toBe('pkg:npm/%40modelcontextprotocol/server-github@1.2.3');
      expect(vals(github, 'rigscore:mcp:transport')).toEqual(['stdio']);
      // Declared env KEYS are inventoried; values must never leak into the BOM.
      expect(vals(github, 'rigscore:mcp:env-key')).toEqual(['GITHUB_TOKEN', 'LOG_LEVEL']);
      expect(JSON.stringify(bom)).not.toContain('ghp_supersecretvalue');
      // The config-shape hash rigscore already computes for rug-pull detection.
      expect(vals(github, 'rigscore:mcp:config-shape-sha256')[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(vals(github, 'rigscore:mcp:runtime-tool-sha256')).toEqual(['a'.repeat(64)]);
      expect(github.externalReferences[0])
        .toEqual({ type: 'configuration', url: '.mcp.json', comment: 'MCP server declaration' });
      // Network-transport server: transport + endpoint, no invented purl.
      const remote = bom.components.find((c) => c['bom-ref'] === 'mcp-server:remote');
      expect(vals(remote, 'rigscore:mcp:transport')).toEqual(['sse']);
      expect(remote.purl).toBeUndefined();
      expect(remote.externalReferences[1].url).toBe('https://mcp.example.com/sse');
    });
  });

  it('models present config/governance files as hashed file components in the dep graph', async () => {
    await withTmpDir(async (tmp) => {
      fixture(tmp);
      const bom = await formatCycloneDx({ score: 70 }, { cwd: tmp });
      const claude = bom.components.find((c) => c['bom-ref'] === 'file:CLAUDE.md');
      expect(claude.type).toBe('file');
      expect(claude.hashes[0].alg).toBe('SHA-256');
      expect(claude.properties).toContainEqual({ name: 'rigscore:file:role', value: 'governance' });
      // Absent files are never asserted into the BOM.
      expect(bom.components.find((c) => c['bom-ref'] === 'file:AGENTS.md')).toBeUndefined();
      // Flat graph: root depends on every component; each component is an empty row.
      expect(bom.dependencies.find((d) => d.ref === 'rigscore:target').dependsOn)
        .toEqual(bom.components.map((c) => c['bom-ref']));
      expect(bom.dependencies).toContainEqual({ ref: 'file:CLAUDE.md', dependsOn: [] });
    });
  });

  // opencode is repo-level (`opencode.json`) and nests its servers under `mcp`.
  // Source: opencode.ai/docs/config + /docs/mcp-servers, verified 2026-07-12.
  it('inventories opencode.json servers, honoring its `mcp` key', async () => {
    await withTmpDir(async (tmp) => {
      fs.writeFileSync(path.join(tmp, 'opencode.json'), JSON.stringify({
        mcp: { linear: { type: 'local', command: ['npx', '-y', 'linear-mcp@1.0.0'], environment: { LINEAR_KEY: 'secretvalue' } } },
      }));
      const bom = await formatCycloneDx({ score: 70 }, { cwd: tmp });
      const linear = bom.components.find((c) => c['bom-ref'] === 'mcp-server:linear');
      expect(linear).toBeDefined();
      expect(linear.externalReferences[0])
        .toEqual({ type: 'configuration', url: 'opencode.json', comment: 'MCP server declaration' });
      const file = bom.components.find((c) => c['bom-ref'] === 'file:opencode.json');
      expect(file.properties).toContainEqual({ name: 'rigscore:file:role', value: 'ai-client-config' });
      // BOM-wide validity is asserted by the schema/contract tests above, not re-litigated here.
    });
  });

  it('--cyclonedx is a plain boolean flag, off by default', () => {
    expect(parseArgs([]).cyclonedx).toBe(false);
    expect(parseArgs(['--cyclonedx']).cyclonedx).toBe(true);
  });
});
