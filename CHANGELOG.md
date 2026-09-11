# Changelog

本项目自 0.3.0 起遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（SemVer）。此处只记录版本之间的行为差异。

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
