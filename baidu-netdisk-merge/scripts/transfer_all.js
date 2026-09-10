// Step 4 批量转存（目标账号侧）
// 用法: node transfer_all.js <目标端口> <shares.json> [results.json] <源账号UK>
// 输出: 默认 transfer_results.json
// 关键：每单元先 Page.navigate 到分享页(带pwd)完成验证，再调 /share/transfer
const { connect, send, evalJs, getBdst } = require('./cdp_common');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);

async function main() {
  const port = parseInt(process.argv[2] || '9222', 10);
  const sharesFile = process.argv[3] || 'share_units.json';
  const outFile = process.argv[4] || 'transfer_results.json';
  // 源账号 UK 为必传参数（可通过分享页源码 / 网盘 API 获取），不得硬编码任何账号
  const SHARE_UK = process.argv[5];
  if (!SHARE_UK) { console.error('缺少源账号 UK：用法 node transfer_all.js <目标端口> <shares.json> [results.json] <源账号UK>'); process.exit(1); }

  await connect(port);
  let bdst = await getBdst();
  if (!bdst) { console.error('未登录（端口 ' + port + '）'); process.exit(1); }
  log('端口', port, '登录确认');

  async function refreshBdst() { bdst = await getBdst(); return bdst; }

  // 预建父目录链
  async function mkdirRecursive(path) {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      await evalJs(`(async () => {
        const resp = await fetch('https://pan.baidu.com/api/create?a=commit&bdstoken=' + encodeURIComponent(${JSON.stringify('__B__')}) + '&clienttype=0&app_id=250528&web=1', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body: 'path=' + encodeURIComponent(${JSON.stringify('__P__')}) + '&isdir=1&block_list=[]' });
        return await resp.text();
      })()`.split('"__B__"').join(JSON.stringify(bdst)).split('"__P__"').join(JSON.stringify(cur)), 30000).catch(e => 'ERR ' + e.message);
    }
  }

  const recs = JSON.parse(fs.readFileSync(sharesFile, 'utf8'));
  const okRecs = recs.filter(r => !r.err && r.shareid);
  log('待转存单元:', okRecs.length);

  const parents = new Set();
  for (const rec of okRecs) {
    if (rec.type === 'dir') {
      const parts = rec.path.split('/').filter(Boolean);
      const parent = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
      parents.add(parent);
      if (parts.length === 1) parents.add(rec.path);
    } else {
      parents.add(rec.path);
    }
  }
  const sorted = [...parents].filter(p => p !== '/').sort((a, b) => a.split('/').length - b.split('/').length);
  log('需创建目录 ' + sorted.length + ' 个');
  for (const p of sorted) { await mkdirRecursive(p); await sleep(200); }
  log('父目录链创建完成');

  const results = [];
  let ok = 0, fail = 0;
  for (let i = 0; i < okRecs.length; i++) {
    const rec = okRecs[i];
    const shorturl = rec.link.replace('https://pan.baidu.com/s/', '').split('?')[0];
    const url = 'https://pan.baidu.com/s/' + shorturl + '?pwd=' + rec.pwd;
    const isDir = rec.type === 'dir';
    const fsidList = isDir ? [rec.fs_id] : rec.files;
    let parent;
    if (isDir) {
      const parts = rec.path.split('/').filter(Boolean);
      parent = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
    } else {
      parent = rec.path;
    }
    const recOut = { idx: rec.idx, path: rec.path, type: rec.type, parent, file_count: rec.file_count, shareid: rec.shareid };

    try {
      await send('Page.navigate', { url });
      await sleep(7000);
      const body = 'fsidlist=' + encodeURIComponent(JSON.stringify(fsidList)) + '&path=' + encodeURIComponent(parent);
      const r = await evalJs(`(async () => {
        const resp = await fetch('https://pan.baidu.com/share/transfer?shareid=' + ${JSON.stringify(String(rec.shareid))} + '&from=' + ${JSON.stringify(SHARE_UK)} + '&bdstoken=' + encodeURIComponent(${JSON.stringify('__B__')}), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' }, body: ${JSON.stringify(body)} });
        return await resp.text();
      })()`.split('"__B__"').join(JSON.stringify(bdst)), 120000);
      const j = JSON.parse(r);
      recOut.resp = r.substring(0, 300);
      if (j.errno === 0) { ok++; recOut.status = 'ok'; }
      else { fail++; recOut.status = 'fail'; recOut.errno = j.errno; recOut.show_msg = j.show_msg || ''; }
    } catch (e) {
      fail++; recOut.status = 'error'; recOut.err = e.message;
      // 会话可能断了：重连 + 刷新 bdstoken
      try { await connect(port); bdst = await refreshBdst(); } catch (ex) {}
    }
    results.push(recOut);
    if ((i + 1) % 10 === 0) log('转存进度', (i + 1) + '/' + okRecs.length, 'ok=' + ok, 'fail=' + fail);
    await sleep(1500);
  }

  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  log('转存完成: ok=' + ok + ' fail=' + fail + ' / ' + okRecs.length);
  const fails = results.filter(r => r.status !== 'ok');
  fails.forEach(f => log('  FAIL[' + f.idx + ']', f.path, f.status, f.show_msg || f.err || ''));
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
