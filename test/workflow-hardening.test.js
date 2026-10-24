import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as YAML from 'yaml';

// Workflow hardening: no template-expression injection into shell scripts,
// least-privilege tokens on the CI and leak-scan workflows, and a
// production-dependency audit gate in CI.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowDir = join(repoRoot, '.github', 'workflows');
const parse = (file) => YAML.parse(readFileSync(join(workflowDir, file), 'utf8'));
const workflowFiles = readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));

const runScripts = (wf) =>
  Object.values(wf.jobs || {}).flatMap((job) =>
    (job.steps || []).filter((s) => typeof s.run === 'string').map((s) => ({ name: s.name || s.id || '(unnamed)', run: s.run })),
  );

const exprs = (script) => [...script.matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1].trim());

describe('workflows — no attacker-controlled expressions inside run: scripts', () => {
  for (const file of workflowFiles) {
    it(`${file} keeps inputs.* and github.event.* out of run: scripts`, () => {
      const offenders = runScripts(parse(file)).flatMap(({ name, run }) =>
        exprs(run)
          .filter((e) => /\binputs\./.test(e) || /\bgithub\.event\./.test(e))
          .map((e) => `${name}: ${e}`),
      );
      expect(offenders).toEqual([]);
    });
  }

  it('prebuilt-binaries.yml also keeps step outputs out of run: scripts (tag is derived from input)', () => {
    const offenders = runScripts(parse('prebuilt-binaries.yml')).flatMap(({ name, run }) =>
      exprs(run).filter((e) => /\bsteps\.[\w-]+\.outputs\./.test(e)).map((e) => `${name}: ${e}`),
    );
    expect(offenders).toEqual([]);
  });

  describe('prebuilt-binaries.yml tag shape check (runs the real step script)', () => {
    const resolve = parse('prebuilt-binaries.yml').jobs.build.steps.find((s) => s.id === 'tag');

    const runResolve = (tag) => {
      const dir = mkdtempSync(join(tmpdir(), 'rigscore-tag-'));
      try {
        const out = join(dir, 'output');
        const envFile = join(dir, 'env');
        writeFileSync(out, '');
        writeFileSync(envFile, '');
        const res = spawnSync('bash', ['-c', resolve.run], {
          env: { PATH: process.env.PATH, TAG: tag, GITHUB_OUTPUT: out, GITHUB_ENV: envFile },
          encoding: 'utf8',
        });
        return { status: res.status, output: readFileSync(out, 'utf8'), env: readFileSync(envFile, 'utf8') };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('takes the tag from the environment, not template substitution', () => {
      expect(resolve.env?.TAG).toContain('github.event.release.tag_name');
    });

    it('accepts release tags', () => {
      for (const tag of ['v1.2.3', 'v0.10.0-rc.1']) {
        const r = runResolve(tag);
        expect(r.status, tag).toBe(0);
        expect(r.output).toBe(`tag=${tag}\n`);
        expect(r.env).toBe(`TAG=${tag}\n`);
      }
    });

    it('rejects malformed tags and writes nothing', () => {
      for (const tag of ['', '1.2.3', 'v1.2', 'v1.2.3; rm -rf /', 'v1.2.3 ', '$(id)']) {
        const r = runResolve(tag);
        expect(r.status, JSON.stringify(tag)).not.toBe(0);
        expect(r.output + r.env, JSON.stringify(tag)).toBe('');
      }
    });

    it('rejects a multi-line value whose first line looks like a tag', () => {
      for (const tag of ['v1.0.0\nBASH_ENV=/tmp/x', 'v1.0.0\n', 'x\nv1.0.0']) {
        const r = runResolve(tag);
        expect(r.status, JSON.stringify(tag)).not.toBe(0);
        expect(r.output + r.env, JSON.stringify(tag)).toBe('');
      }
    });
  });
});

describe('workflows — least-privilege token', () => {
  for (const file of ['ci.yml', 'leak-scan.yml']) {
    it(`${file} declares a top-level read-only permissions block`, () => {
      const wf = parse(file);
      expect(wf.permissions, `${file} has no top-level permissions`).toBeDefined();
      expect(wf.permissions.contents).toBe('read');
      expect(Object.values(wf.permissions)).not.toContain('write');
    });
  }
});

describe('ci.yml — dependency audit gate', () => {
  it('audits production dependencies at high severity on one linux leg', () => {
    const step = parse('ci.yml').jobs.test.steps.find(
      (s) => typeof s.run === 'string' && /npm audit --omit=dev/.test(s.run),
    );
    expect(step, 'no npm audit --omit=dev step').toBeDefined();
    expect(step.run).toContain('--audit-level=high');
    expect(String(step.if)).toMatch(/Linux/);
    expect(String(step.if)).toMatch(/node-version == '22'/);
  });
});
