import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withTmpDir } from './helpers.js';
import { discoverPlugins, loadChecks } from '../src/checks/index.js';

const CHECKS_INDEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'checks', 'index.js',
);

/** Write a minimal valid rigscore-check-* package into `<dir>/node_modules`. */
function writePlugin(dir, pkgName, id, extraPkgFields = {}, entryFile = 'index.js') {
  const pluginDir = path.join(dir, 'node_modules', ...pkgName.split('/'));
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: pkgName, type: 'module', ...extraPkgFields }),
  );
  fs.mkdirSync(path.dirname(path.join(pluginDir, entryFile)), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, entryFile),
    `export default {
      id: '${id}',
      name: 'Plugin ${id}',
      category: 'governance',
      run: async () => ({ score: 100, findings: [] }),
    };`,
  );
  return pluginDir;
}

describe('plugin system', () => {
  it('discovers rigscore-check-* packages', async () => {
    await withTmpDir(async (dir) => {
      // Create a mock plugin
      const pluginDir = path.join(dir, 'node_modules', 'rigscore-check-test');
      fs.mkdirSync(pluginDir, { recursive: true });

      const pluginCode = `
        export default {
          id: 'test-plugin',
          name: 'Test Plugin',
          category: 'governance',
          run: async () => ({
            score: 100,
            findings: [{ severity: 'pass', title: 'Test passed' }],
          }),
        };
      `;

      // Write package.json for the plugin
      fs.writeFileSync(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'rigscore-check-test', type: 'module', main: 'index.js' }),
      );
      fs.writeFileSync(path.join(pluginDir, 'index.js'), pluginCode);

      const plugins = await discoverPlugins(dir);
      expect(plugins.length).toBe(1);
      expect(plugins[0].id).toBe('test-plugin');
      expect(plugins[0].name).toBe('Test Plugin');
      expect(typeof plugins[0].run).toBe('function');
    });
  });

  it('validates plugin shape', async () => {
    await withTmpDir(async (dir) => {
      // Create an invalid plugin (missing run function)
      const pluginDir = path.join(dir, 'node_modules', 'rigscore-check-bad');
      fs.mkdirSync(pluginDir, { recursive: true });

      fs.writeFileSync(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'rigscore-check-bad', type: 'module', main: 'index.js' }),
      );
      fs.writeFileSync(pluginDir + '/index.js', 'export default { id: "bad", name: "Bad" };');

      // Capture stderr
      const warnings = [];
      const origWrite = process.stderr.write;
      process.stderr.write = (msg) => { warnings.push(msg); return true; };

      try {
        const plugins = await discoverPlugins(dir);
        expect(plugins.length).toBe(0);
        expect(warnings.some(w => w.includes('missing required'))).toBe(true);
      } finally {
        process.stderr.write = origWrite;
      }
    });
  });

  it('handles missing node_modules gracefully', async () => {
    const plugins = await discoverPlugins('/nonexistent/path');
    expect(plugins).toEqual([]);
  });

  it('plugin results appear in scan output', async () => {
    await withTmpDir(async (dir) => {
      // Create a mock plugin
      const pluginDir = path.join(dir, 'node_modules', 'rigscore-check-mock');
      fs.mkdirSync(pluginDir, { recursive: true });

      fs.writeFileSync(
        path.join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'rigscore-check-mock', type: 'module', main: 'index.js' }),
      );
      fs.writeFileSync(
        path.join(pluginDir, 'index.js'),
        `export default {
          id: 'mock-check',
          name: 'Mock Check',
          category: 'governance',
          run: async () => ({ score: 85, findings: [{ severity: 'info', title: 'Mock info' }] }),
        };`,
      );

      const checks = await loadChecks({ cwd: dir });
      const pluginCheck = checks.find(c => c.id === 'mock-check');
      expect(pluginCheck).toBeDefined();

      const result = await pluginCheck.run({ cwd: dir });
      expect(result.score).toBe(85);
    });
  });

  it('plugin weight defaults to 0 if not in WEIGHTS', async () => {
    const { WEIGHTS } = await import('../src/constants.js');
    expect(WEIGHTS['some-random-plugin-id']).toBeUndefined();
    // The scanner uses WEIGHTS[check.id] || check.weight || 0
    // So undefined || undefined || 0 = 0
    expect(WEIGHTS['some-random-plugin-id'] || 0).toBe(0);
  });

  it('config weights override applies to plugins', async () => {
    const { resolveWeights } = await import('../src/config.js');
    const config = { weights: { 'custom-plugin': 5 } };
    const resolved = resolveWeights(config);
    expect(resolved['custom-plugin']).toBe(5);
  });

  it('does not double-register two plugin packages that export the same id', async () => {
    // Regression: when the same plugin id appears in two different package
    // directories (e.g., installed in both cwd/node_modules and the
    // rigscore install's node_modules, or under different package names
    // that export the same id), it used to register twice and double-count.
    await withTmpDir(async (dir) => {
      for (const name of ['rigscore-check-dupe-a', 'rigscore-check-dupe-b']) {
        const p = path.join(dir, 'node_modules', name);
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(
          path.join(p, 'package.json'),
          JSON.stringify({ name, type: 'module', main: 'index.js' }),
        );
        fs.writeFileSync(
          path.join(p, 'index.js'),
          `export default {
            id: 'dupe-plugin',
            name: 'Dupe Plugin',
            category: 'governance',
            run: async () => ({ score: 100, findings: [] }),
          };`,
        );
      }
      const plugins = await discoverPlugins(dir);
      const matches = plugins.filter((p) => p.id === 'dupe-plugin');
      expect(matches).toHaveLength(1);
    });
  });

  // Regression: discoverPlugins() import()ed the package DIRECTORY. Node's ESM
  // loader has no directory resolution — a file: URL pointing at a folder is
  // ERR_UNSUPPORTED_DIR_IMPORT, full stop. Vite's resolver silently rewrote
  // that to the package entry point, so every assertion above passed while
  // real `node bin/rigscore.js` failed to load a single plugin. The whole
  // plugin system was dead in production and the suite said otherwise.
  //
  // These run discovery in a real Node process, so the runner's resolver
  // cannot stand in for Node's. They are the oracle that the resolution is
  // genuinely fixed rather than merely re-hidden by a different bundler.
  describe('resolves entry points in real Node (not the runner resolver)', () => {
    /** Run discoverPlugins(dir) in a real Node process; return parsed ids + stderr. */
    function discoverInRealNode(dir) {
      const script = `
        const { discoverPlugins } = await import(${JSON.stringify(pathToFileURL(CHECKS_INDEX).href)});
        const plugins = await discoverPlugins(${JSON.stringify(dir)});
        process.stdout.write('IDS:' + JSON.stringify(plugins.map((p) => p.id)));
      `;
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
      });
      const m = /IDS:(\[.*\])/.exec(res.stdout || '');
      return { ids: m ? JSON.parse(m[1]) : null, stderr: res.stderr || '', status: res.status };
    }

    it('loads a plugin whose entry point comes from package.json "main"', async () => {
      await withTmpDir(async (dir) => {
        writePlugin(dir, 'rigscore-check-mainfield', 'main-plugin', { main: 'lib/entry.js' }, 'lib/entry.js');
        const { ids, stderr } = discoverInRealNode(dir);
        expect(stderr).not.toMatch(/failed to load plugin/);
        expect(ids).toEqual(['main-plugin']);
      });
    });

    it('loads a plugin that relies on the implicit index.js entry point', async () => {
      await withTmpDir(async (dir) => {
        writePlugin(dir, 'rigscore-check-implicit', 'implicit-plugin');
        const { ids, stderr } = discoverInRealNode(dir);
        expect(stderr).not.toMatch(/failed to load plugin/);
        expect(ids).toEqual(['implicit-plugin']);
      });
    });

    it('loads a scoped @org/rigscore-check-* plugin', async () => {
      await withTmpDir(async (dir) => {
        writePlugin(dir, '@acme/rigscore-check-scoped', 'scoped-plugin');
        const { ids, stderr } = discoverInRealNode(dir);
        expect(stderr).not.toMatch(/failed to load plugin/);
        expect(ids).toEqual(['scoped-plugin']);
      });
    });

    it('honours the "exports" entry point when package.json declares one', async () => {
      await withTmpDir(async (dir) => {
        writePlugin(
          dir, 'rigscore-check-exports', 'exports-plugin',
          { exports: { '.': './dist/main.js' } }, 'dist/main.js',
        );
        const { ids, stderr } = discoverInRealNode(dir);
        expect(stderr).not.toMatch(/failed to load plugin/);
        expect(ids).toEqual(['exports-plugin']);
      });
    });
  });
});
