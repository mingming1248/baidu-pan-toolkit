// 天翼云盘全盘扫描（CDP 浏览器桥接）：枚举全部文件(含MD5)与文件夹 → inv.jsonl
// 用法: node scan_md5.js        （在专用工作目录下运行；可中断重跑，自动断点续扫）
const fs = require('fs');
const path = require('path');

const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT_DIR = process.cwd();
const JSONL_PATH = path.join(OUT_DIR, 'inv.jsonl');
const STATE_PATH = path.join(OUT_DIR, 'scan_state.json');
const COOKIES_PATH = path.join(OUT_DIR, 'session_cookies.json');
const CLOUD_URL = 'https://cloud.189.cn/web/main/file/folder/-11';
const LAUNCH_BAT = path.join(__dirname, 'launch_edge_debug.bat');
const LIST_URL = (fid, pageNum) => 'https://cloud.189.cn/api/open/file/listFiles.action?folderId=' + encodeURIComponent(fid) + '&pageSize=60&pageNum=' + pageNum + '&mediaType=0&iconOption=5&orderBy=lastOpTime&descending=true';

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

async function findOrCreateCloudTab() {
  let targets = await listTargets();
  let t = targets.find(t => t.type === 'page' && t.url.includes('189.cn'));
  if (!t) {
    log('no cloud tab, creating...');
    await fetch(CDP_HTTP + '/json/new?' + new URLSearchParams({ url: CLOUD_URL }).toString(), { method: 'PUT' }).catch(() => {});
    await sleep(5000);
    targets = await listTargets();
    t = targets.find(t => t.type === 'page' && t.url.includes('189.cn'));
  }
  if (!t) throw new Error('cloud.189.cn tab not found');
  return t;
}

