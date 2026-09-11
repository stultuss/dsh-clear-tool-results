# 核心补丁（方案 C）：seriesGeneration 双代数

## 为什么需要它

overclock 模式的语义是「某一步的工具结果只对紧随其后的下一步可见」：每步结束（`step/end`）时插件用一次
surface `replace` 把上一步的结果替换为占位符。

核心 `dsh-session` 对**每次** replace 都执行 `replaceGeneration += 1`，而 `dsh-agent-loop` 用这个计数
判断「两次请求之间 surface 被改写过」，于是 append 一个 `request/header {reason:"series"}` 事件；
Chat 界面为每个系列渲染一次系统提示词 —— 结果就是每步重复展示一次。

插件侧无法解决：surface 只有 `append`（不计数）和 `replace`（必然计数）两种操作，而清除必须 replace。

## 补丁做了什么

**双代数**——保留旧计数，新增一个"只对非清除型 replace 递增"的计数：

| 位点 | `<= 0.1.4`（legacy） | `>= 0.1.5`（seq） |
| --- | --- | --- |
| `session:fold-state` | `createFoldState()` 增加 `seriesGeneration: 0` | 文本未变，共用 |
| `session:replace-op-shape` | `isReplaceOp` 只接受 3 键（第 4 键 `impact` 会被浏览器端 wire 校验拒绝）；兼容另一代键拼写，只解析不改写 | 核心改用 `startSeq/endSeq` + `Object.hasOwn`/`isEventSeq` 校验，需独立锚点 |
| `session:clear-impact-helper` | 新增 `clearsToolResultContent(event, shadowedSeqs, events, baseSeq)`：单节点 tool/result 替换改写了内容即为「清除型」 | 文本未变，共用 |
| `session:plan-passthrough` | `planSurfaceEvent` 调 `clearsToolResultContent(...)` 并把结果写进 `plan.impact` | 键名变为 `startSeq/endSeq`，需独立锚点 |
| `session:series-counter` | `applySurfacePlan` 的 replace 分支：`replaceGeneration += 1` 照旧，仅当 `plan.impact !== "clear"` 时 `seriesGeneration += 1` | 文本未变，共用 |
| `session:series-getter` | surface 暴露 `seriesGeneration` getter | 文本未变，共用 |
| `agent-loop:series-generation` | 单处：局部量 `const surfaceGeneration = …seriesGeneration ?? …replaceGeneration`（比较与重捕获都走它） | 三处：构造期捕获 + 系统提示投影比较 + buildRequest 局部量（新增 `startsRequestSeries` / `toolsChanged(...)` 输入） |

`replaceGeneration` 语义完全不变，因此所有既有消费者（模型上下文的投影缓存、压缩轮询、
客户端镜像计数）行为不变；只有「新系列」的判定不再被工具结果清除触发。

agent-loop 侧带 `??` 回退，所以两个文件可以分别应用/回退，任一侧未打补丁都退回原行为。

## 版本兼容矩阵

| 核心代数 | 版本 | surface op 键名 | agent-loop 系列判定 | 补丁状态 |
| --- | --- | --- | --- | --- |
| `legacy` | `<= 0.1.4` | `start` / `end` | 单处局部量 | 6 位点全部可用 |
| `seq` | `>= 0.1.5`（0.1.5-rc.1 / rc.2 已实测） | `startSeq` / `endSeq` | 三处 | 3 个位点走 seq 变体，其余共用 |

识别代数用的是 `isReplaceOp` 的校验表达式（打补丁前后都稳定），**不解析版本号**：
alpha / rc 的版本排序不可靠，而代码谱系是确定的。

* 每个位点登记多个「变体」，apply 时挑选当前文件里唯一匹配的那一个；任一位点无变体匹配
  → 整体拒绝写入（先全量校验、后落盘），不会留下半补丁状态。
* **跨代拼写兼容（只解析、不改写）**：补丁后的 `isReplaceOp` 同时接受 `start/end` 与 `startSeq/endSeq`
  两种拼写，`surfaceOpOf` 把旧拼写解析成本代键名后交给 fold —— 于是旧核心写入的历史会话日志能在
  新核心上折叠重放（反向亦然）。
  ⚠️ **不能就地改写 op 对象**：`>= 0.1.5` 的 `Session.append()` 先 `deepFreeze(event)` 再校验 `surfaceOp`，
  在冻结对象上写 `startSeq` 会抛 `TypeError: Cannot add property startSeq, object is not extensible`；
  v2 补丁正是这么写的，导致 0.1.5 上每一次清除都失败（`v3` 已改为只解析）。
