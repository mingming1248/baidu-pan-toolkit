# 百度网盘工具箱（Baidu Netdisk Toolkit）

无 VIP、不开客户端、不依赖任何第三方 API 密钥的百度网盘网页版自动化工具集。基于 **CDP（Chrome DevTools Protocol）** 桥接已登录的浏览器会话，在页面内直接调用百度官方 Web API，完成两大任务：

1. **`baidu-netdisk-dedup`** — 单账号内 MD5 内容级去重清理
2. **`baidu-netdisk-merge`** — 跨账号整盘迁移合并（分享 → 转存 → 源端清理 → 注销验证）

> 两个 skill 目的与方法完全不同：dedup 是"账号内找重删重"，merge 是"账号间全量搬家"。请按场景选用。

---

## 为什么不用官方客户端 / 第三方工具？

| 痛点 | 本方案 |
|---|---|
| 无 VIP，网盘批量删除/转存受限 | 复用网页版登录态，走官方 Web API，不触发会员限制 |
| 下载上传兜底太慢 | 全程服务端操作（删除 / 分享 / 转存），文件不落地本地 |
| 手工批量操作太耗时 | 脚本化分阶段执行，可断点续跑 |
| 第三方工具泄露账号风险 | 无凭证交互，全部操作在本地浏览器会话内完成 |

## 环境要求

- Windows（脚本含 `.bat` 启动器；核心逻辑为 Node.js 脚本，可在 macOS/Linux 运行）
- Node.js ≥ 18（原生 `WebSocket` / `fetch`）
- Edge 或 Chrome 浏览器（以远程调试端口启动，独立 profile 登录百度网盘）

---

## 1. baidu-netdisk-dedup — 重复文件清理

[`baidu-netdisk-dedup/`](./baidu-netdisk-dedup/SKILL.md)

### 能力

- **全盘扫描**：递归枚举全部文件与文件夹，从服务端直接获取每个文件的 **MD5 + 大小**（内容级指纹，与文件名无关，零误判）
- **去重分析**：按 `md5:size` 分组，评分规则自动保留最优副本，其余生成删除计划
- **批量删除**：调用 `filemanager?opera=delete`，支持断点续删、批间隔降频、登录失效自动等待、errno 132 验证拦截处置
- **终验复核**：删除后全盘重扫，账目核对必须分毫不差

### 实测成绩

- 单账号 3.06 万文件 / 1.93TB 全盘扫描约 11 分钟
- 1,950 个重复文件分批删除零失败，释放 **24.09GB**
- 删除先进回收站（10 天恢复期），安全兜底

### 快速开始

```bat
:: 1. 启动调试浏览器并登录
scripts\launch_edge_debug.bat

:: 2. 全盘扫描（含 MD5）
node scripts\scan_md5.js

:: 3. 去重分析，生成删除计划 deletions.json
node scripts\analyze_dup.js

:: 4. 确认计划后批量删除（先小批量试运行）
node scripts\del_driver.js 100
node scripts\del_driver.js

:: 5. 终验：在新目录重跑 scan_md5.js + analyze_dup.js，核对账目
```

### 关键坑位（已验证）

- `filelist` **必须是纯路径字符串数组** `["/a/b.txt","/c/d.txt"]`，写成对象数组会触发 errno 132 安全拦截
- 删除请求必须带 `X-Requested-With: XMLHttpRequest`、`newVerify=1`、随机 `dp-logid`
- errno 132 处置：让用户在调试窗口手动删除一个文件打通验证状态，再重跑（进度已断点保存）

---

## 2. baidu-netdisk-merge — 跨账号合并

[`baidu-netdisk-merge/`](./baidu-netdisk-merge/SKILL.md)

### 能力

把源账号（小容量）全部文件迁移到目标账号（大容量），之后可注销源账号。全程无需下载、无需 VIP：

```
源账号                   目标账号
   │ 枚举清单                  │
   │ 切分单元(≤500文件)         │
   │ 逐个创建分享(带密码)        │
   │ ──── 分享链接 ────────→ 预建目录链
   │                        │ 导航分享页验证
   │                        │ 批量转存 /share/transfer
   │ ←──────── 转存结果 ────
   │ 完整性验证(路径+大小+MD5)   │
   │ 分批删除已转存(40/批)       │
   │ 补删空目录                 │
   │ 注销源账号 → 验证登录失效     │
```

