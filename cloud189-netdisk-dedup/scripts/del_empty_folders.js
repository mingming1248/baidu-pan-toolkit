// 空文件夹清理：三阶段 plan / run / verify
// 原理：folder 成为"空壳" = 原 subtree 有文件 && 删除后 subtree 剩余文件为 0
// 只删因本次清理而变空的文件夹（保留用户原本就空的文件夹），且只删最大层级的空壳（父递归删除子）
// 用法: node del_empty_folders.js plan|run|verify
//   依赖: inv.jsonl(全盘清单) + del_progress.json(文件删除进度 doneIds)
const fs = require('fs');
const path = require('path');

const DIR = process.cwd();
const INV_PATH = path.join(DIR, 'inv.jsonl');
const PROGRESS_PATH = path.join(DIR, 'del_progress.json');
const FOLDER_PLAN_PATH = path.join(DIR, 'empty_folders.json');
const FOLDER_PROG_PATH = path.join(DIR, 'del_folders_progress.json');
const FOLDER_LOG_PATH = path.join(DIR, 'del_folders.log');
const CDP_HTTP = 'http://127.0.0.1:9222';
const MAIN_URL = 'https://cloud.189.cn/web/main/file/folder/-11';

const SYSTEM_IDS = new Set(['0', '-11', '-12', '-13', '-14', '-15', '-16', '-17', '-18']);
const FOLDER_BATCH = 40;

