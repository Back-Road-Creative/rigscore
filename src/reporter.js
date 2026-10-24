import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import chalk from 'chalk';
import { NOT_APPLICABLE_SCORE, WEIGHTS } from './constants.js';
import { resolveWeights } from './config.js';
import { calculatePracticeScore } from './scoring.js';
import { formatFixHint } from './fixer.js';

// createRequire instead of `import pkg from '../package.json' assert
// { type: 'json' }` because the JSON-import assertion syntax is still
// behind a flag below Node 20.10 (our floor is ≥20.0.0; see engines field
// in package.json). Once the engines floor moves to ≥20.10 — which made
// `import ... with { type: 'json' }` stable without a flag — this
// shim can be replaced with the native import form.
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

export function getGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Hardening tier (Minimal / Standard / Hardened) from the passing ratio of the
 * SCORE-BEARING applicable checks. Weight-0 advisory checks are excluded — they
 * never move the score, and letting their N/A drift move the tier is the same
 * class of bug the scorer fixed by dropping weight-0 checks (scoring.js). Pass
 * resolved weights (config-aware) where available; falls back to static WEIGHTS.
 */
export function getRiskProfile(results, weights = WEIGHTS) {
  const w = weights || WEIGHTS;
  const applicable = results.filter(
    (r) => r.score !== NOT_APPLICABLE_SCORE && (w[r.id] || 0) > 0,
  );
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

/**
 * Format the enforcement-grade label column for a per-check line.
 * Returns a chalk-colored `[mechanical]` / `[pattern]` / `[keyword]` token.
 * Falls back to `[pattern]` for plugin checks that did not declare a grade.
 */
function formatGradeLabel(grade) {
  const g = typeof grade === 'string' ? grade : 'pattern';
  switch (g) {
    case 'mechanical': return chalk.cyan('[mechanical]');
    case 'pattern': return chalk.blue('[pattern]');
    case 'keyword': return chalk.dim('[keyword]');
    default: return chalk.blue('[pattern]');
  }
}

/**
 * Weights the scorer actually used: profile → overrides → disabled (weight 0).
 * The coverage line MUST read from these, not the static WEIGHTS map, or it
 * reports weight for checks `checks.disabled` removed from the score.
 * Falls back to the static map for callers that pass no config.
 */
function displayWeights(config) {
  try {
    return resolveWeights(config);
  } catch {
    return WEIGHTS;
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

// Narrowest width the report wraps to: the fixed-width CTA lines and the score
// box fit inside it. A wider terminal widens the wrap; a narrower one (or a
// bogus value) is clamped here rather than producing one-word-per-line output.
const MIN_WIDTH = 60;
const DEFAULT_WIDTH = 80;

/**
 * Column budget for the human report: an explicit `options.width`, else the
 * attached terminal's width, else 80 (piped output / CI logs have no columns).
 */
function resolveWidth(options = {}) {
  const raw = Number.isFinite(options.width) ? options.width : process.stdout.columns;
  const w = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, w);
}

/**
 * Greedy word wrap of PLAIN text (no ANSI) to `width` columns. A word longer
 * than the width (a long path or URL) is hard-broken rather than overflowing.
 */
function wrapPlain(text, width) {
  const out = [];
  let cur = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > width) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [''];
}

/**
 * Push `text` wrapped to `width`, led by `prefix` (which may carry colour).
 * Continuation lines are indented to the prefix's visible width so wrapped
 * text stays under the first word. `label` is a leading run of `text` kept
 * unstyled (e.g. "Fix: "); `style` colours the rest.
 */
function pushWrapped(lines, width, prefix, text, { label = '', style = (x) => x } = {}) {
  const pad = ' '.repeat(stripAnsi(prefix).length);
  const chunks = wrapPlain(text, Math.max(10, width - pad.length));
  chunks.forEach((chunk, i) => {
    const body = i === 0 && label && chunk.startsWith(label)
      ? label + style(chunk.slice(label.length))
      : style(chunk);
    lines.push(`${i === 0 ? prefix : pad}${body}`);
  });
}

/** Clip `str` to `max` columns with an ellipsis, keeping its start or its tail. */
function clip(str, max, keep = 'start') {
  if (str.length <= max) return str;
  if (max <= 1) return str.slice(0, max);
  return keep === 'end' ? `\u2026${str.slice(-(max - 1))}` : `${str.slice(0, max - 1)}\u2026`;
}

/** Wrapped finding headline: `<icon> <title> [<findingId>]`, id dimmed. */
function pushFindingTitle(lines, width, indent, color, icon, title, findingId) {
  const prefix = `${indent}${color(icon)} `;
  const idTok = findingId ? `[${findingId}]` : '';
  const pad = ' '.repeat(stripAnsi(prefix).length);
  const chunks = wrapPlain(idTok ? `${title || ''} ${idTok}` : (title || ''), Math.max(10, width - pad.length));
  chunks.forEach((chunk, i) => {
    const body = idTok && i === chunks.length - 1 && chunk.endsWith(idTok)
      ? chunk.slice(0, -idTok.length) + chalk.dim(idTok)
      : chunk;
    lines.push(`${i === 0 ? prefix : pad}${body}`);
  });
}

/** Display-safe finding id, or '' when the finding has none. */
function displayId(finding) {
  const id = safeField(finding.findingId);
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * Fold findings that share a `group.key` (within one severity list, so one
 * check) into a single display entry: `<group.title>: <label>, <label>, ...`
 * with one fix line and the member ids. A group of one renders as itself.
 * Display only: scoring, JSON, SARIF and suppression keep one finding each.
 */
function groupFindings(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = item.group && typeof item.group.key === 'string' ? `${item.checkName}\u0000${item.group.key}` : null;
    if (key === null) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }
  const out = [];
  const done = new Set();
  for (const item of items) {
    const key = item.group && typeof item.group.key === 'string' ? `${item.checkName}\u0000${item.group.key}` : null;
    const members = key === null ? null : byKey.get(key);
    if (!members || members.length < 2) { out.push(item); continue; }
    if (done.has(key)) continue;
    done.add(key);
    const labels = members.map((m) => safeField(m.group.label ?? m.title));
    out.push({
      severity: item.severity,
      checkName: item.checkName,
      title: `${safeField(item.group.title ?? item.title)}: ${labels.join(', ')}`,
      remediation: item.group.remediation,
      groupedIds: members.map((m) => displayId(m)).filter(Boolean),
    });
  }
  return out;
}

/** Push one finding (or grouped entry); returns true when it showed an id. */
function pushFinding(lines, width, indent, color, severity, item, { full }) {
  const title = safeField(item.title);
  const remediation = safeField(item.remediation);
  const findingId = displayId(item);
  pushFindingTitle(lines, width, indent, color, getSeverityIcon(severity), title, findingId);
  const arrow = `${indent}  ${chalk.dim('\u2192')} `;
  if (full) {
    const detail = safeField(item.detail);
    const evidence = safeField(item.evidence);
    if (detail) pushWrapped(lines, width, arrow, detail);
    if (evidence) pushWrapped(lines, width, arrow, `Evidence: ${evidence}`, { label: 'Evidence: ', style: chalk.dim });
  }
  if (remediation) pushWrapped(lines, width, arrow, `Fix: ${remediation}`);
  if (item.groupedIds && item.groupedIds.length > 0) {
    pushWrapped(lines, width, arrow, `Ids: ${item.groupedIds.join(', ')}`, { label: 'Ids: ', style: chalk.dim });
  }
  if (full) {
    const learnMore = safeField(item.learnMore);
    if (learnMore) pushWrapped(lines, width, arrow, `Learn more: ${learnMore}`, { label: 'Learn more: ', style: chalk.cyan });
  }
  return Boolean(findingId) || Boolean(item.groupedIds && item.groupedIds.length > 0);
}

/** The once-per-report pointer from a printed `[id]` to its docs. */
function pushExplainHint(lines, width) {
  pushWrapped(lines, width, '  ',
    'Run rigscore explain <id> with the [id] beside a finding for what it checks and how to fix or suppress it.',
    { style: chalk.dim });
  lines.push('');
}

// How many suppressed ids to spell out before collapsing the tail into a
// "+N more" count — keeps the line readable when a config mutes many findings.
const SUPPRESS_ID_PREVIEW = 8;

/**
 * One-line summary of config/--ignore suppression for the human report.
 * Transparency only: the findings are still removed from scoring; this makes
 * the muting visible in the report (and thus the CI log). Returns null when
 * nothing was suppressed so callers can skip the line entirely.
 */
export function formatSuppressedSummary(suppressed) {
  if (!suppressed || !suppressed.count) return null;
  const { count, ids } = suppressed;
  const noun = count === 1 ? 'finding' : 'findings';
  const shown = ids.slice(0, SUPPRESS_ID_PREVIEW);
  const tail = ids.length > SUPPRESS_ID_PREVIEW
    ? `, … (+${ids.length - SUPPRESS_ID_PREVIEW} more)`
    : '';
  const idList = ids.length > 0 ? `: ${shown.join(', ')}${tail}` : '';
  return `Suppressed ${count} ${noun} via config/--ignore${idList}`;
}

/**
 * Summary-only terminal output for `--quiet` (pre-commit / CI log). Two lines:
 * the score/grade/posture/practice headline and the finding-severity counts.
 * Nothing narrows the default report otherwise — only `--verbose` widens it.
 */
function formatQuietSummary(result) {
  const { score, results, config } = result;
  if (result.notApplicable === true) {
    return `  ${chalk.dim('rigscore: n/a — nothing to scan (no AI-tooling surface, no findings).')}`;
  }
  const posture = getRiskProfile(results, displayWeights(config));
  const practice = calculatePracticeScore(results);
  const practiceStr = practice === null ? 'n/a' : `${practice}/100`;
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity in counts) counts[f.severity] += 1;
    }
  }
  const head = getScoreColor(score)(`rigscore ${score}/100 (Grade ${getGrade(score)})`);
  return [
    `  ${head}  ${getRiskColor(posture)(`Posture: ${posture}`)}  ${chalk.dim(`Practice: ${practiceStr}`)}`,
    `  ${chalk.red(`critical ${counts.critical}`)} · ${chalk.yellow(`warning ${counts.warning}`)} · ${chalk.blue(`info ${counts.info}`)}`,
  ].join('\n');
}

