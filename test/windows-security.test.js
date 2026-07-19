import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { withTmpDir } from './helpers.js';

// `/etc/wsl.conf` and `/proc/sys/kernel/osrelease` are absolute HOST paths — they
// ignore cwd and homedir. rigscore itself is developed on a WSL guest, so a check
// that reads them for real would make these assertions depend on the machine
// running the suite. Every test below therefore injects BOTH paths into the check
// context (the same seam `scan()` exposes), pointing them inside a throwaway tmp
// dir. No assertion here ever touches the real /etc/wsl.conf.
const WSL2_OSRELEASE = '6.6.87.2-microsoft-standard-WSL2\n';
const PLAIN_OSRELEASE = '6.8.0-45-generic\n';

async function runCheck(context) {
  const mod = await import('../src/checks/windows-security.js');
  return mod.default.run(context);
}

function contextFor(tmpDir, { osrelease, wslConf, platform = 'linux' } = {}) {
  const wslOsReleasePath = path.join(tmpDir, 'osrelease');
  const wslConfPath = path.join(tmpDir, 'wsl.conf');
  if (osrelease !== undefined) fs.writeFileSync(wslOsReleasePath, osrelease);
  if (wslConf !== undefined) fs.writeFileSync(wslConfPath, wslConf);
  // `platform` is pinned for the same reason the two paths above are: which ARM of
  // the check runs must come from the context, not the OS running the suite. Left
  // to process.platform the guest-arm cases inverted on a Windows runner — a test
  // named "returns N/A on non-Windows platforms" executing ON Windows.
  return { cwd: tmpDir, homedir: tmpDir, platform, wslOsReleasePath, wslConfPath };
}

const idsOf = (result) => result.findings.map((f) => f.findingId);

describe('windows-security check', () => {
  it('returns N/A on non-Windows platforms', async () => {
    // Plain Linux kernel, no WSL marker → nothing to say.
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, { osrelease: PLAIN_OSRELEASE }));
      expect(result.score).toBe(-1);
      expect(result.findings[0].severity).toBe('skipped');
    });
  });

  it('stays N/A on a plain Linux box even when a wsl.conf-shaped file exists', async () => {
    // Guards the ungating: a non-WSL CI runner must never start emitting
    // Windows findings just because some file parses as a wsl.conf.
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, {
        osrelease: PLAIN_OSRELEASE,
        wslConf: '[interop]\nenabled=true\nappendWindowsPath=true\n',
      }));
      expect(result.score).toBe(-1);
      expect(result.findings[0].severity).toBe('skipped');
    });
  });

  it('flags interop appendWindowsPath on the WSL guest, where /etc/wsl.conf lives', async () => {
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, {
        osrelease: WSL2_OSRELEASE,
        wslConf: '[interop]\nenabled=true\nappendWindowsPath=true\n',
      }));
      expect(idsOf(result)).toContain('windows-security/wsl-interop-exposes-path');
      const finding = result.findings.find(
        (f) => f.findingId === 'windows-security/wsl-interop-exposes-path',
      );
      expect(finding.severity).toBe('warning');
    });
  });

  it('treats an unset appendWindowsPath as the exposed default', async () => {
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, {
        osrelease: WSL2_OSRELEASE,
        wslConf: '[interop]\nenabled=true\n',
      }));
      expect(idsOf(result)).toContain('windows-security/wsl-interop-exposes-path');
    });
  });

  it('downgrades to INFO when appendWindowsPath=false', async () => {
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, {
        osrelease: WSL2_OSRELEASE,
        wslConf: '[interop]\nenabled=true\nappendWindowsPath=false\n',
      }));
      expect(idsOf(result)).not.toContain('windows-security/wsl-interop-exposes-path');
      expect(idsOf(result)).toContain('windows-security/wsl-interop-enabled');
    });
  });

  it('passes when interop is disabled', async () => {
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, {
        osrelease: WSL2_OSRELEASE,
        wslConf: '[interop]\nenabled=false\n',
      }));
      expect(result.findings.some((f) => f.severity === 'pass')).toBe(true);
      expect(result.findings.some((f) => f.severity === 'warning')).toBe(false);
    });
  });

  it('invents no interop finding when the guest has no wsl.conf', async () => {
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, { osrelease: WSL2_OSRELEASE }));
      expect(idsOf(result).filter((id) => id && id.startsWith('windows-security/wsl-interop'))).toHaveLength(0);
    });
  });

  it('does not emit the Windows-host-only NTFS advisory from the guest', async () => {
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, {
        osrelease: WSL2_OSRELEASE,
        wslConf: '[interop]\nenabled=true\nappendWindowsPath=true\n',
      }));
      expect(idsOf(result)).not.toContain('windows-security/ntfs-permissions-advisory');
    });
  });

  it('emits the NTFS advisory on a Windows host, and no guest interop finding', async () => {
    // The host arm, now reachable from every runner. /etc/wsl.conf is a GUEST
    // file — a Windows host must not read one even when it is sitting right there.
    await withTmpDir(async (tmp) => {
      const result = await runCheck(contextFor(tmp, {
        platform: 'win32',
        wslConf: '[interop]\nenabled=true\nappendWindowsPath=true\n',
      }));
      expect(idsOf(result)).toContain('windows-security/ntfs-permissions-advisory');
      expect(idsOf(result)).not.toContain('windows-security/wsl-interop-exposes-path');
      expect(result.score).not.toBe(-1);
    });
  });

  it('has correct check metadata', async () => {
    const mod = await import('../src/checks/windows-security.js');
    const check = mod.default;
    expect(check.id).toBe('windows-security');
    expect(check.name).toBe('Windows/WSL security');
    expect(check.category).toBe('isolation');
  });

  it('has weight 0 in constants', async () => {
    const { WEIGHTS } = await import('../src/constants.js');
    expect(WEIGHTS['windows-security']).toBe(0);
  });
});
