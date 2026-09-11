# Changelog

本项目自 0.3.0 起遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（SemVer）。此处只记录版本之间的行为差异。

## [0.6.7] - 2026-09-12

### Fixed
- `read_tool_result_log` 收到字符串编号（如 `turn: "3"`）时会因 `typeof` 判断不符
  而静默落到"列出归档轮次"分支 —— 模型看到的结果像是"取回为空"，却没有任何报错。
  现在纯数字字符串会被归一化成数字。
- 整轮取回（只给 `turn`）的返回里补充 `steps` 按步汇总（哪几步有归档、各步条数与时间范围），
  模型不必再靠试错找步号。
- 取回结果补充 `note`，明确写出原文位置（`toolResults[].text`）。实测有子 Agent 用 `r.steps`
  去取原文，拿到空数组后误判为"归档为空"。

## [0.6.6] - 2026-09-12

### Fixed
- **归因埋点漏掉"看完就用"**：条目此前在"清除时"才登记，而清除发生在紧随其后的那一步结束之后 ——
  于是可见窗口内的复用（最该被看见的那一类）永远无从归因，会被记成"未复用"。现在结果一到达就登记条目，清除只负责打标记。
- `channel` 是单值，导致"先自携带、后取回"被后到的 `read` 覆盖。现在 `channel` 保留首次命中，`channels` 记录全部命中渠道。

### Added
- `usage.json` 升到 `schemaVersion: 3`：每条结果新增 `cleared` / `channels` / `hitTurn` / `hitStep`；`stats` 增加 `attributed`（命中条数）与 `window`（命中发生在"紧随其后的下一步"的条数）。
- `status` 的归因汇总增加"可见窗口内 N"，各渠道占比改以"已清除结果条数"为分母，样板词命中单独成项。

## [0.6.5] - 2026-09-12

### 修复

- **PTC 索引行真正生效**：0.6.4 试图从会话事件流里取 `tool/ptc-dispatch`，实测拿不到（重启后索引行仍是 `run_code → const r = await tools.bas…`）。现在三个来源依次尝试：hook 里自己收下的子调用 → 事件流里的子调用 → 直接解析 `run_code` 的代码（`tools.bash({ command: '…' })`），因此 PTC 下索引行稳定显示 `bash → git status --porcelain…`；三个来源都没有时回退外层 `tool/call`。

### 变更

- **归因只认"稀有记号"**：只有在该会话已登记结果里出现 ≤30% 的记号才算复用证据（`carryText` / `carryReasoning` / `reuseArgs`）。此前任何记号命中即计数，会被工作区路径、`index.mjs` 这类到处都有的词撑满——0.6.3/0.6.4 写下的 `转述·推理 13/21` 就是这么来的，与旧口径不可比。只被样板词命中过的条目记入新的 `样板词命中`（诊断用），并且**不再被提前消费**，之后仍可被稀有记号归因。
- `usage.json` 的 `schemaVersion` 升到 2：`stats` 多一个 `common`，条目 `channel` 可能是 `common`。

## [0.6.4] - 2026-09-12

### 修复

- **PTC 下索引行显示真实动作**：`run_code` 里真正干活的是子调用（bash/read/…），此前索引行只能拿到 `run_code` 的代码前缀（截断后是一段看不懂的碎片，等于索引行在最常用的形态下失效）。现在优先取同一步的 `tool/ptc-dispatch` 事件生成提示，例如 `bash → git status --porcelain`；同一步多个子调用合并，取不到时回退原行为。
- **归因落盘不再静默失败**：`usage.persist` 写盘前 `mkdir -p`，且不再把异常吞掉——写失败会以 `归因埋点落盘失败：…` 记进 `clear-tool-results.log`（此前失败的表现只是 usage.json 永远不出现，看不出原因）。
- **索引行压到 60 字以内**：规模改用 `3.4k` 这类紧凑写法，过长时自动缩短提示词，最长 60 字，避免占位符本身变成新的 token 负担。

## [0.6.3] - 2026-09-11

### 新增

- **占位符索引行**：清除后的占位符不再只有「已清除归档，可用 read_tool_result_log 读取」，而是带一步索引，例如 `[第 2 轮 第 4 步工具结果已清除归档：bash → git status --porcelain（1.2k 字符，失败），可用 read_tool_result_log(turn: 2, step: 4) 读取]`。同一步的多条结果合并成一行（最多两条，其余记 `等 N 条`），失败结果标出「失败」。目的是让模型不必先花一步取回，就能判断某步值不值得取回。
- **取回/旁路归因埋点（新文件 `usage.mjs`）**：只观测、不改行为。每条被清除的结果登记原文里的「可辨识记号」（含数字，或含路径/点号），之后按**首次命中**归入五个渠道之一：`read`（取回命中该轮/该步）、`rerun`（同工具同参数重跑，内容被重新打印）、`carryText`（转述进可见文本）、`carryReasoning`（转述进推理）、`reuseArgs`（具体值被复用到新的工具入参）。每轮末写 `<logsDir>/usage.json`（含每条结果的渠道与规模），`status` 追加一行会话汇总。

### 说明

