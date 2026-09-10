// Step 3 创建分享（源账号侧）
// 用法: node share_create.js <源端口> <plan.json> [shares.json]
// 输出: 默认 share_units.json  [{idx, type, path, fs_id, files, file_count, pwd, errno, link, shareid, err?}]
const { connect, evalJs, getBdst } = require('./cdp_common');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const port = parseInt(process.argv[2] || '9223', 10);
  const planFile = process.argv[3] || 'migration_plan.json';
  const outFile = process.argv[4] || 'share_units.json';
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));

  await connect(port);
  const bdst = await getBdst();
  if (!bdst) { console.error('未登录（端口 ' + port + '）'); process.exit(1); }
  console.log('端口', port, '登录确认');

  const units = [];
  for (const u of plan.units) units.push({ type: 'dir', path: u.path, fs_id: u.fs_id, name: u.name, file_count: u.file_count });
  for (const u of plan.flatFilesUnits) units.push({ type: 'files', path: u.dir, files: u.files.map(f => f.fs_id), file_count: u.files.length });

  const results = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const fidList = u.type === 'dir' ? [u.fs_id] : u.files;
    const pwd = Math.random().toString(36).slice(2, 6);
    const body = 'fid_list=' + encodeURIComponent(JSON.stringify(fidList)) + '&schannel=4&channel_list=[]&period=0&pwd=' + encodeURIComponent(pwd) + '&random_code=' + Math.floor(Math.random() * 1000000) + '&bdstoken=' + encodeURIComponent(bdst);
    let r;
    try {
      r = await evalJs(`(async () => {
        const resp = await fetch('https://pan.baidu.com/share/set?channel=chunlei&clienttype=0&web=1&app_id=250528', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' }, body: ${JSON.stringify(body)} });
        return await resp.text();
      })()`, 60000);
    } catch (e) { r = 'ERR ' + e.message; }
    let rec = { idx: i, type: u.type, path: u.path, fs_id: u.fs_id, files: u.files || null, file_count: u.file_count, pwd, raw: r.substring(0, 300) };
    try {
      const j = JSON.parse(r);
      rec.errno = j.errno; rec.link = j.link || null; rec.shareid = j.shareid || null; rec.show_msg = j.show_msg || '';
      if (j.errno === 0) { ok++; } else { fail++; rec.err = j.errno + ' ' + (j.show_msg || ''); }
    } catch (e) { rec.err = 'parse fail'; fail++; }
    results.push(rec);
    if ((i + 1) % 10 === 0) console.log('进度', (i + 1) + '/' + units.length, 'ok=' + ok, 'fail=' + fail);
    await sleep(1200);
  }

  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log('\n完成: 成功 ' + ok + ', 失败 ' + fail + ' / 共 ' + units.length);
  const fails = results.filter(r => r.err);
  fails.forEach(f => console.log('  FAIL[' + f.idx + ']', f.path, f.err));
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