/**
 * Human report. `options`: `quiet` (two-line summary), `verbose` (include
 * passing findings), `noCta`, and `width` (columns to wrap to; defaults to the
 * terminal width, else 80).
 */
export function formatTerminal(result, cwd, options = {}) {
  const { score, results, config } = result;
  const width = resolveWidth(options);
  // `--check` selected only checks that are N/A here: there is nothing to
  // score. Say so — never invent a 0, which renders as Grade F.
  const notApplicable = result.notApplicable === true;
  if (options.quiet) return formatQuietSummary(result);
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
  pushWrapped(lines, width, '  ', `Scanning ${cwd} ...`);
  lines.push('');

  // C1 banner: when NO AI-tooling governance/coherence surface was found,
  // surface that fact at the top so users reading rigscore output for a
  // vanilla project (create-react-app, FastAPI, Rust) understand that
  // generic-hygiene checks still ran but AI-specific ones were skipped.
  const aiToolingSurfaceIds = new Set(['governance-docs', 'skill-files', 'mcp-config', 'coherence', 'claude-settings']);
  const surfaceResults = results.filter((r) => aiToolingSurfaceIds.has(r.id));
  const allSurfaceMissing = surfaceResults.length > 0 &&
    surfaceResults.every((r) => r.score === NOT_APPLICABLE_SCORE);
  if (allSurfaceMissing) {
    pushWrapped(lines, width, `  ${chalk.yellow('\u26A0')} `, `No AI tooling detected in ${cwd}.`, { style: chalk.yellow });
    pushWrapped(lines, width, `    ${chalk.dim('\u2192')} `, 'Run with --include-home-skills to scan user-level skills, or add a CLAUDE.md / .cursorrules / etc. to your project first.');
    pushWrapped(lines, width, `    ${chalk.dim('\u2192')} `, 'Generic-hygiene checks (secrets, docker, permissions, git-hooks) still ran below.');
    lines.push('');
  }

  // Check scores. Pad to the longest name (not a fixed 30: names reach 31+),
  // clipped so `<icon> <name> <[grade]> <score>` still fits the width.
  const nameWidth = Math.min(
    Math.max(0, ...results.map((r) => r.name.length)),
    width - 26,
  );
  for (const r of results) {
    const gradeLabel = formatGradeLabel(r.enforcementGrade);
    if (r.score === NOT_APPLICABLE_SCORE) {
      const icon = chalk.dim('\u21B7');
      const name = clip(r.name, nameWidth).padEnd(nameWidth, '.');
      lines.push(`  ${icon} ${name} ${gradeLabel} N/A`);
    } else if (r.weight === 0) {
      // Advisory check — no score contribution. Mark clearly, don't use critical red.
      const icon = r.score >= 70 ? chalk.green('\u2713') : chalk.yellow('\u26A0');
      const name = clip(r.name, nameWidth).padEnd(nameWidth, '.');
      lines.push(`  ${icon} ${name} ${gradeLabel} ${chalk.dim('advisory')}`);
    } else {
      const checkScore = Math.round((r.score / 100) * r.weight);
      const icon = r.score >= 70 ? chalk.green('\u2713') : chalk.red('\u2717');
      const name = clip(r.name, nameWidth).padEnd(nameWidth, '.');
      lines.push(`  ${icon} ${name} ${gradeLabel} ${checkScore}/${r.weight}`);
    }
  }

  lines.push('');

  // Score box. Both N/A strings stay well inside box()'s 38-char inner width.
  const scoreStr = notApplicable
    ? chalk.dim('HYGIENE SCORE: n/a')
    : colorFn(`HYGIENE SCORE: ${score}/100`);
  const gradeStr = notApplicable ? chalk.dim('Grade: n/a') : colorFn(`Grade: ${grade}`);
  // Hardening tier. Labelled "Posture:" not "Risk:" — the buckets (Minimal /
  // Standard / Hardened) are hardening tiers, so "Risk: Minimal" beside "Grade: F"
  // read backwards (a minimal-hardening repo is high risk, not low).
  const riskProfile = getRiskProfile(results, displayWeights(config));
  const riskColor = getRiskColor(riskProfile);
  const riskStr = notApplicable ? chalk.dim('Posture: n/a') : riskColor(`Posture: ${riskProfile}`);

  // Second axis. `null` = no practice surface at all — print n/a, never 0/100:
  // a zero would libel every repo that simply isn't in scope for these checks.
  const practiceScore = calculatePracticeScore(results);
  const practiceStr = practiceScore === null
    ? chalk.dim('Practice: n/a')
    : getScoreColor(practiceScore)(`Practice: ${practiceScore}/100 (${getGrade(practiceScore)})`);

  lines.push(box([
    '',
    `        ${scoreStr}`,
    `        ${gradeStr}`,
    `        ${riskStr}`,
    `        ${practiceStr}`,
    '',
  ]));
  lines.push('');
  if (practiceScore === null) {
    pushWrapped(lines, width, '  ', 'Practice: n/a — no agent loops, specs, CI agent jobs or memory files found to score.', { style: chalk.dim });
    lines.push('');
  }

  // Enforcement-grade legend — terminal-only; suppressed in JSON/SARIF paths
  // because formatJson/formatSarif do not call formatTerminal.
  pushWrapped(lines, width, '  ', 'mechanical = deterministic config check \u00B7 pattern = regex/structural \u00B7 keyword = presence detection', { style: chalk.dim });
  lines.push('');

  // Coverage messaging
  const applicableResults = results.filter((r) => r.score !== NOT_APPLICABLE_SCORE);
  const totalResults = results.length;
  const weights = displayWeights(config);
  const applicableWeight = applicableResults.reduce((sum, r) => sum + (weights[r.id] || 0), 0);
  // Denominator is the fixed 100-point axis the scorer scales against
  // (`scale = totalApplicableWeight / 100`), not the sum of resolved weights.
  const totalWeight = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
  // Disclose scaling exactly when the scorer scales: `scale = min(1, weight/100)`
  // shrinks the score for ANY applicable weight below 100. The old `< 60` gate
  // matched nothing in the scorer, so weights 60..99 were scaled in silence —
  // a project whose every check scored 100 saw an unexplained 80/100.
  // ...but never claim a score was "scaled ×0.00" when no score was produced.
  const scaled = applicableWeight < totalWeight && !notApplicable;
  // Weight can fall short with every check still applicable (`checks.disabled`
  // zeroes a weight), so print on weight shortfall alone, not only on N/A checks.
  if (applicableResults.length < totalResults || scaled) {
    const scaleNote = scaled
      ? ` — score scaled ×${(applicableWeight / totalWeight).toFixed(2)}`
      : '';
    pushWrapped(lines, width, '  ', `Coverage: ${applicableResults.length} of ${totalResults} checks applicable (weight ${applicableWeight}/${totalWeight})${scaleNote}`, { style: chalk.dim });
    if (scaled) {
      pushWrapped(lines, width, `  ${chalk.dim('→')} `, `Only ${applicableWeight} of ${totalWeight} points of check weight could be scored, so even an all-passing scan caps at ${applicableWeight}/100.`, { style: chalk.dim });
    }
    lines.push('');
  }

  // Findings by severity (including skipped)
  const allFindings = results.flatMap((r) =>
    r.findings.map((f) => ({ ...f, checkName: r.name })),
  );

  const severities = options.verbose
    ? ['critical', 'warning', 'info', 'skipped', 'pass']
    : ['critical', 'warning', 'info', 'skipped'];
  let anyId = false;
  for (const severity of severities) {
    const items = allFindings.filter((f) => f.severity === severity);
    if (items.length === 0) continue;

    const label = severity.toUpperCase();
    const color = getSeverityColor(severity);
    lines.push(`  ${color(`${label} (${items.length})`)}`);

    for (const item of groupFindings(items)) {
      if (pushFinding(lines, width, '  ', color, severity, item, { full: true })) anyId = true;
      lines.push('');
    }
  }
  if (anyId) pushExplainHint(lines, width);

  // Report-only pointer to --fix when a fixer matches a finding. Never applies
  // anything; just makes the flag discoverable from a plain scan.
  const fixHint = formatFixHint(results);
  if (fixHint) {
    pushWrapped(lines, width, '  ', fixHint, { style: chalk.dim });
    lines.push('');
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

  // Suppression transparency: if config/--ignore muted any findings, say how
  // many and which — the mute is visible in the report and the CI log, not
  // only in a .rigscorerc.json diff.
  const suppressedLine = formatSuppressedSummary(result.suppressed);
  if (suppressedLine) {
    pushWrapped(lines, width, `  ${chalk.yellow('⚠')} `, suppressedLine, { style: chalk.yellow });
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
  const width = resolveWidth(options);
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
  pushWrapped(lines, width, '  ', `Scanning ${rootDir} (${projects.length} projects found)`);
  lines.push('');

  // Per-project summary. Pad to the longest path; clip (keeping the tail, the
  // distinguishing part) so `<icon> <path> <score>/100 (<grade>)` fits.
  const pathWidth = Math.min(
    Math.max(0, ...projects.map((p) => safeField(p.path).length)),
    width - 16,
  );
  for (const project of projects) {
    const name = clip(safeField(project.path), pathWidth, 'end').padEnd(pathWidth, '.');
    if (project.notApplicable) {
      // Nothing to score here: not a red cross, and never in the failing list.
      lines.push(`  ${chalk.dim('\u21b7')} ${name} ${chalk.dim('n/a')}`);
      continue;
    }
    const pGrade = getGrade(project.score);
    const pColor = getScoreColor(project.score);
    const icon = project.score >= 70 ? chalk.green('\u2713') : chalk.red('\u2717');
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
    pushWrapped(lines, width, `  ${chalk.red.bold('⚠ CATASTROPHIC: ')}`, `"${safeField(worstProject.path)}" scores ${worstProject.score}/100 — immediate attention required`, { style: chalk.red });
    lines.push('');
  }

  // Show findings only for projects with issues (score < 100). A project with
  // nothing to score is not "needing attention" — `null < 70` is true, so it
  // has to be filtered explicitly.
  const failing = projects.filter((p) => !p.notApplicable && p.score < 70);
  let anyId = false;
  if (failing.length > 0) {
    lines.push(`  ${chalk.yellow('Projects needing attention:')}`);
    lines.push('');

    for (const project of failing) {
      pushWrapped(lines, width, '  ', `${safeField(project.path)} (${project.score}/100)`, { style: chalk.bold });
      const allFindings = project.results.flatMap((r) =>
        r.findings.map((f) => ({ ...f, checkName: r.name })),
      );

      for (const severity of ['critical', 'warning']) {
        const items = allFindings.filter((f) => f.severity === severity);
        if (items.length === 0) continue;
        const color = getSeverityColor(severity);
        for (const item of groupFindings(items)) {
          if (pushFinding(lines, width, '    ', color, severity, item, { full: false })) anyId = true;
        }
      }
      lines.push('');
    }
  }
  if (anyId) pushExplainHint(lines, width);

  // CTA (opt-in: only shown when noCta is explicitly false)
  if (options.noCta === false) {
    lines.push(`  ${'─'.repeat(40)}`);
    lines.push('');
    lines.push('  Want a full audit with hardened configurations deployed?');
    lines.push(`  ${chalk.cyan('\u2192')} https://backroadcreative.com/ai-agent-security-audit`);
    lines.push('');
  }

  // Suppression transparency (aggregated across projects) — same rationale as
  // the single-project report.
  const suppressedLine = formatSuppressedSummary(result.suppressed);
  if (suppressedLine) {
    pushWrapped(lines, width, `  ${chalk.yellow('⚠')} `, suppressedLine, { style: chalk.yellow });
    lines.push('');
  }

  return lines.join('\n');
}

const JSON_SCHEMA_VERSION = 1;

export function formatJson(result) {
  // Enrich with the A–F grade + hardening tier the terminal shows, so a JSON
  // consumer (a monorepo dashboard, a CI gate) does not reimplement the
  // thresholds. Additive — every existing key is preserved. Both the single-
  // project shape (`results[]`) and the recursive shape (`projects[]`) are handled.
  // `rigscoreVersion` is the tool that produced the report; `schemaVersion`
  // versions the JSON shape itself (bump only on a breaking key change).
  const enriched = { rigscoreVersion: version, schemaVersion: JSON_SCHEMA_VERSION, ...result };
  if (typeof result.score === 'number' && result.notApplicable !== true) {
    enriched.grade = getGrade(result.score);
  } else if (result.notApplicable === true) {
    enriched.grade = 'n/a';
  }
  if (Array.isArray(result.results)) {
    enriched.riskProfile = getRiskProfile(result.results, displayWeights(result.config));
  }
  if (Array.isArray(result.projects)) {
    enriched.projects = result.projects.map((p) => ({
      ...p,
      grade: p.notApplicable ? 'n/a'
        : (typeof p.score === 'number' ? getGrade(p.score) : undefined),
      riskProfile: Array.isArray(p.results)
        ? getRiskProfile(p.results, displayWeights(p.config)) : undefined,
    }));
  }
  return JSON.stringify(enriched, null, 2);
}

const BADGE_COLOR_HEX = {
  brightgreen: '#4c1', green: '#97ca00', blue: '#007ec6',
  yellow: '#dfb317', red: '#e05d44', lightgrey: '#9f9f9f',
};

function badgeColorName(score) {
  return score >= 90 ? 'brightgreen' : score >= 75 ? 'green'
    : score >= 60 ? 'blue' : score >= 40 ? 'yellow' : 'red';
}

/** Minimal self-contained flat SVG badge (no external assets). */
function renderBadgeSvg(label, message, colorName) {
  const hex = BADGE_COLOR_HEX[colorName] || BADGE_COLOR_HEX.lightgrey;
  const lw = Math.round(label.length * 6.5) + 10;
  const mw = Math.round(message.length * 6.5) + 10;
  const total = lw + mw;
  const esc = (s) => escapeXml(s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}">`
    + `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>`
    + `<rect rx="3" width="${total}" height="20" fill="#555"/>`
    + `<rect rx="3" x="${lw}" width="${mw}" height="20" fill="${hex}"/>`
    + `<rect rx="3" width="${total}" height="20" fill="url(#s)"/>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">`
    + `<text x="${lw / 2}" y="14">${esc(label)}</text>`
    + `<text x="${lw + mw / 2}" y="14">${esc(message)}</text>`
    + `</g></svg>`;
}

/**
 * Score badge. `options.format`:
 *   - `markdown` (default) — the static shields.io image snippet (unchanged).
 *   - `endpoint` — shields.io Endpoint Badge JSON. Host it at a public URL and
 *      reference `https://img.shields.io/endpoint?url=<raw-json-url>` for a badge
 *      that auto-updates as the committed JSON changes.
 *   - `svg` — a self-contained SVG (no network) to commit and embed directly.
 */
export function formatBadge(result, options = {}) {
  const format = options.format || 'markdown';
  const { score } = result;
  const na = result.notApplicable === true || score === null;
  const colorName = na ? 'lightgrey' : badgeColorName(score);
  const message = na ? 'n/a' : `${score}/100`;

  if (format === 'endpoint') {
    return JSON.stringify({ schemaVersion: 1, label: 'rigscore', message, color: colorName }, null, 2);
  }
  if (format === 'svg') {
    return renderBadgeSvg('rigscore', message, colorName);
  }
  // markdown (default) — unchanged shields.io static badge.
  const label = na ? 'n%2Fa-lightgrey' : `${score}%2F100-${badgeColorName(score)}`;
  const url = `https://img.shields.io/badge/rigscore-${label}?cacheSeconds=86400`;
  return `![rigscore](${url})\n\nGenerated by [rigscore](https://github.com/Back-Road-Creative/rigscore)`;
}

/** Escape the five XML predefined entities for safe attribute/text embedding. */
function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Best-effort file path from a finding's text — feeds the JUnit/CodeClimate
// `location`. Kept minimal and local (sarif.js has its own copy) to avoid a
// reporter⇄sarif circular import.
function findingPath(finding) {
  const text = `${finding.title || ''} ${finding.detail || ''}`;
  const m = text.match(/(?:\bin|Found in)\s+([.\w][\w./-]*\.\w+)/i)
    || text.match(/^([.\w][\w./-]*\.\w+)\s+(?:is|has|file|not)/i);
  return m ? m[1] : null;
}

/**
 * JUnit XML — one <testcase> per check (Jenkins / Azure Pipelines / GitLab
 * ingest it natively). An N/A check is `<skipped/>`; a check carrying any
 * critical/warning finding is a `<failure>` whose body lists them.
 */
export function formatJUnit(result) {
  const results = result.results || [];
  const cases = [];
  let failures = 0;
  let skipped = 0;
  for (const r of results) {
    const cls = `rigscore.${r.category || 'check'}`;
    if (r.score === NOT_APPLICABLE_SCORE) {
      skipped += 1;
      cases.push(`    <testcase name="${escapeXml(r.id)}" classname="${escapeXml(cls)}"><skipped/></testcase>`);
      continue;
    }
    const bad = (r.findings || []).filter((f) => f.severity === 'critical' || f.severity === 'warning');
    if (bad.length > 0) {
      failures += 1;
      const body = bad.map((f) => {
        const detail = f.detail ? `: ${f.detail}` : '';
        return `      <failure message="${escapeXml(f.title || 'finding')}">${escapeXml((f.title || '') + detail)}</failure>`;
      }).join('\n');
      cases.push(`    <testcase name="${escapeXml(r.id)}" classname="${escapeXml(cls)}">\n${body}\n    </testcase>`);
    } else {
      cases.push(`    <testcase name="${escapeXml(r.id)}" classname="${escapeXml(cls)}"/>`);
    }
  }
  const tests = results.length;
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<testsuites name="rigscore" tests="${tests}" failures="${failures}" skipped="${skipped}">\n`
    + `  <testsuite name="rigscore" tests="${tests}" failures="${failures}" skipped="${skipped}">\n`
    + `${cases.join('\n')}\n`
    + '  </testsuite>\n</testsuites>';
}

const CODECLIMATE_SEVERITY = { critical: 'critical', warning: 'major', info: 'info' };

/**
 * GitLab Code Quality report (CodeClimate JSON). One issue per critical/warning/
 * info finding; pass/skipped findings are omitted. `fingerprint` is a stable hash
 * so GitLab can track an issue across pipelines.
 */
export function formatCodeClimate(result) {
  const issues = [];
  for (const r of result.results || []) {
    for (const f of r.findings || []) {
      const severity = CODECLIMATE_SEVERITY[f.severity];
      if (!severity) continue; // skip pass/skipped
      const path = findingPath(f) || r.id;
      const description = f.detail ? `${f.title}: ${f.detail}` : (f.title || r.name);
      const fingerprint = crypto.createHash('sha256')
        .update(`${f.findingId || f.title || r.id}|${path}`).digest('hex').slice(0, 40);
      issues.push({
        description,
        check_name: r.id,
        fingerprint,
        severity,
        location: { path, lines: { begin: 1 } },
      });
    }
  }
  return JSON.stringify(issues, null, 2);
}
