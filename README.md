# 网盘去重工具箱（Netdisk Toolkit）

无 VIP、不开客户端、不依赖任何第三方 API 密钥的**网盘网页版自动化工具集**。基于 **CDP（Chrome DevTools Protocol）** 桥接已登录的浏览器会话，在页面内直接调用官方 Web API，完成网盘清理与迁移任务。

## 核心思想：网盘去重（通用方法论）

> **这种思路不限于本仓库已实现的百度网盘、天翼云盘（189）——夸克网盘、阿里云盘、139 网盘，以及任何提供 Web API 的网盘，都可以用同一套方法做重复文件清理。**

通用范式只有四步：

1. **复用登录态**：用 CDP 把已登录的浏览器标签页桥接出来，页面内 fetch 官方接口自动携带 Cookie / 会话凭证，无需账号密码、无需抓包逆向
2. **枚举 + 内容指纹**：递归调用官方列表接口，拿全盘文件清单和 **MD5 内容指纹**（服务端直接返回，与文件名无关，零误判）
3. **按 `md5:size` 判重**：内容一致的才算重复，每组保留 1 个最优副本，其余生成删除计划
4. **受控批量删除**：调用官方批量任务 / 删除接口，串行 + 低频 + 断点续删，删除进回收站兜底

任何网盘要接入，只需改三个参数：**列表接口、批量删除接口、会话凭证的获取方式**（本仓库的 `baidu-netdisk-dedup` 与 `cloud189-netdisk-dedup` 就是同一方法论在不同网盘上的两个落地实例）。

---

## 本仓库包含的 Skill

| Skill | 网盘 | 用途 | 实测成绩 |
|---|---|---|---|
| [`baidu-netdisk-dedup`](./baidu-netdisk-dedup/SKILL.md) | 百度网盘 | 单账号内 MD5 去重 | 3.06 万文件 / 1.93TB 扫描 11 分钟；删 1,950 重复释放 24.09GB |
| [`cloud189-netdisk-dedup`](./cloud189-netdisk-dedup/SKILL.md)（网盘去重） | 天翼云盘 189 | 单账号内 MD5 去重 + 空文件夹清理 | 23.8 万文件 / 1.62TB 扫描 10 分钟；删 13.7 万文件释放 844GB，终验 0 重复 |
| [`baidu-netdisk-merge`](./baidu-netdisk-merge/SKILL.md) | 百度网盘 | 跨账号整盘迁移合并（注销前搬家） | 221GB / 4,754 文件零差异，源端清理全成功 |

> dedup（去重）与 merge（合并）目的与方法完全不同：dedup 是"账号内找重删重"，merge 是"账号间全量搬家"。请按场景选用。

---

## 实战验证

本方法论已在真实账号上完整跑通（所有删除均进回收站，10 天恢复期）：

| 工程 | 规模 | 结果 |
|---|---|---|
| 百度网盘去重 | 单账号 3.06 万文件 / 1.93TB | 删除 1,950 个重复文件，释放 24.09GB，终验账目分毫不差 |
| 天翼云盘 189 去重 | 单账号 23.8 万文件 / 1.62TB | 三批删除 13.7 万文件 / 844GB 全程零失败，终验 0 重复、0 空文件夹 |
| 百度网盘跨账号合并 | 源账号 221GB / 5,115 条目 | 79 个迁移单元全部转存，4,754 文件大小零差异，源账号注销成功 |

> 三个工程均无 VIP、无账号密码交互、无第三方工具；完整过程复盘已沉淀为上方三个 Skill，可直接复用。

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
- Edge 或 Chrome 浏览器（以远程调试端口启动，独立 profile 登录网盘）

---

## 1. baidu-netdisk-dedup — 百度网盘重复文件清理

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

## 2. cloud189-netdisk-dedup — 天翼云盘（189）重复文件清理

[`cloud189-netdisk-dedup/`](./cloud189-netdisk-dedup/SKILL.md)　·　Skill 名：**网盘去重**

### 能力

- **全盘扫描**：`listFiles.action` 返回 XML，递归枚举全部文件/文件夹，含 **MD5 + 大小**
- **去重分析**：按 `md5:size` 分组 + 四类分层（A 同文件夹时戳副本 / C 时戳文件夹 / B1 整树镜像 / B2 零散重复）
- **批量删除**：`createBatchTask.action` 批量任务 + `checkBatchTask` 轮询，单账号串行、批次自适应 200→400、断点续删
- **空文件夹清理**：只删"因清理而变空"的空壳目录，最大层级递归删除
- **WAF 对抗**：写操作走浏览器桥接复用挑战 Cookie；请求体文件名替换为通用名规避内容规则拦截（服务端按 fileId 定位，结果准确）

### 实测成绩

- 单账号 23.8 万文件 / 1.62TB 全盘扫描约 10 分钟
- 13.7 万文件 / 844GB 分三批删除，全程零失败
- 终验重扫：101,280 文件 **0 组真实重复、0 个空文件夹**，账目分毫不差

### 快速开始

```bat
:: 1. 启动调试浏览器并登录 cloud.189.cn
scripts\launch_edge_debug.bat

:: 2. 全盘扫描（含 MD5）
node scripts\scan_md5.js

:: 3. 去重分析，生成删除计划 deletions.json
node scripts\analyze_dup.js

:: 4. 确认计划后批量删除（先小批量试运行）
node scripts\del_driver.js 200
node scripts\del_driver.js

:: 5. 清理空文件夹（三步）
node scripts\del_empty_folders.js plan
node scripts\del_empty_folders.js run
node scripts\del_empty_folders.js verify

:: 6. 终验：在新目录重跑 scan_md5.js + analyze_dup.js，核对账目
```

### 关键坑位（已验证）

- **单账号同一时间只允许一个批量任务**：并发提交会导致约 20% 批次整批失败，必须单进程串行（吞吐反而更高）
- 写操作必须经浏览器页面内 fetch（CDP 桥接），Node 直连被 WAF 指纹拦截 403
- 请求体中的 `fileName` 必须替换为通用名（`f0.tmp`）——WAF 内容规则会拦截含系统文件名的请求体
- 后台标签页会被浏览器冻结：每次请求前先 `setWebLifecycleState('active')` + `bringToFront` 唤醒

---

## 3. baidu-netdisk-merge — 跨账号合并

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
- 脚本默认**不硬编码任何账号信息**：端口、账号 UK 等均为运行时参数
- 仅供个人网盘管理使用，请遵守各网盘服务条款，勿用于违规内容操作

## 目录结构

```
netdisk-toolkit/
├── README.md
├── LICENSE
├── baidu-netdisk-dedup/          # 百度网盘去重（MD5 内容级）
│   ├── SKILL.md
│   └── scripts/                  # 扫描 / 分析 / 删除 / 验证 / 抓包
├── cloud189-netdisk-dedup/       # 天翼云盘 189 去重（Skill 名：网盘去重）
│   ├── SKILL.md
│   └── scripts/                  # 扫描 / 分析 / 删除 / 空文件夹清理
└── baidu-netdisk-merge/          # 百度网盘跨账号合并
    ├── SKILL.md
    └── scripts/                  # 枚举 / 切分 / 分享 / 转存 / 验证 / 删除 / 注销验证
```

## License

MIT
