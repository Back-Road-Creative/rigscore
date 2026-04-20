import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import claudeMdCheck from '../src/checks/claude-md.js';
import mcpConfigCheck from '../src/checks/mcp-config.js';
import skillFilesCheck from '../src/checks/skill-files.js';
import coherenceCheck from '../src/checks/coherence.js';
import claudeSettingsCheck from '../src/checks/claude-settings.js';
import { NOT_APPLICABLE_SCORE } from '../src/constants.js';
import { scan } from '../src/scanner.js';
import { stripAnsi, formatTerminal } from '../src/reporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES = {
  nextjs: path.join(__dirname, 'fixtures', 'vanilla-nextjs'),
  fastapi: path.join(__dirname, 'fixtures', 'vanilla-fastapi'),
  rust: path.join(__dirname, 'fixtures', 'vanilla-rust'),
};

const defaultConfig = { paths: { claudeMd: [] }, network: {} };
const NO_HOME = '/tmp/nonexistent-rigscore-home-for-fixture-tests';

/**
 * E1 (Track E): Real on-disk fixtures for three vanilla shapes. The in-memory
 * mkdtemp variant exists in `test/no-ai-tooling.test.js` for unit-level
 * coverage; these fixtures also guard the reporter banner and the overall-
 * score behaviour against structural regression.
 */
describe('E1: vanilla-project fixtures (no AI tooling)', () => {
  for (const [label, fixturePath] of Object.entries(FIXTURES)) {
    describe(`vanilla-${label} fixture`, () => {
      it('governance-surface checks all return NOT_APPLICABLE (not CRITICAL)', async () => {
        const ctx = { cwd: fixturePath, homedir: NO_HOME, config: defaultConfig };

        const claudeMd = await claudeMdCheck.run(ctx);
        const mcpConfig = await mcpConfigCheck.run(ctx);
        const skillFiles = await skillFilesCheck.run(ctx);
        const claudeSettings = await claudeSettingsCheck.run(ctx);

        expect(claudeMd.score).toBe(NOT_APPLICABLE_SCORE);
        expect(mcpConfig.score).toBe(NOT_APPLICABLE_SCORE);
        expect(skillFiles.score).toBe(NOT_APPLICABLE_SCORE);
        expect(claudeSettings.score).toBe(NOT_APPLICABLE_SCORE);

        // No finding on any of the above may be CRITICAL.
        for (const [name, result] of [
          ['claude-md', claudeMd],
          ['mcp-config', mcpConfig],
          ['skill-files', skillFiles],
          ['claude-settings', claudeSettings],
        ]) {
          const critical = result.findings.find((f) => f.severity === 'critical');
          expect(critical, `${name} emitted CRITICAL on vanilla fixture`).toBeUndefined();
        }
      });

      it('coherence check runs cleanly (no CRITICAL from missing governance)', async () => {
        // coherence is pass-2: it reads priorResults. Exercised here directly
        // with an empty priorResults list to confirm it does not synthesise a
        // critical governance-missing finding.
        const result = await coherenceCheck.run({
          cwd: fixturePath,
          homedir: NO_HOME,
          config: defaultConfig,
          priorResults: [],
        });
        // NOT_APPLICABLE is fine; any non-NA score must at least be free of CRITICAL.
        const critical = result.findings.find((f) => f.severity === 'critical');
        expect(critical).toBeUndefined();
      });

      it('reporter prints the "No AI tooling detected" banner', async () => {
        const scanResult = await scan({ cwd: fixturePath, homedir: NO_HOME });
        const output = stripAnsi(formatTerminal(scanResult, fixturePath, { noCta: true }));
        expect(output).toContain('No AI tooling detected');
      });

      it('no CRITICAL finding is synthesised anywhere on the scan', async () => {
        // Track C's continuous coverage scaling legitimately penalises the
        // overall score when only a handful of checks are applicable (the
        // "confidence interval" is low). That is NOT the failure mode this
        // fixture guards against — the failure mode is a governance check
        // emitting a CRITICAL because AI tooling is absent. That finding, on
        // a vanilla Next.js/FastAPI/Rust project, IS the screenshot fodder.
        //
        // Assert no check anywhere emits CRITICAL on a clean vanilla project.
        const result = await scan({ cwd: fixturePath, homedir: NO_HOME });
        const offenders = [];
        for (const r of result.results) {
          for (const f of r.findings) {
            if (f.severity === 'critical') {
              offenders.push(`${r.id}: ${f.title}`);
            }
          }
        }
        expect(offenders, offenders.join('\n')).toHaveLength(0);
      });
    });
  }
});
