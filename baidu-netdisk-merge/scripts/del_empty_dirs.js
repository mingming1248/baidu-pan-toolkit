// Step 6b 源账号补删空目录（删除已转存文件后，清理残留的空目录壳）
// 用法: node del_empty_dirs.js <源端口>
// 流程: 重扫全盘 → 从最深层开始删空目录 → 直到没有可删的
const { connect, evalJs, getBdst, scanTree } = require('./cdp_common');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);

async function main() {
  const port = parseInt(process.argv[2] || '9223', 10);
  const outFile = process.argv[3] || 'del_empty_dirs_result.json';

  await connect(port);
  const bdst = await getBdst();
  if (!bdst) { console.error('未登录（端口 ' + port + '）'); process.exit(1); }
  log('端口', port, '登录确认');

  async function delDir(path) {
    const body = new URLSearchParams();
    body.set('filelist', JSON.stringify([path]));
    const r = await evalJs(`(async () => {
      const resp = await fetch('https://pan.baidu.com/api/filemanager?async=2&onnest=fail&opera=delete&bdstoken=' + encodeURIComponent(${JSON.stringify('__B__')}) + '&newVerify=1&clienttype=0&app_id=250528&web=1&dp-logid=' + Math.floor(Math.random() * 1e18), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' }, body: body.toString() });
      return await resp.text();
    })()`.split('"__B__"').join(JSON.stringify(bdst)), 120000);
    try { return JSON.parse(r).errno; } catch (e) { return 'parse-fail'; }
  }

  let deleted = 0, rounds = 0;
  while (true) {
    rounds++;
    const inv = await scanTree('/');
    // 找出空目录：没有任何文件/子目录的目录
    const dirSet = new Set(inv.dirs.map(d => d.path));
    const childSet = new Set();
    for (const f of inv.files) childSet.add(f.path.split('/').slice(0, -1).join('/'));
    for (const d of inv.dirs) if (d.path !== '/') childSet.add(d.path.split('/').slice(0, -1).join('/'));
    const empty = inv.dirs.filter(d => d.path !== '/' && !childSet.has(d.path));
    if (!empty.length) { log('第' + rounds + '轮: 无空目录，完成'); break; }
    log('第' + rounds + '轮: ' + empty.length + ' 个空目录');
    let roundOk = 0, roundFail = 0;
    for (const d of empty) {
      const errno = await delDir(d.path);
      if (errno === 0) { roundOk++; deleted++; log('  DEL', d.path); }
      else { roundFail++; log('  FAIL', d.path, 'errno=' + errno); }
      await sleep(1500);
    }
    log('第' + rounds + '轮: 删 ' + roundOk + ' 失败 ' + roundFail);
    if (roundOk === 0) { log('无进展，停止'); break; }
  }
  fs.writeFileSync(outFile, JSON.stringify({ rounds, deleted }, null, 2));
  log('空目录清理完成: 共删除 ' + deleted + ' 个');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
