// Step 4b 转存失败重试（针对 transfer_results.json 中 status != ok 的单元）
// 用法: node retry_transfer.js <目标端口> <shares.json> <results.json> <源账号UK> [out.json]
// 输出: 默认 retry_results.json
const { connect, send, evalJs, getBdst } = require('./cdp_common');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);

async function main() {
  const port = parseInt(process.argv[2] || '9222', 10);
  const sharesFile = process.argv[3] || 'share_units.json';
  const resultsFile = process.argv[4] || 'transfer_results.json';
  // 源账号 UK 为必传参数（可通过分享页源码 / 网盘 API 获取），不得硬编码任何账号
  const SHARE_UK = process.argv[5];
  const outFile = process.argv[6] || 'retry_results.json';
  if (!SHARE_UK) { console.error('缺少源账号 UK：用法 node retry_transfer.js <目标端口> <shares.json> <results.json> <源账号UK> [out.json]'); process.exit(1); }

  await connect(port);
  let bdst = await getBdst();
  if (!bdst) { console.error('未登录（端口 ' + port + '）'); process.exit(1); }
  log('端口', port, '登录确认');

  const recs = JSON.parse(fs.readFileSync(sharesFile, 'utf8'));
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const failed = results.filter(r => r.status !== 'ok');
  log('需重试单元:', failed.length);

  const results2 = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < failed.length; i++) {
    const rec = failed[i];
    const src = recs.find(s => s.idx === rec.idx);
    if (!src || !src.link || !src.shareid) { fail++; results2.push({ ...rec, status: 'no-share-skip' }); continue; }
    const shorturl = src.link.replace('https://pan.baidu.com/s/', '').split('?')[0];
    const url = 'https://pan.baidu.com/s/' + shorturl + '?pwd=' + src.pwd;
    const isDir = src.type === 'dir';
    const fsidList = isDir ? [src.fs_id] : src.files;
    const parent = rec.parent || (isDir ? (src.path.split('/').filter(Boolean).length > 1 ? '/' + src.path.split('/').filter(Boolean).slice(0, -1).join('/') : '/') : src.path);
    const recOut = { ...rec };

    try {
      await send('Page.navigate', { url });
      await sleep(7000);
      const body = 'fsidlist=' + encodeURIComponent(JSON.stringify(fsidList)) + '&path=' + encodeURIComponent(parent);
      const r = await evalJs(`(async () => {
        const resp = await fetch('https://pan.baidu.com/share/transfer?shareid=' + ${JSON.stringify(String(src.shareid))} + '&from=' + ${JSON.stringify(SHARE_UK)} + '&bdstoken=' + encodeURIComponent(${JSON.stringify('__B__')}), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' }, body: ${JSON.stringify(body)} });
        return await resp.text();
      })()`.split('"__B__"').join(JSON.stringify(bdst)), 120000);
      const j = JSON.parse(r);
      recOut.resp = r.substring(0, 300);
      if (j.errno === 0) { ok++; recOut.status = 'ok'; recOut.retried = true; }
      else { fail++; recOut.status = 'fail'; recOut.retried = true; recOut.errno2 = j.errno; recOut.show_msg2 = j.show_msg || ''; }
    } catch (e) {
      fail++; recOut.status = 'error'; recOut.retried = true; recOut.err2 = e.message;
      try { await connect(port); bdst = await getBdst(); } catch (ex) {}
    }
    results2.push(recOut);
    if ((i + 1) % 10 === 0) log('重试进度', (i + 1) + '/' + failed.length, 'ok=' + ok, 'fail=' + fail);
    await sleep(1500);
  }

  fs.writeFileSync(outFile, JSON.stringify(results2, null, 2));
  log('重试完成: ok=' + ok + ' fail=' + fail + ' / ' + failed.length);
  const stillFail = results2.filter(r => r.status !== 'ok');
  stillFail.forEach(f => log('  STILL-FAIL[' + f.idx + ']', f.path, f.errno2 || f.err2 || ''));
  process.exit(0);
}
