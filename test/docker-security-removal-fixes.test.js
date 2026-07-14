import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { fixes } from '../src/checks/docker-security.js';

const fixById = (id) => fixes.find((f) => f.id === id);
const privFix = fixById('docker-remove-privileged');
const sockFix = fixById('docker-remove-docker-socket-mount');

function tmpDirWith(body, composeName = 'docker-compose.yml') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-docker-rm-fix-'));
  fs.writeFileSync(path.join(dir, composeName), body, 'utf8');
  return dir;
}

const read = (dir, file = 'docker-compose.yml') =>
  fs.readFileSync(path.join(dir, file), 'utf8');
const svc = (dir, name, file = 'docker-compose.yml') =>
  YAML.parse(read(dir, file)).services[name];

describe('docker-security removal fixes — registration shape', () => {
  it('exports two removal fixers bound to the removal-class finding ids', () => {
    expect(privFix.findingIds).toEqual(['docker-security/container-running-with-privileged-true']);
    expect(sockFix.findingIds).toEqual(['docker-security/container-mounts-docker-socket']);
    expect(typeof privFix.apply).toBe('function');
    expect(typeof sockFix.apply).toBe('function');
  });
});

describe('docker-remove-privileged', () => {
  it('removes privileged: true from a flagged service', async () => {
    const dir = tmpDirWith('services:\n  app:\n    image: node:18\n    privileged: true\n');
    expect(await privFix.apply(dir)).toBe(true);
    expect(svc(dir, 'app').privileged).toBeUndefined();
    expect(svc(dir, 'app').image).toBe('node:18');
  });

  it('leaves privileged: false alone and returns false', async () => {
    const body = 'services:\n  app:\n    image: node:18\n    privileged: false\n';
    const dir = tmpDirWith(body);
    expect(await privFix.apply(dir)).toBe(false);
    expect(svc(dir, 'app').privileged).toBe(false);
    expect(read(dir)).toBe(body);
  });

  it('returns false when no service declares privileged', async () => {
    const dir = tmpDirWith('services:\n  app:\n    image: node:18\n');
    expect(await privFix.apply(dir)).toBe(false);
  });

  it('is idempotent — a second run makes no change and returns false', async () => {
    const dir = tmpDirWith('services:\n  app:\n    image: node:18\n    privileged: true\n');
    expect(await privFix.apply(dir)).toBe(true);
    const afterFirst = read(dir);
    expect(await privFix.apply(dir)).toBe(false);
    expect(read(dir)).toBe(afterFirst);
  });

  it('removes only from the flagged service; preserves comments and other services', async () => {
    const body = [
      '# top-of-file note',
      'services:',
      '  web: # inline keep-me',
      '    image: nginx',
      '    privileged: true',
      '  db:',
      '    image: postgres',
      '    privileged: false',
      '',
    ].join('\n');
    const dir = tmpDirWith(body);
    expect(await privFix.apply(dir)).toBe(true);
    const text = read(dir);
    expect(text).toContain('# top-of-file note');
    expect(text).toContain('# inline keep-me');
    expect(svc(dir, 'web').privileged).toBeUndefined();
    expect(svc(dir, 'web').image).toBe('nginx');
    expect(svc(dir, 'db').privileged).toBe(false); // untouched
  });
});

describe('docker-remove-docker-socket-mount', () => {
  it('removes a short-form socket volume, leaving other volumes intact', async () => {
    const body = [
      'services:',
      '  app:',
      '    image: node:18',
      '    volumes:',
      '      - /var/run/docker.sock:/var/run/docker.sock',
      '      - ./data:/data',
      '',
    ].join('\n');
    const dir = tmpDirWith(body);
    expect(await sockFix.apply(dir)).toBe(true);
    expect(svc(dir, 'app').volumes).toEqual(['./data:/data']);
  });

  it('removes a long-form mapping socket volume, leaving other volumes intact', async () => {
    const body = [
      'services:',
      '  app:',
      '    image: node:18',
      '    volumes:',
      '      - type: bind',
      '        source: /var/run/docker.sock',
      '        target: /var/run/docker.sock',
      '      - type: bind',
      '        source: ./data',
      '        target: /data',
      '',
    ].join('\n');
    const dir = tmpDirWith(body);
    expect(await sockFix.apply(dir)).toBe(true);
    const vols = svc(dir, 'app').volumes;
    expect(vols).toHaveLength(1);
    expect(vols[0].source).toBe('./data');
  });

  it('removes the now-empty volumes key when the socket was the only mount', async () => {
    const body = [
      'services:',
      '  app:',
      '    image: node:18',
      '    volumes:',
      '      - /var/run/docker.sock:/var/run/docker.sock',
      '',
    ].join('\n');
    const dir = tmpDirWith(body);
    expect(await sockFix.apply(dir)).toBe(true);
    expect('volumes' in svc(dir, 'app')).toBe(false);
    expect(svc(dir, 'app').image).toBe('node:18');
  });

  it('leaves comments and other services untouched', async () => {
    const body = [
      '# top-of-file note',
      'services:',
      '  proxy: # inline keep-me',
      '    image: traefik',
      '    volumes:',
      '      - /var/run/docker.sock:/var/run/docker.sock:ro',
      '      - ./certs:/certs',
      '  db:',
      '    image: postgres',
      '    volumes:',
      '      - ./pg:/var/lib/postgresql/data',
      '',
    ].join('\n');
    const dir = tmpDirWith(body);
    expect(await sockFix.apply(dir)).toBe(true);
    const text = read(dir);
    expect(text).toContain('# top-of-file note');
    expect(text).toContain('# inline keep-me');
    expect(svc(dir, 'proxy').volumes).toEqual(['./certs:/certs']);
    expect(svc(dir, 'db').volumes).toEqual(['./pg:/var/lib/postgresql/data']); // untouched
  });

  it('returns false when no socket mount is present', async () => {
    const dir = tmpDirWith('services:\n  app:\n    image: node:18\n    volumes:\n      - ./data:/data\n');
    expect(await sockFix.apply(dir)).toBe(false);
  });

  it('is idempotent — a second run makes no change and returns false', async () => {
    const body = 'services:\n  app:\n    image: node:18\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - ./data:/data\n';
    const dir = tmpDirWith(body);
    expect(await sockFix.apply(dir)).toBe(true);
    const afterFirst = read(dir);
    expect(await sockFix.apply(dir)).toBe(false);
    expect(read(dir)).toBe(afterFirst);
  });
});

describe('docker removal fixes — missing / corrupt compose', () => {
  it('returns false when no compose file exists — never creates one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-docker-rm-fix-'));
    expect(await privFix.apply(dir)).toBe(false);
    expect(await sockFix.apply(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'docker-compose.yml'))).toBe(false);
  });

  it('returns false on a corrupt compose file — never rewrites it', async () => {
    const body = 'services: [ this : is : not : valid';
    const dir = tmpDirWith(body);
    expect(await privFix.apply(dir)).toBe(false);
    expect(await sockFix.apply(dir)).toBe(false);
    expect(read(dir)).toBe(body);
  });
});
