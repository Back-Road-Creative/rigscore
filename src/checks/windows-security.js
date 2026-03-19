import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { calculateCheckScore } from '../scoring.js';
import { readFileSafe } from '../utils.js';

export default {
  id: 'windows-security',
  name: 'Windows/WSL security',
  category: 'isolation',

  async run(context) {
    const findings = [];

    // Only run on Windows
    if (process.platform !== 'win32') {
      findings.push({
        severity: 'skipped',
        title: 'Windows checks skipped (non-Windows platform)',
        detail: 'Windows-specific security checks only run on Windows.',
      });
      return { score: NOT_APPLICABLE_SCORE, findings };
    }

    // Check WSL interop settings
    try {
      const wslConf = await readFileSafe('/etc/wsl.conf');
      if (wslConf) {
        const interopEnabled = /\[interop\][\s\S]*?enabled\s*=\s*true/i.test(wslConf);
        const appendPath = /\[interop\][\s\S]*?appendWindowsPath\s*=\s*true/i.test(wslConf) ||
          // Default is true if not explicitly set
          (!/appendWindowsPath\s*=\s*false/i.test(wslConf) && interopEnabled);

        if (interopEnabled && appendPath) {
          findings.push({
            severity: 'warning',
            title: 'WSL interop exposes Windows PATH',
            detail: 'WSL is configured with interop enabled and appendWindowsPath=true. Windows executables are accessible from WSL, which expands the attack surface.',
            remediation: 'Add appendWindowsPath=false to [interop] section in /etc/wsl.conf if you don\'t need Windows tools from WSL.',
          });
        } else if (interopEnabled) {
          findings.push({
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

    // Check .wslconfig
    try {
      const userProfile = process.env.USERPROFILE || process.env.HOME;
      if (userProfile) {
        const wslConfig = await readFileSafe(path.join(userProfile, '.wslconfig'));
        if (wslConfig) {
          const hasFirewall = /firewall\s*=\s*true/i.test(wslConfig);
          const networkingMode = wslConfig.match(/networkingMode\s*=\s*(\w+)/i);

          if (networkingMode && networkingMode[1].toLowerCase() === 'mirrored') {
            findings.push({
              severity: 'info',
              title: 'WSL uses mirrored networking mode',
              detail: 'Mirrored networking shares the host network stack with WSL. Consider NAT mode for better isolation.',
            });
          }

          if (!hasFirewall) {
            findings.push({
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

    // Check Windows Defender exclusions
    try {
      const output = execSync(
        'powershell.exe -NoProfile -Command "Get-MpPreference | Select-Object -ExpandProperty ExclusionPath"',
        { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      if (output) {
        const exclusions = output.split('\n').map(s => s.trim()).filter(Boolean);
        const riskyExclusions = exclusions.filter(p =>
          p.includes('node_modules') || p.includes(context.cwd)
        );
        if (riskyExclusions.length > 0) {
          findings.push({
            severity: 'warning',
            title: 'Windows Defender excludes project-related paths',
            detail: `Exclusions found: ${riskyExclusions.join(', ')}. Malware in these directories won't be scanned.`,
            remediation: 'Review Windows Defender exclusions and remove project directories if not needed for performance.',
          });
        }
      }
    } catch {
      // PowerShell not available or command failed — skip
    }

    // NTFS permissions advisory
    findings.push({
      severity: 'info',
      title: 'NTFS permissions advisory',
      detail: 'On Windows, use icacls to verify that sensitive files (credentials, keys, .env) are not accessible to other users.',
      remediation: 'Run: icacls .env /inheritance:r /grant:r "%USERNAME%":F',
    });

    if (findings.length === 0) {
      findings.push({
        severity: 'pass',
        title: 'Windows security checks passed',
      });
    }

    return {
      score: calculateCheckScore(findings),
      findings,
    };
  },
};
