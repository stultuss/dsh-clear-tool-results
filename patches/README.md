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

| 文件 | 改动 |
| --- | --- |
| `dsh-session/lib/index.js` | ① `createFoldState()` 增加 `seriesGeneration: 0`；② `isReplaceOp` 放行第 4 个键 `impact:"clear"`；③ `planSurfaceEvent` 把 `impact` 透传进 plan；④ `applySurfacePlan` 的 replace 分支：`replaceGeneration += 1` 照旧，仅当 `plan.impact !== "clear"` 时 `seriesGeneration += 1`；⑤ surface 暴露 `seriesGeneration` getter |
| `dsh-agent-loop/lib/index.js` | 系列判定改读 `this.session.surface.seriesGeneration ?? this.session.surface.replaceGeneration` |

`replaceGeneration` 语义完全不变，因此所有既有消费者（模型上下文的投影缓存、压缩轮询、
客户端镜像计数）行为不变；只有「新系列」的判定不再被工具结果清除触发。

agent-loop 侧带 `??` 回退，所以两个文件可以分别应用/回退，任一侧未打补丁都退回原行为。

## 插件侧的配合

* 逐步清除（`step/end`）时给 `surfaceOp` 加 `impact:"clear"`，**且仅在探测到核心已暴露
  `seriesGeneration` 时才加**（否则旧核心的 `isReplaceOp` 会拒绝 4 键 op）。
* 轮末清除（`turn/end`）保持普通 replace：它每轮只发生一次，正好让下一轮出现一个系列边界，
  Chat 界面每轮展示一次系统提示词。
* 若轮内结果已被逐步清除干净，轮末会做一次内容不变的普通替换（`nudgeSeries`），
  保证「每轮一次」稳定成立。

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
* 核心包升级/重装后补丁会被覆盖，重新执行 `npm run patch:apply` 即可。
