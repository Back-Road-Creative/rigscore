# windows-security

**Enforcement grade:** `mechanical` — parses INI-grammar keys in `/etc/wsl.conf` / `.wslconfig` and compares Defender exclusion-path sets to deterministic invariants. Not prose keyword matching.

## Purpose

Surfaces Windows- and WSL-specific isolation weaknesses that aren't covered by the cross-platform hygiene checks: WSL interop bridging Windows and Linux process space, `.wslconfig` networking modes that collapse the host/guest boundary, Windows Defender exclusions that silently disable scanning for project paths, and an NTFS permissions advisory for sensitive files. A passing check means either (a) the host is non-Windows and the check short-circuits to N/A, or (b) WSL interop is scoped, `.wslconfig` uses NAT + firewall, and Defender has no project-path exclusions. A failure means one of those guardrails is open — typically the highest-impact one is `appendWindowsPath=true` under interop, which lets WSL processes execute Windows binaries directly. No OWASP Agentic Top 10 mapping: this check is about host-level isolation, not agent behavior.

## Triggers

| Condition | Severity | SARIF ruleId | Remediation summary |
|---|---|---|---|
| Non-Windows platform | SKIPPED | — (SARIF level `none`, suppressed) | No action — check is gated to `process.platform === 'win32'`. |
| WSL interop enabled with `appendWindowsPath=true` | WARNING | `windows-security` (level `warning`) | Set `appendWindowsPath=false` in `/etc/wsl.conf` `[interop]`. |
| WSL interop enabled, `appendWindowsPath=false` | INFO | `windows-security` (level `note`) | Informational — exposure is limited. |
| WSL interop disabled | PASS | — | — |
| `.wslconfig` uses `networkingMode=mirrored` | INFO | `windows-security` (level `note`) | Consider NAT mode for stronger host/guest isolation. |
| `.wslconfig` missing `firewall=true` | INFO | `windows-security` (level `note`) | Add `firewall=true` to `.wslconfig`. |
| `.wslconfig` has `firewall=true` | PASS | — | — |
| Windows Defender excludes project paths / `node_modules` | WARNING | `windows-security` (level `warning`) | Remove project-path exclusions via `Remove-MpPreference -ExclusionPath`. |
| NTFS permissions advisory (always emitted on Windows) | INFO | `windows-security` (level `note`) | Run `icacls .env /inheritance:r /grant:r "%USERNAME%":F` on sensitive files. |

## Weight rationale

Advisory — weight 0. This check only produces signal on a single platform (`win32`) and short-circuits everywhere else; scoring it would penalize or credit cross-platform projects based on where they happen to be scanned, which is noise. The findings are also configuration-advice in nature (WSL/Defender posture) rather than concrete vulnerabilities with deterministic remediations, so they belong in the advisory lane rather than competing for moat-first budget with scored checks like `mcp-config` or `env-exposure`.

## Fix semantics

No `fixes` export. `--fix --yes` is a no-op for this check.

- All triggers require manual remediation: WSL config lives outside the project tree (`/etc/wsl.conf`, `%USERPROFILE%\.wslconfig`), Defender exclusions require PowerShell with elevated privileges, and NTFS ACL changes touch user-owned files. None of these are safe to mutate from a repo-scoped scanner.

## SARIF

- Tool component: `rigscore`
- Rule ID emitted: `windows-security` (check-level rule; per-finding discrimination is via message text).
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

- Platform gate: returns `NOT_APPLICABLE` on any `process.platform !== 'win32'`. Linux and macOS scans will never show findings from this module.
- WSL detection reads `/etc/wsl.conf` (guest side) and `%USERPROFILE%\.wslconfig` (host side). Only runs when the respective file exists.
- Defender check shells out to `powershell.exe Get-MpPreference` with a 5s timeout; on systems without PowerShell in PATH, or where Defender is managed by a third party, it silently degrades.
- The NTFS permissions row is an advisory reminder that always fires on Windows — it's a prompt, not a detected weakness.
