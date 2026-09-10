// 百度网盘全盘扫描（CDP 浏览器桥接）：枚举全部文件(含MD5)与文件夹 → inv.jsonl
// 用法: node scan_md5.js   （在专用工作目录下运行；可中断重跑，自动断点续扫）
// 原理: 复用已登录的调试浏览器会话，在页面内 fetch 官方 api/list 接口（同源自动带 cookie）
const fs = require('fs');
const path = require('path');

const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT_DIR = process.cwd();
const JSONL_PATH = path.join(OUT_DIR, 'inv.jsonl');
const STATE_PATH = path.join(OUT_DIR, 'scan_state.json');
const COOKIES_PATH = path.join(OUT_DIR, 'session_cookies.json');
const PAN_URL = 'https://pan.baidu.com/';
const LAUNCH_BAT = path.join(__dirname, 'launch_edge_debug.bat');
const ROOT_DIR = '/';

let ws = null;
let msgSeq = 0;
let connKey = null;
let restoredForConn = null;
let lastLaunch = 0;
const pending = new Map();

const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtB = (n) => { if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + 'TB'; if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + 'GB'; if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + 'MB'; if (n >= 1024) return (n / 1024).toFixed(1) + 'KB'; return n + 'B'; };

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { s.close(); } catch (e) {} reject(new Error('ws connect timeout')); }, 10000);
    s.onopen = () => { clearTimeout(timer); ws = s; resolve(s); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
    s.onclose = () => { ws = null; };
    s.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.rej(new Error(m.error.message || 'cdp error'));
        else p.res(m.result);
      }
    };
  });
}

function send(method, params = {}, timeoutMs = 120000) {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error('ws not open'));
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp timeout ' + method)); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, timeoutMs = 120000) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).substring(0, 400));
  return r.result ? r.result.value : undefined;
}

async function listTargets() {
  const r = await fetch(CDP_HTTP + '/json/list');
  return await r.json();
}

async function findOrCreatePanTab() {
  let targets = await listTargets();
  let t = targets.find(t => t.type === 'page' && t.url.includes('pan.baidu.com'));
  if (!t) {
    log('no pan tab, creating...');
    await fetch(CDP_HTTP + '/json/new?' + new URLSearchParams({ url: PAN_URL }).toString(), { method: 'PUT' }).catch(() => {});
    await sleep(6000);
    targets = await listTargets();
    t = targets.find(t => t.type === 'page' && t.url.includes('pan.baidu.com'));
  }
  if (!t) throw new Error('pan.baidu.com tab not found');
  return t;
}

// 页面内 helper：逐页拉取目录 JSON 并解析为 {files:[{fs_id,name,size,md5,path}], folders:[{name,path}]}
const HELPER = `
window.__bf = async function(dir) {
  const out = { dir: String(dir), files: [], folders: [], error: null, total: 0 };
  try {
    let pageNum = 1, total = -1, got = 0;
    while (true) {
      const url = 'https://pan.baidu.com/api/list?channel=chunlei&clienttype=0&web=1&app_id=250528&num=100&order=name&desc=0&showempty=0&dir=' + encodeURIComponent(dir) + '&page=' + pageNum;
      const resp = await fetch(url, { credentials: 'include' });
      let j = null;
      try { j = await resp.json(); } catch (e) { out.error = 'BAD_JSON'; return out; }
      if (j.errno === -6 || j.errno === 6) { out.error = 'NOT_LOGGED_IN'; return out; }
      if (j.errno !== 0) { out.error = 'ERRNO_' + j.errno; return out; }
      if (total < 0) total = j.total || 0;
      const list = j.list || [];
      if (!list.length) break;
      for (const e of list) {
        if (e.isdir === 1) out.folders.push({ name: e.server_filename, path: e.path });
        else out.files.push({ fs_id: e.fs_id, name: e.server_filename, size: e.size || 0, md5: (e.md5 || '').toLowerCase(), path: e.path });
      }
      got += list.length;
      if (got >= total) break;
      if (pageNum >= 10000) break;
      pageNum++;
    }
  } catch (e) { out.error = String(e); }
  return out;
};
true
`;

