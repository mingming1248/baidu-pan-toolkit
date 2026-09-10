// Step 1 源账号全盘枚举
// 用法: node scan_account.js <端口> [输出文件]
// 输出: 默认 dirs_inventory.json  [{path, fs_id, name, isdir, size?}]
const { connect, evalJs, getBdst } = require('./cdp_common');
const fs = require('fs');

async function main() {
  const port = parseInt(process.argv[2] || '9223', 10);
  const outFile = process.argv[3] || 'dirs_inventory.json';
  await connect(port);
  const bdst = await getBdst();
  if (!bdst) { console.error('未登录（端口 ' + port + '）'); process.exit(1); }
  console.log('端口', port, '登录确认');

  async function listDir(dir, page) {
    const r = await evalJs(`(async () => {
      const resp = await fetch('https://pan.baidu.com/api/list?channel=chunlei&clienttype=0&web=1&app_id=250528&num=1000&order=name&desc=0&showempty=0&dir=' + encodeURIComponent(${JSON.stringify(dir)}) + '&page=' + ${JSON.stringify(page)}, { credentials: 'include' });
      const j = await resp.json();
      if (j.errno !== 0) return { err: j.errno, show_msg: j.show_msg };
      return { items: (j.list || []).map(x => ({ name: x.server_filename, fs_id: x.fs_id, isdir: x.isdir, size: x.size })) };
    })()`, 60000);
    return r;
  }

  const all = [];
  const seen = new Set();
  const queue = ['/'];
  seen.add('/');
  let errors = 0, maxItems = 0;

  while (queue.length) {
    const dir = queue.shift();
    const res = await listDir(dir, 1);
    if (res.err) { errors++; console.log('ERR', dir, res.err, res.show_msg); continue; }
    maxItems = Math.max(maxItems, res.items.length);
    for (const it of res.items) {
      const p = (dir === '/' ? '/' : dir + '/') + it.name;
      if (it.isdir) {
        all.push({ path: p, fs_id: it.fs_id, name: it.name, isdir: 1 });
        if (!seen.has(p)) { seen.add(p); queue.push(p); }
      } else {
        all.push({ path: p, fs_id: it.fs_id, name: it.name, isdir: 0, size: it.size });
      }
    }
    if (queue.length % 50 === 0) console.log('queue', queue.length, 'total', all.length);
  }

  fs.writeFileSync(outFile, JSON.stringify(all, null, 2));
  const files = all.filter(d => d.isdir === 0);
  let total = 0; for (const f of files) total += f.size;
  const fmt = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + 'GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + 'MB' : (n / 1024).toFixed(1) + 'KB';
  console.log('枚举完成: ' + all.length + ' 条目 (' + files.length + ' 文件, ' + (all.length - files.length) + ' 目录), 总大小 ' + fmt(total) + ', 单目录最多条目 ' + maxItems + ', 错误 ' + errors);
  console.log('已保存', outFile);
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
