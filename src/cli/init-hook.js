import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/**
 * Install a rigscore pre-commit hook in `<cwd>/.git/hooks/pre-commit`.
 *
 * Exit code contract (callers should not catch — this function calls
 * `process.exit()` directly to match the historical run() behavior):
 *   0 — installed, or already present (no-op)
 *   1 — no .git directory (error written to stderr)
 *
 * Behavior:
 *   - If the hook already contains "rigscore" and the previous pin
 *     matches the current version, prints a "already installed" note
 *     and exits 0.
 *   - If the previous pin is an older rigscore version, prints a
 *     "re-pin" warning instead of silently appending a shadowing line.
 *   - If the hook file doesn't exist, writes `#!/bin/sh` + the pinned
 *     npx command. If it exists but has no rigscore line, appends to it.
 *   - The npx invocation pins to the release tag matching the
 *     currently-installed rigscore version — an unpinned `npx github:…`
 *     would let any default-branch compromise propagate to every adopter
 *     on their next commit.
 *
 * @param {string} cwd - Project root containing `.git`.
 * @returns {void} Exits the process.
 */
export function runInitHook(cwd) {
  const version = pkg.version;

  const hooksDir = path.join(cwd, '.git', 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');

  try {
    fs.statSync(path.join(cwd, '.git'));
  } catch {
    process.stderr.write('Error: No .git directory found. Run git init first.\n');
    process.exit(1);
  }

  let existing = '';
  try { existing = fs.readFileSync(hookPath, 'utf8'); } catch {}

  // Detect an older pinned version and nudge the user to re-init rather
  // than silently appending a second line that shadows the first.
  const pinnedMatch = existing.match(/rigscore@v(\d+\.\d+\.\d+)/);
  if (existing.includes('rigscore')) {
    if (pinnedMatch && pinnedMatch[1] !== version) {
      process.stderr.write(
        `rigscore hook already installed (pinned to v${pinnedMatch[1]}; ` +
        `current version v${version}). Re-run 'rigscore --init-hook' after ` +
        `editing the old line out of .git/hooks/pre-commit to re-pin.\n`,
      );
    } else {
      process.stderr.write('rigscore hook already installed in .git/hooks/pre-commit\n');
    }
    process.exit(0);
  }

  const pinnedCmd = `npx -y github:Back-Road-Creative/rigscore@v${version} --fail-under 70 --no-cta || exit 1`;
  const pinnedComment = `# rigscore pinned to v${version}. Re-run 'rigscore --init-hook' after upgrading to re-pin.`;

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    if (existing) {
      fs.appendFileSync(hookPath, `\n${pinnedComment}\n${pinnedCmd}\n`);
    } else {
      fs.writeFileSync(hookPath, `#!/bin/sh\n${pinnedComment}\n${pinnedCmd}\n`);
    }
    fs.chmodSync(hookPath, 0o755);
  } catch (err) {
    process.stderr.write(`rigscore: could not install hook at ${hookPath}: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write('Installed rigscore pre-commit hook in .git/hooks/pre-commit\n');
  process.exit(0);
}
