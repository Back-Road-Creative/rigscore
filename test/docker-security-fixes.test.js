import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { fixes } from '../src/checks/docker-security.js';

const fixById = (id) => fixes.find((f) => f.id === id);
const capFix = fixById('docker-add-cap-drop-all');
const nnpFix = fixById('docker-add-no-new-privileges');

function tmpDirWith(composeName, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-docker-fix-'));
  fs.writeFileSync(path.join(dir, composeName), body, 'utf8');
  return dir;
}

const svc = (dir, name, file = 'docker-compose.yml') =>
  YAML.parse(fs.readFileSync(path.join(dir, file), 'utf8')).services[name];

describe('docker-security fixes — registration shape', () => {
  it('exports two additive fixers bound to the additive finding ids', () => {
    expect(capFix.findingIds).toEqual(['docker-security/container-missing-cap-drop-all']);
    expect(nnpFix.findingIds).toEqual(['docker-security/container-missing-no-new-privileges']);
    expect(typeof capFix.apply).toBe('function');
    expect(typeof nnpFix.apply).toBe('function');
  });
});

describe('docker-add-cap-drop-all', () => {
  it('adds cap_drop: [ALL] to a flagged service', async () => {
    const dir = tmpDirWith('docker-compose.yml', 'services:\n  app:\n    image: node:18\n');
    expect(await capFix.apply(dir)).toBe(true);
    expect(svc(dir, 'app').cap_drop).toContain('ALL');
  });

  it('is idempotent — a second run makes no change and returns false', async () => {
    const dir = tmpDirWith('docker-compose.yml', 'services:\n  app:\n    image: node:18\n');
    expect(await capFix.apply(dir)).toBe(true);
    const afterFirst = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
    expect(await capFix.apply(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8')).toBe(afterFirst);
  });

  it('never clobbers a user-authored cap_drop — leaves it and returns false', async () => {
    const body = 'services:\n  app:\n    image: node:18\n    cap_drop:\n      - NET_ADMIN\n';
    const dir = tmpDirWith('docker-compose.yml', body);
    expect(await capFix.apply(dir)).toBe(false);
    expect(svc(dir, 'app').cap_drop).toEqual(['NET_ADMIN']);
  });

  it('preserves comments and leaves unrelated services untouched', async () => {
    const body = [
      '# top-of-file note',
      'services:',
      '  web: # inline keep-me',
      '    image: nginx',
      '  db:',
      '    image: postgres',
      '    cap_drop:',
      '      - ALL',
      '',
    ].join('\n');
    const dir = tmpDirWith('docker-compose.yml', body);
    expect(await capFix.apply(dir)).toBe(true);
    const text = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
    expect(text).toContain('# top-of-file note');
    expect(text).toContain('# inline keep-me');
    expect(svc(dir, 'web').cap_drop).toContain('ALL'); // web was hardened
    expect(svc(dir, 'db').cap_drop).toEqual(['ALL']); // db already hardened, unchanged
    expect(svc(dir, 'db').image).toBe('postgres');
  });

  it('discovers a compose.yaml file, not just docker-compose.yml', async () => {
    const dir = tmpDirWith('compose.yaml', 'services:\n  app:\n    image: node:18\n');
    expect(await capFix.apply(dir)).toBe(true);
    expect(svc(dir, 'app', 'compose.yaml').cap_drop).toContain('ALL');
  });

  it('returns false when no compose file exists — never creates one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-docker-fix-'));
    expect(await capFix.apply(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'docker-compose.yml'))).toBe(false);
  });

  it('returns false on a corrupt compose file — never rewrites it', async () => {
    const body = 'services: [ this : is : not : valid';
    const dir = tmpDirWith('docker-compose.yml', body);
    expect(await capFix.apply(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8')).toBe(body);
  });
});

describe('docker-add-no-new-privileges', () => {
  it('adds security_opt: [no-new-privileges:true] to a flagged service', async () => {
    const dir = tmpDirWith('docker-compose.yml', 'services:\n  app:\n    image: node:18\n');
    expect(await nnpFix.apply(dir)).toBe(true);
    expect(svc(dir, 'app').security_opt).toContain('no-new-privileges:true');
  });

  it('is idempotent — a second run makes no change and returns false', async () => {
    const dir = tmpDirWith('docker-compose.yml', 'services:\n  app:\n    image: node:18\n');
    expect(await nnpFix.apply(dir)).toBe(true);
    expect(await nnpFix.apply(dir)).toBe(false);
  });

  it('never clobbers a user-authored security_opt — leaves it and returns false', async () => {
    const body = 'services:\n  app:\n    image: node:18\n    security_opt:\n      - seccomp:unconfined\n';
    const dir = tmpDirWith('docker-compose.yml', body);
    expect(await nnpFix.apply(dir)).toBe(false);
    expect(svc(dir, 'app').security_opt).toEqual(['seccomp:unconfined']);
  });
});
