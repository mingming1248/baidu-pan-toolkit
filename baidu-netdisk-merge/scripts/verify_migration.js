// Step 5 迁移完整性验证：递归扫描目标目录，与源清单按相对路径+大小对比
// 用法: node verify_migration.js <目标端口> <源inventory.json> [目标顶层目录...]
// 例:   node verify_migration.js 9222 dirs_inventory.json /07_软技能 /20230910-米脂小米高质量发展论坛
const { connect, evalJs, scanTree } = require('./cdp_common');
const fs = require('fs');

const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);

async function main() {
  const port = parseInt(process.argv[2] || '9222', 10);
  const invFile = process.argv[3] || 'dirs_inventory.json';
  const targets2 = process.argv.slice(4);
  if (!targets2.length) { console.error('请指定目标顶层目录（可多个）'); process.exit(1); }

  await connect(port);
  const bdst = await evalJs(`fetch('https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=%5B%22bdstoken%22%5D', {credentials:'include'}).then(r => r.json()).then(j => (j && j.result && j.result.bdstoken) || null)`, 30000);
  if (!bdst) { console.error('未登录（端口 ' + port + '）'); process.exit(1); }
  log('端口', port, '登录确认');

  const srcInv = JSON.parse(fs.readFileSync(invFile, 'utf8'));
  const srcFiles = srcInv.filter(d => d.isdir === 0);
  const srcByRel = new Map();
  for (const f of srcFiles) {
    const parts = f.path.split('/').filter(Boolean);
    if (parts.length >= 1) {
      const top = parts[0];
      const rel = parts.slice(1).join('/');
      if (!srcByRel.has(top)) srcByRel.set(top, []);
      srcByRel.get(top).push({ rel, size: f.size });
    }
  }
  log('源顶层:', [...srcByRel.keys()].join(', '));

  const dstByTop = {};
  for (const top of targets2) {
    log('扫描目标', top, '...');
    const files = await scanTree(top);
    dstByTop[top.replace(/^\//, '')] = files.files;
    log('  ', files.files.length, '文件');
  }

  let totalSrc = 0, matched = 0, missing = 0, sizeMismatch = 0, totalSrcBytes = 0, matchedBytes = 0;
  const missingList = [];
  for (const [top, files] of srcByRel.entries()) {
    const dstTop = dstByTop[top] || [];
    const dstByRel = new Map();
    for (const f of dstTop) {
      const parts = f.path.split('/').filter(Boolean);
      const rel = parts.slice(1).join('/');
      dstByRel.set(rel, f);
    }
    for (const sf of files) {
      totalSrc++; totalSrcBytes += sf.size;
      const df = dstByRel.get(sf.rel);
      if (!df) { missing++; missingList.push(top + '/' + sf.rel + ' (' + sf.size + 'B)'); continue; }
      if (df.size === sf.size) { matched++; matchedBytes += sf.size; }
      else sizeMismatch++;
    }
  }
  const fmt = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + 'GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + 'MB' : (n / 1024).toFixed(1) + 'KB';
  log('========================================');
  log('迁移验证结果');
  log('源文件总数:', totalSrc, '(' + fmt(totalSrcBytes) + ')');
  log('已匹配(路径+大小):', matched, '(' + fmt(matchedBytes) + ')');
  log('缺失:', missing);
  log('大小不符:', sizeMismatch);
  log('缺失明细(前20):');
  missingList.slice(0, 20).forEach(m => log('  MISS', m));
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
