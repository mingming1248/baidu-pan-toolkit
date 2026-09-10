// 重复分析与删除计划生成：inv.jsonl → deletions.json + dup_groups.json
// 按 md5:size 分组，每组保留1个最优副本；零字节文件跳过（空文件MD5恒同属数学必然）
// 同时统计空文件夹（subtree 无任何文件）供终验参考
const fs = require('fs');
const path = require('path');

const DIR = process.cwd();
const INV_PATH = path.join(DIR, 'inv.jsonl');
const OUT_PATH = path.join(DIR, 'deletions.json');
const GROUPS_PATH = path.join(DIR, 'dup_groups.json');

const SYSTEM_IDS = new Set(['0', '-11', '-12', '-13', '-14', '-15', '-16', '-17', '-18']);
const TS_NAME = /\((20\d{12,14})\)$/;          // 文件名尾部时戳后缀 (20250719123326)
const TS_FOLDER = /\/(20\d{12,14})(\/|$)/;      // 路径中的时戳目录段
const fmtB = (n) => { if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + 'TB'; if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + 'GB'; if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + 'MB'; if (n >= 1024) return (n / 1024).toFixed(1) + 'KB'; return n + 'B'; };

function loadInv() {
  const folders = new Map(); // path -> id
  const files = [];
  const text = fs.readFileSync(INV_PATH, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    for (const f of (j.folders || [])) if (!folders.has(f.path)) folders.set(f.path, String(f.id));
    for (const f of (j.files || [])) files.push(f);
  }
  return { folders, files };
}

// 保留评分：分高者为最优副本
function score(f) {
  let s = 0;
  const name = f.path.substring(f.path.lastIndexOf('/') + 1);
  if (!TS_NAME.test(name)) s += 1000;                          // 原始文件名（无时戳副本后缀）
  if (!/\(\d+\)$/.test(name.replace(/\.[^.]+$/, ''))) s += 500; // 无浏览器重复下载后缀(N)
  if (!TS_FOLDER.test(f.path)) s += 100;                       // 不在时戳目录里
  s -= Math.min(name.length, 200);                             // 名字更简洁
  return s;
}

// 重复类别标注（仅用于报告分层与分批执行，删除决策相同）
// A: 同文件夹时戳副本  C: 时戳文件夹内重复  B1: 父目录为另一目录的整树镜像  B2: 零散重复
function classify(f, folderMd5Sets) {
  const name = f.path.substring(f.path.lastIndexOf('/') + 1);
  const parent = f.path.substring(0, f.path.lastIndexOf('/'));
  if (TS_NAME.test(name)) {
    // 同文件夹存在无后缀的同名原文件 → A
    const orig = name.replace(TS_NAME, '');
    return 'A';
  }
  if (TS_FOLDER.test(f.path)) return 'C';
  const set = folderMd5Sets.get(parent);
  if (set && set.mirrorOf) return 'B1';
  return 'B2';
}

