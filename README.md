[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/stultuss/dsh-clear-tool-results)

# dsh-clear-tool-results

DSH 宿主插件：把工具结果（tool result）从对话上下文中清除以减少 Token 消耗，同时把原始结果归档到会话目录（`tool-result-logs`），模型可用 `read_tool_result_log` 工具按轮次（可精确到步骤）或时间自主读取。

两种模式：

- **普通模式（round，默认）**：每轮结束后清除该轮全部工具结果，下一轮开始时不可见；
- **overclock 模式**：同一轮内**逐步清除、滞后一步**——第 N 步的结果只对第 N+1 步的决策可见，第 N+1 步结束时即替换为占位符；每步结果归档为独立文件，模型需要更早步骤时用 `read_tool_result_log(turn, step)` 取回。

> **兼容性**：同一份代码同时支持三代 Harness 核心——
> ① 老核心（会话事件数组为 `session.events`，无步骤事件，overclock 自动退化为普通模式）；
> ② ≥ **0.1.2-rc.1**（事件数组改为 `session.log`）；
> ③ ≥ **0.1.5-rc.1**（surface replace op 的键名由 `start`/`end` 改为 `startSeq`/`endSeq`，`dsh-agent-loop` 的系列判定拆成三处）。
> 插件内部通过 `eventsOf()` 与核心代数探测自动适配，无需按环境区分或改配置；核心补丁也按代登记了各自的
> 锚点变体。已实测代数：`0.1.2-rc.1`、`0.1.5-rc.1`、`0.1.5-rc.2`（`npm run check:compat`）。

命令：`/clear-tool-results on|off|status|overclock`

- GitHub: <https://github.com/stultuss/dsh-clear-tool-results>
- npm: <https://www.npmjs.com/package/dsh-clear-tool-results>

<img width="1594" height="417" alt="image" src="https://github.com/user-attachments/assets/a1247911-e0b6-4ae1-97ba-c99a17c31da0" />

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
| `/clear-tool-results on` | 启用普通模式：每轮归档 + 轮末清除（自动回退核心补丁） |
| `/clear-tool-results overclock` | 启用激进模式：每步即时归档 + 滞后一步清除（自动应用核心补丁） |
| `/clear-tool-results off` | 停用：保留工具结果，不再归档（自动回退核心补丁） |
| `/clear-tool-results status` | 查看当前状态（启用与否 + 模式 + 核心补丁状态） |

模式切换建议在轮次之间进行；轮中途切换时新规则只对之后的步骤生效，已经清除的结果保持占位符（原始数据可在日志中读取）。

## 功能

- **归档**：从追加式会话日志（非改写后的 surface）取出原始 `tool/result` 事件：
  - 普通模式：每轮结束写入 `round-NNNN.json`（附 `index.json` 清单）；
  - overclock：每个 `step/end` 即时写入 `round-NNNN-step-MMM.json`（附 `index.json` 的 `steps` 清单），轮末再刷新 `round-NNNN.json`。
  原始数据完整保留（含轮次/步骤号、工具名、匹配的 `tool/call` 事件）。
- **清除**：
  - 普通模式：`turn/end` 把该轮结果替换为占位符（注明轮次）：
    `[第 3 轮工具结果已清除归档，可用 read_tool_result_log(turn: 3) 读取]`
  - overclock：每个 `step/end` 把**上一步**的结果替换为占位符（注明轮次 + 步骤），整轮结束时兜底清除最后一步：
    `[第 1 轮 第 3 步工具结果已清除归档，可用 read_tool_result_log(turn: 1, step: 3) 读取]`
- **取回引导（0.5.0）**：overclock 模式下，每轮第一条清除占位符会附带“可见性规则”说明——某步结果仅对紧随其后的下一步可见、取回内容同样只存活一步、需要精确原文时请在使用的上一步再取回、总结需引用多步前可整轮取回一次；其余占位符保持短文本以控制常驻上下文开销。`read_tool_result_log` 成功返回内容时附带 `note` 提示字段。
- **自主读取**：注册 `read_tool_result_log` 工具，模型在需要某轮/某步输出时自行调用（无需命令），按轮次、步骤或时间返回原始数据。
- **开关**：`/clear-tool-results on|off|status|overclock`，状态 `{ enabled, mode }` 存于 `$DSH_HOME/clear-tool-results.json`（默认启用、普通模式；旧状态文件自动按普通模式兼容）。
- **补归档**：中途启用或重启后，自动补归档之前未归档的轮次（幂等）。
- 仅依赖 Node 内置模块；适用于所有会话与 agent preset；与 DSH 内置 compaction 兼容。

