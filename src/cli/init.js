import fs from 'node:fs';
import path from 'node:path';
import { PROFILES } from '../config.js';

/**
 * Base `rigscore init` — writes a commented .rigscorerc.json starter into
 * the current directory. Agent C owns `init --example` (a richer template
 * that enumerates all options); this base init is intentionally minimal.
 *
 * Usage:
 *   rigscore init                      → writes default-profile starter
 *   rigscore init --profile home       → pre-fills profile: "home"
 */
export async function runInitSubcommand(args) {
  let profile = null;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && i + 1 < args.length) {
      profile = args[++i];
    } else if (args[i] === '--force' || args[i] === '-f') {
      force = true;
    }
  }

  if (profile && !Object.prototype.hasOwnProperty.call(PROFILES, profile)) {
    process.stderr.write(
      `Error: unknown profile "${profile}". Valid: ${Object.keys(PROFILES).join(', ')}\n`,
    );
    process.exit(2);
  }

  const target = path.join(process.cwd(), '.rigscorerc.json');
  if (fs.existsSync(target) && !force) {
    process.stderr.write(
      `Error: ${target} already exists. Pass --force to overwrite.\n`,
    );
    process.exit(1);
  }

  const body = buildStarter(profile);
  fs.writeFileSync(target, body);
  process.stderr.write(`rigscore: wrote ${target}\n`);
}

/**
 * Build a commented .rigscorerc.json. JSONC (JSON with comments) is
 * accepted by readJsonSafe via stripJsonComments in src/utils.js.
 */
export function buildStarter(profile) {
  const profileLine = profile
    ? `  "profile": "${profile}",`
    : `  // "profile": "default",  // default | minimal | ci | home | monorepo`;

  return `{
  // rigscore config. See https://github.com/Back-Road-Creative/rigscore
  // and docs/profiles/README.md for the full option reference.

${profileLine}

  // Checks to disable entirely (weight → 0 but the check still runs for
  // advisory output). Use sparingly; prefer profile selection first.
  "checks": {
    "disabled": []
  },

  // Suppression patterns. Three forms:
  //   - Substring:   "env file found but NOT in .gitignore"
  //   - Exact id:    "claude-md/missing-claude-md"
  //   - Glob:        "skill-files/drive-resume-*"
  //   - Regex:       "re:/.*sudo.*/i"
  "suppress": [],

  // Custom per-check weights that override the profile. Unknown IDs OK
  // (useful for plugin checks). All weights get clamped to [0, 100].
  "weights": {},

  // Path overrides (infrastructure-security, skill-files, etc.). Arrays
  // concatenate with ~/.rigscorerc.json entries at scan time.
  "paths": {
    "claudeMd": [],
    "mcpConfig": [],
    "dockerCompose": [],
    "skillFiles": []
  }
}
`;
}
