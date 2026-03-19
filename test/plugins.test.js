import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { withTmpDir } from './helpers.js';
import { discoverPlugins, loadChecks } from '../src/checks/index.js';

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
});
