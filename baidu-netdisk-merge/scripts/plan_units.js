// Step 2 切分迁移单元（目录树 ≤500 文件/单元）
// 用法: node plan_units.js <inventory.json> [plan.json]
// 输出: 默认 migration_plan.json  {units:[{type:'dir'|'files',...}], flatFilesUnits:[...]}
const fs = require('fs');

const MAX = 500;

function build(inv) {
  const byPath = new Map();
  for (const it of inv) byPath.set(it.path, it);
  const children = new Map();
  for (const it of inv) {
    const parts = it.path.split('/').filter(Boolean);
    const parent = '/' + parts.slice(0, -1).join('/');
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(it);
  }
  const memo = new Map();
  function subtreeFiles(dirPath) {
    if (memo.has(dirPath)) return memo.get(dirPath);
    let n = 0;
    for (const c of (children.get(dirPath) || [])) n += c.isdir ? subtreeFiles(c.path) : 1;
    memo.set(dirPath, n);
    return n;
  }

  const units = [];
  const flatFilesUnits = [];
  function divide(dirPath) {
    const kids = children.get(dirPath) || [];
    const directFiles = kids.filter(k => !k.isdir);
    const subDirs = kids.filter(k => k.isdir);
    for (let i = 0; i < directFiles.length; i += MAX) {
      const batch = directFiles.slice(i, i + MAX);
      flatFilesUnits.push({ type: 'files', dir: dirPath, files: batch.map(f => ({ path: f.path, fs_id: f.fs_id, size: f.size })) });
    }
    for (const sd of subDirs) {
      const n = subtreeFiles(sd.path);
      if (n > MAX) divide(sd.path);
      else units.push({ type: 'dir', path: sd.path, fs_id: sd.fs_id, name: sd.name, file_count: n });
    }
  }
  for (const top of (children.get('/') || [])) {
    if (top.isdir) {
      const n = subtreeFiles(top.path);
      if (n > MAX) divide(top.path);
      else units.push({ type: 'dir', path: top.path, fs_id: top.fs_id, name: top.name, file_count: n });
    } else {
      flatFilesUnits.push({ type: 'files', dir: '/', files: [{ path: top.path, fs_id: top.fs_id, size: top.size }] });
    }
  }
  let totalBytes = 0;
  for (const u of flatFilesUnits) { for (const f of u.files) totalBytes += f.size; }
  for (const u of units) {
    let sz = 0;
    (function sum(p) { for (const c of (children.get(p) || [])) { if (c.isdir) sum(c.path); else sz += c.size; } })(u.path);
    u.size = sz; totalBytes += sz;
  }
  return { units, flatFilesUnits, totalBytes };
}

async function main() {
  const inFile = process.argv[2] || 'dirs_inventory.json';
  const outFile = process.argv[3] || 'migration_plan.json';
  const inv = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const { units, flatFilesUnits, totalBytes } = build(inv);
  const fmt = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + 'GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + 'MB' : (n / 1024).toFixed(1) + 'KB';
  let totalFiles = 0;
  for (const u of units) totalFiles += u.file_count;
  for (const u of flatFilesUnits) totalFiles += u.files.length;
  console.log('目录单元数:', units.length, ' 文件级单元数:', flatFilesUnits.length, ' 总文件数:', totalFiles, ' 总大小:', fmt(totalBytes));
  units.sort((a, b) => b.size - a.size);
  flatFilesUnits.sort((a, b) => b.files.reduce((s, f) => s + f.size, 0) - a.files.reduce((s, f) => s + f.size, 0));
  console.log('=== 最大目录单元 Top 5 ===');
  units.slice(0, 5).forEach(u => console.log(u.path, fmt(u.size), u.file_count + '文件', 'fsid=' + u.fs_id));
  fs.writeFileSync(outFile, JSON.stringify({ units, flatFilesUnits }, null, 2));
  console.log('已保存', outFile);
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
