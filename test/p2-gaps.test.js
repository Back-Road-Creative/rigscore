import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import check from '../src/checks/docker-security.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rigscore-p2-'));
}

const defaultConfig = { paths: { hookDirs: [] }, network: {} };

// ─── Kubernetes manifest scanning ───────────────────────────────────
describe('docker-security: Kubernetes manifests', () => {
  it('detects privileged container in Deployment', async () => {
    const tmpDir = makeTmpDir();
    const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: risky-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: risky
  template:
    spec:
      containers:
        - name: app
          image: nginx
          securityContext:
            privileged: true
`;
    fs.writeFileSync(path.join(tmpDir, 'deployment.yaml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('privileged container'),
      );
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects hostNetwork in Pod', async () => {
    const tmpDir = makeTmpDir();
    const manifest = `
apiVersion: v1
kind: Pod
metadata:
  name: host-net-pod
spec:
  hostNetwork: true
  containers:
    - name: app
      image: nginx
`;
    fs.writeFileSync(path.join(tmpDir, 'pod.yaml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('hostNetwork'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects hostPID in StatefulSet', async () => {
    const tmpDir = makeTmpDir();
    const manifest = `
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pid-share
spec:
  selector:
    matchLabels:
      app: pid
  template:
    spec:
      hostPID: true
      containers:
        - name: app
          image: nginx
`;
    fs.writeFileSync(path.join(tmpDir, 'statefulset.yml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('hostPID'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects sensitive hostPath volume', async () => {
    const tmpDir = makeTmpDir();
    const manifest = `
apiVersion: v1
kind: Pod
metadata:
  name: hostpath-pod
spec:
  containers:
    - name: app
      image: nginx
  volumes:
    - name: host-root
      hostPath:
        path: /
`;
    fs.writeFileSync(path.join(tmpDir, 'hostpath.yaml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('hostPath'),
      );
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('detects allowPrivilegeEscalation', async () => {
    const tmpDir = makeTmpDir();
    const manifest = `
apiVersion: v1
kind: Pod
metadata:
  name: escalation-pod
spec:
  containers:
    - name: app
      image: nginx
      securityContext:
        allowPrivilegeEscalation: true
`;
    fs.writeFileSync(path.join(tmpDir, 'escalation.yaml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('allowPrivilegeEscalation'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('PASS for secure K8s manifest', async () => {
    const tmpDir = makeTmpDir();
    const manifest = `
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
  containers:
    - name: app
      image: nginx
      securityContext:
        privileged: false
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
      resources:
        limits:
          memory: "128Mi"
          cpu: "500m"
`;
    fs.writeFileSync(path.join(tmpDir, 'secure.yaml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      // Should have no critical or warning findings
      const bad = result.findings.filter(
        (f) => f.severity === 'critical' || f.severity === 'warning',
      );
      expect(bad).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('scans k8s/ subdirectory', async () => {
    const tmpDir = makeTmpDir();
    const k8sDir = path.join(tmpDir, 'k8s');
    fs.mkdirSync(k8sDir);
    const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sub-app
spec:
  template:
    spec:
      hostNetwork: true
      containers:
        - name: app
          image: nginx
`;
    fs.writeFileSync(path.join(k8sDir, 'deploy.yaml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('hostNetwork'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('handles multi-document YAML', async () => {
    const tmpDir = makeTmpDir();
    const manifest = `
apiVersion: v1
kind: Pod
metadata:
  name: pod-a
spec:
  containers:
    - name: app
      image: nginx
      securityContext:
        privileged: true
---
apiVersion: v1
kind: Pod
metadata:
  name: pod-b
spec:
  hostPID: true
  containers:
    - name: app
      image: nginx
`;
    fs.writeFileSync(path.join(tmpDir, 'multi.yaml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const privileged = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('privileged'),
      );
      const hostPid = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('hostPID'),
      );
      expect(privileged).toBeDefined();
      expect(hostPid).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('handles CronJob nested pod spec', async () => {
    const tmpDir = makeTmpDir();
    const manifest = `
apiVersion: batch/v1
kind: CronJob
metadata:
  name: risky-cron
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          hostNetwork: true
          containers:
            - name: worker
              image: busybox
`;
    fs.writeFileSync(path.join(tmpDir, 'cronjob.yaml'), manifest);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const warning = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('hostNetwork'),
      );
      expect(warning).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ─── Podman compose detection ───────────────────────────────────────
describe('docker-security: Podman compose', () => {
  it('detects issues in podman-compose.yml', async () => {
    const tmpDir = makeTmpDir();
    const compose = `
services:
  web:
    image: nginx
    privileged: true
`;
    fs.writeFileSync(path.join(tmpDir, 'podman-compose.yml'), compose);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('privileged'),
      );
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ─── Compose include resolution ─────────────────────────────────────
describe('docker-security: compose include', () => {
  it('analyzes services in included compose files', async () => {
    const tmpDir = makeTmpDir();
    // Main compose with include
    const mainCompose = `
include:
  - infra.yml

services:
  app:
    image: node
    user: "1000:1000"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 256m
`;
    // Included compose with a privileged service
    const infraCompose = `
services:
  db:
    image: postgres
    privileged: true
`;
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), mainCompose);
    fs.writeFileSync(path.join(tmpDir, 'infra.yml'), infraCompose);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      // Should find the privileged issue from the included file
      const critical = result.findings.find(
        (f) => f.severity === 'critical' && f.title.includes('db') && f.title.includes('privileged'),
      );
      expect(critical).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('handles include with object syntax', async () => {
    const tmpDir = makeTmpDir();
    const mainCompose = `
include:
  - path: monitoring.yml

services:
  app:
    image: node
    user: "1000"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges"]
    mem_limit: 256m
`;
    const monitoringCompose = `
services:
  prometheus:
    image: prom/prometheus
    network_mode: host
`;
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), mainCompose);
    fs.writeFileSync(path.join(tmpDir, 'monitoring.yml'), monitoringCompose);
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const hostNet = result.findings.find(
        (f) => f.severity === 'warning' && f.title.includes('prometheus') && f.title.includes('host network'),
      );
      expect(hostNet).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ─── Updated "no config" message ────────────────────────────────────
describe('docker-security: no-config messaging', () => {
  it('says "No container configuration" when nothing found', async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await check.run({ cwd: tmpDir, config: defaultConfig });
      const info = result.findings.find((f) => f.title.includes('No container configuration'));
      expect(info).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
