import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { GOVERNANCE_FILES } from './constants.js';
import { readFileSafe, readJsonSafe, collectGovernanceDirFiles } from './utils.js';
import { mcpServersIn, repoMcpRelPaths } from './clients.js';
import { computeServerHash, loadState } from './state.js';
import { argHasStableVersionPin, checkClaudeSettings, extractPackageName, findPackagePositionArg } from './checks/mcp-config.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const SCHEMA_URL = 'http://cyclonedx.org/schema/bom-1.6.schema.json';
const RIGSCORE_URL = 'https://github.com/Back-Road-Creative/rigscore';
const TARGET_REF = 'rigscore:target';

// Repo-level configs only — home-dir client configs are excluded on purpose:
// a BOM is shippable and must not carry a developer's machine layout.
// Read from the CLIENTS registry, never restated here: a hardcoded subset silently
// dropped `.gemini/settings.json` servers from the BOM while the rug-pull pin covered
// them. `opencode.json` nests its servers under `mcp`; servers are read via mcpServersIn()
// so each file's own key applies (see src/clients.js).
const MCP_CONFIG_FILES = repoMcpRelPaths();
const INVENTORIED_FILES = [...MCP_CONFIG_FILES, '.claude/settings.json', ...GOVERNANCE_FILES];

const prop = (name, value) => ({ name, value: String(value) });
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// `version` + `purl` for an npx-launched server whose package arg is version-pinned.
// Unpinned servers get neither — a purl without a version asserts provenance
// rigscore cannot actually see.
function npmCoordinates(args) {
  const spec = findPackagePositionArg(args);
  if (!spec || !argHasStableVersionPin(spec)) return {};
  const name = extractPackageName(args);
  if (!name || !spec.startsWith(`${name}@`)) return {};
  const pinned = spec.slice(name.length + 1);
  return { version: pinned, purl: `pkg:npm/${name.replace('@', '%40')}@${pinned}` };
}

// A file component (content digest + role). Shared by the inventoried configs/governance
// files and by the grant-surface skill/rule components below.
function fileComponent(relPath, content, role) {
  return {
    type: 'file', 'bom-ref': `file:${relPath}`, name: relPath,
    hashes: [{ alg: 'SHA-256', content: sha256(content) }],
    properties: [prop('rigscore:file:role', role)],
  };
}

// The GRANT SURFACE for one server: whether it is auto-approved on clone, and the
// settings.json allow/deny entries that name it. `mcp__<server>[__<tool>]` is Claude
// Code's MCP permission form, so an entry scopes THIS server only when it matches that.
// Tool identifiers, never secret values.
function grantProps(name, grant) {
  const properties = [];
  if (grant.autoApprove) properties.push(prop('rigscore:grant:auto-approve', 'enableAllProjectMcpServers'));
  const scopes = (entry) => typeof entry === 'string'
    && (entry === `mcp__${name}` || entry.startsWith(`mcp__${name}__`));
  for (const entry of grant.allow.filter(scopes)) properties.push(prop('rigscore:grant:allow', entry));
  for (const entry of grant.deny.filter(scopes)) properties.push(prop('rigscore:grant:deny', entry));
  return properties;
}

// One MCP server → one `application` component. AI facts with no first-class home
// in 1.6 ride on `properties`. Env VALUES are never emitted — they are credentials.
function serverComponent(name, server, relPath, pin, grant) {
  const args = Array.isArray(server.args) ? server.args : [];
  const properties = [
    prop('rigscore:mcp:transport', server.transport || (server.url ? 'http' : 'stdio')),
    prop('rigscore:mcp:config-shape-sha256', computeServerHash(server)),
  ];
  if (typeof server.command === 'string') properties.push(prop('rigscore:mcp:command', server.command));
  if (args.length > 0) properties.push(prop('rigscore:mcp:args', args.join(' ')));
  // Duplicate property names are legal in 1.6 — one row per declared env key.
  for (const key of Object.keys(server.env || {}).sort()) properties.push(prop('rigscore:mcp:env-key', key));
  if (pin && typeof pin.runtimeToolHash === 'string') {
    properties.push(prop('rigscore:mcp:runtime-tool-sha256', pin.runtimeToolHash));
  }
  properties.push(...grantProps(name, grant));
  const externalReferences = [{ type: 'configuration', url: relPath, comment: 'MCP server declaration' }];
  if (typeof server.url === 'string') {
    externalReferences.push({ type: 'other', url: server.url, comment: 'MCP server endpoint' });
  }
  return { type: 'application', 'bom-ref': `mcp-server:${name}`, name, ...npmCoordinates(args), properties, externalReferences };
}

