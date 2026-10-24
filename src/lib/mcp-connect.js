import { spawn } from 'node:child_process';

/**
 * Opt-in launch of a local stdio MCP server to read its live tool list.
 *
 * This is the ONLY module in rigscore that starts a server process. It is
 * imported by the `mcp-hash` / `mcp-pin` / `mcp-verify` subcommands when the
 * operator passes `--connect`, and by nothing on the scan path (a test pins
 * that). It holds no MCP configuration knowledge: the caller resolves a launch
 * plan, shows the operator the exact argv, obtains consent for that run, and
 * only then calls `fetchToolList`.
 *
 * Containment: the child gets the project directory as cwd, a minimal
 * environment (the operator's own environment is NOT forwarded, so secrets in
 * it never reach a repo-chosen binary) plus the env literals the config
 * declares, and is killed as soon as the list is read or the timeout expires.
 */

export const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 20;
const PROTOCOL_VERSION = '2025-03-26';

// Variables a typical Node/Python/binary server needs to start; nothing else is inherited.
const INHERITED_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT',
];

/** Environment for the child: minimal inherited set + the config's own string literals. */
export function buildChildEnv(declaredEnv, base = process.env) {
  const env = {};
  for (const key of INHERITED_ENV_KEYS) {
    if (typeof base[key] === 'string') env[key] = base[key];
  }
  if (declaredEnv && typeof declaredEnv === 'object') {
    for (const [k, v] of Object.entries(declaredEnv)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

class ConnectError extends Error {}

/** SIGKILL the child, and on POSIX its whole process group (it was spawned as a group leader). */
function killTree(child) {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* group already gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Launch `plan.command plan.args` (no shell), run the MCP handshake, page through
 * the server's tool list and return `{ result: { tools } }` — the shape
 * `hashTools` canonicalizes. Rejects with an Error on timeout, early exit or a
 * malformed reply. The child is always killed before this settles.
 *
 * @param {{command: string, args: string[], cwd: string, env: Record<string,string>}} plan
 * @param {{timeoutMs?: number}} [opts]
 */
export function fetchToolList(plan, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        // Own process group on POSIX so a wrapper (npx, a shell script) and the
        // real server it starts can be killed together.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      reject(new ConnectError(`could not start server: ${err.message}`));
      return;
    }

    const tools = [];
    let settled = false;
    let buffer = '';
    let received = 0;
    let nextId = 1;
    let listId = null;
    let pages = 0;
    let timer;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.destroy(); } catch { /* already closed */ }
      killTree(child);
      if (err) reject(err); else resolve(value);
    };

    const send = (message) => {
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
      } catch (err) {
        finish(new ConnectError(`could not write to server: ${err.message}`));
      }
    };

    const requestPage = (cursor) => {
      pages += 1;
      listId = ++nextId;
      send({ id: listId, method: 'tools/list', params: cursor ? { cursor } : {} });
    };

    const onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.id === 1) {
        if (msg.error) {
          finish(new ConnectError(`server rejected initialize: ${msg.error.message || 'error'}`));
          return;
        }
        send({ method: 'notifications/initialized' });
        requestPage();
      } else if (msg.id === listId) {
        if (msg.error) {
          finish(new ConnectError(`server rejected the tool list request: ${msg.error.message || 'error'}`));
          return;
        }
        const page = msg.result && Array.isArray(msg.result.tools) ? msg.result.tools : null;
        if (!page) {
          finish(new ConnectError('server returned a tool list reply without a tools array'));
          return;
        }
        tools.push(...page);
        const cursor = msg.result.nextCursor;
        if (typeof cursor === 'string' && cursor) {
          if (pages >= MAX_PAGES) {
            finish(new ConnectError(`server returned more than ${MAX_PAGES} pages of tools`));
            return;
          }
          requestPage(cursor);
        } else {
          finish(null, { result: { tools } });
        }
      }
    };

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      received += Buffer.byteLength(chunk);
      if (received > MAX_STDOUT_BYTES) {
        finish(new ConnectError('server output exceeded the size limit'));
        return;
      }
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; } // non-JSON chatter on stdout
        onMessage(parsed);
        if (settled) return;
      }
    });
    child.stdin.on('error', () => { /* surfaced via exit/timeout */ });
    child.on('error', (err) => finish(new ConnectError(`could not start server: ${err.message}`)));
    // 'close' fires after stdout has ended, so a reply written just before exit is parsed first.
    child.on('close', (code, signal) => {
      finish(new ConnectError(`server exited before answering (${signal || `code ${code}`})`));
    });
    timer = setTimeout(
      () => finish(new ConnectError(`server did not respond within ${timeoutMs} ms (timed out)`)),
      timeoutMs,
    );

    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'rigscore', version: '0' },
      },
    });
  });
}
