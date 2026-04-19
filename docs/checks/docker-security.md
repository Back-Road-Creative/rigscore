# docker-security

## Purpose

Scans container configuration — `docker-compose.yml` / `compose.yaml`, `Dockerfile` / `Dockerfile.*`, `.devcontainer/devcontainer.json`, and Kubernetes workload manifests (`Pod`, `Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`, `Job`, `CronJob`) — for container-escape and weak-isolation patterns. Maps to **OWASP Agentic ASI05 — Unexpected Code Execution**: an AI agent with access to a privileged or socket-mounted container can break out of the sandbox and execute arbitrary code on the host. A pass guarantees that no privileged containers, Docker socket mounts, host namespaces, dangerous capabilities, or sensitive host-path mounts were found, and that Dockerfiles pin base images, run as non-root, and don't bake secrets into image layers. A failure typically means an attacker — or a hijacked agent — inside the container can reach the host filesystem, signal host processes, or pull an unverified image.

## Triggers

Every `findings.push(...)` in `src/checks/docker-security.js` becomes a row here. The `SARIF ruleId` column shows the finding-id convention (`<check-id>/<slugified-title>`) used by `--ignore` and surfaced as `tags`/`rule.id` in the SARIF run. Titles with container/stage/file variables are shown with `<name>` placeholders; the real slug is computed at runtime.

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Compose service has `privileged: true` | CRITICAL | `docker-security/container-name-running-with-privileged-true` | Remove `privileged`; use explicit `cap_add` |
| Compose service uses `network_mode: host` | WARNING | `docker-security/container-name-uses-host-network-mode` | Use bridge networking with explicit ports |
| Compose service uses `ipc: host` | CRITICAL | `docker-security/container-name-uses-ipc-host` | Remove `ipc: host` |
| Compose service uses `pid: host` | CRITICAL | `docker-security/container-name-uses-pid-host` | Remove `pid: host` |
| Compose service uses `volumes_from` | WARNING | `docker-security/container-name-uses-volumes-from` | Define explicit volume mounts |
| Compose service `cap_add` includes `SYS_ADMIN`/`SYS_PTRACE`/`SYS_MODULE`/`DAC_OVERRIDE`/`NET_ADMIN` | CRITICAL | `docker-security/container-name-adds-dangerous-capability-cap` | Drop the capability |
| Compose service mounts `docker.sock` or `podman.sock` | CRITICAL | `docker-security/container-name-mounts-docker-socket` | Remove socket mount; use rootless or DinD |
| Compose volume host path contains `..` | WARNING | `docker-security/container-name-volume-mount-uses-path-traversal` | Use absolute, project-scoped paths |
| Compose volume mounts `/`, `/etc`, `/root`, or `/home` | CRITICAL | `docker-security/container-name-mounts-sensitive-path-sensitive` | Scope to specific project directories |
| Compose service missing `cap_drop: [ALL]` | WARNING | `docker-security/container-name-missing-cap-drop-all` | Add `cap_drop: [ALL]` |
| Compose service missing `no-new-privileges` | INFO | `docker-security/container-name-missing-no-new-privileges` | Add `security_opt: [no-new-privileges]` |
| Compose service has no `user` directive | WARNING | `docker-security/container-name-has-no-user-directive` | Add a non-root `user` |
| Compose service has no memory limit | INFO | `docker-security/container-name-has-no-memory-limit` | Set `mem_limit` or `deploy.resources.limits.memory` |
| Included compose file fails to parse | INFO | `docker-security/failed-to-parse-included-file-filename` | Fix YAML in the included file |
| Top-level compose file fails to parse | WARNING | `docker-security/failed-to-parse-filename` | Fix YAML syntax |
| K8s pod spec has `hostNetwork: true` | WARNING | `docker-security/k8s-label-hostnetwork-enabled` | Remove `hostNetwork: true` |
| K8s pod spec has `hostPID: true` | WARNING | `docker-security/k8s-label-hostpid-enabled` | Remove `hostPID: true` |
| K8s pod spec has `hostIPC: true` | WARNING | `docker-security/k8s-label-hostipc-enabled` | Remove `hostIPC: true` |
| K8s pod has no pod-level `runAsNonRoot` | INFO | `docker-security/k8s-label-no-pod-level-runasnonroot` | Set `securityContext.runAsNonRoot: true` |
| K8s container `securityContext.privileged: true` | CRITICAL | `docker-security/k8s-clabel-privileged-container` | Remove `privileged: true` |
| K8s container does not drop `ALL` capabilities | INFO | `docker-security/k8s-clabel-capabilities-not-dropped` | Set `capabilities.drop: [ALL]` |
| K8s container allows `allowPrivilegeEscalation: true` | WARNING | `docker-security/k8s-clabel-allowprivilegeescalation-is-true` | Set to `false` |
| K8s container has no resource limits | INFO | `docker-security/k8s-clabel-no-resource-limits` | Add `resources.limits` |
| K8s volume `hostPath` mounts `/`, `/etc`, `/root`, or `/home` | CRITICAL | `docker-security/k8s-label-hostpath-mounts-sensitive` | Use PVCs instead of hostPath |
| Dockerfile has no `USER` directive | WARNING | `docker-security/df-has-no-user-directive` | Add `USER` |
| Dockerfile multi-stage final stage has no `USER` | WARNING | `docker-security/df-multi-stage-build-runs-as-root-in-final-stage` | Add `USER` to final stage |
| Dockerfile `FROM` uses unpinned or `:latest` tag | WARNING | `docker-security/df-unpinned-base-image-image` | Pin to version tag or `@sha256:` digest |
| Dockerfile `ADD` with remote URL | WARNING | `docker-security/df-add-with-remote-url` | Replace with `RUN curl` + checksum + `COPY` |
| Dockerfile `COPY`/`ADD` copies `.env`, `credentials.json`, `*.pem`, `*.key`, `id_rsa` | WARNING | `docker-security/df-copies-sensitive-file-matched` | Use `.dockerignore` or runtime mount |
| Dockerfile `RUN` has `curl\|wget` piped to shell | WARNING | `docker-security/df-pipe-to-shell-in-run-instruction` | Download, verify checksum, then execute |
| Dockerfile `RUN` contains secret pattern (`KEY_PATTERNS`) | CRITICAL | `docker-security/df-secret-in-run-instruction` | Use `--mount=type=secret` build secrets |
| Dockerfile `RUN` contains `chmod 777` | WARNING | `docker-security/df-chmod-777-in-run-instruction` | Use restrictive modes (755, 700) |
| Dockerfile `RUN` runs `apt-get install` without `--no-install-recommends` | INFO | `docker-security/df-apt-get-install-without-no-install-recommends` | Add the flag |
| Dockerfile `RUN` runs `apk add` without `--no-cache` | INFO | `docker-security/df-apk-add-without-no-cache` | Add `--no-cache` |
| Dockerfile `EXPOSE 22` | WARNING | `docker-security/df-exposes-ssh-port-22` | Remove `EXPOSE 22`; use `docker exec` |
| `devcontainer.json` has `--privileged` in `runArgs` | CRITICAL | `docker-security/devcontainer-uses-privileged-mode` | Remove `--privileged` |
| `devcontainer.json` `capAdd` includes `SYS_ADMIN`/`NET_ADMIN`/`SYS_PTRACE`/`ALL` | WARNING | `docker-security/devcontainer-adds-capabilities-caps` | Drop capability |
| `devcontainer.json` mounts `docker.sock`/`podman.sock` | CRITICAL | `docker-security/devcontainer-mounts-docker-socket` | Remove socket mount |
| No container config found anywhere | INFO | `docker-security/no-container-configuration-found` | N/A — check returns N/A |
| All container config looks clean | PASS | — | — |

