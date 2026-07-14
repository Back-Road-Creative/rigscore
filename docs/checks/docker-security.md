# docker-security

**Enforcement grade:** `mechanical` — parses Compose YAML / Dockerfile / K8s manifests and compares flags, mounts, and capabilities to deterministic known-bad constants.

## Purpose

Scans container configuration — `docker-compose.yml` / `compose.yaml`, `Dockerfile` / `Dockerfile.*`, `.devcontainer/devcontainer.json`, and Kubernetes workload manifests (`Pod`, `Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`, `Job`, `CronJob`) — for container-escape and weak-isolation patterns. Maps to **OWASP Agentic ASI05 — Unexpected Code Execution**: an AI agent with access to a privileged or socket-mounted container can break out of the sandbox and execute arbitrary code on the host. A pass guarantees that no privileged containers, Docker socket mounts, host namespaces, dangerous capabilities, or sensitive host-path mounts were found, and that Dockerfiles pin base images, run as non-root, and don't bake secrets into image layers. A failure typically means an attacker — or a hijacked agent — inside the container can reach the host filesystem, signal host processes, or pull an unverified image.

## Triggers

Every `findings.push(...)` in `src/checks/docker-security.js` becomes a row here. The `SARIF ruleId` column is the literal `findingId` string the source emits — used by `--ignore` and surfaced as `tags`/`rule.id` in the SARIF run. Finding ids are **static constants**, not slugified titles: the container name, stage, matched capability, and filename appear only in the human-readable `title`, never in the id. One id therefore covers every service/file that trips the same condition.

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Compose service has `privileged: true` | CRITICAL | `docker-security/container-running-with-privileged-true` | Remove `privileged`; use explicit `cap_add` |
| Compose service uses `network_mode: host` | WARNING | `docker-security/container-uses-host-network-mode` | Use bridge networking with explicit ports |
| Compose service uses `ipc: host` | CRITICAL | `docker-security/container-uses-ipc-host` | Remove `ipc: host` |
| Compose service uses `pid: host` | CRITICAL | `docker-security/container-uses-pid-host` | Remove `pid: host` |
| Compose service uses `volumes_from` | WARNING | `docker-security/container-uses-volumes-from` | Define explicit volume mounts |
| Compose service `cap_add` includes `SYS_ADMIN`/`SYS_PTRACE`/`SYS_MODULE`/`DAC_OVERRIDE`/`NET_ADMIN` | CRITICAL | `docker-security/container-adds-dangerous-capability` | Drop the capability |
| Compose service mounts `docker.sock` or `podman.sock` | CRITICAL | `docker-security/container-mounts-docker-socket` | Remove socket mount; use rootless or DinD |
| Compose volume host path contains `..` | WARNING | `docker-security/container-volume-mount-uses-path-traversal` | Use absolute, project-scoped paths |
| Compose volume mounts `/`, `/etc`, `/root`, or `/home` | CRITICAL | `docker-security/container-mounts-sensitive-path` | Scope to specific project directories |
| Compose service missing `cap_drop: [ALL]` | WARNING | `docker-security/container-missing-cap-drop-all` | Add `cap_drop: [ALL]` |
| Compose service missing `no-new-privileges` | INFO | `docker-security/container-missing-no-new-privileges` | Add `security_opt: [no-new-privileges]` |
| Compose service has no `user` directive | WARNING | `docker-security/container-has-no-user-directive` | Add a non-root `user` |
| Compose service has no memory limit | INFO | `docker-security/container-has-no-memory-limit` | Set `mem_limit` or `deploy.resources.limits.memory` |
| Included compose file fails to parse | INFO | `docker-security/failed-to-parse-included-file` | Fix YAML in the included file |
| Top-level compose file fails to parse | WARNING | `docker-security/failed-to-parse` | Fix YAML syntax |
| K8s pod spec has `hostNetwork: true` | WARNING | `docker-security/k8s-hostnetwork-enabled` | Remove `hostNetwork: true` |
| K8s pod spec has `hostPID: true` | WARNING | `docker-security/k8s-hostpid-enabled` | Remove `hostPID: true` |
| K8s pod spec has `hostIPC: true` | WARNING | `docker-security/k8s-hostipc-enabled` | Remove `hostIPC: true` |
| K8s pod has no pod-level `runAsNonRoot` | INFO | `docker-security/k8s-no-pod-level-runasnonroot` | Set `securityContext.runAsNonRoot: true` |
| K8s container `securityContext.privileged: true` | CRITICAL | `docker-security/k8s-privileged-container` | Remove `privileged: true` |
| K8s container does not drop `ALL` capabilities | INFO | `docker-security/k8s-capabilities-not-dropped` | Set `capabilities.drop: [ALL]` |
| K8s container allows `allowPrivilegeEscalation: true` | WARNING | `docker-security/k8s-allowprivilegeescalation-is-true` | Set to `false` |
| K8s container has no resource limits | INFO | `docker-security/k8s-no-resource-limits` | Add `resources.limits` |
| K8s volume `hostPath` mounts `/`, `/etc`, `/root`, or `/home` | CRITICAL | `docker-security/k8s-hostpath-mounts` | Use PVCs instead of hostPath |
| Dockerfile has no `USER` directive | WARNING | `docker-security/has-no-user-directive` | Add `USER` |
| Dockerfile multi-stage final stage has no `USER` | WARNING | `docker-security/multi-stage-build-runs-as-root-in-final-stage` | Add `USER` to final stage |
| Dockerfile `FROM` uses unpinned or `:latest` tag | WARNING | `docker-security/unpinned-base-image` | Pin to version tag or `@sha256:` digest |
| Dockerfile `ADD` with remote URL | WARNING | `docker-security/add-with-remote-url` | Replace with `RUN curl` + checksum + `COPY` |
| Dockerfile `COPY`/`ADD` copies `.env`, `credentials.json`, `*.pem`, `*.key`, `id_rsa` | WARNING | `docker-security/copies-sensitive-file` | Use `.dockerignore` or runtime mount |
| Dockerfile `RUN` has `curl\|wget` piped to shell | WARNING | `docker-security/pipe-to-shell-in-run-instruction` | Download, verify checksum, then execute |
| Dockerfile `RUN` contains secret pattern (`KEY_PATTERNS`) | CRITICAL | `docker-security/secret-in-run-instruction` | Use `--mount=type=secret` build secrets |
| Dockerfile `RUN` contains `chmod 777` | WARNING | `docker-security/chmod-777-in-run-instruction` | Use restrictive modes (755, 700) |
| Dockerfile `RUN` runs `apt-get install` without `--no-install-recommends` | INFO | `docker-security/apt-get-install-without-no-install-recommends` | Add the flag |
| Dockerfile `RUN` runs `apk add` without `--no-cache` | INFO | `docker-security/apk-add-without-no-cache` | Add `--no-cache` |
| Dockerfile `EXPOSE 22` | WARNING | `docker-security/exposes-ssh-port-22` | Remove `EXPOSE 22`; use `docker exec` |
| `devcontainer.json` has `--privileged` in `runArgs` | CRITICAL | `docker-security/devcontainer-uses-privileged-mode` | Remove `--privileged` |
| `devcontainer.json` `capAdd` includes `SYS_ADMIN`/`NET_ADMIN`/`SYS_PTRACE`/`ALL` | WARNING | `docker-security/devcontainer-adds-capabilities` | Drop capability |
| `devcontainer.json` mounts `docker.sock`/`podman.sock` | CRITICAL | `docker-security/devcontainer-mounts-docker-socket` | Remove socket mount |
| No container config found anywhere | INFO | `docker-security/no-container-configuration-found` | N/A — check returns N/A |
| All container config looks clean | PASS | — | — |

