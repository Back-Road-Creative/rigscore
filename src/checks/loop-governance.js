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

// Any single hit clears a loop. The bias is deliberate: a missed uncapped loop
// is cheaper than a false "your loop is uncapped".
const CAP_PATTERNS = [
  /--max-(?:turns|iterations|steps|cost)\b/,
  /(?:^|[\s;&|(])timeout\s+[-\d]/,     // timeout 300 … / timeout -k 10 …
  /\s-(?:lt|le|gt|ge)\s/,              // [ "$i" -lt "$MAX_ITER" ]
  /\(\([^)]*[<>][^)]*\)\)/,            // (( i < MAX_ITER ))
];

const hasAgent = (text) => AGENT_PATTERNS.some((p) => p.test(text));
const isCapped = (header, text) =>
  // `for x in <finite list>` is bounded by construction; `for ((;;))` is not.
  (/(?:^|[\s;&|])for\b/.test(header) && /\sin\s/.test(header)) ||
  CAP_PATTERNS.some((p) => p.test(text));

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
    let surfaceFound = false;

    // Shell scripts only. skipHidden drops `.github` — CI agent jobs are the
    // `ci-agent-caps` check's surface, and double-flagging would double-deduct.
    const { files } = await walkDirSafe(context.cwd, {
      skipDirs: SKIP_DIRS,
      maxFiles: MAX_FILES,
      shouldInclude: (full) => /\.(?:sh|bash)$/.test(full),
    });

    for (const file of files) {
      const raw = await readFileSafe(file);
      if (!raw) continue;
      const rel = path.relative(context.cwd, file);
      // Blank out whole-line comments so a commented-out loop never counts.
      const lines = raw.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l));
      const text = lines.join('\n');

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
      if (!hasAgent(text)) continue;
      surfaceFound = true;

      // One finding per file — a nested loop would otherwise report twice.
      const loops = findLoops(lines).filter((l) => hasAgent(l.text));
      agentLoops += loops.length;

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
      findings.push({ severity: 'pass', title: 'Agent loops carry an iteration cap' });
    }
    return { score: calculateCheckScore(findings), findings, data: { agentLoops, uncappedLoops } };
  },
};
