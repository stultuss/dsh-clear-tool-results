[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/stultuss/dsh-clear-tool-results)

# dsh-clear-tool-results

DSH 宿主插件：把工具结果**按轮归档**并从对话上下文中清除以减少 Token 消耗；模型可用 `read_tool_result_log` 按轮次或时间自主取回原文。

<img width="1594" height="417" alt="image" src="https://github.com/user-attachments/assets/a1247911-e0b6-4ae1-97ba-c99a17c31da0" />

## 兼容性

同一份代码支持三代核心，无需改配置或按环境区分：

| 核心代数 | 差异 | 插件行为 |
| --- | --- | --- |
| 老核心 | 事件数组为 `session.events` | `eventsOf()` 回退读 `session.events` |
| ≥ 0.1.2-rc.1 | 事件数组改为 `session.log` | `eventsOf()` 优先读 `session.log` |
| ≥ 0.1.5-rc.1 | surface replace 键名改为 `startSeq`/`endSeq` | 按会话头版本选键名，被拒时换另一代重试一次 |

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
| `/clear-tool-results on` | 启用：工具结果按轮归档，并在下一轮开始前从对话清除 |
| `/clear-tool-results off` | 停用：保留工具结果、不再归档 |
| `/clear-tool-results status` | 显示启用状态与插件版本 |

状态存于 `$DSH_HOME/clear-tool-results.json`（`DSH_HOME` 未设置时回退 `~/.dsh`）：`{ "enabled": true }`；旧的 `{ enabled, mode }` 仍可读，`mode` 被忽略。

## 功能

0.7.0 保留的能力就是下面这几条：**每轮归档 → 按轮清除（留占位符）→ 模型按需用 `read_tool_result_log` 取回**。

- **归档**：每轮结束时，从追加式会话日志（而非改写后的 surface）取出该轮原始 `tool/result`，保留轮次/步骤号、工具名与匹配的 `tool/call`，写入 `round-NNNN.json` 并登记 `index.json`；以 index 为准、幂等，可补归档中途启用或重启前的轮次。
- **清除**：`turn/end` 把该轮 surface 节点替换为占位符，例如 `[第 3 轮工具结果已清除归档：bash → git status（1.2k），可用 read_tool_result_log(turn: 3) 读取]`。
- **归档上限 49000 字节（UTF-8）**：超限结果**不归档**——harness 的 spill 策略在 50000 字节处把结果换成「首尾预览 + 通知」并从**中间**掐掉，存了也取不回完整原文。占位符写成「已清除（该结果 49.5k 字节，超过 49000 字节上限，未归档）…。未保存原文，如需请重新执行原工具获取」，**不给取回坐标**；同轮若还有可归档结果则保留坐标并追加「本轮另有 N 条超 49000 字节的结果未归档，需要时请重新执行原工具」。规则同时写进工具描述，随工具注入 Agent。
- **占位符索引**：占位符带紧凑索引——工具名 → 关键参数（命令/路径/模式）+ 规模 + 是否失败，整行压到 60 字以内；同一步的多条合并成一行（最多列 2 条，其余归入「等 N 条」）；PTC（`run_code`）下优先显示里面的子调用（`bash → git status`），而不是 run_code 的代码前缀。让模型先知道「里面有什么」，再决定要不要取回。
- **取回**：`read_tool_result_log` 注册为模型工具，按 `turn` 或 `time` 读取。返回**紧凑纯文本**（非 JSON）：每条以 `--- turn N step S · 工具名 · 参数摘要 · 第 A-B 行 / 共 T 行 · N 字符 / M 字节 ---` 开头（参数摘要为空时省略；`offset` 越过末尾时行窗口显示为「第 T 行之后无内容（共 T 行）」），后接原文。
- **输出预算 48000 字节**：按**整份载荷**计（含表头与末尾通知 ⇒ 整份 ≤ 48400 字节，**永不触发 harness 截断**）；正文 ≤47.7k 字节可一次取回；更大的结果需带 `offset`/`limit` 分段，被截断的条目会附「续取：offset=…」坐标；若单条超出预算且未分段，则跳过该条并提示改用 `offset`/`limit`。
- **依赖**：仅 Node 内置模块；适用于所有会话与 agent preset；与 DSH 内置 compaction 兼容。

> **0.7.0 的功能面 = 每轮归档 + 按轮清除（占位符索引）+ `read_tool_result_log` 取回**，外加 49000 字节归档上限与分页。overclock 模式、配套核心补丁、归因埋点与逐轮追踪日志均已移除。每步清除解决不了「模型把自己的输出当缓存」：实测 ≤49000 字节的已清除结果里，事后只有 **5.5%** 走取回、**52.6%** 靠记忆代偿（41.2% 抄进推理、11.3% 抄进可见正文），而推理会被适配器以 `reasoning_content` 回灌上下文。

## read_tool_result_log 工具

| 参数 | 说明 |
| --- | --- |
| `turn` | 轮次编号（1 起），如 `read_tool_result_log({ turn: 3 })` 读取第 3 轮 |
| `time` | ISO 8601 时间或毫秒时间戳，读取该时刻所在轮次 |
| `offset` / `limit` | 可选：只取原文的第 `offset` 行起、最多 `limit` 行。大结果用它分段取 |
| 都不传 | 已归档轮次列表 |

