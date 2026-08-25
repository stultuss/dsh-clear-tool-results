# dsh-clear-tool-results

DeepSeek Harness（DSH）host 平面插件：**每个 turn 结束时，把上一轮产生的 `tool/result` 从模型上下文中清除**，并提供聊天命令开关：

```
/clear-tool-results on|off|status
```

## 为什么需要它

DSH 的会话日志是 append-only 的，模型可见历史由 `session.surface` 派生。大型工具输出会一直留在后续轮次的请求里，白白占用上下文。

本插件在每个 `turn/end` 后，把刚结束那一轮的 `tool/result` 节点替换成：

```text
[上一轮工具结果已清除]
```

原始工具结果仍保留在会话日志中（持久化、回放、聊天 transcript 不受影响），只是不再发给模型。

## 特性

- host 平面插件：对**所有会话 / 所有 agent preset** 生效；
- 聊天命令开关，无需改文件即可启用/禁用；
- 开关状态持久化在 `$DSH_HOME/clear-tool-results.json`（默认开启）；
- 只依赖 Node 内置模块，无第三方运行时依赖；
- 与 DSH 内置 compaction（`/compact`、`dsh-compaction-basic`、`dsh-compaction-tool-result-pruner`）互不冲突。

## 安装

### 1. 安装 npm 包

把 `dsh-clear-tool-results-0.1.0.tgz` 放到方便的位置，然后在目标 profile 中安装：

```sh
dsh plugin --profile web add ./dsh-clear-tool-results-0.1.0.tgz
```

等价于在该 profile 目录下执行：

```sh
cd ~/.dsh/profiles/web
pnpm add ./dsh-clear-tool-results-0.1.0.tgz
```

### 2. 在 profile 的 `cordis.patch.yml` 中注册

在 `~/.dsh/profiles/web/cordis.patch.yml`（或对应 profile）里加入：

```yaml
- insert:
    - id: clear-tool-results-host
      name: 'dsh-clear-tool-results'
```

保存后 DSH 会热重载配置（无需重启服务）。如果 Web 输入框的命令菜单没更新，刷新页面即可。

## 使用

在聊天输入框输入：

| 命令                         | 效果                               |
| ---------------------------- | ---------------------------------- |
| `/clear-tool-results on`     | 开启：每轮结束后清除上一轮工具结果 |
| `/clear-tool-results off`    | 关闭：保留上一轮工具结果           |
| `/clear-tool-results status` | 查看当前开关状态                   |

开关状态文件：

```json
// $DSH_HOME/clear-tool-results.json
{
  "enabled": true
}
```

文件缺失时视为开启。

## 工作原理

1. 插件监听 `session/event` 中的 `turn/end`；
2. 找出刚结束那一轮里所有 append-origin 的 `tool/result` 节点；
3. 逐个 `session.append('tool/result', ..., { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [seq] })` 替换为占位内容；
4. 替换仅修改 `message.content`，保留 `turn`、`step`、`callId`、错误字段与 `meta`；
5. 原事件仍在 append-only 日志中，可回放。

## 验证

- 新建会话；
- 第一轮：`请务必调用 bash 执行：echo secret-12345，然后只回复"完成"`；
- 第二轮：`刚才那条 secret 是什么？`

若开启清理，模型看不到 `secret-12345`，只会看到 `[上一轮工具结果已清除]`。

## 卸载

1. 从 `cordis.patch.yml` 删除注册行；
2. 移除依赖：

```sh
dsh plugin --profile web remove dsh-clear-tool-results
```

3. （可选）删除 `$DSH_HOME/clear-tool-results.json`。

## 许可证

MIT