async function ensureSession() {
  if (ws && ws.readyState === 1) {
    try { await send('Runtime.evaluate', { expression: '1+1' }, 8000); } catch (e) { try { ws.close(); } catch (e2) {} }
  }
  if (!ws || ws.readyState !== 1) {
    const t = await findOrCreatePanTab();
    await connect(t.webSocketDebuggerUrl);
    connKey = t.webSocketDebuggerUrl;
    await send('Runtime.enable');
    await send('Page.enable').catch(() => {});
    await send('Network.enable').catch(() => {});
  }
  // 唤醒冻结标签页（后台标签会被浏览器冻结，导致evaluate超时）
  await send('Page.setWebLifecycleState', { state: 'active' }, 10000).catch(() => {});
  await send('Page.bringToFront', {}, 10000).catch(() => {});
  try {
    await evaluate(HELPER, 15000);
  } catch (e) { try { await evaluate(HELPER, 15000); } catch (e2) {} }
}

async function probeLogin() {
  const probe = await evaluate(`fetch('https://pan.baidu.com/api/list?channel=chunlei&clienttype=0&web=1&app_id=250528&num=1&order=name&desc=0&showempty=0&dir=%2F&page=1', {credentials:'include'}).then(r => r.text()).then(t => t.substring(0, 300))`, 30000).catch(e => 'ERR:' + e.message);
  return String(probe);
}

const isLoggedIn = (p) => p.includes('"errno":0') || p.includes('"errno": 0') || p.includes('"list"') || p.includes('"fs_id"');

async function snapshotCookies() {
  try {
    const all = await send('Network.getAllCookies', {}, 30000);
    const keep = (all.cookies || []).filter(c => (c.domain || '').includes('baidu.com'));
    if (keep.length) { fs.writeFileSync(COOKIES_PATH, JSON.stringify(keep)); log('cookie snapshot saved: ' + keep.length + ' cookies'); }
  } catch (e) { log('cookie snapshot failed: ' + e.message); }
}

async function restoreCookies() {
  if (!connKey || restoredForConn === connKey) return false;
  restoredForConn = connKey;
  if (!fs.existsSync(COOKIES_PATH)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    if (!Array.isArray(cookies) || !cookies.length) return false;
    await send('Network.enable').catch(() => {});
    let n = 0;
    for (const c of cookies) {
      const p = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' };
      if (c.secure) p.secure = true;
      if (c.httpOnly) p.httpOnly = true;
      if (c.expires && c.expires > 0) p.expires = c.expires;
      const ok = await send('Network.setCookie', p, 15000).catch(() => null);
      if (ok && ok.success) n++;
    }
    log('cookie restore: ' + n + '/' + cookies.length);
    return n > 0;
  } catch (e) { log('cookie restore failed: ' + e.message); return false; }
}

async function ensureDebugInstance() {
  try {
    const r = await fetch(CDP_HTTP + '/json/version', { signal: AbortSignal.timeout(3000) });
    if (r.ok) return;
  } catch (e) {}
  const now = Date.now();
  if (now - lastLaunch > 90000) {
    lastLaunch = now;
    log('debug instance down, relaunching...');
    require('child_process').exec('explorer.exe "' + LAUNCH_BAT + '"');
  }
}

async function waitForLogin() {
  let ticks = 0;
  while (true) {
    await sleep(4000);
    try {
      await ensureDebugInstance();
      await ensureSession();
      let p = await probeLogin();
      if (isLoggedIn(p)) { log('login detected'); await snapshotCookies(); return; }
      if (await restoreCookies()) {
        p = await probeLogin();
        if (isLoggedIn(p)) { log('session restored from saved cookies'); await snapshotCookies(); return; }
      }
      ticks++;
      if (ticks % 8 === 1) log('waiting for login in debug window...');
    } catch (e) { await ensureDebugInstance(); }
  }
}

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    s.seenDirs = new Set(s.seenDirs || []);
    log('RESUMED: queue=' + s.queue.length + ' scannedDirs=' + s.seenDirs.size + ' files=' + s.stats.files);
    return s;
  }
  return { queue: [ROOT_DIR], seenDirs: new Set([ROOT_DIR]), stats: { files: 0, folders: 0, bytes: 0, noMd5: 0, errors: 0, errorList: [] } };
}

