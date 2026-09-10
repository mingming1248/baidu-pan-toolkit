// 快速验证指定端口登录态（Step 0 用）
// 用法: node verify_account.js <端口>
const { connect, evalJs, getBdst } = require('./cdp_common');

async function main() {
  const port = parseInt(process.argv[2] || '9222', 10);
  await connect(port);
  const bdst = await getBdst();
  const r = await evalJs(`(async () => {
    const r2 = await fetch('https://pan.baidu.com/api/list?channel=chunlei&clienttype=0&web=1&app_id=250528&num=3&order=name&desc=0&showempty=0&dir=' + encodeURIComponent('/') + '&page=1', { credentials: 'include' });
    const j = await r2.json();
    return { errno: j.errno, names: (j.list || []).map(x => x.server_filename).slice(0, 3) };
  })()`, 30000).catch(e => 'ERR ' + e.message);
  console.log('端口', port, 'bdstoken:', bdst ? 'OK' : '空', '| 根目录列表:', JSON.stringify(r));
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
