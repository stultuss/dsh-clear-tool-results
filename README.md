[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/stultuss/dsh-clear-tool-results)

# dsh-clear-tool-results

DSH 宿主插件：把工具结果从对话上下文中清除以减少 Token 消耗，并把原始结果归档到会话的 `tool-result-logs/`；模型可用 `read_tool_result_log` 按轮次（可精确到步骤）或时间自主取回。

<img width="1594" height="417" alt="image" src="https://github.com/user-attachments/assets/a1247911-e0b6-4ae1-97ba-c99a17c31da0" />

| 模式 | 清除时机 | 归档 |
| --- | --- | --- |
| `round`（默认） | `turn/end` 清除整轮结果 | `round-NNNN.json` |
| `overclock` | 每个 `step/end` 清除上一步（滞后一步） | 另写 `round-NNNN-step-MMM.json`（每步即时落盘） |

overclock 下第 N 步结果仅对第 N+1 步的决策可见；需要更早的输出时，用 `read_tool_result_log(turn, step)` 取回。

## 兼容性

同一份代码支持三代核心，无需改配置或按环境区分：

| 核心代数 | 差异 | 插件行为 |
| --- | --- | --- |
| 老核心 | 事件数组为 `session.events`，无步骤事件 | overclock 自动退化为 round |
| ≥ 0.1.2-rc.1 | 事件数组改为 `session.log` | `eventsOf()` 优先读 `session.log` |
| ≥ 0.1.5-rc.1 | surface replace 键名改为 `startSeq`/`endSeq` | 按代数选键名，补丁按代数登记锚点 |

已实测代数：`0.1.2-rc.1`、`0.1.5-rc.1`、`0.1.5-rc.2`（`npm run check:compat`）。

## 安装

```sh
dsh plugin --profile web add dsh-clear-tool-results
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 注册：

```yaml
- insert:
    - id: clear-tool-results-host
      name: 'dsh-clear-tool-results'
```

## 使用

| 命令 | 效果 |
| --- | --- |
| `/clear-tool-results on` | 普通模式：每轮归档 + 轮末清除（自动回退核心补丁） |
| `/clear-tool-results overclock` | 激进模式：每步即时归档 + 滞后一步清除（自动应用核心补丁） |
| `/clear-tool-results off` | 停用：保留工具结果、不再归档（自动回退核心补丁） |
| `/clear-tool-results status` | 显示启用状态、模式、插件版本、补丁状态与会话归因汇总 |

建议在轮次之间切换模式；轮中途切换只对之后的步骤生效，已清除的结果保持占位符（原文仍可在归档中读取）。

## 功能

- **归档**：从追加式会话日志（而非改写后的 surface）取出原始 `tool/result`，保留轮次/步骤号、工具名与匹配的 `tool/call`。round 每轮写 `round-NNNN.json`，overclock 每个 `step/end` 写 `round-NNNN-step-MMM.json`，两者都登记进 `index.json`；以 index 为准、幂等，可补归档中途启用或重启前的轮次。
- **清除**：round 在 `turn/end` 写入 `[第 3 轮工具结果已清除归档：bash → git status（1.2k 字符），可用 read_tool_result_log(turn: 3) 读取]`；overclock 在 `step/end` 清除上一步并在占位符注明步骤，`turn/end` 兜底清除最后一步。
- **占位符索引**：占位符带一步索引——工具名 → 关键参数（命令/路径/模式）+ 规模 + 是否失败，整行压到 60 字以内；同一步多条合并成一行；PTC（`run_code`）下优先显示里面的子调用（`bash → git status`），而不是 run_code 的代码前缀。让模型先知道「里面有什么」，再决定要不要取回。
- **取回引导**：overclock 下每轮第一条清除占位符附带「可见性规则」（取回内容同样只存活一步，需精确原文时在使用的上一步再取），其余占位符保持短文本；`read_tool_result_log` 成功返回时附 `note` 提示。
- **归因埋点**：`usage.mjs` 只观测不改行为——每条被清除结果的「稀有记号」（含数字/路径，且在该会话已登记结果里出现 ≤30%）此后首次出现在哪里，就归入 `read` / `rerun` / `carryText` / `carryReasoning` / `reuseArgs` 之一；只被样板词命中过的记入 `样板词命中`（不算复用）。每轮末写 `<logsDir>/usage.json`，`status` 显示一行汇总。用来判断「引导取回」值不值得做。
- **开关与状态**：`{ enabled, mode }` 存于 `$DSH_HOME/clear-tool-results.json`（默认启用 + round；旧状态文件按 round 兼容）。
- **依赖**：仅 Node 内置模块；适用于所有会话与 agent preset；与 DSH 内置 compaction 兼容。

## 模式对照

| | round | overclock |
| --- | --- | --- |
| 清除时机 | `turn/end` 整轮清除 | 每 `step/end` 清除上一步 |
| 步骤结果保留到 | 本轮结束 | 该步的下一步用完 |
| 归档文件 | `round-NNNN.json` | 另写 `round-NNNN-step-MMM.json` |
| 占位符 | `read_tool_result_log(turn: N)` | `read_tool_result_log(turn: N, step: M)` |
| 适用 | 通用、默认 | 长轮次/多步骤任务 |

时间线示例（overclock，同一轮内）：

```
step1: 调用工具 → 结果 R1 入上下文
step2: 能看到 R1 → 执行 → R2 入上下文
       step2/end：归档 R2，把 R1 替换为占位符
