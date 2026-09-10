---
name: baidu-netdisk-dedup
description: "百度网盘(pan.baidu.com)无VIP全盘清理工具包：CDP浏览器桥接调用官方Web API，MD5内容级去重、批量删除重复文件、终验复核。当用户要求清理百度网盘、删除网盘重复文件、网盘瘦身、批量删除文件、按MD5去重时使用。Baidu Netdisk cleanup toolkit - MD5-based dedup and batch delete via CDP bridge. Use when user wants to clean pan.baidu.com, remove duplicate files, free up storage, or batch-delete files."
---

# 百度网盘重复文件清理

针对百度网盘（pan.baidu.com）网页版的完整清理方法论与脚本工具。无需 VIP、无需账号密码——通过 CDP（Chrome DevTools Protocol）复用用户已登录的浏览器会话，调用官方 Web API 完成全盘扫描、MD5 内容级去重、批量删除与终验复核。

实测规模：单账号 3.06 万文件 / 1.93TB 全盘扫描约 11 分钟；1,950 个重复文件分批删除零失败，释放 24.09GB。

## 适用场景

- 用户要求清理百度网盘中的重复文件（"帮我把网盘里的重复文件删掉"）
- 网盘瘦身、释放空间（无 VIP 也可批量删除）
- 删除后的全盘复核验证

## 前置条件

1. **Node.js ≥ 18**（需原生 `WebSocket`、`fetch`）
2. **Edge 或 Chrome**，以远程调试模式启动（端口 9222），并已登录 pan.baidu.com：
   ```bat
   scripts\launch_edge_debug.bat
   ```
   登录一次后 cookie 会持久化在独立 profile（`%LOCALAPPDATA%\baidu-cdp-profile`），后续无需重复登录。
3. 全部脚本在**一个专用空工作目录**下运行（脚本用 `process.cwd()` 定位输出文件，不污染脚本目录）。

## 核心原理（务必理解后再操作）

| 要点 | 说明 |
|---|---|
| 会话获取 | 浏览器登录后，脚本经 CDP 直接复用页面会话；页面内 fetch 同源自动带 cookie，无需抓包逆向 |
| 目录枚举 | `GET /api/list?dir=<路径>&num=100&page=N&...`，返回 **JSON**（entry 含 `fs_id/server_filename/size/md5/isdir/path`）。根目录为 `/` |
| 去重判定 | **MD5 + 大小** 双键分组，与文件名无关——服务端直接返回内容指纹，零误判 |
| bdstoken | `GET /api/gettemplatevariable?fields=["bdstoken"]` 获取，删除请求必须携带 |
| 批量删除 | `POST /api/filemanager?opera=delete&async=2&onnest=fail&bdstoken=...&newVerify=1&...`，body 为 `filelist=<JSON数组>` |
| **filelist 格式（关键坑）** | **必须是纯路径字符串数组** `["/a/b.txt","/c/d.txt"]`（整体 urlencode 后放入 body）。写成对象数组 `[{"path":...}]` 会触发 errno 132 安全拦截 |
| 请求头 | 删除请求必须带 `X-Requested-With: XMLHttpRequest`、`Content-Type: application/x-www-form-urlencoded`；URL 带 `newVerify=1` 和随机 `dp-logid` |
| errno 132 | 安全验证拦截（高频删除或请求格式异常触发）。处置：让用户在调试窗口**手动删除一个文件**打通验证状态，再重跑脚本（进度已断点保存） |
| 高频风控 | 实测删除约 1,200 个/验证周期后再次要求验证；用较小批次（40/批）+ 较长间隔（8s）降低触发频率 |
| 回收站 | 所有删除先进回收站，10 天恢复期——安全兜底，删除前向用户说明 |

## 完整工作流（六阶段）

以下命令均在工作目录执行；`<SKILL_DIR>` 指本 skill 的 scripts 目录绝对路径。

### Phase 0 — 启动调试浏览器并登录
```bat
<SKILL_DIR>\launch_edge_debug.bat
```
在打开的窗口中登录百度网盘（扫码/短信）。登录状态自动持久化。**务必让用户在该调试窗口操作**（日常浏览器窗口 Cookie 相互隔离，操作无效）。

### Phase 1 — 全盘扫描（含 MD5）
```
node <SKILL_DIR>\scan_md5.js
```
- 输出：`inv.jsonl`（全盘清单：文件 path/size/md5 + 文件夹 path）、`scan_state.json`（断点状态）
- 可中断重跑，自动断点续扫；登录失效会自动等待重新登录
- 完成后记录文件总数与总容量作为基准账目

