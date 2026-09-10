// Step 6 源账号删除已转存文件
// 用法: node delete_migrated.js <源端口> <shares.json> [输出文件前缀]
// 流程: 全盘重扫 → 删除集合(成功单元 fs_id) → 分批删除(40/批,8s) → 重扫验证 0 残留
const { connect, evalJs, getBdst, scanTree } = require('./cdp_common');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);

async function main() {
  const port = parseInt(process.argv[2] || '9223', 10);
  const sharesFile = process.argv[3] || 'share_units.json';
  const prefix = process.argv[4] || 'del_migrated';

  await connect(port);
  const bdst = await getBdst();
  if (!bdst) { console.error('未登录（端口 ' + port + '）'); process.exit(1); }
  log('端口', port, '登录确认');

  // 1. 全盘重扫
  log('全盘重扫中...');
  const inv = await scanTree('/');
  log('扫描完成:', inv.files.length, '文件,', inv.dirs.length, '目录');
  fs.writeFileSync(prefix + '_inv_before.json', JSON.stringify(inv, null, 1));

  // 2. 构建删除集合
  const recs = JSON.parse(fs.readFileSync(sharesFile, 'utf8'));
  const okRecs = recs.filter(r => !r.err && r.shareid);
  const fsIdSet = new Set();
  for (const rec of okRecs) {
    if (rec.type === 'dir') fsIdSet.add(rec.fs_id);
    else for (const f of rec.files) fsIdSet.add(f);
  }
  log('删除集合: ' + fsIdSet.size + ' 个 fs_id');

  const fsidToPath = new Map();
  for (const f of inv.files) if (fsIdSet.has(f.fs_id)) fsidToPath.set(f.fs_id, f.path);
  for (const d of inv.dirs) if (fsIdSet.has(d.fs_id)) fsidToPath.set(d.fs_id, d.path);
  const delPaths = [...new Set([...fsidToPath.values()])];
  log('待删路径数:', delPaths.length);
  fs.writeFileSync(prefix + '_plan.json', JSON.stringify(delPaths, null, 1));

  // 3. 分批删除
  const BATCH = 40, INTERVAL = 8000;
  let ok = 0, fail = 0;
  const failList = [];
  for (let i = 0; i < delPaths.length; i += BATCH) {
    const batch = delPaths.slice(i, i + BATCH);
    let r;
    try {
      r = await evalJs(`(async () => {
        const body = new URLSearchParams();
        body.set('filelist', JSON.stringify(${JSON.stringify(batch)}));
        const resp = await fetch('https://pan.baidu.com/api/filemanager?async=2&onnest=fail&opera=delete&bdstoken=' + encodeURIComponent(${JSON.stringify('__B__')}) + '&newVerify=1&clienttype=0&app_id=250528&web=1&dp-logid=' + Math.floor(Math.random() * 1e18), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' }, body: body.toString() });
        return await resp.text();
      })()`.split('"__B__"').join(JSON.stringify(bdst)), 120000);
    } catch (e) {
      fail += batch.length; failList.push({ batch: i, err: e.message }); log('批 ' + (i / BATCH + 1) + ' 异常:', e.message); await sleep(15000); continue;
    }
    let j;
    try { j = JSON.parse(r); } catch (e) { fail += batch.length; failList.push({ batch: i, resp: r.substring(0, 100) }); log('批 ' + (i / BATCH + 1) + ' 响应异常:', r.substring(0, 100)); await sleep(10000); continue; }
    if (j.errno === 0) { ok += batch.length; }
    else {
      fail += batch.length; failList.push({ batch: i, errno: j.errno, msg: j.show_msg || '' });
      log('批 ' + (i / BATCH + 1) + ' 失败: errno=' + j.errno, j.show_msg || '');
      if (j.errno === 132 || (j.show_msg || '').includes('验证')) { log('!!! 触发验证，暂停，等待人工处理'); break; }
    }
    if ((i / BATCH + 1) % 5 === 0) log('删除进度', Math.min(i + BATCH, delPaths.length) + '/' + delPaths.length, 'ok=' + ok, 'fail=' + fail);
    await sleep(INTERVAL);
  }
  log('删除完成: ok=' + ok + ' fail=' + fail);
  if (failList.length) fs.writeFileSync(prefix + '_fails.json', JSON.stringify(failList, null, 1));

  // 4. 重扫验证
  log('删除后重扫验证...');
  const inv2 = await scanTree('/');
  const remain = inv2.files.filter(f => fsIdSet.has(f.fs_id));
  log('剩余:', inv2.files.length, '文件,', inv2.dirs.length, '目录, 应删残留:', remain.length);
  if (remain.length) remain.slice(0, 20).forEach(f => log('  REMAIN', f.path));
  fs.writeFileSync(prefix + '_inv_after.json', JSON.stringify(inv2, null, 1));
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