const logLines = [];
const log = (...a) => {
  const line = new Date().toISOString().substring(11, 19) + ' ' + a.join(' ');
  console.log(line);
  logLines.push(line);
  if (logLines.length > 100) { fs.appendFileSync(FOLDER_LOG_PATH, logLines.splice(0, 100).join('\n') + '\n'); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============ 加载全盘清单 ============
function loadInventory() {
  const folders = new Map(); // path -> {id, parentPath}
  const filesByFolder = new Map(); // folderPath -> {orig}
  const text = fs.readFileSync(INV_PATH, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    for (const f of (j.folders || [])) {
      if (!folders.has(f.path)) folders.set(f.path, { id: String(f.id), parentPath: f.path.substring(0, f.path.lastIndexOf('/')) });
    }
    for (const f of (j.files || [])) {
      const fp = f.path.substring(0, f.path.lastIndexOf('/'));
      if (!filesByFolder.has(fp)) filesByFolder.set(fp, { orig: 0 });
      filesByFolder.get(fp).orig++;
    }
  }
  return { folders, filesByFolder };
}

// ============ CDP 桥接（与删除驱动同模式） ============
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
async function reloadHost() {
  const pages = await listCloudTabs();
  if (!pages.length) throw new Error('no cloud tab');
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
    if (u.includes('/web/main') && skLen > 0) { log('宿主页已就绪'); return true; }
  }
  throw new Error('host reload timeout');
}
async function ensureBridge() {
  if (ws && ws.readyState === 1) {
    const ok = await cdpEv(`(location.href.includes('/web/main') && (sessionStorage.getItem('sessionKey')||'').length > 0) ? 1 : 0`, 8000).catch(() => 0);
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
      const ok = await cdpEv(`(location.href.includes('/web/main') && (sessionStorage.getItem('sessionKey')||'').length > 0) ? 1 : 0`, 8000).catch(() => 0);
      if (ok) return true;
      try { ws.close(); } catch (e) {}
      ws = null;
    }
  }
  return reloadHost();
}
async function bridgeFetch(url, method, body) {
  await ensureBridge();
  await cdpSend('Page.setWebLifecycleState', { state: 'active' }, 10000).catch(() => {});
  await cdpSend('Page.bringToFront', {}, 10000).catch(() => {});
  const expression = `(async () => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 30000);
    try {
      const opts = { method: '${method}', headers: { 'SessionKey': sessionStorage.getItem('sessionKey') || '' }, signal: ac.signal };
      ${body ? `opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; opts.body = ${JSON.stringify(body)};` : ''}
      const resp = await fetch(${JSON.stringify(url)}, opts);
      const text = await resp.text();
      clearTimeout(to);
      return { status: resp.status, body: text.substring(0, 600) };
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

// ============ Phase 1: 计算空壳文件夹 ============
function computePlan() {
  const { folders, filesByFolder } = loadInventory();
  const prog = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  const deletedIds = new Set(prog.doneIds.map(String));

  // 逐文件统计删除后每文件夹剩余文件数
  const text = fs.readFileSync(INV_PATH, 'utf8');
  const remainByFolder = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    for (const f of (j.files || [])) {
      const fp = f.path.substring(0, f.path.lastIndexOf('/'));
      if (!remainByFolder.has(fp)) remainByFolder.set(fp, 0);
      if (!deletedIds.has(String(f.id))) remainByFolder.set(fp, remainByFolder.get(fp) + 1);
    }
  }

  // 构建树：children
  const children = new Map(); // parentPath -> [paths]
  for (const p of folders.keys()) {
    const info = folders.get(p);
    if (!children.has(info.parentPath)) children.set(info.parentPath, []);
    children.get(info.parentPath).push(p);
  }

  // 后序遍历累计 subtree orig/remain（memo）
  const memo = new Map(); // path -> {orig, remain}
  function acc(p) {
    if (memo.has(p)) return memo.get(p);
    const directOrig = (filesByFolder.get(p) || { orig: 0 }).orig;
    const directRemain = remainByFolder.get(p) || 0;
    let orig = directOrig, remain = directRemain;
    for (const c of (children.get(p) || [])) {
      const sub = acc(c);
      orig += sub.orig;
      remain += sub.remain;
    }
    const v = { orig, remain };
    memo.set(p, v);
    return v;
  }
  const roots = [...folders.keys()].filter(p => {
    const pp = folders.get(p).parentPath;
    return pp === '' || !folders.has(pp);
  });
  for (const r of roots) acc(r);

  // S = remain==0 && orig>0（因清理而空），排除系统目录
  const S = new Set();
  for (const [p, v] of memo) {
    if (v.remain === 0 && v.orig > 0) {
      const id = folders.get(p).id;
      if (!SYSTEM_IDS.has(id)) S.add(p);
    }
  }
  // 只保留最大层级（父不在 S 中）
  const maximal = [...S].filter(p => !S.has(folders.get(p).parentPath));
  const out = maximal.map(p => {
    const info = folders.get(p);
    const pp = info.parentPath;
    const parentId = pp === '' ? '-11' : (folders.has(pp) ? folders.get(pp).id : '-11');
    return { id: info.id, path: p, parentId, origFiles: memo.get(p).orig };
  });
  out.sort((a, b) => b.path.split('/').length - a.path.split('/').length);

  // 统计信息
  let userEmpty = 0;
  for (const [p, v] of memo) {
    if (v.orig === 0 && v.remain === 0 && !SYSTEM_IDS.has(folders.get(p).id)) userEmpty++;
  }
  const summary = {
    totalFolders: folders.size,
    emptiedShells: S.size,
    maximalToDelete: out.length,
    preExistingEmpty: userEmpty,
    computedAt: new Date().toISOString(),
    deletedFilesCount: deletedIds.size
  };
  fs.writeFileSync(FOLDER_PLAN_PATH, JSON.stringify({ summary, folders: out }, null, 1));
  log(`全盘文件夹 ${folders.size} 个 | 因清理变空 ${S.size} 个 | 待删(最大层级) ${out.length} 个 | 原本就空(保留) ${userEmpty} 个`);
  log(`样例:`);
  for (const f of out.slice(0, 8)) log(`  [${f.id}] ${f.path} (原有${f.origFiles}文件)`);
  return out;
}

// ============ Phase 2: 删除空壳文件夹 ============
function parseTaskId(body) {
  if (!body) return null;
  const m = body.match(/<taskId>(\d+)<\/taskId>/i);
  if (m) return m[1];
  try {
    const j = JSON.parse(body);
    const id = j.taskId || j.taskID || (j.data && j.data.taskId);
    if (id) return String(id);
  } catch (e) {}
  return null;
}
async function checkTask(taskId) {
  const r = await bridgeFetch(`/api/portal/checkBatchTask.action?taskId=${taskId}&type=DELETE&noCache=${Math.random()}`, 'GET', null);
  if (r.status !== 200) return { ok: false, http: r.status };
  // 响应体会被截断，用正则提取头部字段（响应无taskStatus字段，完成=succeeded+failed+skipped>=subTaskCount）
  const g = (k) => { const m = (r.body || '').match(new RegExp('"' + k + '"\\s*:\\s*(\\d+)')); return m ? parseInt(m[1], 10) : null; };
  const sub = g('subTaskCount');
  if (sub === null) return { ok: false, parse: true };
  const suc = g('successedCount') || 0;
  const fail = g('failedCount') || 0;
  const skip = g('skipCount') || 0;
  const done = sub > 0 && suc + fail + skip >= sub;
  return { ok: true, taskStatus: done ? 4 : 0, successed: suc, failed: fail + skip };
}
async function runDeletion() {
  const plan = JSON.parse(fs.readFileSync(FOLDER_PLAN_PATH, 'utf8'));
  const targets = plan.folders;
  log(`=== 空文件夹清理: ${targets.length} 个 ===`);

  let prog = { doneIds: [], uncertainIds: [], pending: [], tasks: [] };
  if (fs.existsSync(FOLDER_PROG_PATH)) {
    try { prog = JSON.parse(fs.readFileSync(FOLDER_PROG_PATH, 'utf8')); } catch (e) {}
  }
  const doneSet = new Set(prog.doneIds.map(String));

  // 恢复挂起任务（在途任务等待完成，最多重试30轮）
  for (let round = 0; round < 30 && prog.pending.length; round++) {
    for (const pend of [...prog.pending]) {
      const res = await checkTask(pend.taskId);
      if (res.ok && res.taskStatus >= 4) {
        if (res.failed > 0) { prog.uncertainIds.push(...pend.ids); prog.tasks.push({ taskId: pend.taskId, n: pend.ids.length, ok: res.successed, fail: res.failed, at: new Date().toISOString(), kind: 'uncertain' }); }
        else { prog.doneIds.push(...pend.ids); prog.tasks.push({ taskId: pend.taskId, n: pend.ids.length, ok: res.successed, fail: 0, at: new Date().toISOString(), kind: 'done' }); }
        prog.pending = prog.pending.filter(x => x.taskId !== pend.taskId);
        log(`恢复: 任务${pend.taskId} ok=${res.successed} fail=${res.failed}`);
      }
    }
    if (prog.pending.length) {
      log(`恢复: ${prog.pending.length} 个任务仍在处理，等待10秒(第${round + 1}轮)`);
      fs.writeFileSync(FOLDER_PROG_PATH, JSON.stringify(prog));
      await sleep(10000);
    }
  }
  fs.writeFileSync(FOLDER_PROG_PATH, JSON.stringify(prog));

  const uncertainSet = new Set(prog.uncertainIds.map(String));
  let queue = targets.filter(t => !doneSet.has(String(t.id)));
  log(`已完成: ${prog.doneIds.length}, 需复核: ${prog.uncertainIds.length}(重试${queue.filter(t => uncertainSet.has(String(t.id))).length}), 本轮: ${queue.length}`);

  let qi = 0, failStreak = 0, lastCreateAt = 0;
  while (qi < queue.length) {
    if (Date.now() - lastCreateAt < 8000) { await sleep(1000); continue; }
    const chunk = queue.slice(qi, qi + FOLDER_BATCH);
    const taskInfos = chunk.map((c, i) => ({ fileId: c.id, fileName: 'd' + i + '.tmp', isFolder: 1, srcParentId: c.parentId }));
    const body = `type=DELETE&taskInfos=${encodeURIComponent(JSON.stringify(taskInfos))}&targetFolderId=`;
    let r = await bridgeFetch('/api/portal/createBatchTask.action', 'POST', body);
    if ([-2, -3, -8, -9].includes(r.status)) {
      log('桥接异常，重连...');
      try { ws && ws.close(); } catch (e) {}
      ws = null;
      r = await bridgeFetch('/api/portal/createBatchTask.action', 'POST', body);
    }
    let taskId = parseTaskId(r.body);
    if (!(r.status === 200 && taskId) && (r.status === 403 || /cjs\.js|DOCTYPE/i.test(r.body || ''))) {
      log('403拦截，重载宿主页...');
      try { ws && ws.close(); } catch (e) {}
      ws = null;
      try { await reloadHost(); r = await bridgeFetch('/api/portal/createBatchTask.action', 'POST', body); taskId = parseTaskId(r.body); } catch (e) { log('重载失败:', e.message); }
    }
    if (r.status === 200 && taskId) {
      lastCreateAt = Date.now();
      qi += chunk.length;
      prog.pending.push({ taskId, ids: chunk.map(c => c.id), createdAt: Date.now() });
      fs.writeFileSync(FOLDER_PROG_PATH, JSON.stringify(prog));
      log(`任务${taskId} 已创建 (n=${chunk.length}, 剩 ${queue.length - qi})`);
      failStreak = 0;
      // 轮询等待完成（串行）
      let done = false;
      for (let i = 0; i < 60 && !done; i++) {
        await sleep(5000);
        const res = await checkTask(taskId);
        if (res.ok && res.taskStatus >= 4) {
          if (res.failed > 0) {
            prog.uncertainIds.push(...chunk.map(c => c.id));
            prog.tasks.push({ taskId, n: chunk.length, ok: res.successed, fail: res.failed, at: new Date().toISOString(), kind: 'uncertain' });
            log(`任务${taskId} 部分失败: ok=${res.successed} fail=${res.failed}`);
          } else {
            prog.doneIds.push(...chunk.map(c => c.id));
            prog.tasks.push({ taskId, n: chunk.length, ok: res.successed, fail: 0, at: new Date().toISOString(), kind: 'done' });
            log(`任务${taskId} 完成: ok=${res.successed}`);
          }
          prog.pending = prog.pending.filter(x => x.taskId !== taskId);
          fs.writeFileSync(FOLDER_PROG_PATH, JSON.stringify(prog));
          done = true;
        }
      }
      if (!done) log(`任务${taskId} 等待超时，下轮恢复时确认`);
    } else {
      failStreak++;
      log(`创建失败(status=${r.status}): ${(r.body || '').substring(0, 120)}`);
      if (failStreak >= 8) { log('连续失败过多，中止（可重跑续删）'); break; }
      await sleep(15000);
    }
  }
  log(`=== 结束: 已删 ${prog.doneIds.length} 个文件夹, 需复核 ${prog.uncertainIds.length} 个 ===`);
  if (logLines.length) fs.appendFileSync(FOLDER_LOG_PATH, logLines.join('\n') + '\n');
}

// ============ Phase 3: 验证 ============
async function verify() {
  const plan = JSON.parse(fs.readFileSync(FOLDER_PLAN_PATH, 'utf8'));
  const prog = JSON.parse(fs.readFileSync(FOLDER_PROG_PATH, 'utf8'));
  const doneSet = new Set(prog.doneIds.map(String));
  const done = plan.folders.filter(f => doneSet.has(String(f.id)));
  const sample = [];
  const pool = [...done];
  for (let i = 0; i < 20 && pool.length; i++) sample.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  log(`抽查 ${sample.length} 个已删文件夹`);

  await ensureBridge();
  let gone = 0, still = 0, err = 0;
  for (const s of sample) {
    const r = await bridgeFetch(`/api/open/file/listFiles.action?folderId=${s.parentId}&pageSize=200&pageNum=1&mediaType=0&iconOption=5&orderBy=lastOpTime&descending=true`, 'GET', null);
    if (r.status !== 200) { err++; log(`目录${s.parentId} 查询失败 status=${r.status}`); continue; }
    const idRe = /<id>(\d+)<\/id>/g;
    const ids = [];
    let m;
    while ((m = idRe.exec(r.body)) !== null) ids.push(m[1]);
    if (ids.includes(s.id)) { still++; log(`仍存在! [${s.id}] ${s.path}`); }
    else gone++;
    await sleep(600);
  }
  log(`=== 验证: 已消失 ${gone} | 仍存在 ${still} | 异常 ${err} ===`);
}

(async () => {
  const mode = process.argv[2] || 'plan';
  try {
    if (mode === 'plan') computePlan();
    else if (mode === 'run') await runDeletion();
    else if (mode === 'verify') await verify();
    else console.log('用法: node del_empty_folders.js plan|run|verify');
  } catch (e) {
    log('FATAL: ' + e.stack);
    if (logLines.length) fs.appendFileSync(FOLDER_LOG_PATH, logLines.join('\n') + '\n');
    process.exit(1);
  }
  if (logLines.length) fs.appendFileSync(FOLDER_LOG_PATH, logLines.join('\n') + '\n');
  process.exit(0);
})();
