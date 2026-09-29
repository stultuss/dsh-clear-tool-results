# Changelog

本项目自 0.3.0 起遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本（SemVer）。此处只记录版本之间的行为差异。

## [0.8.2] - 2026-09-29

### Fixed
- **单行超预算时预览整行返回**：`takeLines` 的 `picked.length > 0` 守卫使「首行就超预算」的结果把**整行**当作预览——对单行大结果（压缩 JSON、base64、长单行）收据会等于甚至长于原文。现在改为按码点裁到字节预算内（`clipLine`），预览成为**硬上限**。
- **收益护栏**：`saveResult` 在落盘前先算收据；收据不比原文更短时**不落盘、原样放行**（只有超长 cwd / `DSH_HOME` 才会触发）。准入过滤从此**永不把上下文变大**，且不留下无人知道的孤儿归档。

### Added
- `test/l5-coexistence.test.mjs`：把宿主 waterfall 语义固化成回归断言（见下）。

### Verified
- **确定性测试 85/85**（原 73 + L5 共存 8 + 收据边界 4）；`npm test`。
- **L5 监听顺序已定论**（读宿主源码，并在**编译产物** `cordis/lib/index.js` 与 `dsh-tools/lib/index.js` 上复核；已证与活体加载的是同一文件）：cordis `EventsService.waterfall` 按注册数组顺序执行，**数组头 = 最外层**，`register()` 用 `prepend ? 'unshift' : 'push'`；`dsh-tools` 的 `postExecute` 把**同一个 `result` 对象**交给每个监听器，只用最外层活下来的 `decision.content` 覆盖结果。本插件用 `{prepend:true}` ⇒ 最外层；`dsh-spill-policy`(:155)、`dsh-tool-fs-search`(:848/:1159)、`dsh-repeat-tool-reminder`(:1495) 均不带选项 ⇒ 内层。因此：本插件永远读到**原始** `result.content`（与顺序无关），且收据覆盖掉 spill 的预览；代价是 >50000 字节结果会被 spill 内层**重复落一份**（观测项，未处理）。
- **R 实测**（真 `receiptText`，本机 80 会话 / 3,582 条原始结果 / 1,238 条触发）：`R̄ = 705 B`（头行 131 + 路径行 203 + 指引行 88 + 正文 279），`R` 上限 **827 B**，`R ≥ S` **0 条**；`p* = 75.5%`，与设计记录 75.6% 一致。修复前的确切影响：1,238 条中 10 条（0.8%）会产出「收据 ≥ 原文」，合计多 +4.1 KB，单条最多 +437 B。
- **阈值扫描**（预览 300）：`p*` = 75.5 / 79.2 / 82.0 / 85.7 / 87.9%（阈值 1024 / 1536 / 2048 / 3072 / 4096），字节覆盖 93.1% → 68.8%。净省：`p ≤ 0.2` 时 1024 最优；`p = 0.3` 时各档几乎相同（3,395 / 3,411 / 3,356 KB）；`p ≥ 0.5` 时 2048 领先约 8%。⇒ **维持 1024**，把选择留给真实取回率。
- **R 瘦身评估（否决）**：把 88 字节的指引行完全删掉只让 `p*` 从 75.5% 升到 77.0%——不值得牺牲「怎么取回」这一要素。

## [0.8.1] - 2026-09-28

### Changed（破坏性：机制换位置，不是换参数）
- **从「轮末清除」改为「产出时准入过滤」**：不再监听 `turn/end` / `turn/start` 改写已发送的 `tool/result`，改为在 `tools/post-execute` 上决定工具结果进入上下文的形态。超阈值结果**从未进入上下文** ⇒ 不再有轮边界的缓存前缀重建，也**不再需要任何核心补丁**。
- **阈值替换**：`INLINE_MAX_BYTES = 1024`（预览 `PREVIEW_BYTES = 300`）取代 `ARCHIVE_MAX_BYTES = 49000`。1024 按 2026-09-28 复算选定（本机 2,781 条可过滤原始结果）：收据化 **43.9%** 的调用、覆盖 **93.6%** 的工具结果字节（4096 时 15.1% / 69.5%），净省字节 +35%；代价是平衡取回率 `p*` 由 81.0% 降到 75.6%。预览必须同步从 1200 降到 300——否则 1,024–1,500 字节档「收据 + 预览」比原文更长（占收据化条数 22.9%，降到 300 后为 0.2%）。
- `read_tool_result_log` 保留，数据源改为准入端落盘的结果；**恢复 `step` 参数**（0.7.0 曾移除），并在工具描述里写明 `offset`/`limit` 是「对**每条**结果各自生效」。