### 实测成绩

- 源账号 5,115 条目 / 221GB（3,901 文件 + 853 文件）→ 切分 **80 个迁移单元**
- 分享创建 80/80（79 成功 + 1 因内容审查失败），转存 **79/79 全部成功**
- 完整性验证 **4,754/4,755 文件大小零差异**（唯一缺失为被内容审查拦截的 505MB tar 文件）
- 源端删除 96 批全成功 + 7 空目录补删，注销后登录态四信号全失效

### 快速开始

```bat
:: 0. 启动两个调试实例（目标 9222 / 源 9223），分别登录
scripts\launch_edge_debug.bat 9222
scripts\launch_edge_debug.bat 9223

:: 1. 源账号全盘枚举
node scripts\scan_account.js 9223

:: 2. 切分迁移单元（≤500 文件/单元）
node scripts\plan_units.js dirs_inventory.json migration_plan.json

:: 3. 源账号创建分享
node scripts\share_create.js 9223 migration_plan.json share_units.json

:: 4. 目标账号批量转存（源账号 UK 为必传参数，通过分享页源码/API 获取）
node scripts\transfer_all.js 9222 share_units.json transfer_results.json <源UK>

:: 4b. 失败单元重试
node scripts\retry_transfer.js 9222 share_units.json transfer_results.json <源UK>

:: 5. 完整性验证（路径 + 大小零差异）
node scripts\verify_migration.js 9222 dirs_inventory.json /目标顶层目录...

:: 6. 源账号删除已转存 + 补删空目录
node scripts\delete_migrated.js 9223 share_units.json
node scripts\del_empty_dirs.js 9223

:: 7. 注销源账号后验证登录失效
node scripts\verify_account_deleted.js 9223
```

### 关键坑位（已验证）

- **一次分享不能太多文件** → 目录树按 ≤500 文件/单元切分（转存接口 fsidlist 上限）
- 分享创建走 `/share/set`（`/api/sharing/create` 是 404，已证伪）
- 转存必须先**导航分享页（带 pwd）完成验证**再调 `/share/transfer`；cookie 级验证不跨分享共享（`share/verify` 返回 -12，不可行）
- 跨账号 `move` 不可行（六种参数组合全 errno:2）→ 只能分享转存
- 分享内容审查（errno 109，常见于大 tar 等敏感文件）会拦截个别文件 → 告知用户人工处理，不要反复重试

---

## 安全说明

- 所有操作复用用户**已登录**的浏览器会话，无任何账号密码 / token / cookie 交互
- 删除全部进回收站（10 天恢复期）
- 脚本默认**不硬编码任何账号信息**：端口、源账号 UK 等均为运行时参数
- 仅供个人网盘管理使用，请遵守百度网盘服务条款，勿用于违规内容操作

## 目录结构

```
baidu-pan-toolkit/
├── README.md
├── baidu-netdisk-dedup/
│   ├── SKILL.md              # 去重方法论（完整文档）
│   └── scripts/
│       ├── launch_edge_debug.bat
│       ├── scan_md5.js       # 全盘扫描（含 MD5）
│       ├── analyze_dup.js    # 去重分析与删除计划
│       ├── del_driver.js     # 批量删除驱动（断点续删）
│       ├── verify_del.js     # 单文件删除验证
│       └── net_capture.js    # 前端请求抓包对比
└── baidu-netdisk-merge/
    ├── SKILL.md              # 跨账号合并方法论（完整文档）
    └── scripts/
        ├── cdp_common.js     # CDP 连接工具库
        ├── launch_edge_debug.bat
        ├── scan_account.js   # 源账号全盘枚举
        ├── plan_units.js     # 迁移单元切分（≤500 文件）
        ├── share_create.js   # 创建分享
        ├── transfer_all.js   # 批量转存
        ├── retry_transfer.js # 转存失败重试
        ├── verify_migration.js  # 完整性验证
        ├── delete_migrated.js   # 源端删除已转存
        ├── del_empty_dirs.js    # 补删空目录
        ├── verify_account.js    # 登录态快速检查
        └── verify_account_deleted.js  # 注销验证
```

## License

MIT
