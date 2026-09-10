// 139网盘重复分析：读 139_inventory.jsonl → 按 contentHash 分组 → 生成删除计划 deletions.json
// 用法: node 139_analyze.js   （在扫描输出目录下运行）
// 判定: SHA-256 contentHash 全等即内容重复（与文件名无关）；无 hash 文件跳过
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.cwd();
const JSONL_PATH = path.join(OUT_DIR, '139_inventory.jsonl');
const DEL_PATH = path.join(OUT_DIR, 'deletions.json');
const GROUPS_PATH = path.join(OUT_DIR, 'dup_groups.json');
const REPORT_PATH = path.join(OUT_DIR, 'dup_report.txt');

const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);

function score(f) {
  // 分高者保留：非系统目录 +200；无 (N) 后缀 +500；无时间戳后缀 +300；路径短 +少量
  let s = 0;
  const base = f.path.split('/').slice(0, -1).join('/');
  if (base && !/(手机图片|手机视频|同步|photo|手机备份|139邮箱|我的应用收藏|AI空间)$/.test(base)) s += 200;
  if (!/\((\d+)\)/.test(f.name)) s += 500;
  if (!/\(\d{4}[-_.]?\d{2}[-_.]?\d{2}/.test(f.name) && !/20\d{2}[-_.]?\d{2}[-_.]?\d{2}/.test(f.name)) s += 300;
  s += Math.max(0, 100 - f.path.length);
  return s;
}

function main() {
  if (!fs.existsSync(JSONL_PATH)) {
    log('未找到 ' + JSONL_PATH + '，请先运行 139_scan.js');
    process.exit(1);
  }
  const files = [];
  const folders = new Set();
  for (const line of fs.readFileSync(JSONL_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    for (const f of o.files || []) files.push(f);
    for (const d of o.folders || []) folders.add(d.path);
  }
  log('loaded: ' + files.length + ' files, ' + folders.size + ' folders');

  const byHash = new Map();
  for (const f of files) {
    if (!f.contentHash) continue;
    if (!byHash.has(f.contentHash)) byHash.set(f.contentHash, []);
    byHash.get(f.contentHash).push(f);
  }

  const groups = [];
  const deletions = [];
  let dupBytes = 0;
  for (const [hash, list] of byHash) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => score(b) - score(a));
    const keep = sorted[0];
    const del = sorted.slice(1);
    groups.push({ hash, count: list.length, keep: { path: keep.path, size: keep.size }, dupes: del.map(d => ({ path: d.path, size: d.size })) });
    for (const d of del) {
      deletions.push({ fileId: d.fileId, path: d.path, size: d.size, hash, reason: 'dup_of:' + keep.path });
      dupBytes += d.size;
    }
  }

  fs.writeFileSync(DEL_PATH, JSON.stringify(deletions, null, 2));
  fs.writeFileSync(GROUPS_PATH, JSON.stringify(groups, null, 2));

  const fmtB = (n) => { if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + 'GB'; if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + 'MB'; if (n >= 1024) return (n / 1024).toFixed(1) + 'KB'; return n + 'B'; };
  const report = [
    '=== 139网盘重复分析报告 ===',
    '扫描文件数: ' + files.length,
    '含 hash 文件数: ' + files.filter(f => f.contentHash).length,
    '重复组数: ' + groups.length,
    '待删文件数: ' + deletions.length,
    '可释放容量: ' + fmtB(dupBytes),
    '',
    ...groups.map(g => '[' + g.hash.substring(0, 12) + '] x' + g.count + '  保留: ' + g.keep.path + ' (' + fmtB(g.keep.size) + ')' + (g.dupes.length ? '  删除: ' + g.dupes.map(d => d.path).join('; ') : '')),
  ].join('\n');
  fs.writeFileSync(REPORT_PATH, report, 'utf8');
  log(report);
  log('输出: deletions.json / dup_groups.json / dup_report.txt');
}

main();
