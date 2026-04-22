import { calculateCheckScore } from '../scoring.js';
import { NOT_APPLICABLE_SCORE } from '../constants.js';
import { fetchHeaders, fetchBody, probeStatus, checkCertExpiry } from '../http.js';

// Security headers — critical if missing
const CRITICAL_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
];

// Security headers — advisory
const ADVISORY_HEADERS = [
  'referrer-policy',
  'permissions-policy',
];

// Sensitive paths to probe
const EXPOSED_PATHS = [
  '.env', '.env.local', '.env.production', '.env.backup',
  '.git/config', '.git/HEAD',
  '.svn/entries',
  '.htaccess', '.htpasswd',
  'wp-admin/', 'wp-login.php', 'wp-config.php.bak',
  'admin/', 'administrator/',
  'phpmyadmin/', 'adminer.php',
  'backup.zip', 'backup.tar.gz', 'backup.sql', 'db.sql', 'dump.sql',
  'config.php', 'config.yml', 'config.json',
  'composer.json', 'package.json',
  'server-status', 'server-info',
  'robots.txt', 'sitemap.xml',
  'crossdomain.xml', 'clientaccesspolicy.xml',
  '.DS_Store', 'Thumbs.db',
  '.well-known/security.txt',
];

// Paths that are expected to be accessible (not a finding)
const EXPECTED_ACCESSIBLE = new Set([
  'robots.txt', 'sitemap.xml', '.well-known/security.txt',
]);

// Secret patterns in JavaScript source
const JS_SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]{10,}/,
  /sk-(?:proj|svcacct)-[a-zA-Z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /gho_[a-zA-Z0-9]{36}/,
  /sk_live_[a-zA-Z0-9]{24,}/,
  /xoxb-[a-zA-Z0-9-]+/,
  /whsec_[a-zA-Z0-9_-]{24,}/,
];

// Patterns that look like secrets but are harmless (analytics, ads)
const JS_ALLOWLIST_PATTERNS = [
  /^G-[A-Z0-9]+$/,          // Google Analytics 4
  /^UA-\d+-\d+$/,           // Universal Analytics
  /^GTM-[A-Z0-9]+$/,        // Google Tag Manager
  /^ca-pub-\d+$/,           // Google AdSense
  /^AW-\d+$/,               // Google Ads
];

// PII allowlist domains for email detection
const EMAIL_ALLOWLIST = [
  'example.com', 'schema.org', 'w3.org', 'sitemaps.org',
  'xmlns.com', 'purl.org', 'ogp.me', 'rdfs.org',
];

/**
 * Limit concurrency for async operations.
 */
