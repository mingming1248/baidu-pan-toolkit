// Step 7 注销验证：检查源账号登录态是否失效
// 用法: node verify_account_deleted.js <端口>
// 信号: bdstoken 空、list errno -6、quota errno -6、userinfo 失效、页面跳转 login → 注销成功
const { connect, send, evalJs } = require('./cdp_common');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const port = parseInt(process.argv[2] || '9223', 10);
  let targets = null;
  for (let i = 0; i < 15; i++) {
    try {
      targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      if (targets.length) break;
    } catch (e) {}
    await sleep(2000);
  }
  if (!targets || !targets.length) { console.log(port + ' 实例未就绪'); process.exit(1); }
  console.log('实例已就绪, 标签页:', targets.filter(t => t.type === 'page').map(t => t.url).join(' | '));

  await connect(port);
  await send('Page.enable').catch(() => {});
  await send('Page.setWebLifecycleState', { state: 'active' }, 10000).catch(() => {});
  await send('Page.bringToFront', {}, 10000).catch(() => {});

  // 导航到网盘首页，看是否跳登录
  await send('Page.navigate', { url: 'https://pan.baidu.com/disk/main' });
  await sleep(10000);
  const url = await evalJs('location.href', 10000);
  console.log('当前页面:', url);

  const r = await evalJs(`(async () => {
    const out = {};
    try {
      const r1 = await fetch('https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=%5B%22bdstoken%22%5D', { credentials: 'include' });
      const j1 = await r1.json();
      out.bdstoken = j1 && j1.result ? j1.result.bdstoken : null;
      out.tplErrno = j1 && j1.errno;
    } catch (e) { out.bdstokenErr = e.message; }
    try {
      const r2 = await fetch('https://pan.baidu.com/api/list?channel=chunlei&clienttype=0&web=1&app_id=250528&num=10&order=name&desc=0&showempty=0&dir=' + encodeURIComponent('/') + '&page=1', { credentials: 'include' });
      const j2 = await r2.json();
      out.listErrno = j2.errno; out.showMsg = j2.show_msg || '';
    } catch (e) { out.listErr = e.message; }
    try {
      const r3 = await fetch('https://pan.baidu.com/api/quota?checkexpire=1&checkfree=1&clienttype=0&app_id=250528&web=1', { credentials: 'include' });
      const j3 = await r3.json();
      out.quotaErrno = j3.errno; out.quota = j3.quota; out.used = j3.used; out.quotaShowMsg = j3.show_msg || '';
    } catch (e) { out.quotaErr = e.message; }
    try {
      const r4 = await fetch('https://pan.baidu.com/api/userinfo?clienttype=0&app_id=250528&web=1', { credentials: 'include' });
      const j4 = await r4.json();
      out.userErrno = j4.errno; out.username = j4.username || j4.baidu_name || '';
    } catch (e) { out.userErr = e.message; }
    out.hasLoginForm = !!document.querySelector('input[name="userName"], #TANGRAM__PSP_4__userName, [class*="login"]');
    out.title = document.title;
    return out;
  })()`, 30000).catch(e => 'ERR ' + e.message);
  console.log('登录态检查:', JSON.stringify(r, null, 1));
  const errnos = [];
  if (r && typeof r === 'object') {
    for (const k of ['tplErrno', 'listErrno', 'quotaErrno', 'userErrno']) if (r[k] !== undefined) errnos.push(k + '=' + r[k]);
  }
  console.log('结论: 全部信号失效(errno -6 / bdstoken 空 / 跳 login) => 注销成功; 否则仍为登录态');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
