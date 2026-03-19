import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Auto-discover all check modules in this directory (excluding index.js).
 * Then discover rigscore-check-* plugins from node_modules.
 */
export async function loadChecks(options = {}) {
  const files = await fs.promises.readdir(__dirname);
  const checkFiles = files.filter(
    (f) => f.endsWith('.js') && f !== 'index.js',
  );

  const checks = [];
  for (const file of checkFiles) {
    const mod = await import(path.join(__dirname, file));
    checks.push(mod.default);
  }

  // Discover plugins from node_modules
  const plugins = await discoverPlugins(options.cwd);
  checks.push(...plugins);

  return checks;
}

/**
 * Scan node_modules for rigscore-check-* packages.
 * Each plugin must export { id, name, category, run(context) }.
 */
export async function discoverPlugins(cwd) {
  const plugins = [];
  const searchDirs = [
    cwd ? path.join(cwd, 'node_modules') : null,
    // Also check where rigscore itself is installed
    path.resolve(__dirname, '..', '..', 'node_modules'),
  ].filter(Boolean);

  for (const nodeModules of searchDirs) {
    let entries;
    try {
      entries = await fs.promises.readdir(nodeModules, { withFileTypes: true });
    } catch {
      continue;
    }

    const pluginDirs = entries.filter(
      (e) => e.isDirectory() && e.name.startsWith('rigscore-check-'),
    );

    // Also check scoped packages (@org/rigscore-check-*)
    const scopedDirs = entries.filter(
      (e) => e.isDirectory() && e.name.startsWith('@'),
    );
    for (const scope of scopedDirs) {
      try {
        const scopeEntries = await fs.promises.readdir(
          path.join(nodeModules, scope.name),
          { withFileTypes: true },
        );
        for (const entry of scopeEntries) {
          if (entry.isDirectory() && entry.name.startsWith('rigscore-check-')) {
            pluginDirs.push({
              name: `${scope.name}/${entry.name}`,
              isDirectory: () => true,
            });
          }
        }
      } catch {
        continue;
      }
    }

    for (const dir of pluginDirs) {
      try {
        const pluginPath = path.join(nodeModules, dir.name);
        const mod = await import(pluginPath);
        const plugin = mod.default || mod;

        if (!validatePlugin(plugin, dir.name)) continue;
        plugins.push(plugin);
      } catch (err) {
        process.stderr.write(`rigscore: failed to load plugin "${dir.name}": ${err.message}\n`);
      }
    }
  }

  return plugins;
}

/**
 * Validate that a plugin has the required shape.
 */
function validatePlugin(plugin, name) {
  if (!plugin || typeof plugin !== 'object') {
    process.stderr.write(`rigscore: plugin "${name}" does not export a valid object\n`);
    return false;
  }
  if (!plugin.id || typeof plugin.id !== 'string') {
    process.stderr.write(`rigscore: plugin "${name}" missing required "id" field\n`);
    return false;
  }
  if (!plugin.name || typeof plugin.name !== 'string') {
    process.stderr.write(`rigscore: plugin "${name}" missing required "name" field\n`);
    return false;
  }
  if (!plugin.category || typeof plugin.category !== 'string') {
    process.stderr.write(`rigscore: plugin "${name}" missing required "category" field\n`);
    return false;
  }
  if (typeof plugin.run !== 'function') {
    process.stderr.write(`rigscore: plugin "${name}" missing required "run" function\n`);
    return false;
  }
  return true;
}