* **历史补丁态可升级**：v1（旧拼写 3 键）、v2（就地归一化）与 v3（4 键 `impact`）补丁写出的文本都登记在
  `from` 列表里，装过旧版补丁的核心执行 `apply` 会就地升级到 v4（只解析、3 键、内容判定），
  `revert` 仍回到原始文件。
* 插件运行时按代数选择 op 键名（默认按 `>= 0.1.5` 的 `startSeq/endSeq`）；若判断有误，首次写入被
  核心拒绝后会换另一代拼写重试一次并记住（核心的 `surfaceOp` 校验先于写入，失败尝试不会污染会话日志），
  插件载入时也会用本管理器按核心源码校准一次。

验证套件（对每个代数跑「原始 → 应用 → 功能断言 → 回退」闭环，含冻结 op 断言与 v2 → v3 就地升级）：

```bash
npm run check:compat        # 从 npm 拉取各版本核心（需要网络）
node patches/check-harness-compat.mjs --tree legacy=/path/to/0.1.2 --tree seq=/path/to/0.1.5
node patches/check-harness-compat.mjs --v1-tree /usr/local/lib/node_modules/@deepseek-ai/dsh   # 额外验证 v1 → v3 就地升级
```

## 插件侧的配合

* **事件上不带任何自定义标记**——两条路都被核心封死，所以「清除型」由核心看事实判定：
  * `surfaceOp` 只允许 3 个键（`op`/`startSeq`/`endSeq`）。浏览器端 `assertSessionWireEvent → isReplaceOp`
    严格按 3 键校验且明确不做归一化，第 4 个键会让**所有会话共用的 follow 流**里那一帧抛
    `session event "tool/result" carries an invalid replace surfaceOp`，整块 UI 一起卡死
    （每个会话都显示红色「历史加载失败」）。
  * `data` 只允许改 `message.content[0].content`（`assertToolResultRewrite`），加任何其它字段都会被拒。
  * 因此：**内容被改写的单节点 tool/result 替换 = 内容清除**（不推进 `seriesGeneration`）；
    **内容逐字节不变 = 系列边界**（照旧 +1）。核心自带的 `compaction-tool-result-pruner` 同样受益。
* 每轮结束时由 `nudgeSeries` 做一次**内容不变的普通 replace**，作为该轮唯一的系列边界
  （普通模式要求本轮确有结果被清除；overclock 无论如何都补一次）。插件会对比这次替换前后的
  `seriesGeneration`，没推进就告警（说明替换内容与原文不一致，被核心判成了清除型）。
* 系列边界因此稳定为「每轮恰好一次」：`seriesGeneration` 不再被任何一条工具结果的清除推动。

## 命令绑定

补丁与 `/clear-tool-results` 命令联动（`patches/patch-core.mjs` 提供实现）：

| 命令 | 补丁动作 |
| --- | --- |
| `/clear-tool-results overclock` | 自动 `apply` |
| `/clear-tool-results on` | 自动 `revert` |
| `/clear-tool-results off` | 自动 `revert` |
| `/clear-tool-results status` | 显示模式 + 补丁状态 |

也可以手动执行：

```bash
cd ~/.dsh/profiles/web/node_modules/dsh-clear-tool-results
npm run patch:status   # 查看状态
npm run patch:apply    # 应用（自动备份到 ~/.dsh/clear-tool-results-backups/）
npm run patch:revert   # 回退
node patches/patch-core.mjs apply --root /path/to/@deepseek-ai/dsh
```

## 注意事项

* 补丁写入的是磁盘上的核心文件，**必须重启 dsh GUI 进程**才会加载新代码。
* 应用前会校验每个位点的目标文本恰好出现一次；核心版本升级导致文本变化时会拒绝应用并提示，
  不会写入半成品。
* 原始文件备份在 `~/.dsh/clear-tool-results-backups/`（首次应用时创建），`revert` 优先从备份恢复。
  备份带代数元数据（同名 `.json` 边车）：核心升级/降级到另一代后，异代备份**不会被**误用于还原，
  此时自动改用反向替换并在输出里提示。
* 核心包升级/重装后补丁会被覆盖，重新执行 `npm run patch:apply` 即可；换成另一代核心
  （如 0.1.2 → 0.1.5）时 `apply` 会自动挑对应变体，`status` 会显示识别到的代数。
