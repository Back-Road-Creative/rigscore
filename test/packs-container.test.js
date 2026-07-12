// Validates the `container` init pack as pure DATA. It deliberately does NOT import the pack
// framework (src/cli/packs.js) — that lands in a sibling PR; this pack must be green on its own.
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.resolve(__dirname, '..', 'templates', 'container');
const read = (f) => fs.readFileSync(path.join(PACK, f), 'utf8');
const manifest = JSON.parse(read('pack.json'));
// Substitute {{VAR}} exactly as the framework will at install time, so every assertion below is
// made against what the user actually ends up with on disk.
const render = (s) => Object.entries(manifest.vars)
  .reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v), s);
const compose = YAML.parse(render(read('docker-compose.proxy.yml')));
const proxy = compose.services['egress-proxy'];
const dockerfile = read('Dockerfile.proxy');
const hc = read('healthcheck.sh');
const allowlist = render(read('allowlist'));

it('manifest matches the schema; every declared file exists, with no undeclared strays', () => {
  expect(manifest.name).toBe('container');
  expect(manifest.description).toBeTruthy();
  expect(manifest.checks).toEqual(expect.arrayContaining(['docker-security', 'network-exposure']));
  expect(Object.keys(manifest.vars)).toEqual(
    expect.arrayContaining(['PROJECT_NAME', 'ALLOWED_HOSTS', 'EGRESS_SUBNET']));
  for (const f of manifest.files) {
    expect(f.dest, `dest missing for ${f.src}`).toBeTruthy();
    expect(fs.existsSync(path.join(PACK, f.src)), `${f.src} not on disk`).toBe(true);
  }
  const declared = new Set(manifest.files.map((f) => f.src));
  const strays = fs.readdirSync(PACK)
    .filter((f) => f !== 'pack.json' && f !== 'README.md' && !declared.has(f));
  expect(strays, 'undeclared template file').toEqual([]);
});
it('renders to valid compose YAML, with the proxy hardened and digest-pinned', () => {
  expect(proxy.cap_drop).toEqual(['ALL']);
  expect(proxy.read_only).toBe(true);
  expect(proxy.security_opt).toContain('no-new-privileges:true');
  expect(dockerfile).toMatch(/^USER nobody$/m);
  expect(dockerfile).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/m); // pinned, not a floating tag
});
it('puts the agent on an internal-only network with a pinned subnet', () => {
  expect(compose.networks.egress.internal).toBe(true);
  expect(compose.networks.egress.ipam.config[0].subnet).toBe(manifest.vars.EGRESS_SUBNET);
  expect(proxy.networks).toEqual(['egress', 'egress-ext']); // proxy alone gets the outbound leg
  expect(compose.networks['egress-ext'].internal).toBeUndefined();
});
it('denies by default, and scopes proxy clients to that subnet', () => {
  const conf = render(read('tinyproxy.conf'));
  expect(conf).toMatch(/^FilterDefaultDeny Yes$/m);
  expect(conf).toMatch(/^Filter "\/etc\/tinyproxy\/allowlist"$/m);
  expect(conf).toMatch(
    new RegExp(`^Allow ${manifest.vars.EGRESS_SUBNET.replace(/[./]/g, '\\$&')}$`, 'm'));
});
it('routes all container egress through the proxy and closes DNS exfil', () => {
  const dc = JSON.parse(render(read('devcontainer.json')));
  const p = manifest.vars.PROJECT_NAME;
  expect(dc.runArgs).toContain(`--network=${p}-egress`);
  expect(dc.runArgs).toContain('--dns=127.0.0.1'); // DNS cannot be a side channel
  expect(dc.runArgs).toContain('--cap-drop=ALL');
  expect(dc.runArgs).toContain('--security-opt=no-new-privileges:true');
  expect(dc.containerEnv.HTTPS_PROXY).toBe(`http://${p}-egress-proxy:8888`);
  expect(dc.initializeCommand).toContain('--wait'); // fail loud at create time
});

// The healthcheck must prove BOTH directions: a happy-path-only check cannot detect a proxy that has
// failed OPEN, which is exactly what tinyproxy does when its filter fails to parse. `listed` matches
// an active (non-comment) allow-list line for a host, e.g. `(^|\.)github\.com$`.
const listed = (h) => new RegExp(`^[^#\\n]*${h.replace(/\./g, '\\\\?\\.')}\\$`, 'm');
const allowHost = hc.match(/^ALLOW_HOST="(.+)"$/m)?.[1];
const denyHost = hc.match(/^DENY_HOST="(.+)"$/m)?.[1];

it('healthcheck positive leg: an allow-listed host that must tunnel', () => {
  expect(proxy.healthcheck.test.join(' ')).toContain('healthcheck.sh'); // actually wired in
  expect(allowHost).toBeTruthy();
  expect(allowlist).toMatch(listed(allowHost));
  expect(hc).toMatch(/allow-listed CONNECT[\s\S]{0,120}?exit 1/); // non-200 => unhealthy
});
it('healthcheck negative leg: a NON-allow-listed host that must be refused', () => {
  expect(denyHost).toBeTruthy();
  expect(denyHost).not.toBe(allowHost);
  expect(allowlist).not.toMatch(listed(denyHost));
  // A 200 from the denied host means the filter failed open => must exit non-zero.
  expect(hc).toMatch(/\*" 200 "\*\)[\s\S]{0,160}?fail-open[\s\S]{0,80}?exit 1/);
});

// Adapted from a private, PHI-adjacent devcontainer. Nothing identifying that project — least of
// all a storage-account hostname — may ship in this public repo.
it('leaks no identifier from the source project it was adapted from', () => {
  const forbidden = ['quasar', 'pulsar', 'stpulsardev', 'core.windows.net', 'management.azure.com',
    'visualstudio.com', 'vsassets.io', 'vscode-unpkg', '172.20.0.0', 'HOST_GID', '/home/vscode'];
  for (const file of fs.readdirSync(PACK)) {
    const body = read(file).toLowerCase();
    for (const token of forbidden) {
      expect(body, `"${token}" leaked into templates/container/${file}`)
        .not.toContain(token.toLowerCase());
    }
  }
});