- `turn` 接受数字或纯数字字符串（schema 为 `integer`/`string`）。
- `step` 参数自 0.7.0 起移除；仍传 `step` 会返回明确提示，请改用 `turn` 取回整轮。
- **返回体是紧凑纯文本，不是 JSON**：每条为「表头 + 原文」，约 1.0×。旧版输出整条归档条目（`JSON.stringify`），同一份原文出现两次、体积 3–5 倍，会被 harness 从**中间**切开并落盘成 spill。
- **归档上限 49000 字节**：超限结果不保存，占位符写明尺寸（**按字节**）并要求重新执行原工具，**不给取回坐标**；同轮若还有可归档结果则保留坐标并追加「本轮另有 N 条超 49000 字节的结果未归档，需要时请重新执行原工具」。

## 工作原理

1. 监听 `session/event` 的 `turn/end` 与 `turn/start`；另监听 `tool/ptc-dispatch`，只为占位符索引登记 `run_code` 内部真正干活的子调用。
2. `turn/end`：从追加式日志收集该轮原始 `tool/result`，按 `callId` 解析工具名，写 `round-NNNN.json` 与 `index.json`；再把该轮 surface 节点替换为占位符（保持 tool-result 包装结构）。
3. `turn/start`：只补归档中途启用或重启前未归档的轮次，不在此清除；清除统一在上一轮的 `turn/end` 执行，因此下一轮 prompt 组装时该轮结果已不可见。
4. `read_tool_result_log` 从调用方会话目录读取归档并返回原文。
5. 归档与清除失败只写 warning 到 `$DSH_HOME/clear-tool-results.log`（**只有异常路径才写**，正常路径零 I/O；0.7.0 起不再有 per-turn/per-step 追踪行），不牵连彼此的流程。

## Demo：验证 `read_tool_result_log` 跨轮取回

**目的**：证明工具结果被清除后，模型能在**后续轮次**用 `read_tool_result_log` 取回原文，而不是靠上一轮的记忆复述。

**关键设计——随机 token**：固定串（如 `TOPSECRET-12345`）模型在生成它的那一轮见过，可能靠记忆答对；随机串无法预知，只有真正取回才能答对。

**前置**：`/clear-tool-results on`（`/clear-tool-results status` 应显示 enabled）。

### 第 1 轮：生成随机 token，要求不复述

发送：

> 执行 `python3 -c "import secrets; print('DSH-DEMO-' + secrets.token_hex(8))"`。
> 只回复「完成」，不要复述命令输出，也不要在思考或正文里出现任何 token。

工具结果先显示完整值，随后被替换为占位符：

```
[第 1 轮工具结果已清除归档：bash → python3 -c "..."（26），可用 read_tool_result_log(turn: 1) 读取]
```

> ✅ 检查点 1：第 1 轮回复里**不得**出现 `DSH-DEMO-`。一旦出现，说明 token 已写进对话，之后可能靠记忆而非取回答对。

### 第 2 轮：显式跨轮取回

发送：

> 调用 `read_tool_result_log({ turn: 1 })` 取回第 1 轮那条命令的原始输出，把完整 token 原样发我；不要用 bash/read 翻文件。

预期发起的工具调用与返回（工具名/行数/字节数随调用方式与输出浮动；直接调用 `bash` 时表头显示 `bash`，PTC/`run_code` 下显示 `run_code`）：

```
查询：第 1 轮

--- turn 1 step 1 · bash · {"command":"python3 -c \"...\""} · 第 1-N 行 / 共 N 行 · … 字符 / … 字节 ---
DSH-DEMO-xxxxxxxxxxxxxxxx

取回提示：归档在每轮结束时写入，之后随时可读；如需引用多轮原文，可在总结前逐轮取回。
```

### 通过标准

1. 第 2 轮**确实调用** `read_tool_result_log({ turn: 1 })`，而不是用 bash/read 绕过。
2. 返回体以 `查询：第 1 轮` 开头，`--- turn 1 step 1 · … ---` 表头之后是原文。
3. 模型回答的 token 与第 1 轮归档里的 token **逐字相同**——随机值意味着不可能是背出来的。

### 可选扩展

- 空参数 `read_tool_result_log({})` → `已归档轮次：turn 1（…步，…条）`，确认归档已登记。
- 中间多聊几轮后再问同一问题 → 仍取回同一 token，证明取回与轮次间隔无关。
- 用 `time` 参数（取 `index.json` 中该轮的 `timeFrom` 毫秒值）→ 命中同一轮。

### 一键核对

```sh
grep -o 'DSH-DEMO-[0-9a-f]*' ~/.dsh/sessions/*/*/tool-result-logs/round-0001.json
```

输出应与第 2 轮回答中的 token 一致。

## 验证

**跨轮取回**：见上一节 Demo（随机 token + 通过标准）。

**超限回归**：跑一条 >49000 字节的输出（如 `python3 -c "print('中'*16600)"`）→ 占位符应写明「该结果 49.8k 字节，超过 49000 字节上限，未归档」，且 `tool-result-logs/` 下**不得**出现该条目的归档记录。

文件检查：

```sh
ls ~/.dsh/sessions/*/*/tool-result-logs/
cat ~/.dsh/sessions/*/*/tool-result-logs/round-0001.json
```

## 卸载

1. 删除 `cordis.patch.yml` 中的注册行；
2. `dsh plugin --profile web remove dsh-clear-tool-results`；
3. 可选：删除 `$DSH_HOME/clear-tool-results.json`、`$DSH_HOME/clear-tool-results.log` 与各 `tool-result-logs/` 目录。

## 链接

- GitHub: <https://github.com/stultuss/dsh-clear-tool-results>
- npm: <https://www.npmjs.com/package/dsh-clear-tool-results>

## License

MIT