- 背景实测（本机 5 个会话、173 条被清除结果、5191 个可辨识记号）：`read_tool_result_log` 直接被调用 0 次；59% 的结果至少有一个具体事实后来出现在模型自己的推理或文本里（其中 25% 只能来自记忆），27% 靠后续工具输出重新打印一遍。设计里的「按需取回」在真实会话中几乎不被走，因此本版先上埋点看清渠道分布，再决定是否投入「引导取回」的改动（占位符索引行是其中成本最低的一步）。

## [0.6.2] - 2026-09-11

### 修复

- 修「装上插件后所有会话卡死、报 `invalid replace surfaceOp`」：清除型 replace 不再多带第 4 个键 `impact:"clear"`，只写宿主浏览器端要求的 3 键（`op` / `startSeq` / `endSeq`）。
- 「是否属于清除」改由核心按事实判定（单节点替换是否改写 tool/result 内容），事件上不再携带任何自定义标记；旧版本写出的 4 键 op 只会让该次清除失败并告警，不再打断会话流。

## [0.6.1] - 2026-09-11

### 修复

- 修正 surface op 键名策略：只按当前核心代数写入（`≥ 0.1.5` 用 `startSeq`/`endSeq`，`≤ 0.1.4` 用 `start`/`end`），不再写另一种拼写，避免旧拼写被日志序列化层读成 `NaN` 而卡住历史加载。
- 修 dsh ≥ 0.1.5-rc.1 上 overclock 完全不生效：核心补丁的跨代兼容改为「只解析、不改写」（不再就地改写被冻结的事件对象），v2 补丁态在 `apply` 时就地升级到 v3。
- 修状态读取不一致：`readStateSync()` 改为直接读状态文件，同步与异步路径恒一致，overclock 不再被静默降级为轮末清除。
- 修清除失败连累归档：清除与归档各自捕获异常并记 warning，目标不在 surface 时只跳过该条。
- 修插件已关闭时 `turn/start` 仍写入系列边界。
- 清除失败现在会追加写入 `$DSH_HOME/clear-tool-results.log`。

### 新增

- `status` 输出追加插件版本号；新增 `patch:where` 打印实际命中的核心目录。
- `check:compat` 增加冻结 op、`surfaceOpOf` 归一化与「v2 补丁态就地升级」断言。

### 修复（补丁定位）

- `patch:apply` 在 `~/.dsh` profile 或 pnpm 全局安装下也能定位核心目录（多级候选探测，失败时列出候选路径）。

## [0.5.2] - 2026-09-08

### 修复

- 修 overclock「每轮一次系统提示词」漏发：空轮/被中断的轮由 `nudgeSeries` 退化为替换最近一条结果，`turn/start` 另加一次内容不变的兜底替换。

### 变更

- 补丁路径更正为 `patches/patch-core.mjs`（`scripts/` 被 .gitignore 忽略）。

## [0.5.1] - 2026-09-08

### 新增

- 新增核心补丁（双代数）：`dsh-session` 增加仅对非清除型 replace 递增的 `seriesGeneration`，`dsh-agent-loop` 系列判定改读它（缺失时回退 `replaceGeneration`）；解决 overclock 每步重复展示系统提示词。
- 补丁与命令联动：`overclock` 自动 apply、`on`/`off` 自动 revert、`status` 显示补丁状态（需重启 GUI 生效）。

### 变更

- `replaceToolResult` 增加 `clearOnly` 参数；`clearToolResultsWhere` 返回清除数量。
- 补丁资产入仓：`patches/patch-core.mjs`、`patches/README.md`。

## [0.5.0] - 2026-09-08

- overclock 每轮第一条清除占位符附带「可见性规则」说明（取回内容同样只存活一步、需精确原文时在使用的上一步再取），其余占位符保持短文本以控制常驻开销。
- `read_tool_result_log` 成功返回时附 `note` 提示，工具描述补充 overclock 使用提醒。

## [0.4.0] - 2026-09-08

### 新增

- 新增 `overclock` 模式：同轮内按核心 step 滞后一步清除（第 N 步结果仅对第 N+1 步可见），每步即时归档为 `round-NNNN-step-MMM.json` 并登记进 `index.json` 的 `steps`。
- 命令扩展为 `on|off|status|overclock`；状态升级为 `{ enabled, mode }`（旧状态文件按 round 兼容）。
- `read_tool_result_log` 新增 `step` 参数，支持 `{ turn, step }` 精确读取；无参列表包含「进行中但已有 step 文件」的轮次（`inProgress: true`）。
- 清除占位符在具备步骤信息时注明 `turn + step`。
- 归档 schema 升至 v2：条目顶层新增 `turn`/`step`。

### 变更

- 归档写入改为「先清除、后异步写盘」，避免与下一步 prompt 组装竞态。
- overclock 依赖核心 `step/end`；老核心自动退化为普通每轮行为。

## [0.3.0] - 2026-09-04

### 新增

- 兼容核心 ≥ 0.1.2-rc.1：新增 `eventsOf()`（优先 `session.log`，回退 `session.events`），同一份代码支持新旧两代核心。

### 修复

- 修新核心下 `turn/end` 读取 `session.events` 抛 TypeError，导致归档与清除静默失效。

## 0.2.1 及更早版本

未维护 changelog，历史变更见 git 提交记录（0.1.7 → 0.2.0 → 0.2.1）。
