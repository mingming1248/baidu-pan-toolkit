// 百度网盘重复分析：按 md5:size 分组，每组保留 1 个最优副本，其余进入删除计划
// 用法: node analyze_dup.js   （在扫描输出的工作目录下运行）
// 输入: inv.jsonl (scan_md5.js 输出)
// 输出: deletions.json (删除计划), dup_groups.json (人读版), dup_report.txt (统计报告)
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.cwd();
const JSONL_PATH = path.join(OUT_DIR, 'inv.jsonl');
const DEL_PATH = path.join(OUT_DIR, 'deletions.json');
const GROUPS_PATH = path.join(OUT_DIR, 'dup_groups.json');
const REPORT_PATH = path.join(OUT_DIR, 'dup_report.txt');

const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'; // 零字节文件 MD5 恒定值
const fmtB = (n) => { if (n >= 1024 ** 4) return (n / 1024 ** 4).toFixed(2) + 'TB'; if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + 'GB'; if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + 'MB'; if (n >= 1024) return (n / 1024).toFixed(1) + 'KB'; return n + 'B'; };

// 评分：保留分高者
function score(name, dirPath) {
  let s = 0;
  const base = name.replace(/\.[^.]+$/, ''); // 去掉扩展名
  // 原始文件名（无时戳后缀）+1000
  if (!/\(\d{4}[-/.?]\d{1,2}[-/.?]\d{1,2}[^)]*\)/.test(name)) s += 1000;
  // 无浏览器重复下载后缀 (N) +500
  if (!/\(\d+\)$/.test(base)) s += 500;
  // 不在时戳目录中 +100
  if (!/(\d{4}[-/.?]\d{1,2}[-/.?]\d{1,2})/.test(dirPath)) s += 100;
  // 文件名更简洁微加分
  s += Math.max(0, 100 - name.length) * 0.5;
  return s;
}

// reason 分类
function classify(name, dirPath, group) {
  const hasTs = (str) => /(\d{4}[-/.?]\d{1,2}[-/.?]\d{1,2})/.test(str);
  if (hasTs(name)) return 'A';               // 文件名带时戳后缀（下载副本）
  if (hasTs(dirPath)) return 'C';            // 位于时戳文件夹中的重复
  const sameDirCount = group.filter(f => path.dirname(f.path) === path.dirname(dirPath + '/x')).length;
  return 'B2';                               // 零散重复
}

function main() {
  if (!fs.existsSync(JSONL_PATH)) { console.error('not found: ' + JSONL_PATH); process.exit(1); }
  const lines = fs.readFileSync(JSONL_PATH, 'utf8').split('\n').filter(Boolean);
  const files = [];
  for (const ln of lines) {
    const o = JSON.parse(ln);
    for (const f of o.files || []) files.push(f);
  }
  const totalFiles = files.length;
  const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);
  const noMd5 = files.filter(f => !f.md5);
  const usable = files.filter(f => f.md5 && f.md5 !== EMPTY_MD5 && (f.size || 0) > 0);
  const zeroBytes = files.filter(f => !f.size);
  console.log('total files: ' + totalFiles + ' (' + fmtB(totalBytes) + '), usable(md5&size>0): ' + usable.length + ', noMd5: ' + noMd5.length + ', zeroBytes: ' + zeroBytes.length);

  // 按 md5:size 双键分组
  const groups = new Map();
  for (const f of usable) {
    const key = f.md5 + ':' + f.size;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const dupGroups = [];
  let delCount = 0, delBytes = 0;
  const deletions = [];
  const emptyStats = { foldersTotal: 0, foldersEmpty: 0 };

  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const dirSet = new Set(members.map(f => path.dirname(f.path)));
    // 每组评分排序，保留最高分
    const scored = members.map(f => ({ ...f, _s: score(f.name, path.dirname(f.path)) })).sort((a, b) => b._s - a._s);
    const keep = scored[0];
    const del = scored.slice(1);
    const dupBytes = del.reduce((a, f) => a + (f.size || 0), 0);
    delCount += del.length;
    delBytes += dupBytes;
    for (const f of del) {
      deletions.push({ path: f.path, size: f.size, md5: f.md5, reason: classify(f.name, path.dirname(f.path), members), keepPath: keep.path });
    }
    dupGroups.push({
      key,
      size: members[0].size,
      count: members.length,
      bytes: dupBytes,
      keep: { path: keep.path, name: keep.name, score: keep._s },
      delete: del.map(f => ({ path: f.path, name: f.name, reason: classify(f.name, path.dirname(f.path), members) })),
    });
  }

  deletions.sort((a, b) => b.size - a.size);
  fs.writeFileSync(DEL_PATH, JSON.stringify(deletions, null, 1));
  fs.writeFileSync(GROUPS_PATH, JSON.stringify(dupGroups, null, 1));

  const reasonCount = {};
  for (const d of deletions) reasonCount[d.reason] = (reasonCount[d.reason] || 0) + 1;
  const reasonBytes = {};
  for (const d of deletions) reasonBytes[d.reason] = (reasonBytes[d.reason] || 0) + d.size;

  const report = [];
  report.push('========== 百度网盘重复文件分析报告 ==========');
  report.push('扫描文件总数: ' + totalFiles + '  总容量: ' + fmtB(totalBytes));
  report.push('可判重文件(md5非空且size>0): ' + usable.length + '  无md5: ' + noMd5.length + '  零字节(跳过): ' + zeroBytes.length);
  report.push('');
  report.push('重复组数: ' + dupGroups.length);
  report.push('待删除文件数: ' + delCount + '  可释放容量: ' + fmtB(delBytes));
  report.push('保留副本数: ' + dupGroups.length + '（每组保留评分最高者 1 份）');
  report.push('');
  report.push('按删除原因分类:');
  for (const k of Object.keys(reasonCount).sort()) report.push('  ' + k + ': ' + reasonCount[k] + ' 个, ' + fmtB(reasonBytes[k] || 0));
  report.push('');
  report.push('重复 Top10 大文件组:');
  const top = [...dupGroups].sort((a, b) => b.size - a.size).slice(0, 10);
  for (const g of top) report.push('  [' + fmtB(g.size) + ' x' + g.count + '] 保留: ' + g.keep.path);
  report.push('');
  report.push('说明: 删除将进入百度网盘回收站（默认10天可恢复）');
  report.push('提示: 零字节文件(MD5恒为D41D8CD9...)不构成真实重复，已跳过');
  fs.writeFileSync(REPORT_PATH, report.join('\n'), 'utf8');
  console.log(report.join('\n'));
  console.log('outputs: deletions.json / dup_groups.json / dup_report.txt');
}

main();
