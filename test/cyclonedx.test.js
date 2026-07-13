import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatCycloneDx } from '../src/cyclonedx.js';
import { parseArgs } from '../src/index.js';
import { withTmpDir } from './helpers.js';

// Contract distilled from the real CycloneDX 1.6 JSON schema —
// https://raw.githubusercontent.com/CycloneDX/specification/master/schema/bom-1.6.schema.json
// — every `required` field on the objects we emit, the closed enums we emit into,
// and bom-ref uniqueness/resolvability. NOT a JSON-Schema validator: CI carries
// none (docs/cyclonedx.md § Limits says why, and how to wire one).
const COMPONENT_TYPES = ['application', 'framework', 'library', 'container', 'platform', 'operating-system',
  'device', 'device-driver', 'firmware', 'file', 'machine-learning-model', 'data', 'cryptographic-asset'];
const EXT_REF_TYPES = ['configuration', 'other', 'website'];

function contractErrors(bom) {
  const e = [];
  const refs = new Set();
  if (bom.bomFormat !== 'CycloneDX') e.push('bomFormat');
  if (bom.specVersion !== '1.6') e.push('specVersion');
  if (!Number.isInteger(bom.version) || bom.version < 1) e.push('version');
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(bom.serialNumber)) e.push('serialNumber');
  if (Number.isNaN(Date.parse(bom.metadata.timestamp))) e.push('metadata.timestamp');
  for (const c of [bom.metadata.component, ...bom.metadata.tools.components, ...bom.components]) {
    if (!COMPONENT_TYPES.includes(c.type)) e.push(`component.type=${c.type}`);
    if (!c.name) e.push('component.name');
    if (c['bom-ref']) {
      if (refs.has(c['bom-ref'])) e.push(`duplicate bom-ref ${c['bom-ref']}`);
      refs.add(c['bom-ref']);
    }
    for (const h of c.hashes || []) if (h.alg !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(h.content)) e.push('hash');
    for (const p of c.properties || []) if (!p.name || typeof p.value !== 'string') e.push('property');
    for (const r of c.externalReferences || []) if (!EXT_REF_TYPES.includes(r.type) || !r.url) e.push('extRef');
  }
  for (const d of bom.dependencies) {
    for (const ref of [d.ref, ...d.dependsOn]) if (!refs.has(ref)) e.push(`unresolvable ref ${ref}`);
  }
  return e;
}

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
  it('meets the 1.6 required-field contract', async () => {
    await withTmpDir(async (tmp) => {
      fixture(tmp);
      const bom = await formatCycloneDx({ score: 88, config: { profile: 'default' } }, { cwd: tmp });
      expect(contractErrors(bom)).toEqual([]);
      expect(bom.$schema).toBe('http://cyclonedx.org/schema/bom-1.6.schema.json');
      expect(bom.metadata.properties).toContainEqual({ name: 'rigscore:score', value: '88' });
    });
  });

  it('stays contract-clean with no AI wiring, and the check rejects an off-spec BOM', async () => {
    await withTmpDir(async (tmp) => {
      const bom = await formatCycloneDx({ score: 0 }, { cwd: tmp });
      expect(bom.components).toEqual([]);
      expect(contractErrors(bom)).toEqual([]);
      // Guard against a vacuous pass: the check must actually bite.
      bom.components.push({ type: 'not-a-cyclonedx-type', name: 'bogus' });
      expect(contractErrors(bom)).toContain('component.type=not-a-cyclonedx-type');
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