/**
 * A rigscore scan() result → a CycloneDX 1.6 AI-BOM (JSON): every MCP server in a
 * repo-level client config, plus the AI client configs and governance files present.
 * Only 1.6 constructs are used — an Agent/AI BOM type is still an open spec proposal
 * (CycloneDX/specification#895). See docs/cyclonedx.md.
 */
export async function formatCycloneDx(result, options = {}) {
  const cwd = options.cwd || process.cwd();
  const components = [];
  const { state } = await loadState(cwd);
  const pins = (state && typeof state.servers === 'object' && state.servers) || {};

  // Grant surface, read once from the project `.claude/settings.json` (repo-scoped, so
  // homedir === cwd). Auto-approve comes from the same parser the mcp-config check uses
  // (checkClaudeSettings → enableAllProjectMcpServers); allow/deny use the claude-settings
  // permission shape (`allowedTools` || `permissions.allow`, `permissions.deny`).
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const { autoApproveEnabled } = await checkClaudeSettings(cwd, cwd);
  const settings = (await readJsonSafe(path.join(cwd, '.claude', 'settings.json'))) || {};
  const grant = {
    autoApprove: autoApproveEnabled,
    allow: asArray(settings.allowedTools || settings.permissions?.allow),
    deny: asArray(settings.permissions?.deny),
  };

  const seen = new Set();
  for (const relPath of MCP_CONFIG_FILES) {
    const config = await readJsonSafe(path.join(cwd, relPath));
    const servers = mcpServersIn(relPath, config);
    for (const [name, server] of Object.entries(servers)) {
      if (!server || typeof server !== 'object' || seen.has(name)) continue;
      seen.add(name);
      components.push(serverComponent(name, server, relPath, pins[name], grant));
    }
  }

  // Each AI client config / governance file present → one `file` component (content digest).
  for (const relPath of INVENTORIED_FILES) {
    const content = await readFileSafe(path.join(cwd, relPath));
    if (content === null) continue;
    const role = GOVERNANCE_FILES.includes(relPath) ? 'governance' : 'ai-client-config';
    components.push(fileComponent(relPath, content, role));
  }

  // Grant surface, part 2 — skills and directory-form rules as hashed `file` components.
  // Skill discovery mirrors skill-coherence's convention (`.claude/{skills,commands}/<name>/SKILL.md`);
  // rules reuse `collectGovernanceDirFiles` — the exact set skill-coherence / claude-md scan
  // (`.cursor/rules/*.mdc`, `.windsurf/rules`, `.clinerules`, `.github/instructions`). cdxgen
  // models neither, so this is the differentiator. Deduped against files already inventoried.
  const fileRefs = new Set(components.filter((c) => c.type === 'file').map((c) => c['bom-ref']));
  const addFile = async (relPath, role) => {
    if (fileRefs.has(`file:${relPath}`)) return;
    const content = await readFileSafe(path.join(cwd, relPath));
    if (content === null) return;
    fileRefs.add(`file:${relPath}`);
    components.push(fileComponent(relPath, content, role));
  };
  for (const dir of ['.claude/skills', '.claude/commands']) {
    let subs;
    try { subs = await fs.promises.readdir(path.join(cwd, dir), { withFileTypes: true }); } catch { continue; }
    for (const sub of subs) {
      if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
      await addFile(path.join(dir, sub.name, 'SKILL.md'), 'skill');
    }
  }
  for (const { rel } of await collectGovernanceDirFiles(cwd)) await addFile(rel, 'rule');
  const refs = components.map((c) => c['bom-ref']);
  const tool = { type: 'application', name: 'rigscore', version, externalReferences: [{ type: 'website', url: RIGSCORE_URL }] };

  return {
    $schema: SCHEMA_URL,
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [tool] },
      component: { type: 'application', 'bom-ref': TARGET_REF, name: path.basename(path.resolve(cwd)) || 'project' },
      properties: [prop('rigscore:score', result?.score ?? 0), prop('rigscore:profile', result?.config?.profile || 'default')],
    },
    components,
    // Flat graph. Components with no onward deps MUST still appear, as empty rows.
    dependencies: [{ ref: TARGET_REF, dependsOn: refs }, ...refs.map((ref) => ({ ref, dependsOn: [] }))],
  };
}
