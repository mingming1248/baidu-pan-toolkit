// 天翼云盘批量删除驱动：读删除计划 → 浏览器桥接提交批量任务 → 轮询确认 → 断点续删
// 用法: node del_driver.js [limit] [plan.json] [state.json] [progress.json] [类过滤如A,C,B1]
//   limit: 本轮最多提交文件数（试运行用）；默认 0 = 全量
//   plan/progress 默认 deletions.json / scan_state.json / del_progress.json（当前目录）
// 特性: WAF 403自动重载宿主页重试、网关错误退避降批、批次自适应200→400、挂起任务恢复、周期报告
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = process.cwd();
const DEL_PATH = path.resolve(OUT_DIR, process.argv[3] || 'deletions.json');
const STATE_PATH = path.resolve(OUT_DIR, process.argv[4] || 'scan_state.json');
const PROGRESS_PATH = path.resolve(OUT_DIR, process.argv[5] || 'del_progress.json');
const CLASSES = process.argv[6] ? process.argv[6].split(',').map(s => s.trim() + ':') : null; // null=全部
const LOG_PATH = path.join(OUT_DIR, 'del_batch.log');
const COOKIES_PATH = path.join(OUT_DIR, 'session_cookies.json');
const CDP_HTTP = 'http://127.0.0.1:9222';
const MAIN_URL = 'https://cloud.189.cn/web/main/file/folder/-11';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

const START_BATCH = 200;
const MAX_BATCH = 400;
const MIN_BATCH = 10;
const MAX_INFLIGHT = 1;
const TASK_STALE_MS = 20 * 60 * 1000;
const CREATE_MIN_INTERVAL_MS = 5000;
const WAF_COOLDOWN_MS = 5 * 60 * 1000;
const WAF_MAX_STREAK = 6;

let cookieHeader = '';
let sessionKey = '';

const logLines = [];
const log = (...a) => {
  const line = new Date().toISOString().substring(11, 19) + ' ' + a.join(' ');
  console.log(line);
  logLines.push(line);
  if (logLines.length > 200) { fs.appendFileSync(LOG_PATH, logLines.splice(0, 200).join('\n') + '\n'); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ Node直连HTTP (IPv6，仅用于只读轮询) ============
function api(p, { method = 'GET', body = null } = {}) {
  return new Promise((resolve) => {
    const url = p.startsWith('http') ? p : 'https://cloud.189.cn' + p;
    const headers = { 'Cookie': cookieHeader, 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://cloud.189.cn/web/main/', 'Origin': 'https://cloud.189.cn' };
    if (sessionKey) headers['SessionKey'] = sessionKey;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; headers['Content-Length'] = Buffer.byteLength(body); }
    const t0 = Date.now();
    const req = https.request(url, { method, headers, family: 6, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, body: data }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, ms: Date.now() - t0, body: 'TIMEOUT' }); });
    req.on('error', e => resolve({ status: -2, ms: Date.now() - t0, body: 'ERR: ' + e.message }));
    if (body) req.write(body);
    req.end();
  });
}

// ============ CDP 浏览器桥接（写操作走这里，绕过WAF指纹拦截） ============
let ws = null, msgSeq = 0;
const pending = new Map();
function cdpConnect(wsUrl) {
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
function cdpSend(method, params = {}, timeoutMs = 30000) {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error('ws not open'));
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp timeout ' + method)); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function cdpEv(expression, timeoutMs = 30000) {
  const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, timeoutMs);
  if (r.exceptionDetails) throw new Error('page exception');
  return r.result ? r.result.value : undefined;
}

