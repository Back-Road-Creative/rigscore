import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

  it('prebuilt-binaries.yml validates the tag shape before using it', () => {
    const wf = parse('prebuilt-binaries.yml');
    const resolve = wf.jobs.build.steps.find((s) => s.id === 'tag');
    expect(resolve.env?.TAG).toContain('github.event.release.tag_name');
    expect(resolve.run).toContain('"$TAG"');
    expect(resolve.run).toMatch(/\^v\[0-9\]\+/);
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
  it('audits production dependencies at high severity on the linux leg', () => {
    const step = parse('ci.yml').jobs.test.steps.find(
      (s) => typeof s.run === 'string' && /npm audit --omit=dev/.test(s.run),
    );
    expect(step, 'no npm audit --omit=dev step').toBeDefined();
    expect(step.run).toContain('--audit-level=high');
    expect(String(step.if)).toMatch(/Linux|ubuntu/);
  });
});
