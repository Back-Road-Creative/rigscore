# windows-security

**Enforcement grade:** `mechanical` — parses INI-grammar keys in `/etc/wsl.conf` / `.wslconfig` and compares Defender exclusion-path sets to deterministic invariants. Not prose keyword matching.

## Purpose

Surfaces Windows- and WSL-specific isolation weaknesses that aren't covered by the cross-platform hygiene checks: WSL interop bridging Windows and Linux process space, `.wslconfig` networking modes that collapse the host/guest boundary, Windows Defender exclusions that silently disable scanning for project paths, and an NTFS permissions advisory for sensitive files. A passing check means either (a) the machine is neither a Windows host nor a WSL guest, and the check short-circuits to N/A, or (b) WSL interop is scoped, `.wslconfig` uses NAT + firewall, and Defender has no project-path exclusions. A failure means one of those guardrails is open — typically the highest-impact one is `appendWindowsPath=true` under interop, which lets WSL processes execute Windows binaries directly. No OWASP Agentic Top 10 mapping: this check is about host-level isolation, not agent behavior.

**Two arms, two platforms.** The findings split by where the file they read actually lives, and each arm only runs where that is:

| Arm | Reads | Runs when |
|---|---|---|
| WSL interop | `/etc/wsl.conf` | **WSL guest** (`process.platform === 'linux'` + a WSL kernel marker) — this is a Linux-guest file, and never exists on the Windows host. |
| `.wslconfig`, Defender exclusions, NTFS advisory | `%USERPROFILE%\.wslconfig`, `Get-MpPreference`, — | **Windows host** (`process.platform === 'win32'`). |

A plain (non-WSL) Linux or macOS machine matches neither arm and stays N/A. Guest detection reads the kernel's own release string (`/proc/sys/kernel/osrelease`, which contains `microsoft` under WSL1/WSL2) rather than `$WSL_DISTRO_NAME`, which is absent from systemd units, cron jobs, and containers. Both that path and `/etc/wsl.conf` are absolute host paths, so they are injectable through the scan context (`scan({ wslConfPath, wslOsReleasePath })`) — tests pin them instead of reading the real machine.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Neither a Windows host nor a WSL guest (plain Linux, macOS) | SKIPPED | — (SARIF level `none`, suppressed) | No action — neither arm applies. |
| **Guest:** `/etc/wsl.conf` has `[interop] enabled=true` and `appendWindowsPath` is `true` (or unset, which defaults to true) | WARNING | `windows-security/wsl-interop-exposes-path` | Set `appendWindowsPath=false` in `/etc/wsl.conf` `[interop]`. |
| **Guest:** `[interop] enabled=true` with an explicit `appendWindowsPath=false` | INFO | `windows-security/wsl-interop-enabled` | Informational — exposure is limited. |
| **Guest:** WSL interop disabled | PASS | — | — |
| **Host:** `%USERPROFILE%\.wslconfig` sets `networkingMode=mirrored` | INFO | `windows-security/wsl-mirrored-networking` | Consider NAT mode for stronger host/guest isolation. |
| **Host:** `.wslconfig` exists but has no `firewall=true` line | INFO | `windows-security/wsl-firewall-not-enabled` | Add `firewall=true` to `.wslconfig`. |
| **Host:** `.wslconfig` has `firewall=true` | PASS | — | — |
| **Host:** a Defender `ExclusionPath` contains `node_modules` or the scanned project path | WARNING | `windows-security/defender-excludes-project-paths` | Remove project-path exclusions via `Remove-MpPreference -ExclusionPath`. |
| **Host:** NTFS permissions advisory — unconditional, appended to every Windows-host run | INFO | `windows-security/ntfs-permissions-advisory` | Run `icacls .env /inheritance:r /grant:r "%USERNAME%":F` on sensitive files. |

## Weight rationale

Advisory — weight 0. This check only produces signal on a Windows host or a WSL guest and short-circuits everywhere else; scoring it would penalize or credit cross-platform projects based on where they happen to be scanned, which is noise. The findings are also configuration-advice in nature (WSL/Defender posture) rather than concrete vulnerabilities with deterministic remediations, so they belong in the advisory lane rather than competing for moat-first budget with scored checks like `mcp-config` or `env-exposure`.

## Fix semantics

No `fixes` export. `--fix --yes` is a no-op for this check.

- All triggers require manual remediation: WSL config lives outside the project tree (`/etc/wsl.conf`, `%USERPROFILE%\.wslconfig`), Defender exclusions require PowerShell with elevated privileges, and NTFS ACL changes touch user-owned files. None of these are safe to mutate from a repo-scoped scanner.

## SARIF

- Tool component: `rigscore`; rule IDs are the per-finding `windows-security/*` ids in the Triggers table, with `windows-security` as the check-level fallback rule.
- Level mapping: WARNING → `warning`, INFO → `note`, SKIPPED/PASS → `none` (suppressed from SARIF output).
- Location data: no physical file location for `/etc/wsl.conf` or `.wslconfig` (they live outside the scanned project); Defender findings carry the exclusion path string in the message.

## Example

```
ⓘ windows-security — advisory
  WARNING WSL interop exposes Windows PATH
    WSL is configured with interop enabled and appendWindowsPath=true.
    Windows executables are accessible from WSL.
  INFO NTFS permissions advisory
    On Windows, use icacls to verify sensitive files (credentials, keys,
    .env) are not accessible to other users.
    Run: icacls .env /inheritance:r /grant:r "%USERNAME%":F
```

## Scope and limitations

- Platform gate: returns `NOT_APPLICABLE` unless the machine is a Windows host (`win32`) or a WSL guest (`linux` + a `microsoft` kernel marker). A plain Linux or macOS scan will never show findings from this module.
- Each arm only runs when the file it parses exists: `/etc/wsl.conf` on the guest, `%USERPROFILE%\.wslconfig` on the host. A WSL guest with no `wsl.conf` at all reports nothing rather than assuming WSL's defaults.
- A container running on the WSL2 kernel matches the guest marker (it shares that kernel). This is intended, and harmless: the interop arm still only speaks if a `wsl.conf` is actually present in that filesystem.
- Defender check shells out to `powershell.exe Get-MpPreference` with a 5s timeout, **from the Windows host only** — `powershell.exe` is reachable from a WSL guest over interop, but the guest deliberately does not cross that boundary to query the host's posture. On systems without PowerShell in PATH, or where Defender is managed by a third party, it silently degrades.
- The NTFS permissions row is an advisory reminder that always fires on a Windows host (never on the guest, whose rootfs is ext4) — it's a prompt, not a detected weakness.