function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ queue: s.queue, seenDirs: Array.from(s.seenDirs), stats: s.stats }));
}

async function main() {
  log('=== 百度网盘全盘扫描 (inv.jsonl) ===');
  await ensureSession();
  log('session ok, probing login...');
  let p = await probeLogin();
  log('probe:', p.substring(0, 200));
  if (!isLoggedIn(p)) {
    if (await restoreCookies()) p = await probeLogin();
  }
  if (!isLoggedIn(p)) {
    log('============================================================');
    log('需要登录：请在 Edge 调试窗口中登录百度网盘（扫码/短信）');
    log('登录后自动保存会话，以后无需再登录');
    log('============================================================');
    await waitForLogin();
  }
  await snapshotCookies();
  const state = loadState();
  const BATCH = 8;
  let batchNo = 0;
  const t0 = Date.now();

  while (state.queue.length) {
    const batch = state.queue.splice(0, BATCH);
    let results = null;
    for (let attempt = 1; attempt <= 3 && !results; attempt++) {
      try {
        await ensureSession();
        results = await evaluate('Promise.all(' + JSON.stringify(batch) + '.map(d => window.__bf(d)))');
      } catch (e) {
        log('batch error attempt ' + attempt + ': ' + e.message);
        await ensureDebugInstance();
        await sleep(3000);
      }
    }
    if (!results) {
      log('BATCH FAILED after retries, requeueing ' + batch.length + ' dirs');
      state.queue = batch.concat(state.queue);
      saveState(state);
      continue;
    }
    if (results.some(r => r.error === 'NOT_LOGGED_IN')) {
      log('登录失效，等待重新登录...');
      state.queue = batch.concat(state.queue);
      saveState(state);
      await waitForLogin();
      continue;
    }

    const line = { files: [], folders: [] };
    for (const r of results) {
      if (r.error) { state.stats.errors++; state.stats.errorList.push({ dir: r.dir, err: r.error }); continue; }
      for (const f of r.files) {
        line.files.push({ fs_id: f.fs_id, name: f.name, size: f.size, md5: f.md5, path: f.path });
        state.stats.files++;
        state.stats.bytes += f.size;
        if (!f.md5) state.stats.noMd5++;
      }
      for (const d of r.folders) {
        if (state.seenDirs.has(d.path)) continue;
        state.seenDirs.add(d.path);
        line.folders.push({ name: d.name, path: d.path });
        state.stats.folders++;
        state.queue.push(d.path);
      }
    }
    if (line.files.length || line.folders.length) fs.appendFileSync(JSONL_PATH, JSON.stringify(line) + '\n');
    saveState(state);
    batchNo++;
    if (batchNo % 10 === 0) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      log('batch#' + batchNo + ' | total ' + state.stats.files + ' files ' + fmtB(state.stats.bytes) + ' | ' + state.stats.folders + ' dirs | queue ' + state.queue.length + ' | errors ' + state.stats.errors + ' | ' + mins + 'min');
    }
  }

  log('============================================================');
  log('SCAN COMPLETE');
  log('files: ' + state.stats.files + '  folders: ' + state.stats.folders + '  total size: ' + fmtB(state.stats.bytes) + '  noMd5: ' + state.stats.noMd5 + '  errors: ' + state.stats.errors);
  if (state.stats.errorList.length) log('error dirs: ' + JSON.stringify(state.stats.errorList.slice(0, 20)));
  log('output: ' + JSONL_PATH);
}

main().catch(e => { log('FATAL: ' + e.stack); process.exit(1); });
