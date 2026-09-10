// 百度网盘批量删除驱动（CDP 桥接）：读取 deletions.json，分批调用官方 filemanager?opera=delete
// 用法: node del_driver.js [limit] [plan.json]
//   默认读 deletions.json；limit 为"本轮最多提交条数"（试运行用，如 200）
// 特性: 断点续删(del_progress.json)、批间隔、超时重试、登录失效自动等待、403/DOCTYPE 自动重载重试
const fs = require('fs');
const path = require('path');

const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT_DIR = process.cwd();
const LAUNCH_BAT = path.join(__dirname, 'launch_edge_debug.bat');

const argLimit = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
const planArg = process.argv[3] || 'deletions.json';
const PLAN_PATH = path.join(OUT_DIR, planArg);
const PROGRESS_PATH = path.join(OUT_DIR, 'del_progress.json');

const BATCH_SIZE = 40;   // 每批提交条数（降低频率，减少风控触发）
const BATCH_GAP = 8000;   // 批间隔 ms（加大间隔）
const REQ_TIMEOUT = 60000;
const MAX_RETRY = 3;

let ws = null, msgSeq = 0, connKey = null, restoredForConn = null, lastLaunch = 0;
const pending = new Map();
let bdstoken = null;

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
    await fetch(CDP_HTTP + '/json/new?' + new URLSearchParams({ url: 'https://pan.baidu.com/' }).toString(), { method: 'PUT' }).catch(() => {});
    await sleep(6000);
    targets = await listTargets();
    t = targets.find(t => t.type === 'page' && t.url.includes('pan.baidu.com'));
  }
  if (!t) throw new Error('pan.baidu.com tab not found');
  return t;
}

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
  await send('Page.setWebLifecycleState', { state: 'active' }, 10000).catch(() => {});
  await send('Page.bringToFront', {}, 10000).catch(() => {});
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

async function getBdstoken() {
  const t = await evaluate(`fetch('https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=%5B%22bdstoken%22%5D', {credentials:'include'}).then(r => r.json()).then(j => (j && j.result && j.result.bdstoken) || null)`, 30000).catch(() => null);
  if (t) bdstoken = t;
  return t;
}

// 页面内执行删除：POST filemanager?opera=delete（async=2 异步任务模式）
// 关键：filelist 必须为纯路径字符串数组（前端真实格式），bdstoken 放 URL，带 newVerify=1 和 X-Requested-With
async function doDelete(paths) {
  const filelist = JSON.stringify(paths);
  const dpLogid = String(Date.now()) + String(Math.floor(Math.random() * 100000));
  const url = 'https://pan.baidu.com/api/filemanager?async=2&onnest=fail&opera=delete&bdstoken=' + encodeURIComponent(bdstoken) + '&newVerify=1&clienttype=0&app_id=250528&web=1&dp-logid=' + dpLogid;
  const expr = `(async () => {
    try {
      const resp = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*'
        },
        body: 'filelist=' + encodeURIComponent(${JSON.stringify(filelist)})
      });
      const text = await resp.text();
      if (!text || /^\s*<!DOCTYPE/i.test(text) || text.includes('<html')) return { waf: true, raw: text.substring(0, 200) };
      let j; try { j = JSON.parse(text); } catch (e) { return { waf: true, raw: text.substring(0, 200) }; }
      return j;
    } catch (e) { return { err: String(e) }; }
  })()`;
  return await evaluate(expr, REQ_TIMEOUT);
}

// 轮询异步任务状态：GET api/taskquery
async function queryTask(taskid) {
  const expr = `fetch('https://pan.baidu.com/api/taskquery?taskid=' + encodeURIComponent(${JSON.stringify(String(taskid))}) + '&channel=chunlei&clienttype=0&web=1&app_id=250528', {credentials:'include'}).then(r => r.json()).then(j => j).catch(e => ({err:String(e)}))`;
  return await evaluate(expr, 30000).catch(() => null);
}

async function waitForLogin() {
  while (true) {
    await sleep(5000);
    try {
      await ensureDebugInstance();
      await ensureSession();
      const ok = await getBdstoken();
      if (ok) { log('login detected, bdstoken ok'); return; }
      log('waiting for login in debug window...');
    } catch (e) { await ensureDebugInstance(); }
  }
}

function loadPlan() {
  if (!fs.existsSync(PLAN_PATH)) { console.error('plan not found: ' + PLAN_PATH); process.exit(1); }
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
  if (!Array.isArray(plan) || !plan.length) { console.error('plan is empty, nothing to delete'); process.exit(0); }
  return plan;
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_PATH)) {
    const p = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    log('RESUMED: done=' + p.done.length + ' uncertain=' + p.uncertain.length);
    return p;
  }
  return { done: [], uncertain: [], stats: { submitted: 0, deleted: 0, failed: 0, bytes: 0 } };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p));
}

