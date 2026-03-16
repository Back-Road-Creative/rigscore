import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, readJsonSafe } from '../utils.js';

const SENSITIVE_MOUNTS = ['/', '/etc', '/root', '/home'];
const COMPOSE_PATTERNS = [
  'docker-compose.yml', 'docker-compose.yaml',
  'compose.yml', 'compose.yaml',
  'podman-compose.yml', 'podman-compose.yaml',
];

// Kubernetes workload kinds that contain pod specs
const K8S_WORKLOAD_KINDS = [
  'Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob',
];

/**
 * Analyze a compose services block and push findings.
 */
function analyzeComposeServices(services, findings, sourceLabel) {
  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== 'object') continue;

    // Check privileged
    if (service.privileged === true) {
      findings.push({
        severity: 'critical',
        title: `Container "${name}" running with privileged: true`,
        detail: `Privileged containers have full access to the host system. Found in ${sourceLabel}.`,
        remediation: 'Remove privileged: true and use specific capabilities instead.',
      });
    }

    // Check network_mode
    if (service.network_mode === 'host') {
      findings.push({
        severity: 'warning',
        title: `Container "${name}" uses host network mode`,
        detail: `Host network mode exposes all host ports to the container. Found in ${sourceLabel}.`,
        remediation: 'Use bridge networking with explicit port mappings.',
      });
    }

    // Check volumes
    const volumes = service.volumes || [];
    for (const vol of volumes) {
      const volStr = typeof vol === 'string' ? vol : vol.source || '';

      if (volStr.includes('/var/run/docker.sock')) {
        findings.push({
          severity: 'critical',
          title: `Container "${name}" mounts Docker socket`,
          detail: `Docker socket access allows container escape and full host control. Found in ${sourceLabel}.`,
          remediation: 'Remove the Docker socket mount. Use Docker-in-Docker or rootless alternatives.',
        });
      }

      const hostPath = volStr.split(':')[0];
      for (const sensitive of SENSITIVE_MOUNTS) {
        if (hostPath === sensitive) {
          findings.push({
            severity: 'critical',
            title: `Container "${name}" mounts sensitive path: ${sensitive}`,
            detail: `Mounting ${sensitive} gives the container broad host filesystem access. Found in ${sourceLabel}.`,
            remediation: 'Scope volume mounts to specific project directories.',
          });
        }
      }
    }

    // Check cap_drop
    const capDrop = service.cap_drop || [];
    if (!capDrop.includes('ALL')) {
      findings.push({
        severity: 'warning',
        title: `Container "${name}" missing cap_drop: [ALL]`,
        detail: `Without dropping all capabilities, the container retains default Linux capabilities. Found in ${sourceLabel}.`,
        remediation: 'Add cap_drop: [ALL] and only add back specific capabilities needed.',
      });
    }

    // Check security_opt for no-new-privileges
    const securityOpt = service.security_opt || [];
    if (!securityOpt.some((opt) => opt.startsWith('no-new-privileges'))) {
      findings.push({
        severity: 'info',
        title: `Container "${name}" missing no-new-privileges`,
        detail: `Without no-new-privileges, processes inside the container can escalate privileges. Found in ${sourceLabel}.`,
        remediation: 'Add security_opt: [no-new-privileges] to the service.',
      });
    }

    // Check for user directive
    if (!service.user) {
      findings.push({
        severity: 'warning',
        title: `Container "${name}" has no user directive`,
        detail: `Container will run as root by default. Found in ${sourceLabel}.`,
        remediation: 'Add a user directive to run as a non-root user.',
      });
    }

    // Check memory limits
    const hasMemLimit = service.mem_limit || service.deploy?.resources?.limits?.memory;
    if (!hasMemLimit) {
      findings.push({
        severity: 'info',
        title: `Container "${name}" has no memory limit`,
        detail: `Without memory limits, a runaway container can exhaust host memory. Found in ${sourceLabel}.`,
        remediation: 'Add mem_limit or deploy.resources.limits.memory to the service.',
      });
    }
  }
}

/**
 * Resolve compose `include` directives and analyze included files.
 */
async function resolveComposeIncludes(compose, composeDir, findings) {
  const includes = compose?.include;
  if (!includes || !Array.isArray(includes)) return;

  for (const inc of includes) {
    // include can be a string path or an object with `path` key
    const incPath = typeof inc === 'string' ? inc : inc?.path;
    if (!incPath) continue;

    const resolvedPath = path.resolve(composeDir, incPath);
    const content = await readFileSafe(resolvedPath);
    if (!content) continue;

    try {
      const included = YAML.parse(content);
      const services = included?.services || {};
      const label = path.basename(resolvedPath);
      analyzeComposeServices(services, findings, label);
    } catch {
      findings.push({
        severity: 'info',
        title: `Failed to parse included file: ${path.basename(resolvedPath)}`,
        detail: `The included compose file ${resolvedPath} has invalid YAML syntax and could not be analyzed.`,
      });
    }
  }
}

/**
 * Extract pod spec from a Kubernetes resource (handles nested templates).
 */