## Weight rationale

**Weight 6 — 6 points.** Tier-2 hygiene, tied with `infrastructure-security` (6) and `credential-storage` (6). Lower than `deep-secrets`, `env-exposure`, and `claude-settings` (8 each) because most repos don't have container configuration at all — when absent, the check returns N/A and does not affect the score, so a broad 8-point weight would over-index on a signal that's frequently not applicable. Higher than `unicode-steganography` (4) and `permissions-hygiene` (4) because a privileged container or Docker-socket mount is a direct container-escape primitive — one CRITICAL finding here can zero the whole check and wipe 6 points, mirroring the severity of the underlying escape path.

## Fix semantics

**Four compose fixes — two additive, two removal.** `--fix` can repair four findings on `docker-compose.{yml,yaml}` / `compose.{yml,yaml}` / `podman-compose.{yml,yaml}` in `cwd`. The additive pair *adds* an absent hardening key (never rewriting a value the operator already chose); the removal pair *deletes* one specific dangerous thing (never touching any other key, service, volume, or comment):

| Finding | Fixer id | Action |
|---|---|---|
| `docker-security/container-missing-cap-drop-all` | `docker-add-cap-drop-all` | Add `cap_drop: [ALL]` to each flagged service |
| `docker-security/container-missing-no-new-privileges` | `docker-add-no-new-privileges` | Add `security_opt: [no-new-privileges:true]` to each flagged service |
| `docker-security/container-running-with-privileged-true` | `docker-remove-privileged` | Remove `privileged: true` from each flagged service (`privileged: false` is left alone) |
| `docker-security/container-mounts-docker-socket` | `docker-remove-docker-socket-mount` | Remove only the `docker.sock`/`podman.sock` volume entry (short- or long-form) from each flagged service, dropping a now-empty `volumes` key |

The additive pair go through the config-merge engine (`src/lib/config-merge.js`); the removal pair use the yaml Document API directly (config-merge is additive-only and cannot delete). Both paths preserve comments and key order, are idempotent (a second `--fix` is a no-op returning no change), and skip an absent or unparseable compose file — never creating or clobbering one. An additive fixer leaves a service that *already declares* the key byte-for-byte untouched; a removal fixer only deletes the exact flagged construct and leaves every sibling volume, key, and service intact.

**Everything else needs a human decision** — whether a capability is required, which base-image digest to pin to, whether a host mount is intentional:

- Still out of scope (removal-class): removing `network_mode: host`/`ipc: host`/`pid: host`, and `volumes_from`. Deleting these can break the build or change runtime behaviour, so they remain a manual decision.
- Out of scope: rewriting `Dockerfile`, `devcontainer.json`, or K8s manifests.
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
