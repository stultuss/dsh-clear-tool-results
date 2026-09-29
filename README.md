[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/stultuss/dsh-clear-tool-results)

# dsh-clear-tool-results

DSH 宿主插件：在工具结果**进入上下文之前**做准入过滤。超过阈值的纯文本结果全文落盘到会话目录，模型只收到「收据 + 有界预览 + 绝对路径」；需要原文时用内置 `read`（分页）或 `grep`（检索）取回，也可用插件提供的 `read_tool_result_log` 按轮/步/时间取回。

当前版本：**0.8.3**。

## 机制

- **作用点**：`tools/post-execute` waterfall（`{ prepend: true }`），在结果 materialize 之前决定它的形态。
- **从不改写已发送内容**：被收据化的结果从未进入上下文，因此没有轮边界的缓存前缀重建，也不需要任何核心补丁。
- **判定用原始内容**：判定与落盘一律读 `result.content`，不受同一条瀑布上其它监听者（如 `spill-policy`）对模型可见内容的改写影响。
- **失败安全**：落盘失败时原样放行（绝不把一次成功调用变成 `isError`），只写一条 warning。

## 安装

```sh
dsh plugin --profile web add dsh-clear-tool-results
```

包内的 `cordis.patch.yml` 通过 `package.json` 的 `dsh.bundle.patch` 声明，安装时由宿主注入（`id: clear-tool-results-host`），无需手工编辑 profile 的 patch 层。安装或升级后需**重启 dsh GUI**：进程内已 import 的模块不会热替换，不重启则仍在跑旧构建。

## 使用

| 命令 | 效果 |
| --- | --- |
| `/clear-tool-results on` | 启用：超过阈值的纯文本工具结果落盘，模型侧只留收据与预览 |
| `/clear-tool-results off` | 停用：工具结果原样进入上下文 |
| `/clear-tool-results status` | 显示启用状态、准入阈值、豁免工具与插件版本 |

- **默认启用**：状态文件不存在时按启用处理。
- 状态存于 `$DSH_HOME/clear-tool-results.json`（`DSH_HOME` 未设置时回退 `~/.dsh`），内容为 `{ "enabled": true }`；旧状态文件里的 `mode` 字段会被忽略。
- `read_tool_result_log` **无条件注册**：停用后仍可读取此前落盘的归档，只是不再产生新的落盘。
- 准入判定走内存缓存的状态，关闭时零 I/O 直接放行。

## 准入规则

对每条工具结果依次判断，命中任一条即**原样放行**；全部不命中且是超过 1024 字节的纯文本时才落盘 + 收据：

| 条件 | 处理 |
| --- | --- |
| 决策不是 `accept`，或带 `value`（结构化输出） | 原样 |
| 嵌套调用 `exec.parent`（PTC 子调用，不进模型上下文） | 原样 |
| 工具是 `read`、`read_tool_result_log` | 原样（内容就是下一步的必需输入，或本身就是取回通道） |
| `result.isError === true` | 原样（报错内容是排障必需） |
| 结果含任何非 text block | 原样（准入策略只认纯文本） |
| 纯文本，≤ **1024 字节** | 原样 |
| 纯文本，> **1024 字节** | **落盘 + 收据** |

取不到 session 上下文时也原样放行。

## 收据（模型看到的内容）

```
[bash · npm test · 84,231 字节 / 2,104 行 → 全文已落盘，此处是尾部 30 行]
路径：/Users/…/sessions/…/tool-result-logs/results/t0001-s0003-01-bash-call_00_ab12.txt
取全文：read 该路径（可用 offset/limit 分页），或 grep 该路径检索。

……（中间省略 2,074 行，共 2,104 行）
<尾部 30 行原文>
```

