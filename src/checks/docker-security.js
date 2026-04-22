import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE, KEY_PATTERNS } from '../constants.js';
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
        findingId: 'docker-security/container-running-with-privileged-true',
        severity: 'critical',
        title: `Container "${name}" running with privileged: true`,
        detail: `Privileged containers have full access to the host system. Found in ${sourceLabel}.`,
        remediation: 'Remove privileged: true and use specific capabilities instead.',
      });
    }

    // Check network_mode
    if (service.network_mode === 'host') {
      findings.push({
        findingId: 'docker-security/container-uses-host-network-mode',
        severity: 'warning',
        title: `Container "${name}" uses host network mode`,
        detail: `Host network mode exposes all host ports to the container. Found in ${sourceLabel}.`,
        remediation: 'Use bridge networking with explicit port mappings.',
      });
    }

    // Check ipc: host (breaks container IPC isolation)
    if (service.ipc === 'host') {
      findings.push({
        findingId: 'docker-security/container-uses-ipc-host',
        severity: 'critical',
        title: `Container "${name}" uses ipc: host`,
        detail: `Host IPC namespace allows full inter-process communication with the host. Found in ${sourceLabel}.`,
        remediation: 'Remove ipc: host. Use default IPC isolation.',
      });
    }

    // Check pid: host (breaks container PID isolation)
    if (service.pid === 'host') {
      findings.push({
        findingId: 'docker-security/container-uses-pid-host',
        severity: 'critical',
        title: `Container "${name}" uses pid: host`,
        detail: `Host PID namespace allows the container to see and signal all host processes. Found in ${sourceLabel}.`,
        remediation: 'Remove pid: host. Use default PID isolation.',
      });
    }

    // Check volumes_from (inherits all mounts from another container)
    if (service.volumes_from && Array.isArray(service.volumes_from) && service.volumes_from.length > 0) {
      findings.push({
        findingId: 'docker-security/container-uses-volumes-from',
        severity: 'warning',
        title: `Container "${name}" uses volumes_from`,
        detail: `volumes_from inherits all volume mounts from another container, which may include sensitive paths. Found in ${sourceLabel}.`,
        remediation: 'Define explicit volume mounts instead of inheriting from other containers.',
      });
    }

    // Check cap_add for dangerous capabilities
    const capAdd = service.cap_add || [];
    const dangerousCaps = ['SYS_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'DAC_OVERRIDE', 'NET_ADMIN'];
    for (const cap of capAdd) {
      if (dangerousCaps.includes(cap)) {
        findings.push({
          findingId: 'docker-security/container-adds-dangerous-capability',
          severity: 'critical',
          title: `Container "${name}" adds dangerous capability: ${cap}`,
          detail: `${cap} capability can enable privilege escalation or container escape. Found in ${sourceLabel}.`,
          remediation: `Remove ${cap} from cap_add. Use the minimum capabilities needed.`,
        });
      }
    }

    // Check volumes
    const volumes = service.volumes || [];
    for (const vol of volumes) {
      const volStr = typeof vol === 'string' ? vol : vol.source || '';

      if (volStr.includes('/docker.sock') || volStr.includes('/podman.sock')) {
        findings.push({
          findingId: 'docker-security/container-mounts-docker-socket',
          severity: 'critical',
          title: `Container "${name}" mounts Docker socket`,
          detail: `Docker socket access allows container escape and full host control. Found in ${sourceLabel}.`,
          remediation: 'Remove the Docker socket mount. Use Docker-in-Docker or rootless alternatives.',
          learnMore: 'https://headlessmode.com/tools/rigscore/#docker-socket-risk',
        });
      }

      const hostPath = volStr.split(':')[0];

      // Check for path traversal in host path
      if (hostPath.includes('..')) {
        findings.push({
          findingId: 'docker-security/container-volume-mount-uses-path-traversal',
          severity: 'warning',
          title: `Container "${name}" volume mount uses path traversal`,
          detail: `Host path "${hostPath}" contains ".." which may escape the project scope. Found in ${sourceLabel}.`,
          remediation: 'Use absolute paths scoped to your project directory.',
        });
      }

      for (const sensitive of SENSITIVE_MOUNTS) {
        if (hostPath === sensitive) {
          findings.push({
            findingId: 'docker-security/container-mounts-sensitive-path',
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
        findingId: 'docker-security/container-missing-cap-drop-all',
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
        findingId: 'docker-security/container-missing-no-new-privileges',
        severity: 'info',
        title: `Container "${name}" missing no-new-privileges`,
        detail: `Without no-new-privileges, processes inside the container can escalate privileges. Found in ${sourceLabel}.`,
        remediation: 'Add security_opt: [no-new-privileges] to the service.',
      });
    }

    // Check for user directive
    if (!service.user) {
      findings.push({
        findingId: 'docker-security/container-has-no-user-directive',
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
        findingId: 'docker-security/container-has-no-memory-limit',
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
        findingId: 'docker-security/failed-to-parse-included-file',
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
      findingId: 'docker-security/k8s-hostnetwork-enabled',
      severity: 'warning',
      title: `K8s ${label}: hostNetwork enabled`,
      detail: 'Pod shares the host network namespace, exposing all host ports.',
      remediation: 'Remove hostNetwork: true unless specifically required.',
    });
  }

  // hostPID
  if (podSpec.hostPID === true) {
    findings.push({
      findingId: 'docker-security/k8s-hostpid-enabled',
      severity: 'warning',
      title: `K8s ${label}: hostPID enabled`,
      detail: 'Pod shares the host PID namespace, allowing visibility into host processes.',
      remediation: 'Remove hostPID: true unless specifically required.',
    });
  }

  // hostIPC
  if (podSpec.hostIPC === true) {
    findings.push({
      findingId: 'docker-security/k8s-hostipc-enabled',
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
      findingId: 'docker-security/k8s-no-pod-level-runasnonroot',
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
        findingId: 'docker-security/k8s-privileged-container',
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
        findingId: 'docker-security/k8s-capabilities-not-dropped',
        severity: 'info',
        title: `K8s ${cLabel}: capabilities not dropped`,
        detail: 'Container does not drop all capabilities.',
        remediation: 'Add securityContext.capabilities.drop: ["ALL"] and add back only what is needed.',
      });
    }

    // allowPrivilegeEscalation
    if (secCtx.allowPrivilegeEscalation === true) {
      findings.push({
        findingId: 'docker-security/k8s-allowprivilegeescalation-is-true',
        severity: 'warning',
        title: `K8s ${cLabel}: allowPrivilegeEscalation is true`,
        detail: 'Container allows privilege escalation.',
        remediation: 'Set securityContext.allowPrivilegeEscalation: false.',
      });
    }

    // Resource limits
    if (!container.resources?.limits) {
      findings.push({
        findingId: 'docker-security/k8s-no-resource-limits',
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
            findingId: 'docker-security/k8s-hostpath-mounts',
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
  // Also check common k8s directories. Use lstat so a symlink pointing at a
  // system dir (/, /etc) or a cycle into cwd itself doesn't double-scan.
  // Visited-inode set deduplicates real targets.
  const k8sDirs = ['k8s', 'kubernetes', 'manifests', 'deploy'];
  const allDirs = [cwd];
  const visited = new Set();
  try {
    const rootStat = await fs.promises.stat(cwd);
    visited.add(`${rootStat.dev}:${rootStat.ino}`);
  } catch { /* cwd unreadable */ }
  for (const d of k8sDirs) {
    const dirPath = path.join(cwd, d);
    let lst;
    try { lst = await fs.promises.lstat(dirPath); } catch { continue; }
    // Resolve real target for symlinks; require a directory at the end.
    let realPath = dirPath;
    if (lst.isSymbolicLink()) {
      try { realPath = await fs.promises.realpath(dirPath); } catch { continue; }
    }
    let st;
    try { st = await fs.promises.stat(realPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    const key = `${st.dev}:${st.ino}`;
    if (visited.has(key)) continue; // symlink pointing back into cwd
    visited.add(key);
    allDirs.push(realPath);
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
  enforcementGrade: 'mechanical',
  name: 'Docker security',
  category: 'isolation',

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

    // Collect all compose files found
    const composeFiles = [];
    for (const candidate of composeCandidates) {
      const content = await readFileSafe(candidate);
      if (content) {
        composeFiles.push({
          content,
          file: path.basename(candidate),
          dir: path.dirname(candidate),
        });
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

    if (composeFiles.length === 0 && dockerfiles.length === 0 && !devcontainer && !hasK8s) {
      findings.push({
        findingId: 'docker-security/no-container-configuration-found',
        severity: 'info',
        title: 'No container configuration found',
        detail: 'No docker-compose, Dockerfile, devcontainer.json, or Kubernetes manifests found.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    // Analyze all compose files
    for (const cf of composeFiles) {
      let compose;
      try {
        compose = YAML.parse(cf.content);
      } catch {
        findings.push({
          findingId: 'docker-security/failed-to-parse',
          severity: 'warning',
          title: `Failed to parse ${cf.file}`,
          detail: 'The compose file has invalid YAML syntax.',
        });
        continue;
      }

      const services = compose?.services || {};
      analyzeComposeServices(services, findings, cf.file);

      // Resolve and analyze included compose files
      await resolveComposeIncludes(compose, cf.dir, findings);
    }

    // Check Dockerfiles for security issues
    for (const df of dockerfiles) {
      const content = await readFileSafe(path.join(cwd, df));
      if (!content) continue;

      // No USER directive — container runs as root
      if (!/^USER\s+/m.test(content)) {
        findings.push({
          findingId: 'docker-security/has-no-user-directive',
          severity: 'warning',
          title: `${df} has no USER directive`,
          detail: 'Container will run as root by default.',
          remediation: 'Add a USER directive to run as a non-root user.',
        });
      }

      // Unpinned base images (FROM image:latest or FROM image without tag/digest)
      const fromLines = content.match(/^FROM\s+\S+/gm) || [];
      for (const fromLine of fromLines) {
        const image = fromLine.replace(/^FROM\s+/, '').trim();
        // Skip build args (FROM $VAR) and scratch
        if (image.startsWith('$') || image === 'scratch') continue;
        // Pinned = has @sha256: digest or a tag that isn't "latest"
        const hasDigest = image.includes('@sha256:');
        const hasTag = image.includes(':');
        const isLatest = image.endsWith(':latest');
        if (!hasDigest && (!hasTag || isLatest)) {
          findings.push({
            findingId: 'docker-security/unpinned-base-image',
            severity: 'warning',
            title: `${df}: unpinned base image "${image}"`,
            detail: 'Unpinned or :latest base images can change unexpectedly and introduce vulnerabilities.',
            remediation: 'Pin base images to a specific version tag or sha256 digest.',
          });
        }
      }

      // ADD with remote URL (should use COPY or curl+verify)
      const addLines = content.match(/^ADD\s+https?:\/\//gm) || [];
      if (addLines.length > 0) {
        findings.push({
          findingId: 'docker-security/add-with-remote-url',
          severity: 'warning',
          title: `${df}: ADD with remote URL`,
          detail: 'ADD with remote URLs can fetch unverified content. Use COPY with explicit download and checksum verification.',
          remediation: 'Replace ADD <url> with RUN curl/wget + checksum verification + COPY.',
        });
      }

      // COPY/ADD of sensitive files (.env, credentials.json, *.pem, *.key, id_rsa)
      const sensitiveFilePatterns = [/\.env\b/, /credentials\.json/, /\.pem\b/, /\.key\b/, /\bid_rsa\b/];
      const copyAddLines = content.match(/^(?:COPY|ADD)\s+.+$/gm) || [];
      for (const line of copyAddLines) {
        // Skip remote URLs (already handled above)
        if (/^ADD\s+https?:\/\//.test(line)) continue;
        for (const sfp of sensitiveFilePatterns) {
          if (sfp.test(line)) {
            const matched = line.match(sfp)?.[0] || 'sensitive file';
            findings.push({
              findingId: 'docker-security/copies-sensitive-file',
              severity: 'warning',
              title: `${df}: copies sensitive file (${matched})`,
              detail: `COPY/ADD of ${matched} bakes secrets into the image layer.`,
              remediation: 'Use .dockerignore to exclude sensitive files, or mount them at runtime.',
            });
            break; // one finding per line
          }
        }
      }

      // Multi-stage build running as root in final stage
      const stages = content.split(/^FROM\s+/m);
      if (stages.length > 2) {
        // Last stage is stages[stages.length - 1]
        const finalStage = stages[stages.length - 1];
        if (!/^USER\s+/m.test(finalStage)) {
          // Only add if we haven't already flagged missing USER for the whole file
          const alreadyFlagged = findings.some((f) => f.title === `${df} has no USER directive`);
          if (!alreadyFlagged) {
            findings.push({
              findingId: 'docker-security/multi-stage-build-runs-as-root-in-final-stage',
              severity: 'warning',
              title: `${df}: multi-stage build runs as root in final stage`,
              detail: 'The final stage of a multi-stage Dockerfile has no USER directive.',
              remediation: 'Add USER directive to the final stage to run as non-root.',
            });
          }
        }
      }

      // --- RUN instruction analysis ---

      // Join backslash-continuation lines for RUN analysis
      const normalizedContent = content.replace(/\\\s*\n\s*/g, ' ');
      const runLines = normalizedContent.match(/^RUN\s+.+$/gm) || [];

      for (const runLine of runLines) {
        // Pipe-to-shell
        if (/\b(curl|wget)\b.*\|\s*(ba)?sh\b/.test(runLine)) {
          findings.push({
            findingId: 'docker-security/pipe-to-shell-in-run-instruction',
            severity: 'warning',
            title: `${df}: pipe-to-shell in RUN instruction`,
            detail: 'Piping curl/wget output directly to a shell executes unverified remote code.',
            remediation: 'Download the script first, verify its checksum, then execute it.',
          });
        }

        // Secrets in RUN instruction
        for (const pattern of KEY_PATTERNS) {
          if (pattern.test(runLine)) {
            findings.push({
              findingId: 'docker-security/secret-in-run-instruction',
              severity: 'critical',
              title: `${df}: secret in RUN instruction`,
              detail: 'A secret or API key pattern was detected in a RUN instruction. This will be baked into the image layer.',
              remediation: 'Use build secrets (--mount=type=secret) or environment variables instead of hardcoding secrets.',
            });
            break;
          }
        }

        // chmod 777
        if (/\bchmod\s+(-R\s+)?777\b/.test(runLine)) {
          findings.push({
            findingId: 'docker-security/chmod-777-in-run-instruction',
            severity: 'warning',
            title: `${df}: chmod 777 in RUN instruction`,
            detail: 'chmod 777 grants read/write/execute to all users, which is overly permissive.',
            remediation: 'Use more restrictive permissions (e.g., chmod 755 or chmod 700).',
          });
        }

        // apt-get install without --no-install-recommends
        if (/\bapt-get\s+install\b/.test(runLine) && !/--no-install-recommends/.test(runLine)) {
          findings.push({
            findingId: 'docker-security/apt-get-install-without-no-install-recommends',
            severity: 'info',
            title: `${df}: apt-get install without --no-install-recommends`,
            detail: 'Installing recommended packages increases image size and attack surface.',
            remediation: 'Add --no-install-recommends to apt-get install commands.',
          });
        }

        // apk add without --no-cache
        if (/\bapk\s+add\b/.test(runLine) && !/--no-cache/.test(runLine)) {
          findings.push({
            findingId: 'docker-security/apk-add-without-no-cache',
            severity: 'info',
            title: `${df}: apk add without --no-cache`,
            detail: 'Without --no-cache, apk stores the package index in the image, increasing its size.',
            remediation: 'Add --no-cache to apk add commands.',
          });
        }
      }

      // EXPOSE 22 (SSH port) — check original content
      if (/^EXPOSE\s+.*\b22\b/m.test(content)) {
        findings.push({
          findingId: 'docker-security/exposes-ssh-port-22',
          severity: 'warning',
          title: `${df}: exposes SSH port (22)`,
          detail: 'Exposing SSH port in a container is generally unnecessary and increases attack surface.',
          remediation: 'Remove EXPOSE 22 and use docker exec or kubectl exec for container access.',
        });
      }
    }

    // Check devcontainer.json for security issues
    if (devcontainer) {
      const runArgs = devcontainer.runArgs || [];
      const capAdd = devcontainer.capAdd || [];

      if (runArgs.includes('--privileged')) {
        findings.push({
          findingId: 'docker-security/devcontainer-uses-privileged-mode',
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
          findingId: 'docker-security/devcontainer-adds-capabilities',
          severity: 'warning',
          title: `Devcontainer adds capabilities: ${addedDangerous.join(', ')}`,
          detail: 'Adding broad capabilities to devcontainers increases attack surface.',
          remediation: 'Remove unnecessary capabilities from capAdd.',
        });
      }

      const mounts = devcontainer.mounts || [];
      for (const mount of mounts) {
        const mountStr = typeof mount === 'string' ? mount : mount.source || '';
        if (mountStr.includes('/docker.sock') || mountStr.includes('/podman.sock')) {
          findings.push({
            findingId: 'docker-security/devcontainer-mounts-docker-socket',
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

    const hasPrivilegedContainer = findings.some(
      (f) => f.severity === 'critical' && f.title.includes('privileged'),
    );

    return {
      score: calculateCheckScore(findings),
      findings,
      data: { hasPrivilegedContainer },
    };
  },
};
