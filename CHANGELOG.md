# Changelog

本项目自 0.3.0 起遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（SemVer）。

## [未发布]

### 修复

- **`patch:apply` 在 dsh profile / pnpm 全局安装下报“未定位到 dsh 核心目录”**：`resolveCoreRoot` 以前只探测 npm 全局路径
  （`/usr/local/lib`、`/opt/homebrew/lib`、`npm root -g`），而 `dsh` 从 `~/.dsh` 启动时核心模块并不在这些位置，于是永远探测不到。
  现在按优先级探测：`--root` / `DSH_CORE_DIR` → 插件自身目录链的祖先（`<profile>/node_modules/<plugin>` → `<profile>`）→
  `~/.dsh`、`~/.dsh/profiles` 及各 profile → `/usr/local`、`/opt/homebrew`、`npm root -g`、`pnpm root -g` 与 pnpm 全局目录
  （含 `.pnpm/node_modules`）。探测失败时列出全部候选路径，便于用 `--root` 指定。

### 新增

- `patch:where`（`node patches/patch-core.mjs where`）：打印实际命中的 dsh 核心目录。

## [0.5.2] - 2026-09-08

### 修复

- **overclock 下"每轮一次系统提示词"漏发**：若某一轮没有工具结果（空轮）或被中断（没有 `turn/end`），轮末不会产生普通 replace，`seriesGeneration` 不变，下一轮首条请求便不会 append `request/header{reason:"series"}`，Chat 该轮完全不显示系统提示词。现在两处兜底：
  - `nudgeSeries` 在本轮没有工具结果时退化为替换会话里最近的一条（内容不变，不影响历史展示）；
  - `turn/start` 增加兜底：仅当核心已提供 `seriesGeneration`、且自上次 `turn/start` 起代次未变化时，补一次内容不变的替换，保证每轮恰好一次系列边界。

### 变更

- CHANGELOG 中 0.5.1 记录的补丁路径更正为 `patches/patch-core.mjs`（该文件从 `scripts/` 移出，因为 `scripts` 被 .gitignore 忽略）。

## [0.5.1] - 2026-09-08

### 新增

- **核心补丁（方案 C）与命令绑定**：overclock 的每步清除此前会让 Chat 界面每步重复展示一次系统提示词——因为核心对每次 surface `replace` 都递增 `replaceGeneration`，而 `dsh-agent-loop` 据此判定“新系列”并 append `request/header {reason:"series"}`。
  现在新增 `scripts/patch-core.mjs`（`npm run patch:status|apply|revert`），对核心做**双代数**小改动：保留 `replaceGeneration` 原语义，新增只对“非清除型 replace”递增的 `seriesGeneration`；agent-loop 的系列判定改读后者（缺失时回退前者，可独立应用/回退）。
  补丁与命令联动：`/clear-tool-results overclock` 自动 apply、`on`/`off` 自动 revert、`status` 显示补丁状态。补丁写入磁盘后需重启 dsh GUI 生效。
- 插件逐步清除时给 `surfaceOp` 打 `impact:"clear"`（仅在探测到核心已暴露 `seriesGeneration` 时），轮末清除保持普通 replace 并新增 `nudgeSeries` 兜底，保证 Chat 每轮恰好展示一次系统提示词。

### 变更

- `replaceToolResult` 增加 `clearOnly` 参数；`clearToolResultsWhere` 返回清除数量。
- 补丁资产位于本仓库：`patches/patch-core.mjs`（应用/回退/状态）与 `patches/README.md`（原理与用法）。

## [0.5.0] - 2026-09-08

- overclock：每轮第一条清除占位符附带“可见性规则”扩展说明（逐步可见、取回内容同样只存活一步、需要精确原文时用前再取、总结引用多步前可整轮取回一次）；其余占位符保持短文本，控制常驻上下文开销。
- `read_tool_result_log`：成功返回内容时附带 `note` 提示字段（取回内容只存活一步请立即使用；总结前可整轮取回一次）；工具描述补充 overclock 使用提醒。
- 依据同语料 A/B 测试（无提示基线 vs 策略提示组：步骤 14→7、取回 6→1 次、输入 token −71%、困惑片段 6→0、事实命中均 8/8）把提示固化为插件内建引导。

## [0.4.0] - 2026-09-08

### 新增

- 新增 `overclock` 激进模式：同一轮内按核心 step 滞后一步清除工具结果——第 N 步结果仅对第 N+1 步的决策可见，第 N+1 步 `step/end` 时替换为占位符；每步结束即时归档为 `round-NNNN-step-MMM.json`，并写入 `index.json` 的 `steps` 清单。
- `/clear-tool-results` 命令新增 `overclock` 子命令，状态升级为 `{ enabled, mode: 'round' | 'overclock' }`（旧状态文件自动按普通模式兼容）；`status` 同时显示启用状态与模式。
- `read_tool_result_log` 新增 `step` 参数，可按 `{ turn, step }` 精确读取某步原始结果；轮次进行中只有步骤文件时按 `turn` 读取会自动合并。
- `read_tool_result_log()` 无参轮次列表会包含"进行中但已有 step 文件"的轮次（`inProgress: true`），轮次未结束时模型也能发现可读步骤。
- 清除占位符在具备步骤信息时注明 `turn + step`，引导模型精确取回：`[第 1 轮 第 3 步工具结果已清除归档，可用 read_tool_result_log(turn: 1, step: 3) 读取]`。
- 归档 schema 升级到 version 2：`round-NNNN.json` 与 step 文件条目顶层新增 `turn`/`step` 字段。

### 变更

- `clear-tool-results` 命令用法由 `on|off|status` 扩展为 `on|off|status|overclock`。
- 归档写入为"先清除、后异步写盘"的顺序，保证 overclock 的逐步清除不会与下一步 prompt 组装竞态。
- overclock 依赖核心 `step/end` 事件；老核心（无步骤事件）自动退化为普通每轮行为。

## [0.3.0] - 2026-09-04

### 新增

- 兼容新 Harness 核心 ≥ **0.1.2-rc.1**：新核心把会话事件数组从 `session.events` 迁移到 `session.log`，新增 `eventsOf()` 兼容读取（优先 `session.log`，回退 `session.events`），同一份代码同时支持新旧两代核心，无需按环境区分。

### 修复

- 新核心下 `turn/end` 归档时读取 `session.events` 抛 TypeError，导致工具结果不再归档、无法从上下文清除（插件仍能挂载、工具仍能注册，属静默失效）。

## 0.2.1 及更早版本

0.2.1 之前未维护 changelog，历史变更请参见 git 提交记录（0.1.7 → 0.2.0 → 0.2.1）。