- 第一行：工具名 · 参数摘要 · 原始字节数 / 总行数 · 预览方向与行数。参数摘要 ≤60 字符，按 `command`/`file_path`/`path`/`pattern`/`query`/`description`/`prompt`/`url` 的顺序取第一个非空字段。
- 预览 300 字节，按**整行**取（不切坏 UTF-8）：`bash`/`run_code` 取**尾部**（最终状态与错误），其余工具取**开头**（命中列表与正文开头）。取尾部时省略提示在预览之前，取开头时在预览之后。
- 预览是**硬上限**：若首个候选行本身就超过 300 字节（压缩 JSON、base64、长单行），该行会被**按字节裁切**，收据里写明「该行过长，此处仅显示…」——不再出现「预览等于全文、收据反而比原文长」。
- 收据**恒短于原文**：落盘前先算收据，收据不比原文短时不落盘、原样放行（只有超长 cwd / `DSH_HOME` 才会触发）。准入过滤永不把上下文变大。
- **刻意不写「已清除 / 已删除」**：实测这类措辞会被读成「内容没了」，模型转而重跑命令或把内容转述进推理。收据的语义是「全文在盘上，路径在此」。
- 落盘文件是纯文本，可直接 `read`（分页）或 `grep`（检索），不需要学新工具。
- 注意收据那句「或 grep 该路径检索」：`grep` **不在豁免名单**，其结果超过阈值时同样会被收据化。当前真正稳定的取回通道是 `read`（豁免）。

## 落盘与索引

```
<session>/tool-result-logs/
  index.json                              # schemaVersion 3
  results/t0001-s0003-01-bash-call_00_ab12.txt
```

- 文件名：`t<turn 4位>-s<step 4位>-<同轮同步序号 2位>-<工具名≤16>-<callId≤12>.txt`。turn/step 取自 `session/event` 维护的每会话游标，取不到时为 `0000`。
- `index.json`：`{ schemaVersion: 3, sessionId, workspace, updatedAt, results[] }`；每条为 `{ turn, step, callId, tool, hint, file, relFile, bytes, lines, time }`，其中 `file` 是**绝对路径**。
- **幂等**：同一 `callId` 只落一份，重放或重试不会重复归档。但 `callId` 缺失（非字符串）时该机制失效——索引里存 `null`、查找用 `undefined` 永不匹配，于是每次调用都会新落一份，且文件名里 callId 段为空（`…-bash-.txt`，因为 `safeSegment` 用 `?? ''`）。
- 同一会话的索引写入串行化，避免 `index.json` 读写竞争。
- 会话目录优先由 `sessionPersistence.locate()` 解析；不可用时回退默认布局 `$DSH_HOME/sessions/<projectKey>/<encoded-session-id>/tool-result-logs`，编码规则与 `dsh-session-persistence-jsonl` 一致。

## `read_tool_result_log` 工具

收据里已直接给出单条路径，多数情况直接 `read` 即可；这个工具用于按轮/步/时间取回。

| 参数 | 说明 |
| --- | --- |
| `turn` | 轮次编号（1 起），读取该轮全部归档 |
| `step` | 可选，配合 `turn` 精确到某一步 |
| `time` | ISO 8601 时间或毫秒时间戳，取该时刻（±30 分钟）所在的轮 |
| `offset` / `limit` | 可选，按行窗口取回；对**每条**结果各自生效 |
| 都不传 | 归档清单：按轮汇总 + 最近 40 条的坐标与路径，不返回正文 |

- 纯数字字符串会被归一化成数字（`turn: "3"` 等价 `turn: 3`）。
- 返回体是紧凑纯文本，每条是一段以 `---` 开头、以 `---` 收尾的区块：

  ```
  --- turn 3 step 5 · bash · npm test · 第 1-2104 行 / 共 2104 行 · 84231 字节
      路径：/Users/…/tool-result-logs/results/t0003-s0005-01-bash-call_00_ab12.txt ---
  <正文>
  ```

  整份载荷受 **48000 字节**预算约束，超预算的条目会被跳过并提示缩小 `turn+step` 范围或直接 `read` 路径。
