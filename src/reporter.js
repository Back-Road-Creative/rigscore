import { createRequire } from 'node:module';
import chalk from 'chalk';
import { NOT_APPLICABLE_SCORE, WEIGHTS } from './constants.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

// Strip ALL ANSI escape sequences — not just SGR (color) sequences. A
// malicious file could embed CSI control sequences (\x1b[2J clear screen,
// \x1b[H cursor home), OSC hyperlinks (\x1b]8;;...\x07 or ...\x1b\\), or
// other C0/C1 escapes that would execute in a reviewer's terminal when
// file-sourced content is rendered unescaped. We also drop bare control
// characters (BEL, backspace, form-feed, vertical-tab) and the DEL byte
// that can manipulate terminal state or obscure output.
//
// CSI  — ESC [ ... final-byte (0x40–0x7E)
// OSC  — ESC ] ... (ST = BEL or ESC \)
// C1   — ESC (any byte 0x40–0x5F) for the remaining two-byte escapes
const ANSI_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripAnsi(str) {
  if (typeof str !== 'string') return str;
  return str.replace(ANSI_RE, '').replace(CONTROL_RE, '');
}

/** Safely coerce a potentially untrusted finding field to a display-safe string. */
function safeField(value) {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  return stripAnsi(value);
}

function getGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function getRiskProfile(results) {
  const applicable = results.filter((r) => r.score !== NOT_APPLICABLE_SCORE);
  const applicableCount = applicable.length;
  const passingCount = applicable.filter((r) => r.score >= 70).length;

  if (applicableCount >= 7 && passingCount === applicableCount) return 'Hardened';
  if (applicableCount >= 4 && passingCount >= applicableCount * 0.7) return 'Standard';
  return 'Minimal';
}

function getRiskColor(profile) {
  switch (profile) {
    case 'Hardened': return chalk.greenBright;
    case 'Standard': return chalk.blue;
    default: return chalk.yellow;
  }
}

function getScoreColor(score) {
  if (score >= 90) return chalk.greenBright;
  if (score >= 75) return chalk.green;
  if (score >= 60) return chalk.blue;
  if (score >= 40) return chalk.yellow;
  return chalk.red;
}

function getSeverityColor(severity) {
  switch (severity) {
    case 'critical': return chalk.red;
    case 'warning': return chalk.yellow;
    case 'info': return chalk.blue;
    case 'skipped': return chalk.dim;
    case 'pass': return chalk.green;
    default: return chalk.white;
  }
}

function getSeverityIcon(severity) {
  switch (severity) {
    case 'critical': return '\u2717';
    case 'warning': return '\u26A0';
    case 'info': return '\u2139';
    case 'skipped': return '\u21B7';
    case 'pass': return '\u2713';
    default: return ' ';
  }
}

function boxLine(text, width) {
  const plain = stripAnsi(text);
  const pad = Math.max(0, width - plain.length);
  return `  \u2502 ${text}${' '.repeat(pad)} \u2502`;
}

function box(lines, width = 38) {
  const top = `  \u256D${'─'.repeat(width + 2)}\u256E`;
  const bottom = `  \u2570${'─'.repeat(width + 2)}\u256F`;
  const boxed = lines.map((l) => boxLine(l, width));
  return [top, ...boxed, bottom].join('\n');
}