(function main() {
  const { folders, files } = loadInv();
  console.log('文件总数:', files.length, ' 文件夹总数:', folders.size);
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  console.log('总容量:', fmtB(totalBytes));

  const noMd5 = files.filter(f => !f.md5).length;
  const zeroByte = files.filter(f => f.size === 0).length;
  console.log('无MD5文件:', noMd5, ' 零字节文件:', zeroByte, '(零字节不参与判重)');

  // ---- 分组 ----
  const byKey = new Map();
  for (const f of files) {
    if (!f.md5 || !f.size) continue; // 跳过无MD5和零字节
    const k = f.md5 + ':' + (f.size || 0);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }

  // ---- B1 检测：文件夹间 md5 集合高度重叠（≥90%）视为镜像 ----
  const filesByFolder = new Map();
  for (const f of files) {
    if (!f.md5) continue;
    const fp = f.path.substring(0, f.path.lastIndexOf('/'));
    if (!filesByFolder.has(fp)) filesByFolder.set(fp, new Set());
    filesByFolder.get(fp).add(f.md5);
  }
  const folderList = [...filesByFolder.entries()].map(([p, s]) => ({ p, s }));
  const folderMd5Sets = new Map();
  for (const [p, s] of filesByFolder) folderMd5Sets.set(p, { set: s, mirrorOf: null });
  // 只比较文件数相近的文件夹（差异<20%），避免 O(n²) 爆炸
  folderList.sort((a, b) => b.s.size - a.s.size);
  for (let i = 0; i < folderList.length; i++) {
    const a = folderList[i];
    const info = folderMd5Sets.get(a.p);
    if (info.mirrorOf) continue;
    for (let j = i + 1; j < folderList.length && folderList[j].s.size >= a.s.size * 0.8; j++) {
      const b = folderList[j];
      const binfo = folderMd5Sets.get(b.p);
      if (binfo.mirrorOf) continue;
      if (a.s.size < b.s.size * 0.8) break;
      let inter = 0;
      for (const m of a.s) if (b.s.has(m)) inter++;
      const min = Math.min(a.s.size, b.s.size);
      if (min >= 5 && inter / min >= 0.9) {
        // 集合较小者视为镜像方（其内容在对方处有保留）
        if (a.s.size <= b.s.size) info.mirrorOf = b.p; else binfo.mirrorOf = a.p;
      }
    }
  }
  const mirrorCount = [...folderMd5Sets.values()].filter(v => v.mirrorOf).length;
  console.log('检测到镜像文件夹对(B1候选):', mirrorCount, '个文件夹');

  // ---- 生成删除计划 ----
  const deletions = [];
  const groups = [];
  let keepCount = 0;
  for (const [k, arr] of byKey) {
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
    const keep = sorted[0];
    keepCount++;
    const del = sorted.slice(1);
    groups.push({ md5: k.split(':')[0], size: keep.size, keep: keep.path, deleted: del.map(d => d.path) });
    for (const d of del) {
      deletions.push({ id: String(d.id), path: d.path, size: d.size, md5: d.md5, reason: classify(d, folderMd5Sets) + ':dup' });
    }
  }
  const delBytes = deletions.reduce((s, d) => s + d.size, 0);
  const byClass = {};
  for (const d of deletions) byClass[d.reason.split(':')[0]] = (byClass[d.reason.split(':')[0]] || 0) + 1;
  console.log('重复组:', groups.length, ' 保留:', keepCount, ' 删除:', deletions.length, ' 可释放:', fmtB(delBytes));
  console.log('分类分布:', JSON.stringify(byClass), ' (A=同文件夹时戳副本 C=时戳文件夹 B1=整树镜像 B2=零散重复)');

  // 父目录解析检查
  let noParent = 0;
  for (const d of deletions) {
    const pp = d.path.substring(0, d.path.lastIndexOf('/'));
    if (!folders.has(pp)) noParent++;
  }
  console.log('父目录缺失(将被驱动跳过):', noParent);

  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), deletions }));
  fs.writeFileSync(GROUPS_PATH, JSON.stringify({ groups }, null, 1));

  // ---- 空文件夹统计（终验参考：subtree 无任何文件） ----
  const remainByFolder = new Map();
  for (const f of files) {
    const fp = f.path.substring(0, f.path.lastIndexOf('/'));
    remainByFolder.set(fp, (remainByFolder.get(fp) || 0) + 1);
  }
  const children = new Map();
  for (const p of folders.keys()) {
    const pp = p.substring(0, p.lastIndexOf('/'));
    if (!children.has(pp)) children.set(pp, []);
    children.get(pp).push(p);
  }
  const memo = new Map();
  function acc(p) {
    if (memo.has(p)) return memo.get(p);
    let n = remainByFolder.get(p) || 0;
    for (const c of (children.get(p) || [])) n += acc(c);
    memo.set(p, n);
    return n;
  }
  const roots = [...folders.keys()].filter(p => {
    const pp = p.substring(0, p.lastIndexOf('/'));
    return pp === '' || !folders.has(pp);
  });
  for (const r of roots) acc(r);
  const empty = [...memo.entries()].filter(([p, n]) => n === 0 && !SYSTEM_IDS.has(folders.get(p)));
  console.log('空文件夹(subtree无文件):', empty.length, ' (含用户原本就空的，删除仅处理因清理变空的，见 del_empty_folders.js plan)');

  console.log('输出:', OUT_PATH, '和', GROUPS_PATH);
  console.log('样例:');
  for (const g of groups.slice(0, 5)) {
    console.log(`保留: ${g.keep}`);
    for (const d of g.deleted.slice(0, 3)) console.log('  删: ' + d);
  }
})();