## Weight rationale

**Weight 6 — 6 points.** Tier-2 hygiene, tied with `infrastructure-security` (6) and `credential-storage` (6). Lower than `deep-secrets`, `env-exposure`, and `claude-settings` (8 each) because most repos don't have container configuration at all — when absent, the check returns N/A and does not affect the score, so a broad 8-point weight would over-index on a signal that's frequently not applicable. Higher than `unicode-steganography` (4) and `permissions-hygiene` (4) because a privileged container or Docker-socket mount is a direct container-escape primitive — one CRITICAL finding here can zero the whole check and wipe 6 points, mirroring the severity of the underlying escape path.

## Fix semantics

**No auto-fix.** This check exports no `fixes` array. Every finding requires a human decision: whether a capability is actually required, which base-image digest to pin to, whether a host mount is intentional. Auto-modifying compose files, Dockerfiles, or Kubernetes manifests risks breaking the build or silently changing runtime behaviour — out of scope for `--fix --yes`.

- Out of scope: rewriting `docker-compose.yml`, `Dockerfile`, `devcontainer.json`, or K8s manifests.
- Out of scope: picking a pinned image digest (requires registry lookup; rigscore is offline by default).

## SARIF

- Tool component: `rigscore` (driver name in the SARIF run).
- Rule IDs: emitted as `ruleId: "docker-security"` on the SARIF result. The finer-grained `<id>/<slug>` shown in the Triggers table is the `findingId` used by `--ignore` and visible in terminal output; SARIF itself groups all findings under the check-level rule id.
- Level mapping: CRITICAL → `error`, WARNING → `warning`, INFO → `note`, PASS/SKIPPED → suppressed.
- Location: physical location is derived from filename substrings in the finding title/detail (`Dockerfile`, `docker-compose.yml`, manifest filename); otherwise logical location `docker-security` module only.
- Tags: `owasp-agentic:ASI05`, `category:isolation`.

## Example

```
docker-security ..................... 55/100  (weight 6)
  CRITICAL  Container "api" mounts Docker socket
            Docker socket access allows container escape and full host control. Found in docker-compose.yml.
            → Remove the Docker socket mount. Use Docker-in-Docker or rootless alternatives.
  CRITICAL  Container "api" adds dangerous capability: SYS_ADMIN
            SYS_ADMIN capability can enable privilege escalation or container escape. Found in docker-compose.yml.
  WARNING   Container "api" has no user directive
            Container will run as root by default. Found in docker-compose.yml.
  WARNING   Dockerfile: unpinned base image "node:latest"
            Unpinned or :latest base images can change unexpectedly and introduce vulnerabilities.
  INFO      Container "api" missing no-new-privileges
```

## Scope and limitations

- Scanned paths: `docker-compose.{yml,yaml}`, `compose.{yml,yaml}`, `podman-compose.{yml,yaml}` in `cwd`, plus any extra paths in `.rigscorerc.json` → `paths.dockerCompose`; `Dockerfile` and `Dockerfile.*` in `cwd`; `.devcontainer/devcontainer.json`; and any `*.yml`/`*.yaml` in `cwd`, `k8s/`, `kubernetes/`, `manifests/`, `deploy/` containing a `kind:` matching the workload list.
- Compose `include` directives are resolved one level deep and analyzed.
- No platform gate — runs on Linux, macOS, Windows. Returns N/A if no container config is found.
- No network calls; image digests are not verified against a registry. Use `--online` mode + a registry-aware check for digest verification (not implemented by this check).
- Dockerfile RUN analysis joins backslash-continuation lines before pattern matching. Patterns are regex-based — obfuscated shell (e.g. `$( echo c url )`) can evade detection.
