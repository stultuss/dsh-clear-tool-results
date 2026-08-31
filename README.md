# dsh-clear-tool-results

DSH 宿主插件：每轮对话结束后，把该轮的原始工具结果（tool result）归档到会话目录（tool-result-logs），并从上下文中清除，减少 Token 消耗；模型可用 read_tool_result_log 工具按轮次或时间自主读取归档数据。

命令：`/clear-tool-results on|off|status`

- GitHub: <https://github.com/stultuss/dsh-clear-tool-results>
- npm: <https://www.npmjs.com/package/dsh-clear-tool-results>

<img width="1594" height="417" alt="image" src="https://github.com/user-attachments/assets/a1247911-e0b6-4ae1-97ba-c99a17c31da0" />


## 功能

- **归档**：每轮结束时，从追加式会话日志（非改写后的 surface）取出该轮原始 `tool/result` 事件，写入 `~/.dsh/sessions/<workspace>/<session-id>/tool-result-logs/round-NNNN.json`（附 `index.json` 清单），原始数据完整保留（含工具名、匹配的 `tool/call` 事件）。
- **清除**：把已结束轮次的工具结果显示替换为占位符（注明轮次，提示读取工具），下一轮开始时历史工具结果不可见：
  `[第 3 轮工具结果已清除归档，可用 read_tool_result_log(turn: 3) 读取]`
- **自主读取**：注册 `read_tool_result_log` 工具，模型在用户回顾某轮工具输出时自行调用（无需命令），按轮次或时间返回原始数据。
- **开关**：`/clear-tool-results on|off|status`，状态存于 `$DSH_HOME/clear-tool-results.json`（默认启用）。
- **补归档**：中途启用或重启后，自动补归档之前未归档的轮次（幂等）。
- 仅依赖 Node 内置模块；适用于所有会话与 agent preset；与 DSH 内置 compaction 兼容。

## read_tool_result_log 工具

| 参数 | 说明 |
| --- | --- |
| `turn` | 轮次编号（1 起），如 `read_tool_result_log({ turn: 3 })` 读取第 3 轮 |
| `time` | ISO 8601 时间或毫秒时间戳，读取该时刻所在轮次 |
| *(都不传)* | 返回已归档轮次列表 |

示例：用户问"上一轮 bash 命令的输出是什么？"→ 模型调用 `read_tool_result_log({ turn: 2 })` → 注入原始数据并回答。

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
| `/clear-tool-results on` | 启用归档 + 清除 + read_tool_result_log 工具 |
| `/clear-tool-results off` | 停用：保留工具结果，不再归档 |
| `/clear-tool-results status` | 查看当前状态 |

## 原理简述

1. 监听 `session/event` 的 `turn/end` / `turn/start`；
2. `turn/end`：从追加式日志收集该轮原始 `tool/result`，按 `callId` 解析工具名，写入 `round-NNNN.json` + `index.json`；再把已结束轮次的 surface 节点替换为占位符（`session.append('tool/result', ..., { surfaceOp: { op: 'replace' } })`，保持 tool-result 包装结构）；
3. `read_tool_result_log` 读取调用方会话目录下的归档文件返回原始数据；
4. 归档幂等（以 index 为准），可补归档。

> 时机说明：DSH 在 `turn/start` 后同步组装 prompt 且 append 有重入保护，故清除在上一轮 `turn/end` 执行——新轮开始时历史工具结果已不可见。

## 验证

1. 第 1 轮：`请调用 bash 执行 echo TOPSECRET-12345，然后只回复"完成"`；
2. 回复后工具结果显示占位符；
3. 第 2 轮：`刚才那个 TOPSECRET-12345 是什么？`；
4. 预期：模型自主调用 `read_tool_result_log({ turn: 1 })` 并答出秘密。

文件检查：

```sh
ls ~/.dsh/sessions/*/*/tool-result-logs/
cat ~/.dsh/sessions/*/*/tool-result-logs/round-0001.json
```

## 卸载

1. 删除 `cordis.patch.yml` 注册行；
2. `dsh plugin --profile web remove dsh-clear-tool-results`；
3. 可选：删除 `$DSH_HOME/clear-tool-results.json` 与各 `tool-result-logs/` 目录。

## License

MIT
