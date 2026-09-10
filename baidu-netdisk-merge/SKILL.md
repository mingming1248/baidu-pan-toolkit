---
name: baidu-netdisk-merge
description: 跨账号迁移/合并两个百度网盘账号（非VIP方案）。当用户想把一个百度网盘账号的全部文件迁移到另一个账号（如账号合并、注销前搬家、大容量账号归集小账号）时使用。通过 CDP 调试实例 + 分享转存 API 实现：无需下载上传、无需 VIP、无需手工批量操作。与 baidu-netdisk-dedup（单账号内 MD5 去重）目的和方法完全不同；本 skill 专注"账号到账号"的整盘迁移闭环：枚举 → 切分单元 → 建分享 → 批量转存 → 完整性验证 → 源端删除 → 注销验证。
---

# Baidu Netdisk 跨账号合并（Merge）

## 定位与边界

- **适用**：A/B 两个百度网盘账号，把 B 全部文件迁移进 A，之后注销 B。非会员、不下载、不秒传。
- **与去重 skill 的区别**：`baidu-netdisk-dedup` 是单个账号内按 MD5 找重复文件并删除；本 skill 是**跨账号整盘迁移**，核心是"分享 → 转存"管线。两者脚本、接口、数据文件互不通用。
- **不做**：单账号整理/去重（走 dedup skill）；文件内容编辑；下载到本地（非会员 dlink 拿不到）。

## 核心方案（为什么这么做）

1. 一次分享不能太多文件 → 把源账号目录树按 **≤500 文件/单元** 切分（转存接口的 fsidlist 上限）。
2. 分享创建走 `/share/set`（`/api/sharing/create` 是 404，已证伪）。
3. 转存必须先**导航分享页（带 pwd）完成验证**，再调 `/share/transfer`；cookie 级验证不跨分享共享（`share/verify` 返回 -12，不可行）。
4. 完整性靠"源清单 vs 目标递归扫描"按相对路径 + 大小对比（list API 同时返回 md5，可加验）。
5. 源端清理按 fs_id 命中删除（40/批、8s 间隔），删除后重扫验证 0 残留。
6. 全程页面内 fetch（`credentials:'include'` + `X-Requested-With: XMLHttpRequest`），复用调试实例登录态，无 token 处理。

## 前置条件

- Windows 上 Edge 以 `--remote-debugging-port` 启动两个独立 profile（源/目标各一，登录态长期有效）。
- 需要确认两个调试实例的端口号（默认约定：目标账号 9222、源账号 9223；用 `launch_edge_debug.bat` 启动）。
- Node.js 环境；所有脚本在本机运行，通过 CDP 连接调试实例。

## 工作流（按序执行，每步有对应脚本）

### Step 0 启动双实例
`scripts/launch_edge_debug.bat <端口> <profile名>` 启动目标账号实例，再启动源账号实例；分别在打开的窗口登录对应账号（登录一次长期有效）。可用 `verify_account.js <端口>` 快速确认登录态。

### Step 1 源账号全盘枚举
`scripts/scan_account.js <源端口>` → 输出 `dirs_inventory.json`（每个文件/目录的 path、fs_id、isdir、size）。
- 分页拉取每目录（num=1000），BFS 遍历全部目录。
- 记录文件总大小，作为迁移基线。

### Step 2 切分迁移单元
`scripts/plan_units.js <inventory.json> <plan.json>` → 生成迁移计划：
- 目录单元：子树文件数 ≤500 的目录整体一个单元（`{type:'dir', path, fs_id, file_count}`）。
- 文件级单元：目录下直接平铺文件按 ≤500 分批（`{type:'files', dir, files:[fs_id...]}`）。
- 大目录递归下钻，直到每单元 ≤500。

### Step 3 创建分享（源账号）
`scripts/share_create.js <源端口> <plan.json> <shares.json>`：
- 每单元 `POST /share/set`，body：`fid_list=<JSON数组>&schannel=4&channel_list=[]&period=0&pwd=<4位随机>&random_code=<随机>&bdstoken=<t>`。
- 记录返回 `link`/`shareid`；errno≠0 记入失败清单（常见：errno 109 = 分享内容审查，如大 tar 敏感文件，需人工处理或换单元）。

