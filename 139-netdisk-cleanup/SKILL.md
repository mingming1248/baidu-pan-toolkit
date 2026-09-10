---
name: 139-netdisk-cleanup
description: "139网盘/中国移动云盘(yun.139.com)无VIP清理工具包：CDP浏览器桥接调用官方Web API，全盘扫描导出文件内容指纹(SHA-256 contentHash)、内容级去重、批量删除(回收站/彻底删)、回收站清空。当用户要求清理139网盘、删除重复文件、导出文件清单/MD5指纹、网盘瘦身时使用。139 Netdisk (China Mobile Cloud) cleanup toolkit - scan inventory, content-hash dedup and batch delete via CDP bridge."
---

# 139网盘（中国移动云盘）清理工具包

针对 139 网盘网页版（yun.139.com）的完整清理方法论与脚本工具。无需 VIP、无需账号密码——通过 CDP（Chrome DevTools Protocol）复用用户已登录的浏览器会话，调用官方 Web API 完成全盘扫描、内容指纹去重、批量删除与回收站清空。

方法论与百度/189 网盘工具包同源：**CDP 复用登录态 + 官方 Web API**。本 skill 是其第三个实现，已在一个 140G 空间的账号上完成全链路 API 实测（列表/指纹/删除/清空全部打通）。

## 适用场景

- 用户要求清理 139 网盘中的重复文件（"139网盘的重复文件删一下"）
- 全盘文件清单/内容指纹（SHA-256）导出备份（"把文件md5备份到本地"）
- 网盘瘦身、释放空间；回收站清空

## 前置条件

1. **Node.js ≥ 18**（需原生 `WebSocket`、`fetch`）
2. **Edge 或 Chrome**，以远程调试模式启动（端口 9222），并已登录 yun.139.com：
   ```bat
   scripts\launch_edge_debug.bat
   ```
   登录一次后 cookie 持久化在独立 profile（`%LOCALAPPDATA%\139-cdp-profile`），后续无需重复登录。
3. 全部脚本在**一个专用空工作目录**下运行（脚本用 `process.cwd()` 定位输出文件，不污染脚本目录）。

## 核心原理（务必理解后再操作）

| 要点 | 说明 |
|---|---|
| 网页入口 | **yun.139.com**（`cloud.139.com` 是云手机页，不是网盘！） |
| 会话获取 | 浏览器登录后，脚本经 CDP 在页面内执行 fetch，复用页面运行时（`window.MCloudVM.$store.state.auth`），无需抓包 |
| 认证（关键坑） | 不是 cookie 直带，是 **Basic 认证**：`Authorization: Basic base64("pc:" + 手机号 + ":" + authToken)`。authToken 为运行时会话令牌（含账号信息，会轮换），**每次请求从运行时动态读取，勿硬编码** |
| 必带请求头 | `Content-Type: application/json`、`x-yun-api-version: v1`、`x-yun-app-channel: 10000034`、`x-yun-module-type: 100`、`x-yun-client-info: ||9|1|1|1|||zh|||MQ==||`、`mcloud-route: 001` |
| 列表接口 | `POST https://personal-kd-njs.yun.139.com/hcy/file/list` |
| 列表请求体（关键坑） | 字段是 **`parentFileId`**（不是 catalogId！）；分页是 **`pageInfo:{pageSize,pageCursor}`**（不是 startNumber/endNumber）；根目录 ID 为 `"/"`。排序字段是 **`updated_at`/`name`/`size`**（下划线，不是 updateTime）。完整：`{commonAccountInfo:{account:手机号,accountType:1}, pageInfo:{pageSize:100,pageCursor:null}, orderBy:"updated_at", orderDirection:"DESC", parentFileId:"/", imageThumbnailStyleList:["Small","Large"]}` |
| 内容指纹（最大优势） | 列表响应**直接返回** `contentHash` + `contentHashAlgorithm`（SHA-256）——**无需逐文件下载计算**，比百度/189 更省流量。响应字段：fileId/name/size/type/parentFileId/createdAt/updatedAt/systemDir |
| 分页 | 响应 `data.nextPageCursor` 非空则继续翻页（pageCursor=nextPageCursor）；`pageSize` 最大 100 |
| 移入回收站 | `POST /hcy/recyclebin/batchTrash`，body `{fileIds:[...]}`（可批量），返回 taskId |
| 彻底删除 | `POST /hcy/file/batchDelete`，body `{fileIds:[...]}` |
| 清空回收站 | `POST /hcy/recyclebin/clear`，body `{commonAccountInfo}` |
| 系统目录 | 根目录的「手机图片/手机视频/同步/photo/手机备份/139邮箱」等 systemDir 目录经 file/list 返回空（内容可能在独立照片云接口），**不要判为异常** |

## 完整工作流（六阶段）

以下命令均在工作目录执行；`<SKILL_DIR>` 指本 skill 的 scripts 目录绝对路径。

