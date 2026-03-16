import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/docker-security.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-socket-'));
}

const defaultConfig = { paths: { dockerCompose: [] }, network: {} };

describe('Docker socket path variants', () => {
  it('detects /var/run/docker.sock (standard)', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
      'services:',
      '  app:',
      '    image: node:18',
      '    volumes:',
      '      - /var/run/docker.sock:/var/run/docker.sock',
    ].join('\n'));
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('Docker socket'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects /run/docker.sock (alternative path)', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
      'services:',
      '  app:',
      '    image: node:18',
      '    volumes:',
      '      - /run/docker.sock:/var/run/docker.sock',
    ].join('\n'));
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('Docker socket'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects /run/podman/podman.sock', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
      'services:',
      '  app:',
      '    image: node:18',
      '    volumes:',
      '      - /run/podman/podman.sock:/var/run/docker.sock',
    ].join('\n'));
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('socket'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects /run/user/1000/podman/podman.sock (rootless)', async () => {
    const tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
      'services:',
      '  app:',
      '    image: node:18',
      '    volumes:',
      '      - /run/user/1000/podman/podman.sock:/var/run/docker.sock',
    ].join('\n'));
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('socket'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects socket mount in devcontainer.json', async () => {
    const tmpDir = makeTmpDir();
    const dcDir = path.join(tmpDir, '.devcontainer');
    fs.mkdirSync(dcDir, { recursive: true });
    fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), JSON.stringify({
      name: 'dev',
      image: 'node:20',
      mounts: ['source=/run/docker.sock,target=/var/run/docker.sock,type=bind'],
    }));
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('socket'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects podman socket in devcontainer.json', async () => {
    const tmpDir = makeTmpDir();
    const dcDir = path.join(tmpDir, '.devcontainer');
    fs.mkdirSync(dcDir, { recursive: true });
    fs.writeFileSync(path.join(dcDir, 'devcontainer.json'), JSON.stringify({
      name: 'dev',
      image: 'node:20',
      mounts: ['source=/run/podman/podman.sock,target=/var/run/docker.sock,type=bind'],
    }));
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find((f) => f.severity === 'critical' && f.title.includes('socket'));
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