### Removed（破坏性）
- 轮末/轮首清除路径：`clearToolResultsWhere`、`clearCompletedToolResults`、`clearedText`、`describeClearedResult`，以及 `turn/end` / `turn/start` 的清除时机逻辑。
- surface 改写辅助与跨代兼容：`replaceToolResult`、`clearedMessage`、`preferredOpKeys`、`buildSurfaceOp`、`OP_KEYS_LEGACY` / `OP_KEYS_SEQ` 及「被拒则换另一代键名重试」；`eventsOf()` 不再需要。
- `ARCHIVE_MAX_BYTES = 49000` 归档上限及其占位符文案（「超过上限，未归档，请重新执行原工具」）。落盘是插件自己写文件，不再受 harness spill 的 50000 字节截断影响——**0.7.0 的 `(49000, 50000]` 永久取不回断层随之消失**；`(48000, 49000]` 的分段缝也不再存在。

### Added
- **`tools/post-execute` 准入过滤**（`{ prepend: true }`）：`await next()` 后判定是否替换模型可见内容。判定与落盘一律使用**原始 `result.content`**（不是 `decision.content`）——同一条瀑布上 `spill-policy` 等监听者可能已改写过模型可见内容，用原始内容才能保证落盘的是完整原文。
- **落盘**：`tool-result-logs/results/t<TTTT>-s<SSSS>-<NN>-<tool>-<callId>.txt`（**纯文本**，供 `read` 分页 / `grep` 检索）+ `index.json`（schemaVersion **3**，`results[]` 含 turn/step/tool/hint/bytes/lines/file）；幂等，同一 `callId` 只落一份。
- **收据**：`[工具 · 参数摘要 · N 字节 / M 行 → 全文已落盘，此处是尾部/开头 K 行]` + **绝对路径** + 取全文提示；预览 300 字节（`bash`/`run_code` 取尾部，其余取开头）。**刻意不含「已清除 / 已删除」**——实测模型会据此判定「内容没了」，转而重跑命令或把内容转述进推理。
- **豁免规则**：`read`、`read_tool_result_log`、`isError` 结果、嵌套 `exec.parent` 调用、含非 text block 的结果。
- 落盘失败时**原样放行**（绝不把一次成功调用变成 `isError`），只写一条 warning 到 `$DSH_HOME/clear-tool-results.log`。

### Verified
- **确定性集成测试 17/17**：mock `ctx` 直驱 `tools/post-execute`（含「落盘内容与原文逐字节一致」「收据不含『已清除·已删除』」等断言）。
- **端到端 3 次 headless 沙箱会话**（目标页 `web_fetch` 5,413 字节）：收据化生效；模型写入参 `read <收据里的绝对路径>` 取回全文（0 次重跑命令）；预览够用时**不取回**直接作答。
- **净收益模型**：平衡取回率 `p* = 75.6%`（1024 阈值 / 300 预览）；`p = 0.5` 时省 1.85 MB，`p = 0.9` 时亏 1.04 MB。对比 4096/300 的 `p* = 87.8%`：覆盖率与净省字节都更高，但脆弱区下移到 1,024–1,500 字节档。**取回率尚未在真实使用中测准，它是本机制唯一的决定性变量。**

### Kept
- `read_tool_result_log` 工具与旧归档（0.7.0 的 `round-NNNN.json` 仍可按轮读回）；`$DSH_HOME/clear-tool-results.json` 状态文件；`on|off|status` 命令；告警日志（仅异常路径写）。

## [0.7.0] - 2026-09-14

### Removed（破坏性）
- **overclock 模式整体移除**：不再有 `/clear-tool-results overclock`；不再按 `step/end` 清除上一步、不再写 `round-NNNN-step-NNNN.json`；`read_tool_result_log` 不再接受 `step`（传 `step` 返回明确提示）；`index.json` 不再有 `steps`；渲染器不再输出「步骤索引」；「可见性规则」占位符变体删除。
- **核心补丁整体移除**：`patches/`、`scripts/check-harness-compat.mjs` 与 `npm run patch:*` / `check:compat` 脚本删除，`package.json` 的 `files` 同步收敛；`dsh-session`、`dsh-agent-loop` 已回退原样，**需重启 dsh GUI 才生效**。
- **逐轮追踪日志移除**：原 `trace()`（`turn/end` 清除条数、清除统计）删除，`$DSH_HOME/clear-tool-results.log` 从此**只在告警时才有内容**（归档/清除失败），正常路径零 I/O；已积累的 4301 行 / 475KB 追踪日志清除。
- **归因埋点整体移除**：`usage.mjs`（rare-token 判定、五渠道归因、每轮末写 `<logsDir>/usage.json`）与 `status` 的归因汇总行全部删除，不再有任何逐轮落盘的观测数据；占位符索引那一半（`recordPtcDispatch` / `ptcItems` / `indexText` / `hintOfArgs` / `argsText` / `callKeyOf`）内联进 `index.mjs`，行为不变。
- 状态文件不再有 `mode` 字段（旧 `{enabled, mode}` 仍可读，`mode` 被忽略）。