- 都不传时是**清单模式**：不返回正文，每条的头行只给**真实尺寸**（`10,238 字节 / 82 行`）与路径，没有行窗口（正文里那行「（清单模式不返回正文）…」只是占位）。
- `turn` 不是正整数时报错「轮次编号必须为正整数」；该轮无归档时报错并列出已归档轮次；`time` 无法解析时报错。
- **旧归档可读**：0.7.0 写的 `round-NNNN.json` 仍可按轮取回（正文从旧事件的 `tool-result` block 中提取）；旧版 `index.json`（只有 `rounds`、没有 `results`）按空结果集处理，由旧文件兜底。

## 设计取值

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `INLINE_MAX_BYTES` | 1024 | 准入阈值（UTF-8 字节） |
| `PREVIEW_BYTES` | 300 | 收据预览预算（字节） |
| `RENDER_BUDGET_BYTES` | 48000 | 取回渲染总预算，留在 harness 的 50000 字节截断线以内 |

- 预览**必须显著小于**阈值：收据固定开销约 426 字节（头行 131 + 路径行 203 + 指引行 88 + 换行），阈值 1024 配预览 300 时 `R̄ = 705 B`、上限 827 B。若预览保持 1200，1,024–1,500 字节档里约 22.9% 的收据会比原文更长（降到 300 后为 0）。
- 阈值 1024 相对 4096 是拿取回率换覆盖率：更多调用被收据化、字节覆盖更高，但平衡取回率 `p*` 从约 87.9% 降到约 **75.5%**（本机 80 会话 / 1,238 条触发，用真 `receiptText` 离线复算）。判据是 **`E > 0 ⟺ 真实取回率 p̂ < p*(T)`**，故 **`p*` 越高越好**。
- 阈值扫描（预览 300）：`p*` = 75.5 / 79.2 / 82.0 / 85.7 / 87.9 / 92.4%（阈值 1024 / 1536 / 2048 / 3072 / 4096 / 8192），字节覆盖 93.1% → 52%。
- **⚠️ 2026-09-29 实测推翻了「维持 1024」**：A3 口径在真实会话上测出 **`p̂ = 80.8%`**（21/26；见 `.sandbox/evidence/2026-09-29/l2/`），**高于 `p*(1024) = 75.4%` ⇒ 1024 净亏**。`E(阈值)` 扫描（`.sandbox/evidence/2026-09-29/e-sweep/`）显示 `E` 有**内部最优 ≈ 8192**：在最坏情况（`p ∈ [0.769, 0.808]` × `C ∈ {269, 400, 803}`）下 `E(1024) = −402 KB`、`E(2048) = +74 KB`、`E(8192) = +418 KB`。先前"维持 1024"的依据是被低估的 `p̂ = 68%`（用 `hint` 子串代理算的粗糙上界，已作废）。
- **注意：当前代码仍是 1024**——上调阈值是代码改动，需重装并重启 GUI，尚未执行；且 `p̂` 只有 26 个样本（还都来自开发会话）。扫描给出的建议值是 **8192**（maximin），保守可取 **4096**。
- **降阈值没有意义**：`saveResult` 护栏「收据不比原文短就不落盘」使有效下界由收据自身大小（~705–830 B）决定；阈值 1024 → 200 只多 215 条生效，其余全被护栏跳过。
- 单条口径：原文 `S`、收据 `R`、取回时多一轮开销 `C`——不取回省 `S−R`，取回则付出 `R+C`。
- **边界**：本机制只覆盖工具结果。豁免工具（如 `read`）、reasoning、assistant 输出与系统提示都不受它影响。

## 工作原理

1. `apply()` 注册四件事：`/clear-tool-results` 命令、`session/event` 监听、`tools/post-execute` 监听（`prepend: true`）、`read_tool_result_log` 工具。
2. `session/event` 中凡带数字 `turn`/`step` 的事件都更新该会话的游标，供落盘时标注坐标。
3. `tools/post-execute` 里先 `await next()`，再按准入规则判断；命中落盘条件时用 `result.content` 写文件并登记 `index.json`，返回 `{ kind: 'accept', content: [收据] }`（保留上游的 `additionalContexts`）。
4. 落盘失败或任何异常：`warn()` 后原样返回上游决策，绝不把成功调用变成错误。warning 同时交给 `ctx.logger` 并追加到 `$DSH_HOME/clear-tool-results.log`——只有异常路径写，正常路径零 I/O。
5. `read_tool_result_log` 从调用方会话目录读 `index.json` 与落盘文件，返回原文。

