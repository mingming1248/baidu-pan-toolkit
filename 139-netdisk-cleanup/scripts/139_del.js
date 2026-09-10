// 139网盘批量删除（CDP 浏览器桥接）：读 deletions.json → 分批调用官方删除接口
// 用法: node 139_del.js [limit] [--hard]
//   limit   本轮最多提交 N 个（默认全量）
//   --hard  彻底删除（/file/batchDelete，跳过回收站）；默认移入回收站（/recyclebin/batchTrash）
// 原理: 页面内动态读取运行时认证，POST 官方批量删除接口，断点续删
const fs = require('fs');
const path = require('path');

const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT_DIR = process.cwd();
const DEL_PATH = path.join(OUT_DIR, 'deletions.json');
const PROG_PATH = path.join(OUT_DIR, 'del_progress.json');
const PAN_URL = 'https://yun.139.com/w/#/index';
const LAUNCH_BAT = path.join(__dirname, 'launch_edge_debug.bat');

const HARD = process.argv.includes('--hard');
const LIMIT = (() => { const n = parseInt(process.argv[2], 10); return isNaN(n) ? 0 : n; })();
const BATCH_SIZE = 50; // 批次大小
const BATCH_GAP = 2000; // 批次间隔 ms（高频风控降频可调大）

let ws = null;
let msgSeq = 0;
let lastLaunch = 0;
const pending = new Map();

const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

async function findOrCreate139Tab() {
  let targets = await listTargets();
  let t = targets.find(t => t.type === 'page' && t.url.includes('yun.139.com'));
  if (!t) {
    log('no yun.139.com tab, creating...');
    await fetch(CDP_HTTP + '/json/new?' + new URLSearchParams({ url: PAN_URL }).toString(), { method: 'PUT' }).catch(() => {});
    await sleep(6000);
    targets = await listTargets();
    t = targets.find(t => t.type === 'page' && t.url.includes('yun.139.com'));
  }
  if (!t) throw new Error('yun.139.com tab not found');
  return t;
}