### Phase 2 — 重复分析并生成删除计划
```
node <SKILL_DIR>\analyze_dup.js
```
- 按 `md5:size` 分组，每组用评分规则保留 1 个最优副本，其余进入删除计划
- **评分规则（保留分高者）**：原始文件名（无 `(20xx…)` 时戳后缀）+1000；无浏览器重复下载后缀 `(N)` +500；不在时戳目录中 +100；文件名更简洁微加分
- **零字节文件一律跳过**：空文件 MD5 恒为 `D41D8CD9…` 属数学必然，不构成真实重复
- 输出：`deletions.json`（含 path/size/md5/reason）、`dup_groups.json`（人读版）、`dup_report.txt`（统计报告）
- reason 分类：`A`（文件名带时戳后缀）/ `C`（时戳文件夹重复）/ `B2`（零散重复）

### Phase 3 — 向用户确认
把 Phase 2 的统计（重复组数、待删文件数、可释放容量、保留策略、回收站 10 天可恢复）报给用户，**取得明确同意后再删除**。可先小批量试删（Phase 4 的 limit 参数）。

### Phase 4 — 批量删除
```
node <SKILL_DIR>\del_driver.js            # 全量
node <SKILL_DIR>\del_driver.js 100        # 试运行：本轮最多提交 100 个
```
- 默认读 `deletions.json` + 进度文件 `del_progress.json`
- 内置：断点续删、登录失效等待、errno 132 自动提示（等待用户手动删除打通验证）、异步任务轮询、批次自适应
- 参数：`node del_driver.js <limit> <plan.json>`
- 建议后台运行，定期查看日志

### Phase 5 — 终验（把 Phase 1 重做一遍）
在**新的空目录**中重跑 `scan_md5.js` + `analyze_dup.js`：
- 账目核对：`初始文件数 − 已删文件数 = 终扫文件数`，计划内文件终扫残留必须为 0
- 期望结果：**0 组真实重复**（零字节文件除外）
- 若仍有重复（如扫描期间新上传），生成新一轮 deletions.json 回到 Phase 4
- 若终扫文件数比预期少，多出的差值通常为**用户手动删除**（不在计划内），向用户说明

### Phase 6 — 总结报告
汇总文件数/容量/失败数、时间线、终验结论、回收站到期日（删除日 +10 天），交付报告。

## 故障排查

| 现象 | 原因与处置 |
|---|---|
| 删除返回 `errno 132` + authwidget | 安全验证：先检查 filelist 是否为**纯路径字符串数组**且带 `newVerify=1`/`X-Requested-With`；若格式正确，是高频风控——让用户在调试窗口手动删除一个文件打通验证，重跑脚本（断点续删） |
| 删除返回 `errno -6` / list 返回 errno -6 | 登录失效 → 脚本自动进入等待登录循环，去调试窗口重新登录即可 |
| evaluate 长时间超时 | 标签页被冻结 → 脚本已内置唤醒（`Page.setWebLifecycleState('active')` + `Page.bringToFront`）；仍失败则重启调试浏览器 |
| CDP 9222 端口不通 | 调试实例退出 → 重新运行 `launch_edge_debug.bat`（profile 持久化，cookie 保留，通常无需重新登录） |
| Node 直连 CDP fetch 偶发失败 | 瞬时网络问题，重试即可；重试仍失败则重启调试实例 |
| 抓包对比前端真实请求 | 运行 `node <SKILL_DIR>\net_capture.js`（90 秒窗口），让用户手动删除一个文件，对比 URL/参数/header 差异 |
| 快速验证删除是否放行 | 运行 `node <SKILL_DIR>\verify_del.js`（删计划中最小文件，观察 errno） |

## 性能参考（3.06 万文件/1.93TB 实测）

- 全盘扫描：约 11 分钟（BFS 并发 8 目录/批，`num=100` 分页）
- 删除吞吐：100/批 + 3s 间隔约 35 个/秒；降频后 40/批 + 8s 间隔约 5 个/秒（更稳，风控触发少）
- 终验重扫：与首扫同量级，完成后账目必须分毫不差

## 安全红线

- 删除前必须向用户确认范围；先小批量试删验证
- 永远保留每组重复中的 1 个副本（评分最高者）
- 所有删除进回收站（10 天），报告中注明到期日
- 不碰系统目录；零字节文件不判重、不删除
- 写操作走浏览器页面内 fetch（CDP 桥接），不要用 Node 直连模拟，避免被风控拦截
