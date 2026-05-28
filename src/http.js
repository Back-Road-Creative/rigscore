import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { createRequire } from 'node:module';

// A5: 5s default network timeout (was 10s). Overridable per-call via the
// `timeout` argument; scanner passes config.limits.networkTimeoutMs when set.
const DEFAULT_TIMEOUT = 5_000;

// Response body cap for fetchBody. A misbehaving or malicious host could
// stream gigabytes into us; without a cap, fetchBody would happily
// concatenate the whole thing into memory. 10MB is well above any
// real-world site-security HTML or registry JSON we scan. Exported so
// mcp-registry.js (which uses globalThis.fetch, not the http.js helpers)
// can share the same ceiling.
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

// Read version from package.json once at module load so the User-Agent
// advertised to external hosts matches the installed release.
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
export const USER_AGENT = `rigscore/${pkg.version} (+https://github.com/Back-Road-Creative/rigscore)`;

/**
 * Fetch HTTP/HTTPS response headers for a URL.
 * @returns {Promise<{statusCode: number, headers: Object}|null>}
 */
export async function fetchHeaders(url, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https://') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': USER_AGENT } }, (res) => {
      res.resume(); // drain
      resolve({ statusCode: res.statusCode, headers: res.headers });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Fetch the full body of a URL as a string, capped at MAX_RESPONSE_BYTES.
 * Over-cap responses are aborted mid-stream and resolve to null (treated
 * by callers as a fetch failure, same as a timeout).
 * @returns {Promise<string|null>}
 */
export async function fetchBody(url, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https://') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': USER_AGENT } }, (res) => {
      // Honour Content-Length as a cheap upfront check; falls through to
      // the streaming cap if the server omits or lies about the header.
      const declared = parseInt(res.headers['content-length'], 10);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      const chunks = [];
      let bytesRead = 0;
      res.on('data', (chunk) => {
        bytesRead += chunk.length;
        if (bytesRead > MAX_RESPONSE_BYTES) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Probe a URL and return its HTTP status code.
 * @returns {Promise<number|null>}
 */
export async function probeStatus(url, timeout = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https://') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': USER_AGENT } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Check TLS certificate expiry for a hostname.
 * @returns {Promise<{daysUntilExpiry: number, validTo: string}|null>}
 */
export async function checkCertExpiry(hostname, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (!cert || !cert.valid_to) {
        resolve(null);
        return;
      }
      const expiry = new Date(cert.valid_to);
      const now = new Date();
      const daysUntilExpiry = Math.floor((expiry - now) / (1000 * 60 * 60 * 24));
      resolve({ daysUntilExpiry, validTo: cert.valid_to });
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}