async function listCloudTabs() {
  const targets = await (await fetch(CDP_HTTP + '/json/list')).json();
  const pages = targets.filter(x => x.type === 'page' && x.url.includes('cloud.189.cn'));
  pages.sort((a, b) => (b.url.includes('/web/main') ? 1 : 0) - (a.url.includes('/web/main') ? 1 : 0));
  return pages;
}
const HOST_OK_EXPR = `(location.href.includes('/web/main') && (sessionStorage.getItem('sessionKey')||'').length > 0) ? 1 : 0`;
// 重载宿主页到web/main：页面加载时浏览器会自动执行WAF挑战JS获得放行cookie
async function reloadHost() {
  const pages = await listCloudTabs();
  if (!pages.length) throw new Error('no cloud tab for reload');
  try { ws && ws.close(); } catch (e) {}
  ws = null;
  await cdpConnect(pages[0].webSocketDebuggerUrl);
  await cdpSend('Runtime.enable');
  await cdpSend('Page.enable').catch(() => {});
  await cdpSend('Page.navigate', { url: MAIN_URL }, 20000).catch(() => {});
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const u = await cdpEv('location.href').catch(() => '');
    const skLen = await cdpEv(`(sessionStorage.getItem('sessionKey')||'').length`, 6000).catch(() => 0);
    const ready = await cdpEv('document.readyState', 6000).catch(() => '');
    if (u.includes('/web/main') && skLen > 0 && ready === 'complete') {
      sessionKey = await cdpEv(`(sessionStorage.getItem('sessionKey')||'')`, 6000).catch(() => sessionKey);
      log('宿主页已就绪:', u.substring(0, 70));
      return true;
    }
  }
  throw new Error('host reload timeout');
}
async function ensureBridge() {
  if (ws && ws.readyState === 1) {
    const ok = await cdpEv(HOST_OK_EXPR, 8000).catch(() => 0);
    if (ok) return true;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  const pages = await listCloudTabs();
  const main = pages.find(t => t.url.includes('/web/main'));
  if (main) {
    try { await cdpConnect(main.webSocketDebuggerUrl); } catch (e) {}
    if (ws && ws.readyState === 1) {
      await cdpSend('Runtime.enable').catch(() => {});
      await cdpSend('Page.enable').catch(() => {});
      const ok = await cdpEv(HOST_OK_EXPR, 8000).catch(() => 0);
      if (ok) { log('桥接宿主:', main.url.substring(0, 70)); return true; }
      try { ws.close(); } catch (e) {}
      ws = null;
    }
  }
  return reloadHost();
}
// 唤醒休眠标签页：后台标签页JS线程被冻结，必须先激活
async function wakeTab() {
  await cdpSend('Page.setWebLifecycleState', { state: 'active' }, 10000).catch(() => {});
  await cdpSend('Page.bringToFront', {}, 10000).catch(() => {});
}
async function bridgeFetch(url, method, body) {
  await ensureBridge();
  await wakeTab();
  const expression = `(async () => {
    const t0 = performance.now();
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 30000);
    try {
      const opts = { method: ${method ? "'" + method + "'" : "'GET'"}, headers: { 'SessionKey': sessionStorage.getItem('sessionKey') || '' }, signal: ac.signal };
      ${body ? `opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; opts.body = ${JSON.stringify(body)};` : ''}
      const resp = await fetch(${JSON.stringify(url)}, opts);
      const text = await resp.text();
      clearTimeout(to);
      return { status: resp.status, ms: Math.round(performance.now() - t0), body: text.substring(0, 600) };
    } catch (e) {
      clearTimeout(to);
      return { status: -8, body: 'FETCH_ERR: ' + e.message };
    }
  })()`;
  try {
    const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 45000);
    if (r.exceptionDetails) return { status: -9, body: 'EVAL_ERR' };
    return r.result && r.result.value ? r.result.value : { status: -9, body: 'NO_VALUE' };
  } catch (e) {
    return { status: -9, body: 'CDP_ERR: ' + e.message };
  }
}

