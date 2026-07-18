import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolves a plugin package directory to its actual entry FILE. A file: URL
// must point at a file — it gets no package.json "main"/"exports" resolution —
// so importing the directory URL only worked while Vite's resolver happened to
// cover for it. require.resolve does the real package resolution.
const requireFrom = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level cache for self-registered fixes collected during loadChecks().
// null until loadChecks runs at least once — getRegisteredFixes uses that
// to distinguish "no fixers exist" from "loadChecks never ran".
let _registeredFixes = null;

/**
 * Auto-discover all check modules in this directory (excluding index.js).
 * Then discover rigscore-check-* plugins from node_modules.
 * Also collects self-registered fixes from check modules that export a `fixes` array.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] - Project root scanned for rigscore-check-* plugins.
 * @param {string[]} [options.extraCheckDirs] - Extra directories scanned for check
 *   modules, in addition to this one (default: none — behaviour is unchanged).
 *   A caller that needs to register a check module which does NOT live in
 *   src/checks — an out-of-tree module, or a throwaway fixture — passes its
 *   directory here. Writing such a module into src/checks instead mutates a
 *   source directory other readers scan concurrently.
 */
export async function loadChecks(options = {}) {
  // Reset the module-level fixer cache up front, BEFORE any await. Doing it
  // before the first I/O yield means a downstream caller cannot observe a
  // stale-but-populated cache while we're mid-load.
  _registeredFixes = {};

  const checks = [];
  const checkDirs = [__dirname, ...(options.extraCheckDirs || [])];

  for (const dir of checkDirs) {
    const files = await fs.promises.readdir(dir);
    // .sort() is PRECAUTIONARY, not a live-bug fix: `deduplicateFindings` breaks
    // cross-check ties by `results[]` order, which is this readdir's order — and
    // no two checks collide on a findingId today. One line, landmine gone.
    const checkFiles = files
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .sort();

    for (const file of checkFiles) {
      // pathToFileURL, not a bare path: on win32 an absolute path ("C:\...")
      // is not a valid import specifier and ESM rejects it with
      // "Only URLs with a scheme in: file, data ...", which aborted the whole
      // scan on Windows.
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
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
  }

  // Discover plugins from node_modules
  const plugins = await discoverPlugins(options.cwd);
  checks.push(...plugins);

  // Discover local-path plugins declared in the project's `.rigscorerc.json`
  // `plugins: ["./checks/foo.js"]`. Deduped by id against everything already
  // loaded (built-ins + npm plugins) — first registration wins.
  const existingIds = new Set(checks.map((c) => c?.id).filter(Boolean));
  const localPlugins = await discoverLocalPlugins(options.cwd, options.plugins);
  for (const p of localPlugins) {
    if (existingIds.has(p.id)) continue;
    existingIds.add(p.id);
    checks.push(p);
  }

  return checks;
}

/** Read the `plugins` array from the project's `.rigscorerc.json` (best-effort). */
async function readConfiguredPluginPaths(cwd) {
  if (!cwd) return [];
  try {
    const raw = await fs.promises.readFile(path.join(cwd, '.rigscorerc.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.plugins)
      ? parsed.plugins.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Load local-path check plugins (`plugins: ["./checks/foo.js"]`). Each entry is a
 * LOCAL path to an ES module exporting a check ({id,name,category,run}), resolved
 * relative to the project root. URLs and npm specifiers are rejected — remote and
 * npm plugins have their own (SHA-verified / registry) discovery paths; this one
 * is for a check a repo ships in-tree without publishing.
 *
 * @param {string} [cwd] Project root. @param {string[]} [pluginPaths] Explicit
 *   override (else read from `.rigscorerc.json`). @returns {Promise<object[]>}
 */
export async function discoverLocalPlugins(cwd, pluginPaths) {
  const paths = pluginPaths && pluginPaths.length
    ? pluginPaths : await readConfiguredPluginPaths(cwd);
  const plugins = [];
  const seenIds = new Set();
  for (const rel of paths) {
    if (/^https?:\/\//i.test(rel)) {
      process.stderr.write(`rigscore: local plugin "${rel}" ignored — must be a local path, not a URL\n`);
      continue;
    }
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd || process.cwd(), rel);
    try {
      const mod = await import(pathToFileURL(abs).href);
      const plugin = mod.default || mod;
      if (!validatePlugin(plugin, rel)) continue;
      if (seenIds.has(plugin.id)) continue;
      seenIds.add(plugin.id);
      plugins.push(plugin);
    } catch (err) {
      process.stderr.write(`rigscore: failed to load local plugin "${rel}": ${err.message}\n`);
    }
  }
  return plugins;
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

        // Resolve the package entry file, then import it as a file: URL (the
        // win32 constraint from the built-in loader above still applies).
        const entry = requireFrom.resolve(resolved);
        const mod = await import(pathToFileURL(entry).href);
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