### Step 4 批量转存（目标账号）
`scripts/transfer_all.js <目标端口> <shares.json> [results.json] <源账号UK>`：
1. 先预建所有父目录链（`/api/create?a=commit`，body `path&isdir=1&block_list=[]`）。
2. 每单元：`Page.navigate` 到分享页 `https://pan.baidu.com/s/<short>?pwd=<pwd>` → sleep 7s → `POST /share/transfer?shareid=<id>&from=<源UK>&bdstoken=<t>`，body `fsidlist=<JSON数组>&path=<父目录>`。
- 目录单元 fsidlist=[fs_id]，转存到其父目录；文件单元 fsidlist=fs_id数组，转存到该目录。
- 失败自动重试机制见 `retry_transfer.js`（对 errno 非 0 单元重跑一次）。

### Step 5 完整性验证
`scripts/verify_migration.js <目标端口> <源inventory.json>`：
- 递归扫描目标迁移落地目录，按相对路径匹配源清单，比对大小（0 差异 = 完美）。
- 输出 matched / missing / sizeMismatch 明细；缺失文件单独列表。

### Step 6 源账号删除已转存
`scripts/delete_migrated.js <源端口> <shares.json>`：
1. 重扫源账号全盘 → fs_id→path 映射。
2. 删除集合 = 成功单元的全部 fs_id（目录按单元 fs_id，文件按 fs_id 数组）。
3. 40/批、8s 间隔 `filemanager opera=delete`（filelist=纯路径数组整体 urlencode）。
4. 触发验证（errno 132 或 show_msg 含"验证"）→ 暂停等人工。
5. 删除后重扫，确认应删 fs_id 残留 0。
- 随后 `scripts/del_empty_dirs.js <源端口>` 清理空目录壳。

### Step 7 注销与验证
- 用户自行注销源账号后，运行 `scripts/verify_account_deleted.js <源端口>`：检查 bdstoken/list/quota/userinfo 四信号全失效（errno -6 / 跳转 login）即注销成功。

## 接口速查（页面内 fetch，均带 credentials:include）

| 操作 | 接口 | 要点 |
|---|---|---|
| 列表 | `GET /api/list?channel=chunlei&clienttype=0&web=1&app_id=250528&num=1000&order=name&desc=0&showempty=0&dir=<enc>&page=N` | num 上限 1000，>1000 分页 |
| bdstoken | `GET /api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=["bdstoken"]` | 每实例独立 |
| 建目录 | `POST /api/create?a=commit&bdstoken=<t>&clienttype=0&app_id=250528&web=1` | body `path&isdir=1&block_list=[]` |
| 分享创建 | `POST /share/set?channel=chunlei&clienttype=0&web=1&app_id=250528` | body `fid_list&schannel=4&channel_list=[]&period=0&pwd&random_code&bdstoken` |
| 转存 | `POST /share/transfer?shareid=<id>&from=<UK>&bdstoken=<t>` | **先导航分享页带 pwd 验证**；body `fsidlist&path` |
| 删除 | `POST /api/filemanager?async=2&onnest=fail&opera=delete&bdstoken=<t>&newVerify=1&clienttype=0&app_id=250528&web=1&dp-logid=<rand>` | body `filelist=<纯路径字符串数组整体urlencode>`；目录路径可递归删 |

## 已验证失败（不要再试）

- `/api/sharing/create` → 404
- `share/verify` → errno -12（验证不跨分享共享）
- rapidupload 秒传 → errno:2（>4MB 需分片 md5，不可行）
- download / dlink 接口 → errno:2（需签名）；浏览器 UI 下载弹"打开客户端"（非会员受限）
- `filemanager opera=move` 六种参数组合 → 全 errno:2（跨账号移动不可行，必须走分享转存）

## 数据文件契约

- `dirs_inventory.json`：`[{path, fs_id, name, isdir, size?}]`
- `plan.json`：`{units:[{type:'dir'|'files', path, fs_id?, files?, file_count}], flatFilesUnits:[...]}`
- `shares.json`：`[{idx, type, path, fs_id, files, file_count, pwd, errno, link, shareid, err?}]`
- `results.json`：`[{idx, path, type, parent, file_count, shareid, status, errno?, show_msg?}]`

## 注意事项

- **一次不要并行太多转存**：串行 + 1.5s 间隔 + 每 10 个打印进度，避免触发风控。
- 大目录拆分粒度按文件数（≤500），不是按大小；单文件超大（如 >500MB）无法拆分，只能整体单元。
- 分享内容审查（errno 109）命中时换小单元或告知用户人工处理；**不要反复重试同一敏感文件**。
- 所有删除前先确认目标存在，删除后逐一回查（err -9 = 已删）。
- 容量口径以实际 list 聚合为准；迁移前后总量应基本不变（允许去重等微小差异）。