## 兼容性

- 依赖 `tools/post-execute` waterfall（本机 `0.1.5-rc.1` 核心验证通过）。不使用 surface 改写，因此不需要按核心代数切换 op 键名，也不需要任何核心补丁。
- 只用 Node 内置模块；适用于所有会话与 agent preset；可与内置 `compaction`、`spill-policy` 共存。
- **与内置监听者的顺序**（读宿主源码定论）：cordis 的 waterfall 按监听器**注册数组顺序**执行，**数组头 = 最外层**，`register()` 用 `prepend ? 'unshift' : 'push'`；`dsh-tools` 的 `postExecute` 把**同一个 `result` 对象**交给每个监听者，只用最外层活下来的 `decision.content` 覆盖结果。本插件用 `{prepend:true}` ⇒ **最外层**；`spill-policy` / `dsh-tool-fs-search` / `dsh-repeat-tool-reminder` 都不带选项 ⇒ 内层。两个后果：①本插件读到的是**原始** `result.content`，与顺序无关；②模型看到的是**本插件收据**（指向会话目录里持久的全文），spill 的预览被覆盖——代价是 >50000 字节的结果会被 spill 重复落一份（已知冗余，未处理）。
- `inject: ['commands', 'tools', 'sessionPersistence']`。

## 验证

- **确定性测试（L1，已入库）**：`npm test`（`node --test "test/*.test.mjs"`）跑 **87** 个用例，mock `ctx` 直驱 `tools/post-execute` 与取回工具。覆盖：**准入判定** 15（阈值边界、按字节不按字符、多 text block 无分隔符拼接、豁免与 `isError`/嵌套/非纯文本/`value` 原样）、**收据与预览** 12（头行格式、取端规则、300 字节硬上限、单行裁切不切坏码点、收据恒短于原文、无「已清除/已删除」）、**落盘与索引** 17（文件名与截断、幂等、ordinal、并发、索引损坏重建、路径编码、`locate` 与回退、无收益时不落盘）、**取回** 15（清单 / turn / step / time、逐条 offset·limit、48000 预算跳过、报错分支、旧 `round-NNNN.json` 回读）、**旧数据回读** 4、**状态与命令** 6、**宿主共存** 8（waterfall 顺序、内层改写被丢弃、反序时收据被覆盖但全文已落盘、`read` 双豁免、`additionalContexts` 透传）、**失败路径** 10（不可写、日志不可写、`DSH_HOME` 不存在、非 ASCII cwd）。用例走隔离的临时 `DSH_HOME`，每条一份全新模块实例（`DSH_HOME` 与 `stateCache` 都在 import 时定型）。
- **端到端**：用 `web_fetch` 这类**结果大小不可预处理**的工具（`bash` 不行——模型会主动把大输出重定向掉）。用隔离的 `DSH_HOME` 起 headless 会话，抓一个超过 1024 字节的页面：

```sh
DSH_HOME=<隔离的 DSH_HOME> dsh --profile headless \
  --patch <path>/plugin-patch.yml "抓取 <url>，告诉我 <需要看正文细节的问题>"
```

预期：工具结果被换成收据；模型用 `read <收据里的绝对路径>` 取回全文；落盘文件出现在 `<session>/tool-result-logs/results/`。

```sh
ls "$DSH_HOME"/sessions/*/*/tool-result-logs/results/
cat "$DSH_HOME"/sessions/*/*/tool-result-logs/index.json
```

## 卸载

1. `dsh plugin --profile web remove dsh-clear-tool-results`；
2. 可选清理：`$DSH_HOME/clear-tool-results.json`、`$DSH_HOME/clear-tool-results.log` 与各会话的 `tool-result-logs/` 目录。

## 链接

- GitHub: <https://github.com/stultuss/dsh-clear-tool-results>
- npm: <https://www.npmjs.com/package/dsh-clear-tool-results>

## License

MIT