step3: 能看到 R2；需要 R1 时调用 read_tool_result_log({ turn, step: 1 })
       step3/end：归档 R3，把 R2 替换为占位符
...
turn/end：归档整轮，兜底清除最后一步结果
```

## read_tool_result_log 工具

| 参数 | 说明 |
| --- | --- |
| `turn` | 轮次编号（1 起），如 `read_tool_result_log({ turn: 3 })` 读取第 3 轮 |
| `step` | 步骤编号（1 起，需配合 `turn`），如 `read_tool_result_log({ turn: 1, step: 3 })` |
| `time` | ISO 8601 时间或毫秒时间戳，读取该时刻所在轮次 |
| 都不传 | 已归档轮次列表（含「进行中但已有 step 文件」的轮次） |

`turn + step` 优先读步骤文件，老数据回退到整轮文件过滤；按 `turn` 读取会合并整轮文件与该轮步骤文件（按 seq 去重，支持轮次进行中读取）。

## 工作原理

1. 监听 `session/event` 的 `turn/end`、`turn/start`、`step/end`。
2. `turn/end`：从追加式日志收集该轮原始 `tool/result`，按 `callId` 解析工具名，写 `round-NNNN.json` 与 `index.json`；再把该轮 surface 节点替换为占位符（保持 tool-result 包装结构）。
3. overclock 的 `step/end`：先同步把**上一步**结果替换为占位符（保证下一步 prompt 组装前不可见），再异步写 `round-NNNN-step-MMM.json` 并更新 `index.json` 的 `steps`。
4. `read_tool_result_log` 从调用方会话目录读取归档返回原文。
5. 时机：round 的清除在上一轮 `turn/end` 执行；overclock 的清除在 `step/end` 后经 `queueMicrotask` 于下一步 prompt 组装前完成——先清除、后异步写盘，避免与 `deriveMessages()` 竞态。

## 核心补丁（可选，overclock 专用）

overclock 每步都要 replace，而核心对每次 replace 都递增 `replaceGeneration`；`dsh-agent-loop` 据此判定「新系列」，于是每步 append 一次 `request/header`，Chat 界面每步重复渲染系统提示词。插件侧无法规避（surface 只有 append 与 replace，清除必须 replace），因此提供一个可选的双代数核心补丁：

- `dsh-session`：新增 `seriesGeneration`，仅「非清除型 replace」递增；`replaceGeneration` 语义不变（模型上下文投影缓存、压缩轮询、客户端镜像仍依赖它）。
- `dsh-agent-loop`：系列判定改读 `seriesGeneration`（缺失时回退 `replaceGeneration`，可独立应用/回退）。

补丁与命令绑定：`overclock` 自动应用、`on`/`off` 自动回退、`status` 显示状态。也可手动执行：

```sh
cd ~/.dsh/profiles/web/node_modules/dsh-clear-tool-results
npm run patch:where    # 打印探测到的 dsh 核心目录
npm run patch:status   # 补丁状态与识别到的代数
npm run patch:apply    # 应用（自动备份到 ~/.dsh/clear-tool-results-backups/）
npm run patch:revert   # 回退
```

- 核心目录按 `--root` / `DSH_CORE_DIR` → 插件自身目录链（`<profile>/node_modules/<plugin>` → `<profile>`）→ `~/.dsh` 及各 profile → `/usr/local`、`/opt/homebrew`、`npm root -g`、`pnpm root -g`（含 `.pnpm/node_modules`）的顺序探测，失败时列出候选路径。
- 边界语义：每轮**恰好一次**系列边界（轮末由 `nudgeSeries` 做一次内容不变的普通 replace）。清除本身不推进系列代次——补丁按事实判定「单节点 `tool/result` 替换改写了内容 = 清除」，而边界那次替换内容逐字节不变。事件上不带任何自定义标记：`surfaceOp` 多一个键会被浏览器端 wire 校验拒绝（`invalid replace surfaceOp`，整条 follow 流卡死），`data` 多一个字段会被 `assertToolResultRewrite` 拒绝。
- 补丁写入的是磁盘上的核心文件，**必须重启 dsh GUI 进程**才生效；核心升级/重装后重新 `npm run patch:apply`（跨代自动挑对应锚点，装过旧版补丁的核心就地升级）。原理与注意事项见 `patches/README.md`。
- 未打补丁也能用：插件按代数选择 op 键名（`≤ 0.1.4` 用 `start`/`end`，`≥ 0.1.5` 用 `startSeq`/`endSeq`，被拒时换另一代重试一次），逐步清除照常工作，只是每步会重开一个请求系列。
- `≥ 0.1.5` 的核心「先深冻结事件、再校验 surfaceOp」，跨代拼写只能解析、不能就地改写（v2 补丁在冻结 op 上写 `startSeq` 会抛 `TypeError: not extensible`，v3 已修正并支持就地升级）。清除失败只记 warning，不牵连归档。

## 验证

```sh
npm run check:compat   # 各代核心的补丁锚点/键名「应用 → 断言 → 回退」闭环
                       # 离线：--tree <label>=<本地解包目录>