## 模式对照

| | 普通模式（round） | overclock |
| --- | --- | --- |
| 清除时机 | `turn/end` 整轮清除 | 每 `step/end` 清除**上一步**（滞后一步） |
| 步骤结果在上下文中保留 | 保留到本**轮**结束 | 只保留到本**步**的下一步用完 |
| 归档文件 | `round-NNNN.json` | 另写 `round-NNNN-step-MMM.json`（每步即时落盘） |
| 占位符 | `read_tool_result_log(turn: N)` | `read_tool_result_log(turn: N, step: M)` |
| 适用 | 通用、默认 | 长轮次/多步骤任务，进一步压缩上下文 |

时间线示例（overclock，同一轮内）：

```
step1: 调用工具 → 结果 R1 入上下文
step2: 模型能看到 R1 → 执行 → R2 入上下文
       step2/end：归档 R2，把 R1 替换为占位符
step3: 模型能看到 R2；需要 R1 时调用 read_tool_result_log({ turn, step: 1 })
       step3/end：归档 R3，把 R2 替换为占位符
...
turn/end：归档整轮，兜底清除最后一步结果
```

## read_tool_result_log 工具

| 参数 | 说明 |
| --- | --- |
| `turn` | 轮次编号（1 起），如 `read_tool_result_log({ turn: 3 })` 读取第 3 轮 |
| `step` | 步骤编号（1 起，需配合 `turn`），如 `read_tool_result_log({ turn: 1, step: 3 })` 读取第 1 轮第 3 步 |
| `time` | ISO 8601 时间或毫秒时间戳，读取该时刻所在轮次 |
| *(都不传)* | 返回已归档轮次列表（含"进行中但已有 step 文件"的轮次，可继续按 `turn + step` 读取） |

示例：

- 用户问"上一轮 bash 命令的输出是什么？"→ `read_tool_result_log({ turn: 2 })`；
- overclock 占位符提示"第 1 轮 第 3 步"→ `read_tool_result_log({ turn: 1, step: 3 })`。

## 原理简述

1. 监听 `session/event` 的 `turn/end` / `turn/start` / `step/end`；
2. `turn/end`：从追加式日志收集该轮原始 `tool/result`，按 `callId` 解析工具名，写入 `round-NNNN.json` + `index.json`；再把该轮 surface 节点替换为占位符（`session.append('tool/result', ..., { surfaceOp: { op: 'replace' } })`，保持 tool-result 包装结构）；
3. overclock 的 `step/end`：先用同步替换把**上一步**结果变成占位符（确保下一步 prompt 组装前不可见），再异步把刚结束的步骤写入 `round-NNNN-step-MMM.json` + 更新 `index.json` 的 `steps`；
4. `read_tool_result_log` 读取调用方会话目录下的归档文件返回原始数据：`turn + step` 优先读步骤文件，普通模式/老数据回退到整轮文件过滤；按 `turn` 整轮读取会合并 `round-NNNN.json` 与该轮 step 文件（按 seq 去重，兼容轮次进行中读取）；
5. 归档幂等（以 index 为准），可补归档。

> 时机说明：DSH 在 `turn/start` 后同步组装 prompt 且 append 有重入保护，故普通模式清除在上一轮 `turn/end` 执行；overclock 的清除通过 `step/end` 事件后的 `queueMicrotask` 在下一步 prompt 组装前完成（先清除、后异步写盘，避免与下一步 `deriveMessages()` 竞态）。

## 验证

**核心代数兼容性**（补丁锚点、surface op 键名、应用/回退闭环）：

```sh
npm run check:compat   # 从 npm 拉取各代核心；也可 --tree <label>=<本地解包目录> 离线运行
```

**普通模式回归**：

1. 第 1 轮：`请调用 bash 执行 echo TOPSECRET-12345，然后只回复"完成"`；
2. 回复后工具结果显示占位符；
3. 第 2 轮：`刚才那个 TOPSECRET-12345 是什么？`；
4. 预期：模型自主调用 `read_tool_result_log({ turn: 1 })` 并答出秘密。