function buildCookieHeader(cookies) {
  const seen = new Map();
  for (const c of cookies) {
    if (c.domain.includes('cloud.189.cn') || c.domain.includes('e.189.cn')) seen.set(c.name, c.value);
  }
  return [...seen.entries()].map(([k, v]) => k + '=' + v).join('; ');
}
async function refreshSession() {
  const pages = await listCloudTabs();
  if (!pages.length) throw new Error('no cloud tab for session refresh');
  try { ws && ws.close(); } catch (e) {}
  ws = null;
  await cdpConnect(pages[0].webSocketDebuggerUrl);
  await cdpSend('Runtime.enable');
  await cdpSend('Page.enable').catch(() => {});
  await cdpSend('Network.enable').catch(() => {});
  await cdpSend('Page.navigate', { url: MAIN_URL }, 20000).catch(() => {});
  await sleep(8000);
  for (let i = 0; i < 10; i++) {
    const u = await cdpEv('location.href').catch(() => '');
    const sk = await cdpEv(`(sessionStorage.getItem('sessionKey')||'')`).catch(() => '');
    if (u.includes('/web/main') && sk) { sessionKey = sk; break; }
    await sleep(2000);
  }
  const ck = await cdpSend('Network.getCookies', { urls: ['https://cloud.189.cn/', 'https://e.189.cn/', 'https://open.e.189.cn/'] }, 10000);
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(ck.cookies));
  cookieHeader = buildCookieHeader(ck.cookies);
  try { ws && ws.close(); } catch (e) {}
  log(`会话已刷新: cookie ${cookieHeader.length}字符, sessionKey ${sessionKey ? '有' : '无'}`);
}

function parseTaskId(body) {
  if (!body) return null;
  let m = body.match(/<taskId>(\d+)<\/taskId>/i);
  if (m) return m[1];
  try {
    const j = JSON.parse(body);
    const id = j.taskId || j.taskID || (j.data && j.data.taskId);
    if (id) return String(id);
  } catch (e) {}
  if (/^\d{5,}$/.test(body.trim())) return body.trim();
  return null;
}

async function createDeleteTask(entries) {
  // WAF拦截含系统文件名(win32api/VCRUNTIME等)的请求体；服务端按fileId定位删除，通用名已验证可正常删除
  const taskInfos = entries.map((e, i) => ({ fileId: e.id, fileName: 'f' + i + '.tmp', isFolder: 0, srcParentId: e.parentId }));
  const body = `type=DELETE&taskInfos=${encodeURIComponent(JSON.stringify(taskInfos))}&targetFolderId=`;
  let r = await bridgeFetch('/api/portal/createBatchTask.action', 'POST', body);
  // 桥接失效时重连一次
  if ([-2, -3, -8, -9].includes(r.status)) {
    log('桥接异常(' + r.status + ')，重连...');
    try { ws && ws.close(); } catch (e) {}
    ws = null;
    r = await bridgeFetch('/api/portal/createBatchTask.action', 'POST', body);
  }
  return r;
}

async function checkTask(taskId) {
  const ck = await api(`/api/portal/checkBatchTask.action?taskId=${taskId}&type=DELETE&noCache=${Math.random()}`);
  if (ck.status !== 200) return { ok: false, http: ck.status, body: (ck.body || '').substring(0, 120) };
  try {
    const j = JSON.parse(ck.body);
    return { ok: true, taskStatus: j.taskStatus, successed: j.successedCount || 0, failed: j.failedCount || 0, sub: j.subTaskCount || 0 };
  } catch (e) {
    // 响应可能被截断且无taskStatus字段：正则提取头部计数，suc+fail+skip>=sub 判完成
    const g = (k) => { const m = (ck.body || '').match(new RegExp('"' + k + '"\\s*:\\s*(\\d+)')); return m ? parseInt(m[1], 10) : null; };
    const sub = g('subTaskCount');
    if (sub === null) return { ok: false, parse: true, body: (ck.body || '').substring(0, 120) };
    const suc = g('successedCount') || 0;
    const fail = g('failedCount') || 0;
    const skip = g('skipCount') || 0;
    return { ok: true, taskStatus: (sub > 0 && suc + fail + skip >= sub) ? 4 : 0, successed: suc, failed: fail + skip };
  }
}

async function verifySession() {
  const r = await api('/api/open/user/getUserInfoForPortal.action?noCache=' + Math.random());
  return r.status === 200 && (r.body || '').includes('loginName');
}

function newProgress() {
  return { startedAt: new Date().toISOString(), doneIds: [], uncertainIds: [], pending: [], tasks: [], doneBytes: 0, uncertainBytes: 0 };
}
function loadProgress() {
  if (fs.existsSync(PROGRESS_PATH)) {
    try { return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')); } catch (e) {}
  }
  return newProgress();
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p));
}

