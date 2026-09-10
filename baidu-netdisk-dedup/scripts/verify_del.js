// 删除放行快速验证：按前端真实请求格式（filelist 为纯路径字符串数组）删除计划中最小文件
// 用法: node verify_del.js   在工作目录运行（删除 deletions.json 中一个文件，errno=0 即放行）
// 场景: 遇到 errno 132 或刚完成手动验证后，快速确认删除接口是否放行
const fs = require('fs');
const path = require('path');
const CDP_HTTP = 'http://127.0.0.1:9222';
const OUT_DIR = process.cwd();

let ws = null, msgSeq = 0;
const pending = new Map();

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
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, timeoutMs = 120000) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).substring(0, 400));
  return r.result ? r.result.value : undefined;
}

async function main() {
  const plan = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'deletions.json'), 'utf8'));
  const sorted = [...plan].sort((a, b) => a.size - b.size);
  const target = sorted[0];
  console.log('test target:', target.path, '(' + target.size + 'B)');

  const targets = await (await fetch(CDP_HTTP + '/json/list')).json();
  const t = targets.find(t => t.type === 'page' && t.url.includes('pan.baidu.com'));
  if (!t) { console.error('no pan tab'); process.exit(1); }
  await connect(t.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable').catch(() => {});
  await send('Page.setWebLifecycleState', { state: 'active' }, 10000).catch(() => {});
  await send('Page.bringToFront', {}, 10000).catch(() => {});

  const bdst = await evaluate(`fetch('https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=%5B%22bdstoken%22%5D', {credentials:'include'}).then(r => r.json()).then(j => (j && j.result && j.result.bdstoken) || null)`, 30000);
  console.log('bdstoken:', bdst);
  const dpLogid = String(Date.now()) + String(Math.floor(Math.random() * 100000));

  // 前端真实格式：filelist 为纯路径字符串数组，bdstoken 在 URL，newVerify=1
  const filelist = JSON.stringify([target.path]);
  const expr = `(async () => {
    const body = 'filelist=' + encodeURIComponent(${JSON.stringify(filelist)});
    const url = 'https://pan.baidu.com/api/filemanager?async=2&onnest=fail&opera=delete&bdstoken=' + encodeURIComponent(${JSON.stringify(bdst)}) + '&newVerify=1&clienttype=0&app_id=250528&web=1&dp-logid=' + ${JSON.stringify(dpLogid)};
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*'
      },
      body: body
    });
    const text = await resp.text();
    return { status: resp.status, resp: text.substring(0, 500) };
  })()`;
  console.log('--- delete with real format ---');
  const r1 = await evaluate(expr, 60000);
  console.log(JSON.stringify(r1));

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