### Kept（保留：0.7.0 的功能面就是这三件）
- **每轮归档**：`turn/end` 从追加式会话日志（而非改写后的 surface）取出该轮**原始** `tool/result`——保留轮次/步骤号、工具名与匹配的 `tool/call`——写入会话 `tool-result-logs/round-NNNN.json` 并登记 `index.json`；以 index 为准、幂等，可补归档中途启用或重启前的轮次。
- **按轮清除与占位符**：该轮 surface 结果被替换为按轮标注的占位符（含「工具名 → 关键参数 + 规模」紧凑索引），在下一轮开始前生效；模型据此决定要不要取回。
- **取回工具**：`read_tool_result_log` 保留为模型工具，按 `turn` 或 `time` 取回整轮原文，`offset` / `limit` 按行分页取回。
- **命令**：`/clear-tool-results on|off|status` 三态保留（`status` 现在只剩启用状态与插件版本）。

### Why
- 每步清除解决不了「模型把自己的输出当缓存」：实测 ≤49000 字节的已清除结果里，事后复用只有 **5.5%** 走取回、**52.6%** 靠记忆代偿（41.2% 抄进推理、11.3% 抄进可见正文），而适配器会把历史推理以 `reasoning_content` 回灌上下文。每步清除换来的上下文收益，抵不上一个要改 DSH 核心的补丁。

### Added
- **归档上限 49000 字节（UTF-8）**：超限结果**不再归档**——harness 的 spill 策略在 50000 字节处把结果换成「首尾预览 + 通知」，并从**中间**掐掉，存了也取不回完整原文。这类结果的占位符写明尺寸（**按字节**）、**不给取回坐标**、要求重新执行原工具；同轮若还有可归档结果，则保留坐标并追加「本轮另有 N 条超限未归档」。规则同时写进 `read_tool_result_log` 的工具描述，随工具注入 Agent。
- **取回分页**：`read_tool_result_log({ turn, offset, limit })` 按行窗口取回，返回「第 A-B 行 / 共 T 行」与续取坐标（`offset = B+1`）。

### Changed
- **取回返回体改为紧凑纯文本**：原为整条归档条目 `JSON.stringify(…, null, 2)`——同一份原文出现两次、体积是原文的 3–5 倍，实测 **46% 的取回**在约 31k 字符处被 harness 从**中间**切开并落盘成 spill。现输出 `查询 / 已归档轮次` + 每条 `--- turn N · 工具名 · 参数摘要 · 第 A-B 行 / 共 T 行 · N 字符 / M 字节 ---` + 原文，约 1.0×。
- **输出预算改为按字节**：`RENDER_BUDGET_BYTES = 48000`（原 24000 **字符**——中文居多的结果 ≈48–72k 字节，取回时仍会撞 50000 字节线）。预算按**整份载荷**计（含表头）⇒ 整份 ≤ 48400 字节，**永不触发 harness 截断**；正文约 47.7k 字节以内一次取回即拿全，48k–49k 这一段分页。
- 占位符只按轮标注：`[第 3 轮工具结果已清除归档：bash → git status（1.2k 字符），可用 read_tool_result_log(turn: 3) 读取]`；超限文案「本步另有」→「本轮另有」；占位符识别守卫由 `已清除归档` 放宽为 `已清除`。

### Verified
- **线上端到端**：49,500 与 60,000 字节两条结果**均未归档**，占位符按规则提示重新执行原工具；10,000 字节那条归档并可全量取回（无截断，返回体只含该条）；盘上超 49000 字节条目 **0** 条。
- **离线断言 13/13**：按字节判上限（ASCII 48999 可归档 / 49001 不可；中文 16400 字符 = 49200 字节 → 不可归档）；归档占位符逐字未变。

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
