import path from 'node:path';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { calculateCheckScore } from '../scoring.js';
import { readFileSafe, execSafe } from '../utils.js';

// Absolute HOST paths — they ignore cwd/homedir, so they are read through the
// scan context (`scan({ wslConfPath, wslOsReleasePath })`) with these as the
// production defaults. Tests pin them at a tmp dir; without that seam a suite
// run on a WSL workstation and one on a Linux CI runner would disagree.
const DEFAULT_WSL_CONF_PATH = '/etc/wsl.conf';
const DEFAULT_WSL_OSRELEASE_PATH = '/proc/sys/kernel/osrelease';

/**
 * Are we running INSIDE a WSL guest (where /etc/wsl.conf actually exists)?
 *
 * Marker: the kernel's own release string — "…microsoft-standard-WSL2" on WSL2,
 * "…Microsoft" on WSL1. Chosen over $WSL_DISTRO_NAME because the env var is only
 * inherited from an interactive WSL login shell: systemd units, cron jobs and
 * containers on the WSL kernel don't have it, and a check that goes blind in CI
 * is worse than one that reads a file. A container on the WSL2 kernel matches
 * too — correctly, since it shares that kernel; the interop arm then still only
 * speaks if a wsl.conf is actually present.
 *
 * The marker is the SOLE signal — deliberately not `&& process.platform === 'linux'`.
 * That conjunct would be redundant (only a Linux kernel has /proc/sys/kernel/osrelease,
 * so macOS and Windows read null and answer false anyway) while making the answer
 * un-injectable: the guest arm could then only be exercised by a test that happens to
 * run on Linux, which is the host-dependence this seam exists to remove.
 */
async function isWslGuest(context) {
  const osRelease = await readFileSafe(context.wslOsReleasePath ?? DEFAULT_WSL_OSRELEASE_PATH);
  return osRelease !== null && /microsoft/i.test(osRelease);
}