function extractPodSpec(doc) {
  // Pod kind has spec directly
  if (doc.kind === 'Pod') {
    return doc.spec;
  }
  // CronJob has jobTemplate.spec.template.spec
  if (doc.kind === 'CronJob') {
    return doc.spec?.jobTemplate?.spec?.template?.spec;
  }
  // Deployment, StatefulSet, DaemonSet, ReplicaSet, Job have template.spec
  return doc.spec?.template?.spec;
}

/**
 * Analyze a Kubernetes pod spec for security issues.
 */
function analyzeK8sPodSpec(podSpec, resourceName, kind, fileName, findings) {
  if (!podSpec) return;

  const label = `${kind}/${resourceName} in ${fileName}`;

  // hostNetwork
  if (podSpec.hostNetwork === true) {
    findings.push({
      severity: 'warning',
      title: `K8s ${label}: hostNetwork enabled`,
      detail: 'Pod shares the host network namespace, exposing all host ports.',
      remediation: 'Remove hostNetwork: true unless specifically required.',
    });
  }

  // hostPID
  if (podSpec.hostPID === true) {
    findings.push({
      severity: 'warning',
      title: `K8s ${label}: hostPID enabled`,
      detail: 'Pod shares the host PID namespace, allowing visibility into host processes.',
      remediation: 'Remove hostPID: true unless specifically required.',
    });
  }

  // hostIPC
  if (podSpec.hostIPC === true) {
    findings.push({
      severity: 'warning',
      title: `K8s ${label}: hostIPC enabled`,
      detail: 'Pod shares the host IPC namespace.',
      remediation: 'Remove hostIPC: true unless specifically required.',
    });
  }

  // Check pod-level securityContext
  const podSecCtx = podSpec.securityContext || {};
  if (podSecCtx.runAsNonRoot !== true && !podSecCtx.runAsUser) {
    findings.push({
      severity: 'info',
      title: `K8s ${label}: no pod-level runAsNonRoot`,
      detail: 'Pod does not enforce non-root execution at the pod level.',
      remediation: 'Add securityContext.runAsNonRoot: true to the pod spec.',
    });
  }

  // Check containers
  const containers = [...(podSpec.containers || []), ...(podSpec.initContainers || [])];
  for (const container of containers) {
    const cLabel = `${kind}/${resourceName}/${container.name || 'unnamed'} in ${fileName}`;
    const secCtx = container.securityContext || {};

    // privileged
    if (secCtx.privileged === true) {
      findings.push({
        severity: 'critical',
        title: `K8s ${cLabel}: privileged container`,
        detail: 'Container runs in privileged mode with full host access.',
        remediation: 'Remove securityContext.privileged: true.',
      });
    }

    // capabilities
    const caps = secCtx.capabilities || {};
    const dropAll = (caps.drop || []).some((c) => c === 'ALL' || c === 'all');
    if (!dropAll) {
      findings.push({
        severity: 'info',
        title: `K8s ${cLabel}: capabilities not dropped`,
        detail: 'Container does not drop all capabilities.',
        remediation: 'Add securityContext.capabilities.drop: ["ALL"] and add back only what is needed.',
      });
    }

    // allowPrivilegeEscalation
    if (secCtx.allowPrivilegeEscalation === true) {
      findings.push({
        severity: 'warning',
        title: `K8s ${cLabel}: allowPrivilegeEscalation is true`,
        detail: 'Container allows privilege escalation.',
        remediation: 'Set securityContext.allowPrivilegeEscalation: false.',
      });
    }

    // Resource limits
    if (!container.resources?.limits) {
      findings.push({
        severity: 'info',
        title: `K8s ${cLabel}: no resource limits`,
        detail: 'Container has no CPU/memory limits set.',
        remediation: 'Add resources.limits to prevent resource exhaustion.',
      });
    }
  }

  // Check volumes for sensitive hostPath mounts
  const volumes = podSpec.volumes || [];
  for (const vol of volumes) {
    if (vol.hostPath) {
      const hp = vol.hostPath.path;
      for (const sensitive of SENSITIVE_MOUNTS) {
        if (hp === sensitive) {
          findings.push({
            severity: 'critical',
            title: `K8s ${label}: hostPath mounts ${sensitive}`,
            detail: `Volume "${vol.name}" mounts sensitive host path ${sensitive}.`,
            remediation: 'Use PersistentVolumeClaims instead of hostPath for sensitive directories.',
          });
        }
      }
    }
  }
}

/**
 * Scan for Kubernetes manifest YAML files in cwd.
 */
