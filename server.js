/**
 * Node.js local server for Disk Cleaner UI + auto scan/apply APIs (no external deps).
 * macOS-focused; HOME-scoped; safe defaults; Trash by default.
 *
 * Endpoints:
 * - GET  /api/ping                          -> { ok: true }
 * - GET  /api/scan?minSize=bytes&olderThan=days&include=a,b&exclude=x,y&downloads=1
 *        returns report JSON: { generatedAt, home, totals, categories, items[] }
 * - POST /api/apply?dryRun=1&mode=trash|delete
 *        body: plan JSON { items:[ { path, category } ] }
 *        returns: { ok: true, summary: { count, bytes }, details: [...] }
 *
 * Static UI:
 * - Serves ./index.html, ./styles.css, ./script.js and other static files in cwd.
 *
 * Run:
 *   node server.js
 * Then open:
 *   http://localhost:8765/index.html  (UI will auto-detect backend and auto-scan)
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = Number(process.env.PORT || 8765);
const HOME = os.homedir();

// Static root + scan cache (security/perf)
const STATIC_ROOT = process.cwd();
const STATIC_ROOT_RESOLVED = path.resolve(STATIC_ROOT);
const SCAN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const scanCache = new Map();

// Safe defaults (match --easy)
const DEFAULT_MIN_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_OLDER_DAYS = 30;

// Categories
const CATEGORIES = ['user-caches', 'browsers', 'dev', 'pkg', 'downloads', 'docker', 'deep'];

// Deny-list: Photos, Mail, iCloud Documents, Desktop, Documents
function isDenyListed(p) {
  const pics = path.join(HOME, 'Pictures');
  const mail = path.join(HOME, 'Library', 'Mail');
  const icloudDocs = path.join(HOME, 'Library', 'Mobile Documents');
  const desktop = path.join(HOME, 'Desktop');
  const documents = path.join(HOME, 'Documents');

  const normalized = path.resolve(p);
  if (normalized.startsWith(path.resolve(pics))) return true;
  if (normalized.match(/\.photoslibrary[\/\\]/)) return true;
  if (normalized.startsWith(path.resolve(mail))) return true;
  if (normalized.startsWith(path.resolve(icloudDocs))) return true;
  if (normalized.startsWith(path.resolve(desktop))) return true;
  if (normalized.startsWith(path.resolve(documents))) return true;
  return false;
}

function ensureHomeScoped(p) {
  const normalized = path.resolve(p);
  return normalized.startsWith(path.resolve(HOME) + path.sep);
}

function humanize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const fixed = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${fixed} ${units[i]}`;
}

function nowIso() {
  return new Date().toISOString();
}

function parseQuery(reqUrl) {
  const q = url.parse(reqUrl, true).query || {};
  const out = {};
  out.minSize = isFinite(Number(q.minSize)) ? Number(q.minSize) : undefined;
  out.olderThan = isFinite(Number(q.olderThan)) ? Number(q.olderThan) : undefined;
  out.include = typeof q.include === 'string' && q.include.trim() ? q.include.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  out.exclude = typeof q.exclude === 'string' && q.exclude.trim() ? q.exclude.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  out.downloads = q.downloads === '1' || q.downloads === 'true';
  out.dryRun = q.dryRun === '1' || q.dryRun === 'true';
  out.mode = q.mode === 'delete' ? 'delete' : 'trash';
  return out;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

// Simple static file server (serve from current working directory)
async function serveStatic(req, res) {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || '/');
  if (pathname === '/') pathname = '/index.html';

  // Resolve within static root and block traversal/symlinks
  const fp = path.join(STATIC_ROOT, pathname);
  const resolved = path.resolve(fp);

  // Hard scope: must stay under STATIC_ROOT
  if (!resolved.startsWith(STATIC_ROOT_RESOLVED + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  try {
    // Disallow serving symlinks to avoid sneaking outside
    const lst = await fsp.lstat(resolved);
    if (lst.isSymbolicLink()) {
      return sendText(res, 403, 'Forbidden');
    }

    const st = await fsp.stat(resolved);
    if (st.isDirectory()) {
      return sendText(res, 403, 'Forbidden');
    }
    const data = await fsp.readFile(resolved);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(resolved),
      'Cache-Control': 'no-store'
    });
    res.end(data);
  } catch (e) {
    sendText(res, 404, 'Not found');
  }
}
 
// Utility: list immediate subdirectories (best-effort)
async function listDirs(dir) {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents.filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// Recursively walk a directory collecting files matching filters
async function walkCollect(baseDir, opts, pushItem, reason, category) {
  // opts: { minBytes, olderDays }
  // Avoid massive full-home scans: only scan known dirs passed to this function
  const stack = [baseDir];

  while (stack.length) {
    const current = stack.pop();
    let ents;
    try {
      ents = await fsp.readdir(current, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of ents) {
      const full = path.join(current, ent.name);
      // scope and deny-list
      if (!ensureHomeScoped(full) || isDenyListed(full)) continue;
      try {
        const st = await fsp.lstat(full);
        if (st.isSymbolicLink()) continue; // skip symlinks to avoid cycles
        if (st.isDirectory()) {
          // Avoid descending into massive dirs under Desktop/Documents etc due to deny-list above
          stack.push(full);
        } else if (st.isFile()) {
          const bytes = Number(st.size) || 0;
          if (opts.minBytes && bytes < opts.minBytes) continue;
          const mtimeMs = Number(st.mtimeMs) || 0;
          if (opts.olderDays > 0) {
            const ageMs = Date.now() - mtimeMs;
            if (ageMs < opts.olderDays * 86400 * 1000) continue;
          }
          pushItem({
            path: full,
            bytes,
            mtime: Math.floor(mtimeMs / 1000),
            category,
            reason,
            trashable: true
          });
        }
      } catch {
        // ignore per-file errors
      }
    }
  }
}

async function scanHandler(req, res) {
  const q = parseQuery(req.url);
  const minBytes = q.minSize ?? DEFAULT_MIN_BYTES;
  const olderDays = q.olderThan ?? DEFAULT_OLDER_DAYS;

  // Determine categories
  let cats = ['user-caches', 'browsers', 'dev', 'pkg'];
  if (q.downloads) cats.push('downloads');
  if (Array.isArray(q.include) && q.include.length) cats = q.include;
  if (Array.isArray(q.exclude) && q.exclude.length) {
    cats = cats.filter(c => !q.exclude.includes(c));
  }

  // Simple in-memory cache (TTL) to avoid repeated heavy scans
  const cacheKey = JSON.stringify({
    minBytes,
    olderDays,
    cats: [...cats].sort(),
    downloads: !!q.downloads
  });
  const cached = scanCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SCAN_CACHE_TTL_MS) {
    return sendJson(res, 200, cached.body);
  }

  const items = [];
  const pushItem = (it) => items.push(it);

  const options = { minBytes, olderDays };

  try {
    if (cats.includes('user-caches')) {
      const base = path.join(HOME, 'Library', 'Caches');
      if (fs.existsSync(base)) await walkCollect(base, options, pushItem, 'User Library cache', 'user-caches');
    }
    if (cats.includes('browsers')) {
      const bdirs = [
        path.join(HOME, 'Library', 'Caches', 'com.apple.Safari'),
        path.join(HOME, 'Library', 'Caches', 'Google', 'Chrome'),
        path.join(HOME, 'Library', 'Caches', 'Microsoft Edge'),
        path.join(HOME, 'Library', 'Caches', 'Firefox', 'Profiles')
      ];
      for (const d of bdirs) if (fs.existsSync(d)) await walkCollect(d, options, pushItem, 'Browser cache', 'browsers');
    }
    if (cats.includes('dev')) {
      const ddirs = [
        path.join(HOME, 'Library', 'Developer', 'Xcode', 'DerivedData'),
        path.join(HOME, 'Library', 'Developer', 'Xcode', 'iOS DeviceSupport'),
        path.join(HOME, 'Library', 'Developer', 'CoreSimulator', 'Caches'),
      ];
      for (const d of ddirs) if (fs.existsSync(d)) await walkCollect(d, options, pushItem, 'Developer cache', 'dev');
    }
    if (cats.includes('pkg')) {
      // Homebrew cache
      try {
        const which = await fsp.access('/usr/local/bin/brew').then(() => true).catch(() => false);
        const which2 = await fsp.access('/opt/homebrew/bin/brew').then(() => true).catch(() => false);
        const brewPath = which ? '/usr/local/bin/brew' : (which2 ? '/opt/homebrew/bin/brew' : null);
        if (brewPath) {
          const { execFileSync } = require('child_process');
          try {
            const bcache = execFileSync(brewPath, ['--cache'], { encoding: 'utf8' }).trim();
            if (bcache && fs.existsSync(bcache)) await walkCollect(bcache, options, pushItem, 'Homebrew cache', 'pkg');
          } catch {}
        }
      } catch {}
      const pdirs = [
        path.join(HOME, '.npm', '_cacache'),
        path.join(HOME, 'Library', 'Caches', 'npm'),
        path.join(HOME, 'Library', 'Caches', 'Yarn'),
        path.join(HOME, 'Library', 'pnpm', 'store'),
        path.join(HOME, 'Library', 'Caches', 'pnpm'),
        path.join(HOME, '.cache', 'pip'),
        path.join(HOME, 'Library', 'Caches', 'pip'),
        path.join(HOME, '.cache', 'pipx'),
      ];
      for (const d of pdirs) if (fs.existsSync(d)) await walkCollect(d, options, pushItem, 'Package manager cache', 'pkg');
    }
    if (cats.includes('downloads')) {
      const d = path.join(HOME, 'Downloads');
      if (fs.existsSync(d)) await walkCollect(d, options, pushItem, 'Downloads item', 'downloads');
    }

    // Deep scan: curated additional heavy areas under ~/Library (safe scope)
    if (cats.includes('deep')) {
      // 1) App container caches: ~/Library/Containers/*/Data/Library/Caches
      const containers = path.join(HOME, 'Library', 'Containers');
      if (fs.existsSync(containers)) {
        const apps = await listDirs(containers);
        for (const appDir of apps) {
          const cachePath = path.join(appDir, 'Data', 'Library', 'Caches');
          if (fs.existsSync(cachePath)) {
            await walkCollect(cachePath, options, pushItem, 'App container cache', 'deep');
          }
        }
      }

      // 2) Simulator device caches: ~/Library/Developer/CoreSimulator/Devices/*/data/Library/Caches
      const devicesRoot = path.join(HOME, 'Library', 'Developer', 'CoreSimulator', 'Devices');
      if (fs.existsSync(devicesRoot)) {
        const devices = await listDirs(devicesRoot);
        for (const devDir of devices) {
          const devCache = path.join(devDir, 'data', 'Library', 'Caches');
          if (fs.existsSync(devCache)) {
            await walkCollect(devCache, options, pushItem, 'Simulator device cache', 'deep');
          }
        }
      }

      // 3) Xcode Archives (often large): ~/Library/Developer/Xcode/Archives
      const archives = path.join(HOME, 'Library', 'Developer', 'Xcode', 'Archives');
      if (fs.existsSync(archives)) {
        await walkCollect(archives, options, pushItem, 'Xcode archive content', 'deep');
      }

      // 4) Logs (filter by minBytes): ~/Library/Logs
      const logsDir = path.join(HOME, 'Library', 'Logs');
      if (fs.existsSync(logsDir)) {
        await walkCollect(logsDir, options, pushItem, 'Logs', 'deep');
      }
    }
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e) });
  }

  const totals = items.reduce((acc, it) => {
    acc.count += 1;
    acc.bytes += Number(it.bytes) || 0;
    return acc;
  }, { count: 0, bytes: 0 });

  const body = {
    generatedAt: nowIso(),
    home: HOME,
    totals,
    categories: cats,
    items
  };

  // Store in cache and respond
  scanCache.set(cacheKey, { ts: Date.now(), body });
  sendJson(res, 200, body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const buf = Buffer.concat(chunks);
  const txt = buf.toString('utf8');
  if (!txt.trim()) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

function ensureTrashDir() {
  const t = path.join(HOME, '.Trash');
  try {
    if (!fs.existsSync(t)) fs.mkdirSync(t, { recursive: true });
    return t;
  } catch {
    return null;
  }
}

function safeTrashMove(p) {
  const trashDir = ensureTrashDir();
  if (!trashDir) throw new Error('Cannot access ~/.Trash');
  const name = path.basename(p);
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  let dest = path.join(trashDir, name);
  if (fs.existsSync(dest)) dest = path.join(trashDir, `${name}-${ts}`);
  fs.renameSync(p, dest);
  return dest;
}

async function applyHandler(req, res) {
  const q = parseQuery(req.url);
  const dryRun = q.dryRun;
  const mode = q.mode; // 'trash' or 'delete'

  const plan = await readJsonBody(req);
  if (!plan || !Array.isArray(plan.items)) {
    return sendJson(res, 400, { ok: false, error: 'Invalid plan JSON; expected { items: [ { path, category } ] }' });
  }

  let totalBytes = 0;
  let count = 0;
  const details = [];

  for (const it of plan.items) {
    const p = String(it.path || '');
    if (!p || !fs.existsSync(p)) {
      details.push({ path: p, status: 'missing' });
      continue;
    }
    if (!ensureHomeScoped(p)) {
      details.push({ path: p, status: 'skipped', reason: 'outside_home' });
      continue;
    }
    if (isDenyListed(p)) {
      details.push({ path: p, status: 'skipped', reason: 'deny_listed' });
      continue;
    }
    let st = null;
    try { st = fs.statSync(p); } catch {}
    const bytes = st ? Number(st.size) || 0 : 0;

    if (dryRun) {
      details.push({ path: p, status: 'dry', action: (mode === 'delete' ? 'delete' : 'trash'), bytes });
      totalBytes += bytes; count++;
      continue;
    }

    try {
      if (mode === 'delete') {
        // Be careful: rm recursive if directory
        if (st && st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.rmSync(p, { force: true });
        details.push({ path: p, status: 'deleted', bytes });
      } else {
        const dest = safeTrashMove(p);
        details.push({ path: p, status: 'trashed', dest, bytes });
      }
      totalBytes += bytes; count++;
    } catch (e) {
      details.push({ path: p, status: 'error', error: String(e) });
    }
  }

  const responseBody = {
    ok: true,
    summary: { count, bytes: totalBytes, human: humanize(totalBytes), dryRun, mode },
    details
  };

  // Invalidate scan cache after apply to avoid stale results
  try { scanCache.clear(); } catch {}

  sendJson(res, 200, responseBody);
}

// Router
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname || '/';

  // CORS for convenience (local usage)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname === '/api/ping') {
    return sendJson(res, 200, { ok: true, ts: nowIso() });
  }
  if (pathname === '/api/scan' && req.method === 'GET') {
    return scanHandler(req, res);
  }
  if (pathname === '/api/apply' && req.method === 'POST') {
    return applyHandler(req, res);
  }
  // Static
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log(`[server] Open index.html in a browser; the UI will auto-detect the backend and auto-scan.`);
});