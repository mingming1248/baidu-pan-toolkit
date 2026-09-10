// 共享 CDP 连接工具库：连接调试实例、执行页面内 fetch、取 bdstoken
// 用法: const { connect, evalJs, getBdst, listDir, scanTree } = require('./cdp_common');
const CDP_HTTP = 'http://127.0.0.1:9222'; // 默认端口，脚本可覆盖

let ws = null, msgSeq = 0;
const pending = new Map();

function connect(port) {
  const base = 'http://127.0.0.1:' + port;
  return (async () => {
    let targets = null;
    for (let i = 0; i < 20; i++) {
      try {
        targets = await (await fetch(base + '/json/list')).json();
        if (targets.length) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!targets || !targets.length) throw new Error(port + ' 实例未就绪');
    let t = targets.find(t => t.type === 'page' && t.url.includes('pan.baidu.com'));
    if (!t) t = targets.find(t => t.type === 'page');
    return new Promise((resolve, reject) => {
      const s = new WebSocket(t.webSocketDebuggerUrl);
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
  })();
}

function send(method, params = {}, timeoutMs = 120000) {
  if (!ws || ws.readyState !== 1) return Promise.reject(new Error('ws not open'));
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression, timeoutMs = 60000) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).substring(0, 300));
  return r.result ? r.result.value : undefined;
}

async function getBdst() {
  return await evalJs(`fetch('https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=%5B%22bdstoken%22%5D', {credentials:'include'}).then(r => r.json()).then(j => (j && j.result && j.result.bdstoken) || null)`, 30000);
}

async function listDir(dir, page) {
  const r = await evalJs(`(async () => {
    const resp = await fetch('https://pan.baidu.com/api/list?channel=chunlei&clienttype=0&web=1&app_id=250528&num=1000&order=name&desc=0&showempty=0&dir=' + encodeURIComponent(${JSON.stringify(dir)}) + '&page=' + ${JSON.stringify(page)}, { credentials: 'include' });
    const j = await resp.json();
    if (j.errno !== 0) return { err: j.errno };
    return { items: (j.list || []).map(x => ({ name: x.server_filename, fs_id: x.fs_id, isdir: x.isdir, size: x.size, md5: x.md5 || null })) };
  })()`, 60000);
  return r;
}

// 递归扫描整棵目录树，返回全部文件与目录
async function scanTree(rootDir) {
  const files = [];
  const dirs = [];
  const queue = [rootDir];
  const seen = new Set([rootDir]);
  while (queue.length) {
    const dir = queue.shift();
    let page = 1;
    while (true) {
      const r = await listDir(dir, page);
      if (r.err || !r.items) { console.log('LIST ERR', dir, r.err); break; }
      for (const it of r.items) {
        const p = (dir === '/' ? '/' : dir + '/') + it.name;
        if (it.isdir) { dirs.push({ path: p, fs_id: it.fs_id, name: it.name }); if (!seen.has(p)) { seen.add(p); queue.push(p); } }
        else files.push({ path: p, fs_id: it.fs_id, name: it.name, size: it.size, md5: it.md5 });
      }
      if (r.items.length < 1000) break;
      page++;
      if (page > 30) break;
    }
  }
  return { files, dirs };
}

module.exports = { connect, send, evalJs, getBdst, listDir, scanTree, CDP_HTTP };