### Phase 0 — 启动调试浏览器并登录
```bat
<SKILL_DIR>\launch_edge_debug.bat
```
在打开的窗口中登录 139 网盘（yun.139.com，扫码/短信）。登录状态自动持久化。**务必让用户在该调试窗口操作**（日常浏览器窗口 Cookie 相互隔离，操作无效）。

### Phase 1 — 全盘扫描（含内容指纹）
```
node <SKILL_DIR>\139_scan.js
```
- 输出：`139_inventory.jsonl`（全盘清单：文件 path/fileId/size/contentHash/algorithm + 文件夹）、`scan_state.json`（断点状态）
- 可中断重跑，自动断点续扫；认证失效会自动等待重新登录
- 完成后记录文件总数与总容量作为基准账目

### Phase 2 — 重复分析并生成删除计划
```
node <SKILL_DIR>\139_analyze.js
```
- 按 `contentHash` 分组（SHA-256 全等即重复），每组保留 1 个最优副本，其余进入删除计划
- **评分规则（保留分高者）**：非系统目录 +200；文件名无重复下载后缀 `(N)` +500；无时间戳后缀 +300；路径更短微加分
- **空指纹/无 hash 文件一律跳过**（无法判定，不构成可证重复）
- 输出：`deletions.json`（含 fileId/path/size/hash/reason）、`dup_groups.json`（人读版）、`dup_report.txt`（统计报告）

### Phase 3 — 向用户确认
把 Phase 2 的统计（重复组数、待删文件数、可释放容量、保留策略、回收站可恢复）报给用户，**取得明确同意后再删除**。可先小批量试删（Phase 4 的 limit 参数）。

### Phase 4 — 批量删除
```
node <SKILL_DIR>\139_del.js            # 全量（默认移入回收站）
node <SKILL_DIR>\139_del.js 100        # 试运行：本轮最多提交 100 个
node <SKILL_DIR>\139_del.js 0 --hard   # 彻底删除（跳过回收站，慎用）
```
- 默认读 `deletions.json` + 进度文件 `del_progress.json`
- 内置：断点续删、认证失效等待、批次自适应（50/批 + 2s 间隔，可降频）
- 建议后台运行，定期查看日志

### Phase 5 — 终验（把 Phase 1 重做一遍）
在**新的空目录**中重跑 `139_scan.js` + `139_analyze.js`：
- 账目核对：`初始文件数 − 已删文件数 = 终扫文件数`，计划内文件终扫残留必须为 0
- 期望结果：**0 组真实重复**（无 hash 文件除外）
- 若终扫文件数比预期少，多出的差值通常为**用户手动删除**，向用户说明

### Phase 6 — 总结报告
汇总文件数/容量/失败数、时间线、终验结论、回收站到期情况，交付报告。

## 故障排查

| 现象 | 原因与处置 |
|---|---|
| 列表返回 `04000005 认证失败` | authToken 过期/登录失效 → 脚本自动进入等待循环，去调试窗口重新登录即可 |
| 列表返回 `04000002 排序字段不合法` | orderBy 用错值 → 必须用 `updated_at`/`name`/`size`（下划线），不要用 updateTime |
| 列表返回 `04000002 父目录ID不允许为空` | 字段名写错 → 必须用 `parentFileId`（不是 catalogId），根目录为 `"/"` |
| 列表返回 `04000002 文件类型为file/folder` | type 字段值非法 → 列表请求**不要带** type 字段（getDisk 转换中 filterType=0 会省略 type） |
| evaluate 长时间超时 | 标签页被冻结 → 脚本已内置唤醒（`Page.setWebLifecycleState('active')` + `Page.bringToFront`）；仍失败则重启调试浏览器 |
| CDP 9222 端口不通 | 调试实例退出 → 重新运行 `launch_edge_debug.bat`（profile 持久化，cookie 保留，通常无需重新登录） |
| 打开 cloud.139.com 显示云手机 | 那是云手机页，正确入口是 **yun.139.com** |

## 实测记录（本会话）

- 认证/列表/分页/指纹/删除/清空全链路 API 实测通过
- 判重验证：上传 2 个相同文件 → contentHash 完全一致（SHA-256）→ batchTrash 删除其一 → 列表确认 → 清理 → recyclebin/clear 清空
- 实测账号为近空盘（2M/140G）：全盘扫描得 16 个目录、0 个文件（系统目录经 file/list 返回空属正常）

## 安全红线

- 删除前必须向用户确认范围；先小批量试删验证
- 永远保留每组重复中的 1 个副本（评分最高者）
- 默认删除进回收站；`--hard` 彻底删除需用户明确同意
- 不碰系统目录；无 hash 文件不判重、不删除
- 写操作走浏览器页面内 fetch（CDP 桥接），保持与官方前端一致的请求形态