// 页面内 helper：逐页拉取目录 XML 并解析为 {files:[{id,name,size,md5}], folders:[{id,name}]}
const HELPER = `
window.__lf = async function(fid) {
  const out = { fid: String(fid), files: [], folders: [], error: null };
  const gv = (el, tags) => { for (const t of tags) { const e = el.querySelector(t); if (e && e.textContent != null) return e.textContent; } return null; };
  try {
    let pageNum = 1, count = -1, got = 0;
    while (true) {
      const url = 'https://cloud.189.cn/api/open/file/listFiles.action?folderId=' + encodeURIComponent(fid) + '&pageSize=60&pageNum=' + pageNum + '&mediaType=0&iconOption=5&orderBy=lastOpTime&descending=true';
      const resp = await fetch(url);
      const txt = await resp.text();
      if (resp.status !== 200) { out.error = 'HTTP_' + resp.status; return out; }
      if (!txt || /^\s*<!DOCTYPE/i.test(txt) || txt.includes('<html')) { out.error = 'NOT_LOGGED_IN'; return out; }
      const t0 = txt.trimStart();
      if (t0.startsWith('{') || t0.includes('"errorCode"')) { out.error = 'NOT_LOGGED_IN'; return out; }
      const doc = new DOMParser().parseFromString(txt, 'text/xml');
      if (count < 0) { const c = doc.querySelector('count'); count = c ? (parseInt(c.textContent, 10) || 0) : 0; }
      const fsEls = Array.from(doc.querySelectorAll('file'));
      const dsEls = Array.from(doc.querySelectorAll('folder'));
      if (!fsEls.length && !dsEls.length) break;
      for (const el of fsEls) {
        const id = gv(el, ['id', 'fileId']);
        const name = gv(el, ['name', 'fileName']) || '';
        if (!id) continue;
        out.files.push({ id: id, name: name, size: parseInt(gv(el, ['size', 'fileSize']) || '0', 10) || 0, md5: (gv(el, ['md5']) || '').toUpperCase() });
      }
      for (const el of dsEls) {
        const id = gv(el, ['id', 'folderId']);
        const name = gv(el, ['name', 'folderName']) || '';
        if (!id) continue;
        out.folders.push({ id: id, name: name });
      }
      got += fsEls.length + dsEls.length;
      if (count > 0 && got >= count) break;
      if (pageNum >= 500) break;
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
    const t = await findOrCreateCloudTab();
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
  const probe = await evaluate(`fetch(${JSON.stringify(LIST_URL('-11', 1))}).then(r => r.text()).then(t => t.substring(0, 400))`, 30000).catch(e => 'ERR:' + e.message);
  return String(probe);
}

const isLoggedIn = (p) => p.includes('<file') || p.includes('<folder');

async function snapshotCookies() {
  try {
    const all = await send('Network.getAllCookies', {}, 30000);
    const keep = (all.cookies || []).filter(c => (c.domain || '').includes('189.cn'));
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
    s.seenFolders = new Set(s.seenFolders || []);
    log('RESUMED: queue=' + s.queue.length + ' scannedFolders=' + s.seenFolders.size + ' files=' + s.stats.files);
    return s;
  }
  return { queue: ['-11'], pathMap: { '-11': '' }, seenFolders: new Set(['-11']), stats: { files: 0, folders: 0, bytes: 0, errors: 0, errorList: [] } };
}

function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ queue: s.queue, pathMap: s.pathMap, seenFolders: Array.from(s.seenFolders), stats: s.stats }));
}

async function main() {
  log('=== 天翼云盘全盘扫描 (inv.jsonl) ===');
  await ensureSession();
  log('session ok, probing login...');
  let p = await probeLogin();
  log('probe:', p.substring(0, 200));
  if (!isLoggedIn(p)) {
    if (await restoreCookies()) p = await probeLogin();
  }
  if (!isLoggedIn(p)) {
    log('============================================================');
    log('需要登录：请在 Edge 调试窗口中登录天翼云盘');
    log('（短信验证码或App扫码；登录后自动保存会话，以后无需再登录）');
    log('============================================================');
    await waitForLogin();
  }
  await snapshotCookies();
  const state = loadState();
  const BATCH = 15;
  let batchNo = 0;
  const t0 = Date.now();

  while (state.queue.length) {
    const batch = state.queue.splice(0, BATCH);
    let results = null;
    for (let attempt = 1; attempt <= 3 && !results; attempt++) {
      try {
        await ensureSession();
        results = await evaluate('Promise.all(' + JSON.stringify(batch) + '.map(id => window.__lf(id)))');
      } catch (e) {
        log('batch error attempt ' + attempt + ': ' + e.message);
        await ensureDebugInstance();
        await sleep(3000);
      }
    }
    if (!results) {
      log('BATCH FAILED after retries, requeueing ' + batch.length + ' folders');
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
      if (r.error) { state.stats.errors++; state.stats.errorList.push({ fid: r.fid, err: r.error }); continue; }
      const ppath = state.pathMap[r.fid] || '';
      for (const f of r.files) {
        line.files.push({ id: f.id, name: f.name, size: f.size, md5: f.md5, path: ppath + '/' + f.name });
        state.stats.files++;
        state.stats.bytes += f.size;
      }
      for (const d of r.folders) {
        if (state.seenFolders.has(d.id)) continue;
        state.seenFolders.add(d.id);
        state.pathMap[d.id] = ppath + '/' + d.name;
        line.folders.push({ id: d.id, name: d.name, path: ppath + '/' + d.name });
        state.stats.folders++;
        state.queue.push(d.id);
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
  log('files: ' + state.stats.files + '  folders: ' + state.stats.folders + '  total size: ' + fmtB(state.stats.bytes) + '  errors: ' + state.stats.errors);
  if (state.stats.errorList.length) log('error folders: ' + JSON.stringify(state.stats.errorList.slice(0, 20)));
  log('output: ' + JSONL_PATH);
  log('注意: scan_state.json 的 pathMap 是后续删除驱动解析父目录ID的依据，请保留');
}

main().catch(e => { log('FATAL: ' + e.stack); process.exit(1); });
