#!/opt/homebrew/bin/node
/* mdview: capability-link markdown viewer
   - mdview share <absPath> [--ttl-hours 24]
   - mdview revoke <token>
   - mdview prune
   - mdview serve [--port 4323]

   Registry: $MDVIEW_REG_DIR/registry.json (defaults to ~/.openclaw/mdview/registry.json)
*/

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const REG_DIR = process.env.MDVIEW_REG_DIR || path.join(os.homedir(), '.openclaw', 'mdview');
const REG_PATH = path.join(REG_DIR, 'registry.json');
const REG_LOCK_PATH = path.join(REG_DIR, 'registry.lock');
const DEFAULT_BASEPATH = (process.env.MDVIEW_BASEPATH || '/mdview').replace(/\/$/, '');

function nowMs() { return Date.now(); }

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureRegistryDir() {
  await fsp.mkdir(REG_DIR, { recursive: true });
}

async function acquireRegistryLock() {
  await ensureRegistryDir();
  const maxWaitMs = 5000;
  const staleLockMs = 30000;
  const startedAt = nowMs();

  while ((nowMs() - startedAt) < maxWaitMs) {
    let handle;
    try {
      handle = await fsp.open(REG_LOCK_PATH, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${nowMs()}\n`);
      return async () => {
        try {
          await handle.close();
        } finally {
          await fsp.unlink(REG_LOCK_PATH).catch(() => {});
        }
      };
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      if (err.code !== 'EEXIST') throw err;

      try {
        const st = await fsp.stat(REG_LOCK_PATH);
        if ((nowMs() - st.mtimeMs) > staleLockMs) {
          await fsp.unlink(REG_LOCK_PATH).catch(() => {});
          continue;
        }
      } catch (_statErr) {}

      await sleep(50);
    }
  }

  throw new Error('timed out waiting for registry lock');
}

async function withRegistryLock(fn) {
  const release = await acquireRegistryLock();
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function loadRegistry() {
  await ensureRegistryDir();
  try {
    const raw = await fsp.readFile(REG_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') throw new Error('bad registry');
    if (!j.version) j.version = 1;
    if (!j.shares) j.shares = {};
    return j;
  } catch (e) {
    return { version: 1, shares: {} };
  }
}

async function saveRegistry(reg) {
  await ensureRegistryDir();
  const tmp = REG_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, REG_PATH);
}

function parseArgs(argv) {
  // very small arg parser
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

async function cmdShare(filePath, ttlHours) {
  if (!path.isAbsolute(filePath)) {
    throw new Error('share requires an absolute path');
  }
  const real = await fsp.realpath(filePath);
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new Error('path is not a file');

  const token = b64url(crypto.randomBytes(32)); // ~256-bit
  const createdAtMs = nowMs();
  const expiresAtMs = createdAtMs + ttlHours * 3600 * 1000;

  await withRegistryLock(async () => {
    const reg = await loadRegistry();
    reg.shares[token] = {
      path: real,
      createdAtMs,
      expiresAtMs,
      size: st.size
    };
    await saveRegistry(reg);
  });

  const host = await resolvePublicHost();
  // With Tailscale Serve path proxy, the public URL is typically HTTPS without an explicit port.
  const url = `https://${host}${DEFAULT_BASEPATH}/md/${token}`;
  console.log(url);
}

async function cmdRevoke(token) {
  const found = await withRegistryLock(async () => {
    const reg = await loadRegistry();
    if (!reg.shares[token]) return false;
    delete reg.shares[token];
    await saveRegistry(reg);
    return true;
  });
  console.log(found ? 'revoked' : 'not found');
}

async function cmdPrune() {
  const removed = await withRegistryLock(async () => {
    const reg = await loadRegistry();
    const t = nowMs();
    let removedCount = 0;
    for (const [tok, rec] of Object.entries(reg.shares)) {
      if (!rec || typeof rec.expiresAtMs !== 'number' || rec.expiresAtMs <= t) {
        delete reg.shares[tok];
        removedCount++;
      }
    }
    await saveRegistry(reg);
    return removedCount;
  });
  console.log(`pruned ${removed}`);
}

function resolveTailscaleBin() {
  if (process.env.TAILSCALE_BIN) return process.env.TAILSCALE_BIN;
  const candidates = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
    'tailscale'
  ];
  return candidates.find(candidate => candidate === 'tailscale' || fs.existsSync(candidate));
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function resolvePublicHost() {
  if (process.env.MDVIEW_HOST) return process.env.MDVIEW_HOST;

  try {
    const stdout = await execFileText(resolveTailscaleBin(), ['status', '--json'], { timeout: 3000 });
    const status = JSON.parse(stdout);
    const dnsName = status?.Self?.DNSName || '';
    if (dnsName) return dnsName.replace(/\.$/, '');
  } catch (_err) {}

  throw new Error('MDVIEW_HOST is not set and Tailscale host auto-detection failed');
}

async function cmdServe(port) {
  const express = require('express');
  const MarkdownIt = require('markdown-it');

  const app = express();

  // Strip raw HTML: html=false
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true
  });

  // Hardening: bind access to Tailscale identity.
  // Preferred: trust Tailscale Serve forwarded headers (when present).
  // Fallback: tailscale whois on client IP (less reliable under proxies).
  const ALLOW_LOGIN = process.env.MDVIEW_ALLOW_LOGIN || '';
  const ALLOW_DNSNAMES = (process.env.MDVIEW_ALLOW_DNSNAMES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const whoisCache = new Map(); // ip -> {ts, data}
  const WHOIS_CACHE_MS = 5 * 60 * 1000;

  function normaliseIp(ip) {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }

  function getRemoteAddress(req) {
    return normaliseIp(req.socket?.remoteAddress || '');
  }

  function isLoopbackAddress(ip) {
    return ip === '127.0.0.1' || ip === '::1';
  }

  function shouldTrustProxyHeaders(req) {
    return isLoopbackAddress(getRemoteAddress(req));
  }

  function getClientIp(req) {
    if (!shouldTrustProxyHeaders(req)) {
      return getRemoteAddress(req);
    }

    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      return xff.split(',')[0].trim();
    }
    return getRemoteAddress(req);
  }

  function tailscaleWhois(ip) {
    return new Promise((resolve, reject) => {
      execFile(resolveTailscaleBin(), ['whois', '--json', ip], { timeout: 3000 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  function checkIdentity(login, dns, res) {
    if (ALLOW_LOGIN && login !== ALLOW_LOGIN) {
      res.status(403).type('text/plain').send('Forbidden');
      return false;
    }
    if (ALLOW_DNSNAMES.length && !ALLOW_DNSNAMES.includes(dns)) {
      res.status(403).type('text/plain').send('Forbidden');
      return false;
    }
    return true;
  }

  async function enforceIdentity(req, res) {
    if (!ALLOW_LOGIN && ALLOW_DNSNAMES.length === 0) return true; // disabled

    // Preferred: Tailscale Serve forwarded header (present in our logs).
    const hdrLogin = (req.headers['tailscale-user-login'] || '').toString();
    const hdrDns = (req.headers['tailscale-dnsname'] || '').toString();
    if (hdrLogin && shouldTrustProxyHeaders(req)) {
      return checkIdentity(hdrLogin, hdrDns, res);
    }

    // Fallback: whois by client IP.
    const ip = getClientIp(req);
    if (!ip) {
      res.status(403).type('text/plain').send('Forbidden');
      return false;
    }

    const cached = whoisCache.get(ip);
    const t = nowMs();
    if (cached && (t - cached.ts) < WHOIS_CACHE_MS) {
      const login = cached.data?.UserProfile?.LoginName || '';
      const dns = cached.data?.Node?.DNSName || '';
      return checkIdentity(login, dns, res);
    }

    try {
      const data = await tailscaleWhois(ip);
      whoisCache.set(ip, { ts: t, data });
      const login = data?.UserProfile?.LoginName || '';
      const dns = data?.Node?.DNSName || '';
      return checkIdentity(login, dns, res);
    } catch (_e) {
      res.status(403).type('text/plain').send('Forbidden');
      return false;
    }
  }

  function page(title, bodyHtml) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 20px; }
  pre { overflow: auto; padding: 12px; border-radius: 8px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  h1,h2,h3 { margin-top: 1.2em; }
  a { word-break: break-word; }
  .meta { opacity: 0.7; font-size: 0.9em; margin-bottom: 18px; }
</style>
</head>
<body>
  <div class="wrap">
    ${bodyHtml}
  </div>
</body>
</html>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function resolveToken(token) {
    return withRegistryLock(async () => {
      const reg = await loadRegistry();
      const rec = reg.shares[token];
      if (!rec) return { ok: false, status: 404, msg: 'Not found' };
      if (typeof rec.expiresAtMs !== 'number' || rec.expiresAtMs <= nowMs()) {
        // auto-prune this token
        delete reg.shares[token];
        await saveRegistry(reg);
        return { ok: false, status: 404, msg: 'Expired' };
      }
      return { ok: true, rec };
    });
  }

  const ACCESS_LOG = process.env.MDVIEW_ACCESS_LOG || '/tmp/mdview.access.log';

  function logAccess(req, extra) {
    try {
      const ip = getClientIp(req);
      const rec = {
        t: new Date().toISOString(),
        path: req.path,
        ip,
        remoteAddress: req.socket?.remoteAddress || null,
        headers: {
          'x-forwarded-for': req.headers['x-forwarded-for'] || null,
          'x-real-ip': req.headers['x-real-ip'] || null,
          'forwarded': req.headers['forwarded'] || null,
          'user-agent': req.headers['user-agent'] || null,
          'host': req.headers['host'] || null,
          // capture any tailscale-specific headers if present
          'tailscale-user-login': req.headers['tailscale-user-login'] || null,
          'tailscale-user': req.headers['tailscale-user'] || null,
          'tailscale-name': req.headers['tailscale-name'] || null,
          'tailscale-dnsname': req.headers['tailscale-dnsname'] || null,
          'tailscale-client-ip': req.headers['tailscale-client-ip'] || null,
        },
        extra: extra || null,
      };
      fs.appendFileSync(ACCESS_LOG, JSON.stringify(rec) + '\n');
    } catch (_e) {}
  }

  app.get('/health', (req, res) => {
    logAccess(req, { health: true });
    res.type('text/plain').send('ok');
  });

  app.get('/md/:token', async (req, res) => {
    try {
      logAccess(req, { route: 'md' });
      if (!(await enforceIdentity(req, res))) return;

      const { token } = req.params;
      const r = await resolveToken(token);
      if (!r.ok) return res.status(r.status).type('text/plain').send(r.msg);

      const rec = r.rec;
      const content = await fsp.readFile(rec.path, 'utf8');
      const html = md.render(content);
      const title = path.basename(rec.path);
      const meta = `<div class="meta">${escapeHtml(rec.path)}<br/>Expires: ${new Date(rec.expiresAtMs).toLocaleString()}</div>`;
      res.type('text/html').send(page(title, meta + html));
    } catch (e) {
      res.status(500).type('text/plain').send('Internal error');
    }
  });

  app.get('/raw/:token', async (req, res) => {
    try {
      logAccess(req, { route: 'raw' });
      if (!(await enforceIdentity(req, res))) return;

      const { token } = req.params;
      const r = await resolveToken(token);
      if (!r.ok) return res.status(r.status).type('text/plain').send(r.msg);
      const rec = r.rec;
      const content = await fsp.readFile(rec.path, 'utf8');
      res.type('text/plain; charset=utf-8').send(content);
    } catch (e) {
      res.status(500).type('text/plain').send('Internal error');
    }
  });

  const listenHost = process.env.MDVIEW_BIND || '127.0.0.1';
  app.listen(port, listenHost, () => {
    console.log(`mdview listening on http://${listenHost}:${port}`);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { args, flags } = parseArgs(argv.slice(1));

  if (!cmd || ['-h', '--help', 'help'].includes(cmd)) {
    console.log('Usage: mdview <share|revoke|prune|serve> ...');
    process.exit(0);
  }

  if (cmd === 'share') {
    const p = args[0];
    const ttl = Number(flags['ttl-hours'] ?? process.env.MDVIEW_TTL_HOURS ?? 24);
    if (!p) throw new Error('share requires a path');
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('bad ttl-hours');
    await cmdShare(p, ttl);
    return;
  }

  if (cmd === 'revoke') {
    const tok = args[0];
    if (!tok) throw new Error('revoke requires a token');
    await cmdRevoke(tok);
    return;
  }

  if (cmd === 'prune') {
    await cmdPrune();
    return;
  }

  if (cmd === 'serve') {
    const port = Number(flags['port'] ?? process.env.PORT ?? 4323);
    await cmdServe(port);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(1);
});