export function formatTerminal(result, cwd, options = {}) {
  const { score, results } = result;
  const grade = getGrade(score);
  const colorFn = getScoreColor(score);
  const lines = [];

  // Header
  lines.push('');
  lines.push(box([
    '',
    `${'       '}rigscore v${version}`,
    '  AI Dev Environment Hygiene Check',
    '',
  ]));
  lines.push('');
  lines.push(`  Scanning ${cwd} ...`);
  lines.push('');

  // C1 banner: when NO AI-tooling governance/coherence surface was found,
  // surface that fact at the top so users reading rigscore output for a
  // vanilla project (create-react-app, FastAPI, Rust) understand that
  // generic-hygiene checks still ran but AI-specific ones were skipped.
  const aiToolingSurfaceIds = new Set(['claude-md', 'skill-files', 'mcp-config', 'coherence', 'claude-settings']);
  const surfaceResults = results.filter((r) => aiToolingSurfaceIds.has(r.id));
  const allSurfaceMissing = surfaceResults.length > 0 &&
    surfaceResults.every((r) => r.score === NOT_APPLICABLE_SCORE);
  if (allSurfaceMissing) {
    lines.push(`  ${chalk.yellow('\u26A0')} ${chalk.yellow(`No AI tooling detected in ${cwd}.`)}`);
    lines.push(`    ${chalk.dim('\u2192')} Run with ${chalk.cyan('--include-home-skills')} to scan user-level skills, or add a`);
    lines.push(`      ${chalk.cyan('CLAUDE.md')} / ${chalk.cyan('.cursorrules')} / ${chalk.cyan('etc.')} to your project first.`);
    lines.push(`    ${chalk.dim('\u2192')} Generic-hygiene checks (secrets, docker, permissions, git-hooks) still ran below.`);
    lines.push('');
  }

  // Check scores
  for (const r of results) {
    if (r.score === NOT_APPLICABLE_SCORE) {
      const icon = chalk.dim('\u21B7');
      const name = r.name.padEnd(30, '.');
      lines.push(`  ${icon} ${name} N/A`);
    } else if (r.weight === 0) {
      // Advisory check — no score contribution. Mark clearly, don't use critical red.
      const icon = r.score >= 70 ? chalk.green('\u2713') : chalk.yellow('\u26A0');
      const name = r.name.padEnd(30, '.');
      lines.push(`  ${icon} ${name} ${chalk.dim('advisory')}`);
    } else {
      const checkScore = Math.round((r.score / 100) * r.weight);
      const icon = r.score >= 70 ? chalk.green('\u2713') : chalk.red('\u2717');
      const name = r.name.padEnd(30, '.');
      lines.push(`  ${icon} ${name} ${checkScore}/${r.weight}`);
    }
  }

  lines.push('');

  // Score box
  const scoreStr = colorFn(`HYGIENE SCORE: ${score}/100`);
  const gradeStr = colorFn(`Grade: ${grade}`);
  // Risk profile
  const riskProfile = getRiskProfile(results);
  const riskColor = getRiskColor(riskProfile);
  const riskStr = riskColor(`Risk: ${riskProfile}`);

  lines.push(box([
    '',
    `        ${scoreStr}`,
    `        ${gradeStr}`,
    `        ${riskStr}`,
    '',
  ]));
  lines.push('');

  // Coverage messaging
  const applicableResults = results.filter((r) => r.score !== NOT_APPLICABLE_SCORE);
  const totalResults = results.length;
  const applicableWeight = applicableResults.reduce((sum, r) => sum + (WEIGHTS[r.id] || 0), 0);
  const totalWeight = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
  if (applicableResults.length < totalResults) {
    lines.push(`  ${chalk.dim(`Coverage: ${applicableResults.length} of ${totalResults} checks applicable (weight ${applicableWeight}/${totalWeight})${applicableWeight < 60 ? ' — score scaled down' : ''}`)}`);
    lines.push('');
  }

  // Findings by severity (including skipped)
  const allFindings = results.flatMap((r) =>
    r.findings.map((f) => ({ ...f, checkName: r.name })),
  );

  const severities = options.verbose
    ? ['critical', 'warning', 'info', 'skipped', 'pass']
    : ['critical', 'warning', 'info', 'skipped'];
  for (const severity of severities) {
    const items = allFindings.filter((f) => f.severity === severity);
    if (items.length === 0) continue;

    const label = severity.toUpperCase();
    const color = getSeverityColor(severity);
    lines.push(`  ${color(`${label} (${items.length})`)}`);

    for (const item of items) {
      const icon = getSeverityIcon(severity);
      const title = safeField(item.title);
      const detail = safeField(item.detail);
      const evidence = safeField(item.evidence);
      const remediation = safeField(item.remediation);
      const learnMore = safeField(item.learnMore);
      lines.push(`  ${color(icon)} ${title}`);
      if (detail) {
        lines.push(`    ${chalk.dim('\u2192')} ${detail}`);
      }
      if (evidence) {
        lines.push(`    ${chalk.dim('\u2192')} Evidence: ${chalk.dim(evidence)}`);
      }
      if (remediation) {
        lines.push(`    ${chalk.dim('\u2192')} Fix: ${remediation}`);
      }
      if (learnMore) {
        lines.push(`    ${chalk.dim('\u2192')} Learn more: ${chalk.cyan(learnMore)}`);
      }
      lines.push('');
    }
  }

  // CTA (opt-in: only shown when noCta is explicitly false)
  if (options.noCta === false) {
    lines.push(`  ${'─'.repeat(40)}`);
    lines.push('');
    lines.push('  Want a full audit with hardened configurations deployed?');
    lines.push(`  ${chalk.cyan('\u2192')} https://backroadcreative.com/ai-agent-security-audit`);
    lines.push('');
    lines.push(`  Share your score: ${chalk.dim('npx rigscore --badge')}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format recursive scan results for terminal output.
 * Shows per-project summary table + expanded findings for failing projects.
 */
export function formatTerminalRecursive(result, rootDir, options = {}) {
  const { score, projects, worstProject } = result;
  const grade = getGrade(score);
  const colorFn = getScoreColor(score);
  const lines = [];

  // Header
  lines.push('');
  lines.push(box([
    '',
    `${'       '}rigscore v${version}`,
    '  AI Dev Environment Hygiene Check',
    `${'     '}Recursive Mode`,
    '',
  ]));
  lines.push('');
  lines.push(`  Scanning ${rootDir} (${projects.length} projects found)`);
  lines.push('');

  // Per-project summary
  for (const project of projects) {
    const pGrade = getGrade(project.score);
    const pColor = getScoreColor(project.score);
    const icon = project.score >= 70 ? chalk.green('\u2713') : chalk.red('\u2717');
    const name = project.path.padEnd(40, '.');
    lines.push(`  ${icon} ${name} ${pColor(`${project.score}/100 (${pGrade})`)}`);
  }

  lines.push('');

  // Overall score box
  const scoreStr = colorFn(`OVERALL HYGIENE SCORE: ${score}/100`);
  const gradeStr = colorFn(`Grade: ${grade} (average)`);
  lines.push(box([
    '',
    `      ${scoreStr}`,
    `      ${gradeStr}`,
    '',
  ]));
  lines.push('');

  // Catastrophic project warning
  if (worstProject && worstProject.score < 40) {
    lines.push(`  ${chalk.red.bold('⚠ CATASTROPHIC: ')}${chalk.red(`"${worstProject.path}" scores ${worstProject.score}/100 — immediate attention required`)}`);
    lines.push('');
  }

  // Show findings only for projects with issues (score < 100)
  const failing = projects.filter((p) => p.score < 70);
  if (failing.length > 0) {
    lines.push(`  ${chalk.yellow('Projects needing attention:')}`);
    lines.push('');

    for (const project of failing) {
      lines.push(`  ${chalk.bold(project.path)} (${project.score}/100)`);
      const allFindings = project.results.flatMap((r) =>
        r.findings.map((f) => ({ ...f, checkName: r.name })),
      );

      for (const severity of ['critical', 'warning']) {
        const items = allFindings.filter((f) => f.severity === severity);
        if (items.length === 0) continue;
        const color = getSeverityColor(severity);
        for (const item of items) {
          const icon = getSeverityIcon(severity);
          const title = safeField(item.title);
          const remediation = safeField(item.remediation);
          lines.push(`    ${color(icon)} ${title}`);
          if (remediation) {
            lines.push(`      ${chalk.dim('\u2192')} Fix: ${remediation}`);
          }
        }
      }
      lines.push('');
    }
  }

  // CTA (opt-in: only shown when noCta is explicitly false)
  if (options.noCta === false) {
    lines.push(`  ${'─'.repeat(40)}`);
    lines.push('');
    lines.push('  Want a full audit with hardened configurations deployed?');
    lines.push(`  ${chalk.cyan('\u2192')} https://backroadcreative.com/ai-agent-security-audit`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatJson(result) {
  return JSON.stringify(result, null, 2);
}

export function formatBadge(result) {
  const { score } = result;
  const color = score >= 90 ? 'brightgreen' : score >= 75 ? 'green' : score >= 60 ? 'blue' : score >= 40 ? 'yellow' : 'red';
  const url = `https://img.shields.io/badge/rigscore-${score}%2F100-${color}?cacheSeconds=86400`;
  return `![rigscore](${url})\n\nGenerated by [rigscore](https://github.com/Back-Road-Creative/rigscore)`;
}