async function mapWithLimit(items, limit, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = fn(item).then((r) => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function checkSecurityHeaders(url) {
  const findings = [];
  const resp = await fetchHeaders(url);
  if (!resp) {
    findings.push({
      findingId: 'site-security/cannot-reach',
      severity: 'warning',
      title: `Cannot reach ${url}`,
      context: { url },
    });
    return findings;
  }

  for (const header of CRITICAL_HEADERS) {
    if (resp.headers[header]) {
      findings.push({ severity: 'pass', title: `Header present: ${header}` });
    } else {
      findings.push({
        findingId: 'site-security/missing-security-header',
        severity: 'critical',
        title: `Missing security header: ${header}`,
        detail: `${url} does not set ${header}`,
        remediation: `Add ${header} to your server/CDN response headers.`,
        context: { url, header },
      });
    }
  }

  for (const header of ADVISORY_HEADERS) {
    if (!resp.headers[header]) {
      findings.push({
        findingId: 'site-security/missing-advisory-header',
        severity: 'warning',
        title: `Missing advisory header: ${header}`,
        detail: `${url} does not set ${header}`,
        context: { url, header },
      });
    }
  }

  // Server fingerprinting
  const poweredBy = resp.headers['x-powered-by'];
  if (poweredBy) {
    findings.push({
      findingId: 'site-security/x-powered-by-disclosed',
      severity: 'warning',
      title: 'Server discloses X-Powered-By',
      detail: `Value: ${poweredBy}`,
      remediation: 'Remove or suppress X-Powered-By header.',
      context: { url, value: poweredBy },
    });
  }

  const server = resp.headers['server'];
  if (server && /\d/.test(server)) {
    findings.push({
      findingId: 'site-security/server-header-version',
      severity: 'warning',
      title: 'Server header discloses version',
      detail: `Value: ${server}`,
      remediation: 'Suppress version numbers from Server header.',
      context: { url, value: server },
    });
  }

  return findings;
}

async function checkExposedPaths(baseUrl) {
  const findings = [];
  const url = baseUrl.replace(/\/$/, '');

  const results = await mapWithLimit(EXPOSED_PATHS, 5, async (p) => {
    const status = await probeStatus(`${url}/${p}`);
    return { path: p, status };
  });

  for (const { path: p, status } of results) {
    if (status === 200 && !EXPECTED_ACCESSIBLE.has(p)) {
      findings.push({
        findingId: 'site-security/exposed-path-accessible',
        severity: 'critical',
        title: `Exposed path accessible: /${p}`,
        detail: `${url}/${p} returned HTTP 200`,
        remediation: `Block access to /${p} via server config or CDN rules.`,
        context: { url, path: p },
      });
    }
  }

  if (findings.length === 0) {
    findings.push({ severity: 'pass', title: 'No sensitive paths exposed' });
  }

  return findings;
}

async function checkPiiAndSecrets(url) {
  const findings = [];
  const body = await fetchBody(url);
  if (!body) return findings;

  // Email detection
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = [...new Set((body.match(emailRegex) || []))];
  const realEmails = emails.filter((e) => !EMAIL_ALLOWLIST.some((d) => e.endsWith(`@${d}`)));
  if (realEmails.length > 0) {
    findings.push({
      findingId: 'site-security/pii-email-leak',
      severity: 'critical',
      title: `PII leak: ${realEmails.length} email(s) found in HTML`,
      detail: `Found: ${realEmails.slice(0, 3).join(', ')}${realEmails.length > 3 ? '...' : ''}`,
      context: { url, count: realEmails.length },
    });
  }

  // Phone detection (US format)
  const phoneRegex = /(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const phones = body.match(phoneRegex) || [];
  if (phones.length > 0) {
    findings.push({
      findingId: 'site-security/pii-phone-leak',
      severity: 'warning',
      title: `PII: ${phones.length} phone number(s) found in HTML`,
      context: { url, count: phones.length },
    });
  }

  // JS secret patterns
  for (const pattern of JS_SECRET_PATTERNS) {
    const match = body.match(pattern);
    if (match) {
      const value = match[0];
      const isAllowlisted = JS_ALLOWLIST_PATTERNS.some((ap) => ap.test(value));
      if (!isAllowlisted) {
        findings.push({
          findingId: 'site-security/secret-in-page-source',
          severity: 'critical',
          title: 'Secret pattern found in page source',
          detail: `Matched: ${value.substring(0, 12)}...`,
          remediation: 'Remove secrets from client-side code. Use server-side environment variables.',
          context: { url },
        });
      }
    }
  }

  // Internal IPs
  const internalIpRegex = /(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}/g;
  const ips = [...new Set((body.match(internalIpRegex) || []))];
  if (ips.length > 0) {
    findings.push({
      findingId: 'site-security/internal-ip-disclosed',
      severity: 'warning',
      title: `Internal IP address(es) found in HTML: ${ips.slice(0, 3).join(', ')}`,
      context: { url, ips: ips.slice(0, 5) },
    });
  }

  // Generator meta tag
  const generatorMatch = body.match(/<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i);
  if (generatorMatch) {
    findings.push({
      findingId: 'site-security/generator-tag-disclosed',
      severity: 'warning',
      title: `Generator tag discloses build tool: ${generatorMatch[1]}`,
      remediation: 'Remove the <meta name="generator"> tag.',
      context: { url, generator: generatorMatch[1] },
    });
  }

  return findings;
}

async function checkSsl(url) {
  const findings = [];
  try {
    const hostname = new URL(url).hostname;
    const cert = await checkCertExpiry(hostname);
    if (!cert) {
      findings.push({
        findingId: 'site-security/ssl-check-failed',
        severity: 'warning',
        title: 'Cannot check SSL certificate',
        detail: `Could not connect to ${hostname}:443`,
        context: { url, hostname },
      });
    } else if (cert.daysUntilExpiry < 0) {
      findings.push({
        findingId: 'site-security/ssl-certificate-expired',
        severity: 'critical',
        title: `SSL certificate expired ${Math.abs(cert.daysUntilExpiry)} day(s) ago`,
        context: { url, daysPastExpiry: Math.abs(cert.daysUntilExpiry) },
      });
    } else if (cert.daysUntilExpiry < 30) {
      findings.push({
        findingId: 'site-security/ssl-certificate-expiring-soon',
        severity: 'warning',
        title: `SSL certificate expires in ${cert.daysUntilExpiry} day(s)`,
        detail: `Expires: ${cert.validTo}`,
        context: { url, daysUntilExpiry: cert.daysUntilExpiry },
      });
    } else {
      findings.push({ severity: 'pass', title: `SSL certificate valid (${cert.daysUntilExpiry} days remaining)` });
    }
  } catch {
    // Non-HTTPS URL or invalid URL — skip
  }
  return findings;
}

export default {
  id: 'site-security',
  enforcementGrade: 'mechanical',
  name: 'Site security',
  category: 'isolation',

  async run(context) {
    if (!context.online) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{ severity: 'skipped', title: 'Site security requires --online flag' }],
      };
    }

    const sites = context.config?.sites || [];
    if (sites.length === 0) {
      return {
        score: NOT_APPLICABLE_SCORE,
        findings: [{ severity: 'info', title: 'No sites configured — add "sites" array to .rigscorerc.json' }],
      };
    }

    const allFindings = [];

    for (const url of sites) {
      allFindings.push(...(await checkSecurityHeaders(url)));
      allFindings.push(...(await checkExposedPaths(url)));
      allFindings.push(...(await checkPiiAndSecrets(url)));
      if (url.startsWith('https')) {
        allFindings.push(...(await checkSsl(url)));
      }
    }

    return {
      score: calculateCheckScore(allFindings),
      findings: allFindings,
      data: {
        sitesScanned: sites.length,
      },
    };
  },
};