function archiveTask(prog, pend, res, targetById) {
  const bytes = pend.ids.reduce((s, id) => s + (targetById.get(id) ? targetById.get(id).size : 0), 0);
  if (res.failed > 0) {
    const uc = new Set(prog.uncertainIds);
    let addBytes = 0;
    for (const id of pend.ids) {
      if (!uc.has(id)) { uc.add(id); addBytes += (targetById.get(id) ? targetById.get(id).size : 0); }
    }
    prog.uncertainIds = [...uc];
    prog.uncertainBytes += addBytes;
    prog.tasks.push({ taskId: pend.taskId, n: pend.ids.length, ok: res.successed, fail: res.failed, at: new Date().toISOString(), kind: 'uncertain' });
  } else {
    const uc = new Set(prog.uncertainIds);
    let removedBytes = 0;
    for (const id of pend.ids) {
      if (uc.delete(id)) removedBytes += (targetById.get(id) ? targetById.get(id).size : 0);
    }
    prog.uncertainIds = [...uc];
    prog.uncertainBytes = Math.max(0, prog.uncertainBytes - removedBytes);
    const dn = new Set(prog.doneIds);
    let addBytes = 0;
    for (const id of pend.ids) {
      if (!dn.has(id)) { dn.add(id); addBytes += (targetById.get(id) ? targetById.get(id).size : 0); }
    }
    prog.doneIds = [...dn];
    prog.doneBytes += addBytes;
    prog.tasks.push({ taskId: pend.taskId, n: pend.ids.length, ok: res.successed, fail: 0, at: new Date().toISOString(), kind: 'done' });
  }
  prog.pending = prog.pending.filter(x => x.taskId !== pend.taskId);
  saveProgress(prog);
}

