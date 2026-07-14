// Memory probe for test/oversize-stream-scan.test.js. NOT a test file — vitest's
// include glob only matches *.test.* / *.spec.*, so this is never collected.
//
//   node test/mem-probe.mjs <chunk|readline> <dir containing app.min.js>
//
// Prints {"mode","peakRssBytes","detail"} on stdout.
//
// Why a child process: the test compares two read strategies over one fixture.
// Run in-process and back-to-back, the first arm's retained heap becomes the
// second arm's baseline, so whichever runs second looks artificially cheap and
// the comparison is ordering-dependent. A fresh process per arm gives each a
// clean baseline, which is what makes the ratio stable run-to-run.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import deepSecrets from '../src/checks/deep-secrets.js';

const [mode, dir] = process.argv.slice(2);
const file = path.join(dir, 'app.min.js');

// CONTROL ARM — the read strategy that caused the original OOM: readline over
// the file. On a minified single-line file it buffers the WHOLE line, so its
// memory scales with FILE SIZE. It deliberately does not run the secret regexes:
// the property being measured is the read strategy's memory profile, and matching
// every KEY_PATTERN against a 64 MB string would burn seconds of CI time without
// moving the measurement by a byte.
async function readlineArm() {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let longestLine = 0;
  for await (const line of rl) longestLine = Math.max(longestLine, line.length);
  return longestLine; // proves the control really did buffer the whole line
}

// SUBJECT ARM — the real check. scanFileStreaming reads bounded windows, so its
// memory is CHUNK + OVERLAP regardless of file size or line structure.
async function chunkArm() {
  const { findings } = await deepSecrets.run({ cwd: dir, deep: true, config: {} });
  return findings.filter((f) => f.severity === 'critical').length;
}

const base = process.memoryUsage().rss;
let peak = 0;
const timer = setInterval(() => {
  const delta = process.memoryUsage().rss - base;
  if (delta > peak) peak = delta;
}, 5);

const detail = mode === 'readline' ? await readlineArm() : await chunkArm();

clearInterval(timer);
const end = process.memoryUsage().rss - base;
if (end > peak) peak = end;

process.stdout.write(JSON.stringify({ mode, peakRssBytes: peak, detail }));