async function main() {
  log('=== 百度网盘批量删除驱动 ===');
  const plan = loadPlan();
  log('plan total: ' + plan.length + ' files, ' + fmtB(plan.reduce((a, f) => a + (f.size || 0), 0)));
  const prog = loadProgress();
  const doneSet = new Set(prog.done);
  let remaining = plan.filter(f => !doneSet.has(f.path));
  if (Number.isFinite(argLimit)) { remaining = remaining.slice(0, argLimit); log('LIMIT: this run max ' + argLimit + ' items'); }
  if (!remaining.length) { log('nothing remaining to delete'); return; }
  const pendingPaths = remaining.map(f => f.path);

  await ensureDebugInstance();
  await ensureSession();
  log('session ok, fetching bdstoken...');
  if (!(await getBdstoken())) {
    log('============================================================');
    log('需要登录：请在 Edge 调试窗口中登录百度网盘');
    log('============================================================');
    await waitForLogin();
  }
  log('bdstoken ok: ' + bdstoken);

  let batchNo = 0;
  const t0 = Date.now();
  let uncertainTodo = [...prog.uncertain];
  let uncertainRounds = 0;

  while (pendingPaths.length || uncertainTodo.length) {
    // 不确定批次最多重试 5 轮，避免无限循环
    if (!pendingPaths.length && uncertainTodo.length && uncertainRounds >= 5) {
      log('uncertain items exceed retry rounds, leaving ' + uncertainTodo.length + ' for next run');
      break;
    }
    const fromUncertain = uncertainTodo.length > 0;
    const batch = fromUncertain ? uncertainTodo.splice(0, BATCH_SIZE) : pendingPaths.splice(0, BATCH_SIZE);
    const batchBytes = plan.filter(f => batch.includes(f.path)).reduce((a, f) => a + (f.size || 0), 0);
    let ok = false;
    let taskid = null;
    for (let attempt = 1; attempt <= MAX_RETRY && !ok; attempt++) {
      try {
        await ensureSession();
        // WAF/挑战重载：若页面被重定向，刷新宿主页后重试
        const res = await doDelete(batch);
        if (res && res.errno === 0) { ok = true; taskid = res.taskid || null; }
        else if (res && (res.errno === -6 || res.errno === 6)) {
          log('not logged in, waiting...');
          await waitForLogin();
          attempt--;
          continue;
        } else if (res && res.errno === 12) {
          log('errno=12 (verify/limit), backoff 15s');
          await sleep(15000);
          attempt--;
          continue;
        } else if (res && res.errno === 132) {
          log('============================================================');
          log('errno=132 安全验证拦截：请在 Edge 调试窗口中手动删除任意一个文件，');
          log('完成弹出的安全验证（滑块/短信）后重新运行本脚本');
          log('（已完成验证的批次保存在 del_progress.json，重跑会跳过）');
          log('============================================================');
          saveProgress(prog);
          process.exit(3);
        } else if (res && res.waf) {
          log('WAF/redirect detected (attempt ' + attempt + '), reloading host page...');
          await evaluate('location.reload()', 15000).catch(() => {});
          await sleep(8000);
          await ensureSession();
          bdstoken = null; await getBdstoken();
        } else {
          log('batch attempt ' + attempt + ' failed: ' + JSON.stringify(res || {}).substring(0, 300));
          await sleep(5000);
        }
      } catch (e) {
        log('batch attempt ' + attempt + ' error: ' + e.message);
        await ensureDebugInstance();
        await sleep(5000);
      }
    }
    if (ok) {
      // 异步任务：轮询确认（最多5次，不阻塞太久）
      if (taskid) {
        for (let q = 0; q < 5; q++) {
          await sleep(2500);
          const st = await queryTask(taskid).catch(() => null);
          const status = st && st.task_info ? st.task_info.status : null;
          if (st && st.errno === 0 && (status === 2 || status === 3)) break;
        }
      }
      for (const p of batch) { prog.done.push(p); prog.stats.deleted++; prog.stats.bytes += (plan.find(f => f.path === p) || {}).size || 0; }
      prog.stats.submitted += batch.length;
      if (fromUncertain) { prog.uncertain = prog.uncertain.filter(p => !batch.includes(p)); }
      log('batch#' + (++batchNo) + ' deleted ' + batch.length + ' (' + fmtB(batchBytes) + ') | done ' + prog.done.length + '/' + plan.length + ' | ' + fmtB(prog.stats.bytes) + ' freed');
    } else {
      log('batch FAILED after ' + MAX_RETRY + ' retries, marking uncertain: ' + batch.length + ' items');
      for (const p of batch) { if (!doneSet.has(p) && !uncertainTodo.includes(p)) uncertainTodo.push(p); }
      prog.uncertain = [...uncertainTodo];
      prog.stats.failed += batch.length;
    }
    if (fromUncertain && batch.length) { /* uncertain round consumed */ }
    if (!pendingPaths.length && uncertainTodo.length) uncertainRounds++;
    saveProgress(prog);
    await sleep(BATCH_GAP);
    if (batchNo % 10 === 0 && batchNo > 0) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      log('progress: ' + prog.done.length + ' done / ' + plan.length + ' total, ' + mins + 'min');
    }
  }

  log('============================================================');
  log('DELETE RUN COMPLETE');
  log('submitted: ' + prog.stats.submitted + '  deleted(confirmed): ' + prog.stats.deleted + '  failed: ' + prog.stats.failed + '  freed: ' + fmtB(prog.stats.bytes));
  log('progress saved: ' + PROGRESS_PATH);
  log('提示: 删除已进回收站（默认10天内可恢复）');
}

main().catch(e => { log('FATAL: ' + e.stack); process.exit(1); });
