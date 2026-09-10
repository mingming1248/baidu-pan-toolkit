// 百度网盘全请求抓包（CDP）：抓取所有 pan.baidu.com API 请求，对比前端真实删除请求
// 用法: node net_capture.js   然后在调试窗口手动删除一个文件（90秒窗口）
const CDP_HTTP = 'http://127.0.0.1:9222';

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
      if (m.method && m.method.startsWith('Network.')) handleNet(m);
    };
  });
}

function send(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++msgSeq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
    pending.set(id, { res: (v) => { clearTimeout(timer); resolve(v); }, rej: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const printed = new Set();
function handleNet(m) {
  try {
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      if (!r.url || !r.url.includes('pan.baidu.com/api/')) return;
      const reqId = m.params.requestId;
      if (printed.has(reqId)) return;
      printed.add(reqId);
      // 打印所有写操作(POST/PUT)和 filemanager/task/verify 相关请求
      const interesting = r.method !== 'GET' || /filemanager|task|verify|safesign|auth|recycle/i.test(r.url);
      if (!interesting) return;
      console.log('\n================= REQ =================');
      console.log('METHOD:', r.method);
      console.log('URL:', r.url);
      console.log('HEADERS:', JSON.stringify(r.headers || {}, null, 1));
      if (r.postData) console.log('POSTDATA:', r.postData);
    }
    if (m.method === 'Network.responseReceived') {
      const resp = m.params.response;
      if (!resp.url || !resp.url.includes('pan.baidu.com/api/')) return;
      if (/filemanager|task|verify|recycle/i.test(resp.url)) {
        console.log('RESP:', resp.status, resp.url);
      }
    }
  } catch (e) { console.log('err:', e.message); }
}

async function main() {
  const targets = await (await fetch(CDP_HTTP + '/json/list')).json();
  const t = targets.find(t => t.type === 'page' && t.url.includes('pan.baidu.com'));
  if (!t) { console.error('no pan tab'); process.exit(1); }
  await connect(t.webSocketDebuggerUrl);
  await send('Network.enable');
  await send('Page.setWebLifecycleState', { state: 'active' }, 10000).catch(() => {});
  await send('Page.bringToFront', {}, 10000).catch(() => {});
  console.log('=== 抓包中（90秒）：请在调试窗口手动删除一个文件 ===');
  await new Promise(resolve => setTimeout(resolve, 90000));
  console.log('=== 抓包结束 ===');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
