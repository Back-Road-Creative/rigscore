import chalk from 'chalk';
import { NOT_APPLICABLE_SCORE } from './constants.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str) {
  return str.replace(ANSI_RE, '');
}

function getGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
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
    `${'       '}rigscore v0.1.0`,
    '  AI Dev Environment Hygiene Check',
    '',
  ]));
  lines.push('');
  lines.push(`  Scanning ${cwd} ...`);
  lines.push('');

  // Check scores
  for (const r of results) {
    if (r.score === NOT_APPLICABLE_SCORE) {
      const icon = chalk.dim('\u21B7');
      const name = r.name.padEnd(30, '.');
      lines.push(`  ${icon} ${name} N/A`);
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
  lines.push(box([
    '',
    `        ${scoreStr}`,
    `        ${gradeStr}`,
    '',
  ]));
  lines.push('');

  // Findings by severity (including skipped)
  const allFindings = results.flatMap((r) =>
    r.findings.map((f) => ({ ...f, checkName: r.name })),
  );

  for (const severity of ['critical', 'warning', 'info', 'skipped']) {
    const items = allFindings.filter((f) => f.severity === severity);
    if (items.length === 0) continue;

    const label = severity.toUpperCase();
    const color = getSeverityColor(severity);
    lines.push(`  ${color(`${label} (${items.length})`)}`);

    for (const item of items) {
      const icon = getSeverityIcon(severity);
      lines.push(`  ${color(icon)} ${item.title}`);
      if (item.detail) {
        lines.push(`    ${chalk.dim('\u2192')} ${item.detail}`);
      }
      if (item.remediation) {
        lines.push(`    ${chalk.dim('\u2192')} Fix: ${item.remediation}`);
      }
      lines.push('');
    }
  }

  // CTA
  if (!options.noCta) {
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
    `${'       '}rigscore v0.1.0`,
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
          lines.push(`    ${color(icon)} ${item.title}`);
          if (item.remediation) {
            lines.push(`      ${chalk.dim('\u2192')} Fix: ${item.remediation}`);
          }
        }
      }
      lines.push('');
    }
  }

  // CTA
  if (!options.noCta) {
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
  const url = `https://img.shields.io/badge/rigscore-${score}%2F100-${color}`;
  return `![rigscore](${url})\n\nGenerated by [rigscore](https://github.com/backroadcreative/rigscore)`;
}