// 页面内删除 helper：动态读认证，批量删除，返回逐条结果
const DEL_HELPER = `
window.__139del = async function(fileIds, hard) {
  const out = { ok: [], fail: [], error: null };
  try {
    let auth = null;
    try { auth = window.MCloudVM.$store.state.auth; } catch (e) {}
    if (!auth || !auth.accountPhone || !auth.authToken) { out.error = 'NO_AUTH'; return out; }
    const authz = 'Basic ' + btoa(unescape(encodeURIComponent('pc:' + auth.accountPhone + ':' + auth.authToken)));
    const headers = { 'Content-Type': 'application/json', 'x-yun-api-version': 'v1', 'Authorization': authz, 'x-yun-app-channel': '10000034', 'x-yun-module-type': '100', 'x-yun-client-info': '||9|1|1|1|||zh|||MQ==||', 'mcloud-route': '001' };
    const url = 'https://personal-kd-njs.yun.139.com/hcy/' + (hard ? 'file/batchDelete' : 'recyclebin/batchTrash');
    const body = JSON.stringify({ commonAccountInfo: { account: auth.accountPhone, accountType: 1 }, fileIds: fileIds });
    const resp = await fetch(url, { method: 'POST', headers, body });
    const j = await resp.json();
    if (!j || !j.success) {
      if (j && (j.code === '04000005' || j.code === '04010013')) { out.error = 'NOT_LOGGED_IN'; return out; }
      out.error = (j && (j.code + ':' + j.message)) || 'BAD_JSON'; return out;
    }
    out.ok = fileIds;
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
    const t = await findOrCreate139Tab();
    await connect(t.webSocketDebuggerUrl);
    await send('Runtime.enable');
    await send('Page.enable').catch(() => {});
    await send('Network.enable').catch(() => {});
  }
  await send('Page.setWebLifecycleState', { state: 'active' }, 10000).catch(() => {});
  await send('Page.bringToFront', {}, 10000).catch(() => {});
  try {
    await evaluate(DEL_HELPER, 15000);
  } catch (e) { try { await evaluate(DEL_HELPER, 15000); } catch (e2) {} }
}

async function probeLogin() {
  const probe = await evaluate(`fetch('https://personal-kd-njs.yun.139.com/hcy/file/list',{method:'POST',headers:{'Content-Type':'application/json','x-yun-api-version':'v1','x-yun-app-channel':'10000034','x-yun-module-type':'100','x-yun-client-info':'||9|1|1|1|||zh|||MQ==||','mcloud-route':'001'},body:JSON.stringify({commonAccountInfo:{account:(window.MCloudVM.$store.state.auth||{}).accountPhone||'',accountType:1},pageInfo:{pageSize:1,pageCursor:null},orderBy:'updated_at',orderDirection:'DESC',parentFileId:'/',imageThumbnailStyleList:['Small','Large']})}).then(r=>r.text()).then(t=>t.substring(0,300))`, 30000).catch(e => 'ERR:' + e.message);
  return String(probe);
}

const isLoggedIn = (p) => p.includes('"success":true') || p.includes('"items"') || (p.includes('"success":false') && p.includes('04000002'));

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
      const p = await probeLogin();
      if (isLoggedIn(p)) { log('login detected'); return; }
      ticks++;
      if (ticks % 8 === 1) log('waiting for login in debug window...');
    } catch (e) { await ensureDebugInstance(); }
  }
}

function loadProgress() {
  if (fs.existsSync(PROG_PATH)) {
    const s = JSON.parse(fs.readFileSync(PROG_PATH, 'utf8'));
    log('RESUMED: done=' + s.done.length + ' remaining=' + s.remaining.length);
    return s;
  }
  const deletions = JSON.parse(fs.readFileSync(DEL_PATH, 'utf8'));
  return { done: [], remaining: deletions.map(d => d.fileId) };
}

function saveProgress(s) {
  fs.writeFileSync(PROG_PATH, JSON.stringify({ done: s.done, remaining: s.remaining }));
}

async function main() {
  if (!fs.existsSync(DEL_PATH)) {
    log('未找到 ' + DEL_PATH + '，请先运行 139_scan.js + 139_analyze.js');
    process.exit(1);
  }
  log('=== 139网盘批量删除 (' + (HARD ? '彻底删除' : '移入回收站') + ') ===');
  await ensureSession();
  const p = await probeLogin();
  if (!isLoggedIn(p)) {
    log('需要登录：请在 Edge 调试窗口中登录139网盘后继续');
    await waitForLogin();
  }

  const prog = loadProgress();
  if (LIMIT > 0) prog.remaining = prog.remaining.slice(0, LIMIT);
  log('待删: ' + prog.remaining.length + ' 个 | 已删: ' + prog.done.length);

  let failCount = 0;
  while (prog.remaining.length) {
    const batch = prog.remaining.splice(0, BATCH_SIZE);
    let result = null;
    for (let attempt = 1; attempt <= 3 && !result; attempt++) {
      try {
        await ensureSession();
        result = await evaluate('window.__139del(' + JSON.stringify(batch) + ',' + (HARD ? 'true' : 'false') + ')');
      } catch (e) {
        log('batch error attempt ' + attempt + ': ' + e.message);
        await ensureDebugInstance();
        await sleep(3000);
      }
    }
    if (!result) { failCount += batch.length; log('BATCH FAILED: ' + batch.length); continue; }
    if (result.error === 'NOT_LOGGED_IN') {
      log('登录失效，等待重新登录...');
      prog.remaining = batch.concat(prog.remaining);
      saveProgress(prog);
      await waitForLogin();
      continue;
    }
    if (result.error) {
      failCount += batch.length;
      log('delete error: ' + result.error + ' | requeue ' + batch.length);
      prog.remaining = batch.concat(prog.remaining);
      saveProgress(prog);
      await sleep(5000);
      continue;
    }
    prog.done = prog.done.concat(result.ok || []);
    saveProgress(prog);
    log('deleted ' + batch.length + ' | total done ' + prog.done.length + ' | remaining ' + prog.remaining.length + ' | fail ' + failCount);
    await sleep(BATCH_GAP);
  }

  log('============================================================');
  log('DELETE COMPLETE: done=' + prog.done.length + ' fail=' + failCount);
  if (failCount > 0) log('有失败项，重新运行本脚本可继续重试（断点续删）');
  else log('全部删除成功。如需清空回收站：node ' + path.basename(process.argv[1]) + ' --clear 或调用 /hcy/recyclebin/clear');
}

main().catch(e => { log('FATAL: ' + e.stack); process.exit(1); });
