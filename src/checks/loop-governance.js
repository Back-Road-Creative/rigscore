import path from 'node:path';
import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { readFileSafe, walkDirSafe } from '../utils.js';

// `fixtures` is skipped for the same reason deep-secrets skips *.test.* files:
// fixture trees hold deliberately-unsafe samples, not loops anyone runs.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'coverage', 'fixtures',
]);
const MAX_FILES = 2000;

// The binary must sit in command position — line start or after a shell
// separator — so `.claude/settings.json` or `codexample` cannot match.
const AGENT_PATTERNS = [
  /(?:^|[\s;|&(`])claude\s[^\n]*?(?:-p\b|--print\b)/,
  /(?:^|[\s;|&(`])codex(?:\s|$)/,
  /(?:^|[\s;|&(`])gemini(?:\s|$)/,
  /(?:^|[\s;|&(`])opencode\s+run\b/,
  /(?:^|[\s;|&(`])aider(?:\s|$)/,
];
const SKIP_PERMS = /--dangerously-skip-permissions\b/;
const LOOP_START = /(?:^|[\s;&|])(?:while|until|for)\b/;
const LOOP_END = /(?:^|[\s;&|])done\b/;

// A header that can never become false on its own. Exactly the three written
// forms — `while :` and friends are a deliberate miss (see the doc page).
const UNCONDITIONAL_HEADER = [
  /(?:^|[\s;&|])while\s+true\b/,
  /(?:^|[\s;&|])until\s+false\b/,
  /(?:^|[\s;&|])for\s*\(\(\s*;\s*;\s*\)\)/,
];

// Anything here means the body evaluates *something* to decide it is done.
// Any single hit buys silence — same bias as CAP_PATTERNS.
const STOP_PATTERNS = [
  /(?:^|[\s;&|(])(?:break|exit|return)\b/,
  /(?:^|[\s;&|(])if\b/,
  /\[\s+!?\s*-[a-z]\b/,                    // [ -f /tmp/stop ] / [ ! -e … ]
  /(?:^|[\s;&|(])test\s+!?\s*-[a-z]\b/,    // test -f ./STOP
  /(?:^|[\s;&|(])grep\s+(?:-\w*\s+)*-\w*q/, // grep -q DONE
];

// Cron surface: an agent on a schedule terminates each tick, so the stop
// condition is not the question — what one unattended tick may spend is.
const CRON_SHORTHAND = /^\s*@\w+\s+\S/;
// Five schedule fields, then a command. `PATH=/usr/bin` cannot match — `=`
// and `:` are outside the field charset.
const CRON_FIELDS = /^\s*(?:[-\d*/,A-Za-z]+\s+){5}\S/;

const isCronFile = (full) => {
  const base = path.basename(full);
  return base === 'crontab' || /\.(?:cron|crontab)$/.test(base);
};
const isCronLine = (line) => CRON_SHORTHAND.test(line) || CRON_FIELDS.test(line);

// Indirection surface: files that can *hide* an agent behind one call.
const isMakefile = (full) => /^(?:GNUmakefile|[Mm]akefile)$|\.mk$/.test(path.basename(full));
const isPkgJson = (full) => path.basename(full) === 'package.json';
const isPython = (full) => /\.py$/.test(full);
const isShell = (full) => /\.(?:sh|bash)$/.test(full);
// Where a loop can actually be read. package.json and *.py are resolved, not parsed.
const isLoopFile = (full) => isShell(full) || isMakefile(full) || isCronFile(full);

// systemd: a `.timer` schedules a `.service`, and the agent is in its ExecStart.
const isTimer = (full) => /\.timer$/.test(full);
const isService = (full) => /\.service$/.test(full);
const SVC_EXEC = /^\s*ExecStart\s*=\s*(.+)$/;
const SVC_UNIT = /^\s*Unit\s*=\s*(\S+)/;
// systemd's own bound on a tick. `infinity` is not a bound.
const SVC_BOUND = /^\s*(?:RuntimeMaxSec|TimeoutStartSec|TimeoutSec)\s*=\s*(?!infinity)\S+/;
// ExecStart must be an absolute path (optionally `@-+!`-prefixed). Strip the
// dirname so the shared command-position AGENT_PATTERNS apply: /usr/bin/claude → claude
const execCommand = (line) => line.replace(/^\s*[@+!-]*(?:\/\S+\/)/, '');

// A target line (`build:`), not a variable assignment (`CC := gcc`).
const MAKE_TARGET = /^([A-Za-z0-9_.\-/]+)\s*:(?!=)/;
const PY_SUBPROCESS = /(?:subprocess\.(?:run|Popen|call|check_call|check_output)|os\.system)\s*\(/;
// Rebuild a shell-ish command line from a Python arg list so the shared
// AGENT_PATTERNS apply: ["claude", "-p", x] → [ claude -p , x].
const pyCommandish = (src) => src.replace(/['"]\s*,\s*['"]/g, ' ').replace(/['"]/g, ' ');

// Any single hit clears a loop. The bias is deliberate: a missed uncapped loop
// is cheaper than a false "your loop is uncapped".
const CAP_PATTERNS = [
  /--max-(?:turns|iterations|steps|cost)\b/,
  /(?:^|[\s;&|(])timeout\s+[-\d]/,     // timeout 300 … / timeout -k 10 …
  /\s-(?:lt|le|gt|ge)\s/,              // [ "$i" -lt "$MAX_ITER" ]
  /\(\([^)]*[<>][^)]*\)\)/,            // (( i < MAX_ITER ))
];

const hasAgent = (text) => AGENT_PATTERNS.some((p) => p.test(text));

/**
 * Resolve ONE level of call: record every make target, npm script, and python
 * module that actually reaches an agent. A loop that runs `make agent` drives
 * an agent just as surely as one that types `claude -p` — the binary is simply
 * a file away. One level only: `make a` → `make b` → agent is not followed.
 */
function indexIndirection(file, lines, raw, idx) {
  if (isMakefile(file)) {
    let target = null;
    for (const line of lines) {
      // Recipe lines are tab-indented; the block ends at the next flush line.
      if (/^\t/.test(line)) {
        if (target && hasAgent(line)) idx.make.add(target);
        continue;
      }
      const m = line.match(MAKE_TARGET);
      target = m ? m[1] : null;
    }
  } else if (isPkgJson(file)) {
    try {
      const scripts = JSON.parse(raw).scripts || {};
      for (const [name, cmd] of Object.entries(scripts)) {
        if (typeof cmd === 'string' && hasAgent(cmd)) idx.npm.add(name);
      }
    } catch { /* an unparseable package.json is not this check's business */ }
  } else if (isService(file)) {
    // Agent-ness is decided in pass 2 — an ExecStart may itself be `make agent`,
    // and the make index is not complete until every file has been read.
    idx.svc.set(path.basename(file), {
      execs: lines.filter((l) => SVC_EXEC.test(l)).map((l) => execCommand(l.match(SVC_EXEC)[1])),
      bounded: lines.some((l) => SVC_BOUND.test(l)),
    });
  } else if (isPython(file)) {
    const text = lines.join('\n');
    // Both must hold: a subprocess call, and an agent in its arguments. The
    // word `claude` in a docstring next to an unrelated Popen is not a loop.
    if (PY_SUBPROCESS.test(text) && hasAgent(pyCommandish(text))) idx.py.add(path.basename(file));
  }
}

/** Does this text invoke an agent-bearing make target / npm script / python module? */
function callsIndirectAgent(text, idx) {
  for (const m of text.matchAll(/(?:^|[\s;|&(`])make\s+([^\n;|&]+)/g)) {
    // Covers `make agent`, `make -C sub agent`, `make lint agent`.
    if (m[1].split(/\s+/).some((tok) => idx.make.has(tok))) return true;
  }
  for (const m of text.matchAll(/(?:^|[\s;|&(`])(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) {
    if (idx.npm.has(m[1])) return true;
  }
  for (const m of text.matchAll(/(?:^|[\s;|&(`])(?:python3?|uv|poetry|pipenv)\b[^\n;|&]*?([\w./-]+\.py)\b/g)) {
    if (idx.py.has(path.basename(m[1]))) return true;
  }
  return false;
}

const isCapped = (header, text) =>
  // `for x in <finite list>` is bounded by construction; `for ((;;))` is not.
  (/(?:^|[\s;&|])for\b/.test(header) && /\sin\s/.test(header)) ||
  CAP_PATTERNS.some((p) => p.test(text));

// Orthogonal to isCapped: a `--max-turns` loop is bounded per iteration and
// still runs forever. Both conditions must hold, and either one being unsure
// resolves to silence.
const hasNoStopCondition = (header, text) =>
  UNCONDITIONAL_HEADER.some((p) => p.test(header)) &&
  !STOP_PATTERNS.some((p) => p.test(text));

/** Split a script into loop blocks, each carrying its header + body text. */
function findLoops(lines) {
  const loops = [];
  const stack = [];
  for (const line of lines) {
    if (LOOP_START.test(line)) stack.push({ header: line, body: [] });
    for (const frame of stack) frame.body.push(line);
    if (LOOP_END.test(line) && stack.length) {
      const f = stack.pop();
      loops.push({ header: f.header, text: f.body.join('\n') });
    }
  }
  return loops;
}

export default {
  id: 'loop-governance',
  enforcementGrade: 'pattern',
  name: 'Loop governance',
  category: 'process',

  async run(context) {
    const findings = [];
    let agentLoops = 0;
    let uncappedLoops = 0;
    let cronJobs = 0;
    let timerJobs = 0;
    let surfaceFound = false;

    // Shell scripts + crontabs, plus the three indirection surfaces. skipHidden
    // drops `.github` — CI agent jobs are the `ci-agent-caps` check's surface,
    // and double-flagging would double-deduct.
    const { files } = await walkDirSafe(context.cwd, {
      skipDirs: SKIP_DIRS,
      maxFiles: MAX_FILES,
      shouldInclude: (full) =>
        isShell(full) || isCronFile(full) || isMakefile(full) || isPkgJson(full) ||
        isPython(full) || isTimer(full) || isService(full),
    });

    // Pass 1 — read each file once and resolve one level of call, so pass 2 can
    // see the agent behind `make agent` / `npm run agent` / `python agent.py`.
    const indirect = { make: new Set(), npm: new Set(), py: new Set(), svc: new Map() };
    const docs = [];
    for (const file of files) {
      const raw = await readFileSafe(file);
      if (!raw) continue;
      // Blank out whole-line comments so a commented-out loop never counts, and
      // strip make's `@`/`-`/`+` recipe prefixes so `@claude -p` reads as a command.
      const lines = raw
        .split('\n')
        .map((l) => (/^\s*#/.test(l) ? '' : l))
        .map((l) => (isMakefile(file) ? l.replace(/^\t[@+-]+/, '\t') : l));
      docs.push({ file, rel: path.relative(context.cwd, file), lines, text: lines.join('\n') });
      indexIndirection(file, lines, raw, indirect);
    }

    // An agent reached directly, or one call away.
    const agentIn = (text) => hasAgent(text) || callsIndirectAgent(text, indirect);

    // Pass 2 — findings.
    for (const { file, rel, lines, text } of docs) {
      if (SKIP_PERMS.test(text)) {
        surfaceFound = true;
        findings.push({
          findingId: 'loop-governance/skip-permissions',
          severity: 'warning',
          title: `\`--dangerously-skip-permissions\` in ${rel}`,
          detail: `${rel} runs an agent with --dangerously-skip-permissions — every tool call executes with no confirmation, leaving the deny list as the only thing between the agent and the machine.`,
          evidence: rel,
          remediation: 'Drop the flag and allow-list the specific tools the run needs.',
          context: { file: rel },
        });
      }
      if (isTimer(file)) {
        // Pair the timer to its service: an explicit `Unit=`, else same-basename.
        const named = lines.map((l) => l.match(SVC_UNIT)).find(Boolean);
        const svc = indirect.svc.get(
          named ? named[1] : path.basename(file).replace(/\.timer$/, '.service'),
        );
        const exec = svc && svc.execs.find((e) => agentIn(e));
        if (!exec) continue;
        surfaceFound = true;
        timerJobs++;
        if (!svc.bounded && !CAP_PATTERNS.some((p) => p.test(exec))) {
          findings.push({
            findingId: 'loop-governance/uncapped-timer',
            severity: 'warning',
            title: `Uncapped agent systemd timer in ${rel}`,
            detail: `${rel} schedules a service whose ExecStart runs an agent with nothing bounding one tick — no RuntimeMaxSec, no --max-turns, no timeout. Unattended by definition, a wedged tick burns quota and keeps writing until the next one lands on top of it.`,
            evidence: exec.trim().slice(0, 120),
            remediation: 'Add `RuntimeMaxSec=` to the service unit, or give the agent a --max-turns budget.',
            context: { file: rel },
          });
        }
        continue;
      }

      // package.json, *.py and *.service hold no loop this check can read — they
      // are resolved (pass 1), not parsed. Their flag above still counts.
      if (!isLoopFile(file)) continue;
      if (!agentIn(text)) continue;
      surfaceFound = true;

      if (isCronFile(file)) {
        // A cron line is a loop whose iteration is the schedule: it terminates
        // each tick, so only the spend of one unattended tick is in question.
        const jobs = lines.filter((l) => isCronLine(l) && agentIn(l));
        cronJobs += jobs.length;

        const uncappedJob = jobs.find((l) => !CAP_PATTERNS.some((p) => p.test(l)));
        if (uncappedJob) {
          findings.push({
            findingId: 'loop-governance/uncapped-cron',
            severity: 'warning',
            title: `Uncapped agent cron job in ${rel}`,
            detail: `${rel} schedules an agent with nothing bounding one tick — no --max-turns, no timeout, no run budget. Unattended by definition, a wedged tick burns quota and keeps writing until the next one lands on top of it.`,
            evidence: uncappedJob.trim().slice(0, 120),
            remediation: 'Wrap the scheduled invocation in `timeout`, or give it a --max-turns budget.',
            context: { file: rel },
          });
        }
        continue;
      }

      // One finding per file — a nested loop would otherwise report twice.
      const loops = findLoops(lines).filter((l) => agentIn(l.text));
      agentLoops += loops.length;

      const stopless = loops.find((l) => hasNoStopCondition(l.header, l.text));
      if (stopless) {
        findings.push({
          findingId: 'loop-governance/no-stop-condition',
          severity: 'warning',
          title: `Agent loop with no stop condition in ${rel}`,
          detail: `${rel} drives an agent inside an unconditional loop whose body evaluates nothing to decide it is done — no break, no exit, no sentinel check. A per-iteration cap bounds each turn; nothing ends the run but killing the process.`,
          evidence: stopless.header.trim().slice(0, 120),
          remediation: 'Give the loop a terminal state to test for — break on success, or check a stop sentinel each pass.',
          context: { file: rel },
        });
      }

      const uncapped = loops.find((l) => !isCapped(l.header, l.text));
      if (uncapped) {
        uncappedLoops++;
        findings.push({
          findingId: 'loop-governance/uncapped-loop',
          severity: 'warning',
          title: `Uncapped agent loop in ${rel}`,
          detail: `${rel} drives an agent inside a loop with no bound — no iteration counter tested against a limit, no --max-turns, no timeout, no run budget. A wedged agent burns quota and keeps writing until someone notices.`,
          evidence: uncapped.header.trim().slice(0, 120),
          remediation: 'Add an iteration cap, a --max-turns budget, or wrap the invocation in `timeout`.',
          context: { file: rel },
        });
      }
    }

    // Most repos have no agent-loop surface. Scoring its absence would be a
    // false positive, so N/A is the honest answer.
    if (!surfaceFound) return { score: NOT_APPLICABLE_SCORE, findings: [], data: {} };

    if (findings.length === 0) {
      findings.push({ severity: 'pass', title: 'Agent loops and cron jobs carry a bound' });
    }
    return {
      score: calculateCheckScore(findings),
      findings,
      data: {
        agentLoops,
        uncappedLoops,
        cronJobs,
        timerJobs,
        indirectAgents: indirect.make.size + indirect.npm.size + indirect.py.size,
      },
    };
  },
};