async function scanK8sManifests(cwd, findings) {
  const entries = await fs.promises.readdir(cwd).catch(() => []);
  // Also check common k8s directories
  const k8sDirs = ['k8s', 'kubernetes', 'manifests', 'deploy'];
  const allDirs = [cwd];
  for (const d of k8sDirs) {
    const dirPath = path.join(cwd, d);
    try {
      const stat = await fs.promises.stat(dirPath);
      if (stat.isDirectory()) allDirs.push(dirPath);
    } catch {
      // doesn't exist
    }
  }

  let foundAny = false;

  for (const dir of allDirs) {
    const dirEntries = await fs.promises.readdir(dir).catch(() => []);
    const yamlFiles = dirEntries.filter((e) => e.endsWith('.yml') || e.endsWith('.yaml'));

    for (const file of yamlFiles) {
      // Skip compose files — those are handled separately
      if (COMPOSE_PATTERNS.includes(file)) continue;

      const filePath = path.join(dir, file);
      const content = await readFileSafe(filePath);
      if (!content) continue;

      // Parse multi-document YAML (--- separators)
      let docs;
      try {
        docs = YAML.parseAllDocuments(content);
      } catch {
        continue;
      }

      for (const doc of docs) {
        const parsed = doc.toJSON?.();
        if (!parsed || !parsed.kind) continue;
        if (!K8S_WORKLOAD_KINDS.includes(parsed.kind)) continue;

        foundAny = true;
        const resourceName = parsed.metadata?.name || 'unnamed';
        const relFile = path.relative(cwd, filePath) || file;
        const podSpec = extractPodSpec(parsed);
        analyzeK8sPodSpec(podSpec, resourceName, parsed.kind, relFile, findings);
      }
    }
  }

  return foundAny;
}

export default {
  id: 'docker-security',
  name: 'Docker security',
  category: 'isolation',
  weight: 15,

  async run(context) {
    const { cwd, config } = context;
    const findings = [];

    // Collect compose file paths: defaults + config-specified
    const composeCandidates = COMPOSE_PATTERNS.map((p) => path.join(cwd, p));
    if (config?.paths?.dockerCompose) {
      for (const p of config.paths.dockerCompose) {
        composeCandidates.push(p);
      }
    }

    // Find first compose file
    let composeContent = null;
    let composeFile = null;
    let composeDir = null;
    for (const candidate of composeCandidates) {
      const content = await readFileSafe(candidate);
      if (content) {
        composeContent = content;
        composeFile = path.basename(candidate);
        composeDir = path.dirname(candidate);
        break;
      }
    }

    // Find Dockerfiles
    const entries = await fs.promises.readdir(cwd).catch(() => []);
    const dockerfiles = entries.filter((e) => e === 'Dockerfile' || e.startsWith('Dockerfile.'));

    // Check for devcontainer.json
    const devcontainerPath = path.join(cwd, '.devcontainer', 'devcontainer.json');
    const devcontainer = await readJsonSafe(devcontainerPath);

    // Scan for Kubernetes manifests
    const hasK8s = await scanK8sManifests(cwd, findings);

    if (!composeContent && dockerfiles.length === 0 && !devcontainer && !hasK8s) {
      findings.push({
        severity: 'info',
        title: 'No container configuration found',
        detail: 'No docker-compose, Dockerfile, devcontainer.json, or Kubernetes manifests found.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    // Analyze compose file
    if (composeContent) {
      let compose;
      try {
        compose = YAML.parse(composeContent);
      } catch {
        findings.push({
          severity: 'warning',
          title: `Failed to parse ${composeFile}`,
          detail: 'The compose file has invalid YAML syntax.',
        });
        return { score: calculateCheckScore(findings), findings };
      }

      const services = compose?.services || {};
      analyzeComposeServices(services, findings, composeFile);

      // Resolve and analyze included compose files
      await resolveComposeIncludes(compose, composeDir, findings);
    }

    // Check Dockerfiles for USER directive
    for (const df of dockerfiles) {
      const content = await readFileSafe(path.join(cwd, df));
      if (content && !/^USER\s+/m.test(content)) {
        findings.push({
          severity: 'warning',
          title: `${df} has no USER directive`,
          detail: 'Container will run as root by default.',
          remediation: 'Add a USER directive to run as a non-root user.',
        });
      }
    }

    // Check devcontainer.json for security issues
    if (devcontainer) {
      const runArgs = devcontainer.runArgs || [];
      const capAdd = devcontainer.capAdd || [];

      if (runArgs.includes('--privileged')) {
        findings.push({
          severity: 'critical',
          title: 'Devcontainer uses --privileged mode',
          detail: 'The devcontainer.json has --privileged in runArgs, granting full host access.',
          remediation: 'Remove --privileged from runArgs and use specific capabilities instead.',
        });
      }

      const dangerousCaps = ['SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'ALL'];
      const addedDangerous = capAdd.filter((c) => dangerousCaps.includes(c));
      if (addedDangerous.length > 0) {
        findings.push({
          severity: 'warning',
          title: `Devcontainer adds capabilities: ${addedDangerous.join(', ')}`,
          detail: 'Adding broad capabilities to devcontainers increases attack surface.',
          remediation: 'Remove unnecessary capabilities from capAdd.',
        });
      }

      const mounts = devcontainer.mounts || [];
      for (const mount of mounts) {
        const mountStr = typeof mount === 'string' ? mount : mount.source || '';
        if (mountStr.includes('/var/run/docker.sock')) {
          findings.push({
            severity: 'critical',
            title: 'Devcontainer mounts Docker socket',
            detail: 'Docker socket access in devcontainer allows container escape.',
            remediation: 'Remove Docker socket mount from devcontainer.json.',
          });
        }
      }
    }

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'Container configuration looks secure',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