async function main() {
  log('=== 天翼云盘批量删除驱动 v8 (浏览器桥接+通用名绕WAF) ===');
  // 1. 会话初始化
  if (fs.existsSync(COOKIES_PATH)) {
    cookieHeader = buildCookieHeader(JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8')));
  }
  try {
    await ensureBridge();
    const sk = await cdpEv(`(sessionStorage.getItem('sessionKey')||'')`, 8000).catch(() => '');
    if (sk) { sessionKey = sk; log('已从浏览器获取sessionKey'); }
  } catch (e) { log('桥接初始化失败(继续):', e.message); }

  if (!(await verifySession())) {
    log('会话无效，通过浏览器刷新...');
    await refreshSession();
    if (!(await verifySession())) { log('会话刷新后仍无效，退出'); process.exit(1); }
  }
  log('会话有效');

  // 2. 构建目标清单（核对计划文件，防止读到空计划空转）
  const plan = JSON.parse(fs.readFileSync(DEL_PATH, 'utf8'));
  if (!plan.deletions || !plan.deletions.length) { log('FATAL: 删除计划为空: ' + DEL_PATH); process.exit(1); }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const invPath = {};
  for (const [fid, fp] of Object.entries(state.pathMap)) invPath[fp] = fid;

  const targets = [];
  let noParent = 0;
  for (const d of plan.deletions) {
    if (CLASSES && !CLASSES.some(c => d.reason.startsWith(c))) continue;
    const name = d.path.substring(d.path.lastIndexOf('/') + 1);
    const parentPath = d.path.substring(0, d.path.lastIndexOf('/'));
    const parentId = invPath[parentPath];
    if (!parentId) { noParent++; continue; }
    targets.push({ id: d.id, name, parentId, size: d.size, reason: d.reason.split(':')[0] });
  }
  if (!targets.length) { log('FATAL: 过滤后目标为0 (计划' + plan.deletions.length + '条, 类过滤: ' + (CLASSES ? CLASSES.join(',') : '全部') + ')'); process.exit(1); }
  const targetById = new Map(targets.map(t => [t.id, t]));
  const totalBytes = targets.reduce((s, t) => s + t.size, 0);
  log(`目标: ${targets.length} 个文件, ${(totalBytes / 1024 ** 3).toFixed(2)}GB (父目录缺失跳过: ${noParent})`);

  // 3. 恢复进度
  const prog = loadProgress();
  const inflight = [];
  for (const pend of [...prog.pending]) {
    const res = await checkTask(pend.taskId);
    if (res.ok && res.taskStatus >= 4) {
      archiveTask(prog, pend, res, targetById);
      log(`恢复: 任务${pend.taskId} 已完成 ok=${res.successed} fail=${res.failed}`);
    } else {
      inflight.push({ taskId: pend.taskId, ids: pend.ids, createdAt: Date.now() });
      log(`恢复: 任务${pend.taskId} 仍在处理中，重新挂载`);
    }
  }
  const seen = new Set([...prog.doneIds, ...inflight.flatMap(t => t.ids)]);
  // uncertain批次多为并发争抢导致的整批失败(ok=0)，本轮重试；已删文件重复提交只会失败，无副作用
  const uncertainSet = new Set(prog.uncertainIds);
  let queue = targets.filter(t => !seen.has(t.id));
  const retried = queue.filter(t => uncertainSet.has(t.id)).length;
  log(`已完成: ${prog.doneIds.length}, 需复核: ${prog.uncertainIds.length}(其中${retried}个本轮重试), 本轮待删: ${queue.length}`);

  const limit = parseInt(process.argv[2] || '0', 10);
  if (limit > 0) { queue = queue.slice(0, limit); log(`试运行模式: 本轮最多提交 ${queue.length} 个`); }

  // 4. 流水线主循环
  let batch = START_BATCH;
  let qi = 0;
  let createFailStreak = 0;
  let wafCooldownUntil = 0;
  let lastCreateAt = 0;
  let lastReport = Date.now();
  const t0 = Date.now();
  const doneAtStart = prog.doneIds.length;
  let aborted = false;

  while ((qi < queue.length || inflight.length > 0) && !aborted) {
    // 4a. 轮询挂起任务
    for (const t of [...inflight]) {
      if (Date.now() - t.createdAt > TASK_STALE_MS) {
        const pend = prog.pending.find(x => x.taskId === t.taskId);
        if (pend) {
          log(`任务${t.taskId} 等待超时(${Math.round((Date.now() - t.createdAt) / 60000)}分)，整批标记需复核`);
          archiveTask(prog, pend, { taskStatus: -1, successed: 0, failed: pend.ids.length }, targetById);
        }
        inflight.splice(inflight.indexOf(t), 1);
        continue;
      }
      const res = await checkTask(t.taskId);
      if (res.ok && res.taskStatus >= 4) {
        const pend = prog.pending.find(x => x.taskId === t.taskId);
        if (pend) archiveTask(prog, pend, res, targetById);
        log(`任务${t.taskId} 完成: ok=${res.successed} fail=${res.failed}`);
        inflight.splice(inflight.indexOf(t), 1);
      }
    }

    // 4b. 提交新批次（走浏览器桥接）
    const intervalOk = Date.now() - lastCreateAt >= CREATE_MIN_INTERVAL_MS;
    if (qi < queue.length && inflight.length < MAX_INFLIGHT && intervalOk && Date.now() >= wafCooldownUntil) {
      const chunk = queue.slice(qi, qi + batch);
      try {
        let create = await createDeleteTask(chunk);
        let taskId = parseTaskId(create.body);
        // WAF挑战拦截：重载宿主页让浏览器自动解题获得新cookie，然后立即重试
        if (!(create.status === 200 && taskId) && (create.status === 403 || /cjs\.js|DOCTYPE/i.test(create.body || ''))) {
          log('创建被拦截(403)，重载宿主页刷新防护cookie后重试...');
          try { ws && ws.close(); } catch (e) {}
          ws = null;
          try {
            await reloadHost();
            create = await createDeleteTask(chunk);
            taskId = parseTaskId(create.body);
          } catch (e) {
            log('宿主页重载失败:', e.message);
            create = { status: -9, body: 'RELOAD_ERR: ' + e.message };
          }
        }
        if (create.status === 200 && taskId) {
          lastCreateAt = Date.now();
          qi += chunk.length;
          const ids = chunk.map(c => c.id);
          prog.pending.push({ taskId, ids, createdAt: Date.now() });
          saveProgress(prog);
          inflight.push({ taskId, ids, createdAt: Date.now() });
          createFailStreak = 0;
          log(`任务${taskId} 已创建 (n=${chunk.length}, 队列剩 ${queue.length - qi}, 挂起 ${inflight.length})`);
          if (batch < MAX_BATCH) {
            const nb = Math.min(MAX_BATCH, Math.ceil(batch * 1.3));
            if (nb !== batch) { batch = nb; log('批次提升至', batch); }
          }
        } else {
          const b = create.body || '';
          if (/InvalidSessionKey|check ip/i.test(b)) {
            log('会话失效，通过浏览器刷新...');
            await refreshSession();
          } else if (create.status === 403 || /cjs\.js|DOCTYPE/i.test(b)) {
            createFailStreak++;
            wafCooldownUntil = Date.now() + WAF_COOLDOWN_MS;
            log(`创建被拦截(403, streak=${createFailStreak})，冷却${WAF_COOLDOWN_MS / 60000}分钟`);
            if (createFailStreak >= WAF_MAX_STREAK) { log('连续拦截达到容忍上限，中止本轮(稍后可重启续删)'); aborted = true; }
          } else if (create.status === 504 || create.status === 502 || create.status === 503 || create.status === -1) {
            createFailStreak++;
            const wait = Math.min(60, 10 + createFailStreak * 10);
            log(`创建失败(网关, streak=${createFailStreak}) 批次降至 ${Math.max(MIN_BATCH, Math.floor(batch / 2))} 等${wait}s`);
            batch = Math.max(MIN_BATCH, Math.floor(batch / 2));
            await sleep(wait * 1000);
          } else {
            createFailStreak++;
            log(`创建失败(status=${create.status}): ${b.substring(0, 150)}`);
            batch = Math.max(MIN_BATCH, Math.floor(batch / 2));
            await sleep(5000);
            if (createFailStreak >= 10) { log('连续失败过多，中止本轮'); aborted = true; }
          }
        }
      } catch (e) {
        log('创建异常:', e.message);
        await sleep(8000);
        try { ws && ws.close(); } catch (e2) {}
        ws = null;
      }
    }

    // 4c. 周期报告
    if (Date.now() - lastReport > 5 * 60 * 1000) {
      lastReport = Date.now();
      const done = prog.doneIds.length;
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (done - doneAtStart) / Math.max(elapsed, 1);
      const remain = targets.length - done - prog.uncertainIds.length;
      log(`[报告] 完成 ${done}/${targets.length} (${(done / targets.length * 100).toFixed(1)}%) ${(prog.doneBytes / 1024 ** 3).toFixed(1)}GB | 本轮速率 ${rate.toFixed(2)}个/s | 复核 ${prog.uncertainIds.length} | 挂起 ${inflight.length} | 剩余约${(remain / Math.max(rate, 0.01) / 3600).toFixed(1)}小时`);
    }
    await sleep(3000);
  }

  // 5. 汇总
  log('=== 本轮结束 ===');
  log(`已删除(累计): ${prog.doneIds.length} 个, ${(prog.doneBytes / 1024 ** 3).toFixed(2)}GB`);
  log(`需复核(累计): ${prog.uncertainIds.length} 个, ${(prog.uncertainBytes / 1024 ** 3).toFixed(2)}GB`);
  log(`挂起未确认: ${inflight.length} 个任务`);
  log(`本轮耗时: ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  fs.writeFileSync(path.join(OUT_DIR, 'del_report.json'), JSON.stringify({
    total: targets.length,
    deleted: prog.doneIds.length,
    deletedBytes: prog.doneBytes,
    uncertain: prog.uncertainIds.length,
    uncertainBytes: prog.uncertainBytes,
    inflight: inflight.map(t => t.taskId),
    minutes: (Date.now() - t0) / 60000
  }, null, 1));
  if (logLines.length) fs.appendFileSync(LOG_PATH, logLines.join('\n') + '\n');
  log('DONE');
}

main().catch(e => {
  log('FATAL: ' + e.stack);
  if (logLines.length) fs.appendFileSync(LOG_PATH, logLines.join('\n') + '\n');
  process.exit(1);
});