**overclock（同轮跨步回溯）**：

1. `/clear-tool-results overclock`，确认 `/status` 显示已启用（overclock）；
2. 一条消息内布置三步任务，例如：`先用 bash echo SECRET-111；再用 bash echo SECRET-222；最后一步：读回第 1 步的 SECRET-111 并只回复它`；
3. 预期：第 3 步时第 1 步结果已被清除（界面为带 `turn + step` 的占位符），模型自主调用 `read_tool_result_log({ turn: 1, step: 1 })` 并答出秘密；
4. 回到普通模式：`/clear-tool-results on`。

文件检查：

```sh
ls ~/.dsh/sessions/*/*/tool-result-logs/
cat ~/.dsh/sessions/*/*/tool-result-logs/round-0001.json
cat ~/.dsh/sessions/*/*/tool-result-logs/round-0001-step-0001.json
```

## 卸载

1. 删除 `cordis.patch.yml` 注册行；
2. `dsh plugin --profile web remove dsh-clear-tool-results`；
3. 可选：删除 `$DSH_HOME/clear-tool-results.json` 与各 `tool-result-logs/` 目录。

## 修复提示词 UI 重复展示补丁（0.5.1+，overclock 专用）

overclock 每步都会用 surface `replace` 清除上一步结果，而核心对**每次** replace 都递增
`replaceGeneration`；`dsh-agent-loop` 用它判断「两次请求之间 surface 被改写过」，于是每步都
append 一个 `request/header {reason:"series"}`，Chat 界面就为每个系列渲染一次系统提示词——
表现为**每步重复展示**。

插件侧无法规避（surface 只有 `append` 与 `replace` 两种操作，清除必须 replace），因此提供
一个可选的核心小补丁（**双代数**）：

- `dsh-session`：新增 `seriesGeneration`，只有「非清除型 replace」才递增；`replaceGeneration` 语义不变
  （模型上下文投影缓存、压缩轮询、客户端镜像都继续依赖它）。
- `dsh-agent-loop`：系列判定改读 `seriesGeneration`（缺失时回退 `replaceGeneration`，可独立应用/回退；
  ≥ 0.1.5 的核心里该判定位于三处，补丁已按代登记变体）。

补丁与命令绑定：`overclock` 自动应用、`on`/`off` 自动回退、`status` 显示状态。也可以手动执行：

```sh
cd ~/.dsh/profiles/web/node_modules/dsh-clear-tool-results
npm run patch:where    # 打印探测到的 dsh 核心目录
npm run patch:status   # 状态
npm run patch:apply    # 应用（自动备份到 ~/.dsh/clear-tool-results-backups/）
npm run patch:revert   # 回退
```

核心目录按 `--root` / `DSH_CORE_DIR` → 插件自身所在目录链（`<profile>/node_modules/<plugin>` → `<profile>`）→
`~/.dsh`、`~/.dsh/profiles` 及各 profile → `/usr/local`、`/opt/homebrew`、`npm root -g`、`pnpm root -g` 与 pnpm
全局目录的顺序自动探测；探测失败时会列出全部候选路径，可据此用 `--root <目录>` 指定。

打补丁后的边界语义：每轮**恰好一次**系列边界——轮末的普通 replace（清除本轮剩余结果；空轮或
被中断的轮则由 `nudgeSeries` 做一次内容不变的替换）使 `seriesGeneration` +1，下一轮首条请求
才会 append 一次 `request/header`，于是 Chat 每轮只展示一次（可折叠的）系统提示词。

补丁写入的是磁盘上的核心文件，**必须重启 dsh GUI 进程**才会生效；核心升级/重装后重新
`npm run patch:apply` 即可——跨代升级（如 0.1.2 → 0.1.5）时会自动挑对应代的锚点变体，
装过旧版补丁的核心就地升级，`status` 会显示识别到的代数。原理与注意事项见 `patches/README.md`。

插件运行时也按核心代数选择 surface op 键名（`start/end` ⇄ `startSeq/endSeq`），因此**即使没打补丁，
逐步清除在老核心与新核心上都能正常工作**——只是每步会重开一个请求系列（系统提示词重复展示）。

## License

MIT