```

**round 回归**：第 1 轮让模型执行 `echo TOPSECRET-12345` 并只回复「完成」→ 工具结果应变为占位符；第 2 轮问「刚才那个 TOPSECRET-12345 是什么？」→ 模型应自主调用 `read_tool_result_log({ turn: 1 })` 并答出。

**overclock 回归**：`/clear-tool-results overclock` → 一条消息内布置三步（echo SECRET-111 / echo SECRET-222 / 读回第 1 步的 SECRET-111）→ 第 3 步时第 1 步结果应为带 `turn + step` 的占位符，模型自主取回并答出 → `/clear-tool-results on` 回到普通模式。

文件检查：

```sh
ls ~/.dsh/sessions/*/*/tool-result-logs/
cat ~/.dsh/sessions/*/*/tool-result-logs/round-0001.json
cat ~/.dsh/sessions/*/*/tool-result-logs/round-0001-step-0001.json
```

## 卸载

1. 删除 `cordis.patch.yml` 中的注册行；
2. `dsh plugin --profile web remove dsh-clear-tool-results`；
3. 可选：删除 `$DSH_HOME/clear-tool-results.json` 与各 `tool-result-logs/` 目录。

## 链接

- GitHub: <https://github.com/stultuss/dsh-clear-tool-results>
- npm: <https://www.npmjs.com/package/dsh-clear-tool-results>

## License

MIT
