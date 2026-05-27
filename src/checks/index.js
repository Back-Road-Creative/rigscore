import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level cache for self-registered fixes collected during loadChecks().
// null until loadChecks runs at least once — getRegisteredFixes uses that
// to distinguish "no fixers exist" from "loadChecks never ran".
let _registeredFixes = null;

/**
 * Auto-discover all check modules in this directory (excluding index.js).
 * Then discover rigscore-check-* plugins from node_modules.
 * Also collects self-registered fixes from check modules that export a `fixes` array.
 */
export async function loadChecks(options = {}) {
  // Reset the module-level fixer cache up front, BEFORE any await. Doing it
  // before the first I/O yield means a downstream caller cannot observe a
  // stale-but-populated cache while we're mid-load.
  _registeredFixes = {};

  const files = await fs.promises.readdir(__dirname);
  const checkFiles = files.filter(
    (f) => f.endsWith('.js') && f !== 'index.js',
  );

  const checks = [];

  for (const file of checkFiles) {
    const mod = await import(path.join(__dirname, file));
    checks.push(mod.default);

    // Collect self-registered fixes. A fixer must declare EITHER a `match`
    // predicate function OR a non-empty `findingIds` array — the two matching
    // paths supported by src/fixer.js. Requiring `match` alone silently
    // dropped findingIds-only fixers at load time.
    if (Array.isArray(mod.fixes)) {
      for (const fix of mod.fixes) {
        if (!fix.id || typeof fix.apply !== 'function') continue;
        const hasMatch = typeof fix.match === 'function';
        const hasFindingIds = Array.isArray(fix.findingIds) && fix.findingIds.length > 0;
        if (!hasMatch && !hasFindingIds) continue;
        _registeredFixes[fix.id] = fix;
      }
    }
  }

  // Discover plugins from node_modules
  const plugins = await discoverPlugins(options.cwd);
  checks.push(...plugins);

  return checks;
}

/**
 * Return fixes self-registered by check modules during the last loadChecks() call.
 * Keys are fix IDs, values are { id, match, description, apply } objects.
 * Throws if loadChecks() has never run — that condition would otherwise
 * silently return an empty map and make `--fix` look like "no fixes available".
 */
export function getRegisteredFixes() {
  if (_registeredFixes === null) {
    throw new Error('getRegisteredFixes() called before loadChecks() — call loadChecks() first.');
  }
  return _registeredFixes;
}

/**
 * Scan node_modules for rigscore-check-* packages.
 * Each plugin must export { id, name, category, run(context) }.
 */
export async function discoverPlugins(cwd) {
  const plugins = [];
  // Track resolved plugin directories already imported. Without this, a
  // plugin installed in both `cwd/node_modules` and rigscore's own install
  // gets loaded twice and its findings double-count.
  const seenPaths = new Set();
  const seenIds = new Set();
  const rawSearchDirs = [
    cwd ? path.join(cwd, 'node_modules') : null,
    // Also check where rigscore itself is installed
    path.resolve(__dirname, '..', '..', 'node_modules'),
  ].filter(Boolean);
  // Resolved-path dedup of the search roots themselves — when cwd IS the
  // rigscore install dir, both entries point at the same node_modules.
  const seenRoots = new Set();
  const searchDirs = [];
  for (const d of rawSearchDirs) {
    const resolved = path.resolve(d);
    if (seenRoots.has(resolved)) continue;
    seenRoots.add(resolved);
    searchDirs.push(d);
  }

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
        const resolved = path.resolve(pluginPath);
        if (seenPaths.has(resolved)) continue;
        seenPaths.add(resolved);

        const mod = await import(pluginPath);
        const plugin = mod.default || mod;

        if (!validatePlugin(plugin, dir.name)) continue;
        // Belt-and-suspenders: even if two distinct paths export the same
        // plugin id (e.g., symlink farm), only register the first.
        if (seenIds.has(plugin.id)) continue;
        seenIds.add(plugin.id);
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