export default {
  id: 'windows-security',
  enforcementGrade: 'mechanical',
  name: 'Windows/WSL security',
  category: 'isolation',

  async run(context) {
    const findings = [];

    // Two arms, two platforms. The interop arm parses /etc/wsl.conf, a LINUX-guest
    // file that never exists on the Windows host — gating it on win32 made it
    // unreachable. The .wslconfig / Defender / NTFS arms are genuinely host-side.
    // Injectable for the same reason wslConfPath/wslOsReleasePath are: this arm's
    // answer must come from the scan context, not from whichever OS happens to be
    // running the suite. Without the seam the guest-arm assertions below silently
    // inverted on a Windows runner (and the host arm was unreachable everywhere
    // else), so the tests asserted the machine rather than the check.
    const onWindowsHost = (context.platform ?? process.platform) === 'win32';
    const onWslGuest = !onWindowsHost && (await isWslGuest(context));

    if (!onWindowsHost && !onWslGuest) {
      findings.push({
        severity: 'skipped',
        title: 'Windows checks skipped (non-Windows platform)',
        detail: 'Windows/WSL security checks only run on a Windows host or inside a WSL guest.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    // Check WSL interop settings — guest-side only.
    try {
      const wslConf = onWslGuest
        ? await readFileSafe(context.wslConfPath ?? DEFAULT_WSL_CONF_PATH)
        : null;
      if (wslConf) {
        const interopEnabled = /\[interop\][\s\S]*?enabled\s*=\s*true/i.test(wslConf);
        const appendPath = /\[interop\][\s\S]*?appendWindowsPath\s*=\s*true/i.test(wslConf) ||
          // Default is true if not explicitly set
          (!/appendWindowsPath\s*=\s*false/i.test(wslConf) && interopEnabled);

        if (interopEnabled && appendPath) {
          findings.push({
            findingId: 'windows-security/wsl-interop-exposes-path',
            severity: 'warning',
            title: 'WSL interop exposes Windows PATH',
            detail: 'WSL is configured with interop enabled and appendWindowsPath=true. Windows executables are accessible from WSL, which expands the attack surface.',
            remediation: 'Add appendWindowsPath=false to [interop] section in /etc/wsl.conf if you don\'t need Windows tools from WSL.',
          });
        } else if (interopEnabled) {
          findings.push({
            findingId: 'windows-security/wsl-interop-enabled',
            severity: 'info',
            title: 'WSL interop is enabled',
            detail: 'WSL interop allows calling Windows executables from Linux. appendWindowsPath is disabled, limiting exposure.',
          });
        } else {
          findings.push({
            severity: 'pass',
            title: 'WSL interop is disabled',
          });
        }
      }
    } catch {
      // Not in WSL or can't read config — skip
    }

    // Check .wslconfig — host-side: it lives under %USERPROFILE% on Windows.
    try {
      const userProfile = onWindowsHost ? process.env.USERPROFILE || process.env.HOME : null;
      if (userProfile) {
        const wslConfig = await readFileSafe(path.join(userProfile, '.wslconfig'));
        if (wslConfig) {
          const hasFirewall = /firewall\s*=\s*true/i.test(wslConfig);
          const networkingMode = wslConfig.match(/networkingMode\s*=\s*(\w+)/i);

          if (networkingMode && networkingMode[1].toLowerCase() === 'mirrored') {
            findings.push({
              findingId: 'windows-security/wsl-mirrored-networking',
              severity: 'info',
              title: 'WSL uses mirrored networking mode',
              detail: 'Mirrored networking shares the host network stack with WSL. Consider NAT mode for better isolation.',
            });
          }

          if (!hasFirewall) {
            findings.push({
              findingId: 'windows-security/wsl-firewall-not-enabled',
              severity: 'info',
              title: 'WSL firewall not explicitly enabled',
              detail: 'Consider adding firewall=true to .wslconfig for additional network isolation.',
            });
          } else {
            findings.push({
              severity: 'pass',
              title: 'WSL firewall enabled',
            });
          }
        }
      }
    } catch {
      // Can't read .wslconfig — skip
    }

    // Check Windows Defender exclusions — host-side. A6: use execSafe (async, 5s
    // timeout) so the event loop is never blocked on a hung PowerShell
    // call. Argument list is explicit — no shell interpolation. Never shelled from
    // the guest: powershell.exe is reachable over interop, but Defender posture is
    // the host's, and a scan must not cross that boundary to go get it.
    const output = onWindowsHost
      ? await execSafe(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-MpPreference | Select-Object -ExpandProperty ExclusionPath',
        ],
        { timeout: 5000 },
      )
      : null;
    if (output) {
      const exclusions = output.split('\n').map((s) => s.trim()).filter(Boolean);
      const riskyExclusions = exclusions.filter((p) =>
        p.includes('node_modules') || p.includes(context.cwd),
      );
      if (riskyExclusions.length > 0) {
        findings.push({
          findingId: 'windows-security/defender-excludes-project-paths',
          severity: 'warning',
          title: 'Windows Defender excludes project-related paths',
          detail: `Exclusions found: ${riskyExclusions.join(', ')}. Malware in these directories won't be scanned.`,
          remediation: 'Review Windows Defender exclusions and remove project directories if not needed for performance.',
        });
      }
    }
    // execSafe returns null on failure/timeout — nothing to handle here.

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'Windows security checks passed',
      });
    }

    // NTFS permissions advisory — always shown on Windows, and only there: icacls
    // and NTFS ACLs are host concepts, meaningless against the guest's ext4 rootfs.
    if (onWindowsHost) {
      findings.push({
        findingId: 'windows-security/ntfs-permissions-advisory',
        severity: 'info',
        title: 'NTFS permissions advisory',
        detail: 'On Windows, use icacls to verify that sensitive files (credentials, keys, .env) are not accessible to other users.',
        remediation: 'Run: icacls .env /inheritance:r /grant:r "%USERNAME%":F',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
