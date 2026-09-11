#!/usr/bin/env node
/**
 * dsh-clear-tool-results · 核心补丁管理器（多代适配）
 *
 * 背景
 *   插件 overclock 模式每一步都会把上一步的工具结果替换为占位符（surface replace）。
 *   核心 dsh-session 每执行一次 replace 就 `replaceGeneration += 1`，而 dsh-agent-loop
 *   在两次请求之间发现该计数变化就判定「新系列」（append `request/header {reason:"series"}`），
 *   Chat 界面对每个系列都渲染一次系统提示词 —— 于是每步都重复展示一次。
 *
 * 方案
 *   双代数：
 *     · `replaceGeneration` 保持原语义（任何 replace 都 +1）—— 投影缓存、压缩轮询、
 *       客户端镜像都依赖它，绝不能改。
 *     · 新增 `seriesGeneration`：只有「非清除型」replace 才 +1。判定「清除型」的依据是
 *       替换是否改写了 tool/result 的内容（见下），因此不再开启新系列。
 *   agent-loop 的系列判定改读 `seriesGeneration`（缺失时回退 `replaceGeneration`，
 *   所以两个文件可以独立应用/回退，任一侧未打补丁都保持原行为）。
 *
 * 「清除型」怎么判定（v4 起的约定）
 *   事件上不能带任何自定义标记：
 *     · surfaceOp 只允许 3 个键（op / startSeq / endSeq）。浏览器端
 *       dsh-api-session-controller / dsh-client-connection 的 assertSessionWireEvent → isReplaceOp
 *       严格按 3 键校验且不做归一化，第 4 个键会让 follow 流里那一帧抛
 *       `session event "tool/result" carries an invalid replace surfaceOp`；follow 流是所有
 *       会话共用的，整块 UI 会一起卡死（每个会话都报历史加载失败）。
 *     · data 只允许改 `message.content[0].content`（assertToolResultRewrite），
 *       加任何其它字段都会被拒。
 *   所以判定改成看事实本身：单节点 tool/result 替换**改写了内容** = 内容清除（不开新系列）；
 *   内容逐字节不变 = 插件用来划分轮次系列边界的那次替换（照旧开新系列）。
 *   顺带地，核心自带的 compaction-tool-result-pruner 的修剪也不再产生新系列 ——
 *   它同样只是改写 tool/result 内容。
 *   isReplaceOp 因此只接受 3 键：任何旧版本插件写出的 4 键 op 都会在宿主侧被拒绝 ——
 *   清除失败（记 warning），但会话不受影响。
 *
 * 多代适配
 *   核心有两条代码谱系，差异不只是版本号，所以按「位点变体」适配而不是解析版本号：
 *
 *   legacy（<= 0.1.4）
 *     · surface op 键名：`start` / `end`
 *     · agent-loop：局部量 `const surfaceGeneration = this.session.surface.replaceGeneration`
 *       同时供比较与重捕获使用 → 单点补丁即可覆盖全部系列判定
 *
 *   seq（>= 0.1.5）
 *     · surface op 键名：`startSeq` / `endSeq`（isReplaceOp 同时用 Object.hasOwn + isEventSeq 校验）
 *     · agent-loop：拆成「构造期捕获 + 系统提示投影比较 + buildRequest 局部量」三处，
 *       并新增 `startsRequestSeries` / `toolsChanged(...)` 两个输入 → 一个变体含 3 组替换
 *
 *   每个位点可挂多个变体，apply 时挑选当前文件里恰好匹配的那一个；任一位点无变体匹配
 *   → 整体拒绝写入（先全量校验、后落盘），绝不产生半补丁状态。
 *
 *   跨代拼写兼容：isReplaceOp 同时接受两种键拼写，并**只解析、不改写**（>=0.1.5 的核心
 *   先深冻结事件、后校验 surfaceOp，就地归一化会抛 TypeError: not extensible）。
 *   旧拼写在 `surfaceOpOf` 返回时被解析成本代键名，fold 因此照样能重放旧核心写入的会话日志。
 *
 *   历史补丁态：v1 补丁写出的文本也登记在 `from` 列表里，所以已经装过 v1 的核心
 *   可以就地升级到 v2，revert 仍能回到原始文件。
 *
 * 用法
 *   node patches/patch-core.mjs status            # 查看补丁状态（含核心代数）
 *   node patches/patch-core.mjs apply             # 应用（备份到 ~/.dsh/clear-tool-results-backups/）
 *   node patches/patch-core.mjs revert            # 回退
 *   node patches/patch-core.mjs apply --root /path/to/@deepseek-ai/dsh
 *   也通过 npm run patch:status / patch:apply / patch:revert 调用。
 *
 * 注意
 *   补丁写入的是磁盘上的核心包文件，**必须重启 dsh GUI 进程**才会加载新代码。
 *   /clear-tool-results 命令已与补丁绑定：overclock → 自动 apply；on/off → 自动 revert。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 备份目录可覆盖：CI / 兼容性验证脚本会指向临时目录
const BACKUP_DIR = process.env.DSH_CLEAR_TOOL_RESULTS_BACKUP_DIR ?? join(homedir(), '.dsh', 'clear-tool-results-backups')

export const SESSION_REL = 'node_modules/@deepseek-ai/dsh-session/lib/index.js'
export const AGENT_LOOP_REL = 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'

/** 核心代数标识。 */
export const GEN_LEGACY = 'legacy' // <= 0.1.4
export const GEN_SEQ = 'seq' // >= 0.1.5

const KEY_NAMES = {
  [GEN_LEGACY]: { start: 'start', end: 'end' },
  [GEN_SEQ]: { start: 'startSeq', end: 'endSeq' },
}

/** 判定核心代数的稳定特征（打补丁前后都成立）。 */
const SEQ_MARKER = 'isEventSeq(op["startSeq"])'

/** v1 补丁写出的 isReplaceOp 文本（用于就地升级）。 */
const V1_REPLACE_OP_SHAPE =
  '\tconst keys = Object.keys(op);\n' +
  '\treturn (keys.length === 3 || (keys.length === 4 && op["impact"] === "clear")) && Object.hasOwn(op, "op") && Object.hasOwn(op, "start") && Object.hasOwn(op, "end") && op["op"] === "replace" && isEventSeq(op["start"]) && isEventSeq(op["end"]);'

/**
 * v2 补丁写出的 isReplaceOp 文本（>=0.1.5 态，用于就地升级）。
 * 它在冻结的 op 上就地写 startSeq，而 >=0.1.5 的核心是「先深冻结事件、后校验 surfaceOp」，
 * 因此该写法在 0.1.5 上会抛 TypeError: Cannot add property startSeq, object is not extensible。
 */
export const V2_SEQ_REPLACE_OP_SHAPE =
  '\tif (op === null || typeof op !== "object") return false;\n' +
  '\tconst keys = Object.keys(op);\n' +
  '\t// 跨代兼容：旧核心写入的日志用 start/end，就地归一化为本代拼写\n' +
  '\tif (Object.hasOwn(op, "start") && !Object.hasOwn(op, "startSeq")) {\n' +
  '\t\top["startSeq"] = op["start"];\n' +
  '\t\top["endSeq"] = op["end"];\n' +
  '\t\tdelete op["start"];\n' +
  '\t\tdelete op["end"];\n' +
  '\t}\n' +
  '\treturn (keys.length === 3 || (keys.length === 4 && op["impact"] === "clear")) && Object.hasOwn(op, "op") && op["op"] === "replace" && isEventSeq(op["startSeq"]) && isEventSeq(op["endSeq"]);'

/** v3 补丁写出的 isReplaceOp 文本（两代；放行第 4 个键 impact:"clear"，v4 起废弃）。 */
export const V3_LEGACY_REPLACE_OP_SHAPE =
  '\tif (op === null || typeof op !== "object") return false;\n' +
  '\tconst keys = Object.keys(op);\n' +
  '\t// 跨代兼容：新核心写入的日志用 startSeq/endSeq，就地归一化为本代拼写\n' +
  '\tif (Object.hasOwn(op, "startSeq") && !Object.hasOwn(op, "start")) {\n' +
  '\t\top["start"] = op["startSeq"];\n' +
  '\t\top["end"] = op["endSeq"];\n' +
  '\t\tdelete op["startSeq"];\n' +
  '\t\tdelete op["endSeq"];\n' +
  '\t}\n' +
  '\treturn (keys.length === 3 || (keys.length === 4 && op["impact"] === "clear")) && Object.hasOwn(op, "op") && Object.hasOwn(op, "start") && Object.hasOwn(op, "end") && op["op"] === "replace" && isEventSeq(op["start"]) && isEventSeq(op["end"]);'

export const V3_SEQ_REPLACE_OP_SHAPE =
  '\tif (op === null || typeof op !== "object") return false;\n' +
  '\tconst keys = Object.keys(op);\n' +
  '\t// 跨代兼容：旧核心写入的日志用 start/end。核心在写入前深冻结事件，\n' +
  '\t// 所以这里只解析、不改写（就地归一化会在冻结的 op 上抛 TypeError）。\n' +
  '\treturn (keys.length === 3 || (keys.length === 4 && op["impact"] === "clear")) && Object.hasOwn(op, "op") && op["op"] === "replace" && (Object.hasOwn(op, "startSeq") ? isEventSeq(op["startSeq"]) : isEventSeq(op["start"])) && (Object.hasOwn(op, "endSeq") ? isEventSeq(op["endSeq"]) : isEventSeq(op["end"]));'

/** v3 补丁写出的 surfaceOpOf 文本（把 surfaceOp 上的 impact 原样带进 fold）。 */
const V3_SURFACE_OP_OF =
  '\tif (!isReplaceOp(op)) throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);\n' +
  '\tif (Object.hasOwn(op, "startSeq")) return op;\n' +
  '\treturn { op: "replace", startSeq: op["start"], endSeq: op["end"], ...(Object.hasOwn(op, "impact") ? { impact: op["impact"] } : {}) };'

/**
 * v4：replace op 恒为 3 键，只解析、不改写；跨代拼写仍然兼容。
 * 第 4 个键会被浏览器端 wire 校验拒绝，所以这里必须拒绝它（见文件头说明）。
 */
const V4_SEQ_REPLACE_OP_SHAPE =
  '\tif (op === null || typeof op !== "object") return false;\n' +
  '\t// 跨代兼容：旧核心写入的日志用 start/end。核心在写入前深冻结事件，\n' +
  '\t// 所以这里只解析、不改写（就地归一化会在冻结的 op 上抛 TypeError）。\n' +
  '\t// 只接受 3 键：第 4 个键会被浏览器端 wire 校验拒绝，导致整块 UI 卡死。\n' +
  '\treturn Object.keys(op).length === 3 && Object.hasOwn(op, "op") && op["op"] === "replace" && (Object.hasOwn(op, "startSeq") ? isEventSeq(op["startSeq"]) : isEventSeq(op["start"])) && (Object.hasOwn(op, "endSeq") ? isEventSeq(op["endSeq"]) : isEventSeq(op["end"]));'

const V4_SURFACE_OP_OF =
  '\tif (!isReplaceOp(op)) throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);\n' +
  '\tif (Object.hasOwn(op, "startSeq")) return op;\n' +
  '\treturn { op: "replace", startSeq: op["start"], endSeq: op["end"] };'

/**
 * v4：判定「清除型替换」的辅助函数 —— 单节点 tool/result 替换改写了内容即为清除。
 * 事件上不能带自定义标记（surfaceOp 只能 3 键、data 只能改 content，见文件头）。
 */
export const CLEAR_IMPACT_HELPER = [
  '/** 该替换是否只是改写了单个 tool/result 的内容（= 内容清除，不开启新系列）。 */',
  'function clearsToolResultContent(event, shadowedSeqs, events, baseSeq) {',
  '\tif (event.type !== "tool/result" || shadowedSeqs.length !== 1) return false;',
  '\tconst original = events[shadowedSeqs[0] - baseSeq];',
  '\tif (original?.type !== "tool/result") return false;',
  '\treturn !isDeepEqualJson(original.data?.message?.content?.[0]?.content, event.data?.message?.content?.[0]?.content);',
  '}',
  '',
].join('\n')

/**
 * 各补丁位点。
 *   variants: [{ gens, pairs: [{ from: [...可接受的现状文本], to: 补丁后文本 }] }]
 *   · from[0] 必为原始（未打补丁）文本，revert 会回到它；
 *   · from[1..] 为历史补丁态，apply 时可就地升级；
 *   · to 必须唯一出现；一个变体可含多组替换（同代里同一语义散落在多处）。
 */
const EDITS = [
  {
    file: SESSION_REL,
    id: 'session:fold-state',
    note: 'fold 状态新增 seriesGeneration（系列代数，初始 0）',
    variants: [
      {
        gens: [GEN_LEGACY, GEN_SEQ],
        pairs: [
          {
            from: [
              'function createFoldState() {\n\treturn {\n\t\tnodes: [],\n\t\treplaceGeneration: 0\n\t};\n}',
            ],
            to: 'function createFoldState() {\n\treturn {\n\t\tnodes: [],\n\t\treplaceGeneration: 0,\n\t\tseriesGeneration: 0\n\t};\n}',
          },
        ],
      },
    ],
  },
  {
    file: SESSION_REL,
    id: 'session:replace-op-shape',
    note: 'replace op 只接受 3 键（并兼容另一代的键拼写）',
    variants: [
      {
        gens: [GEN_LEGACY],
        pairs: [
          {
            from: [
              '\treturn Object.keys(op).length === 3 && Object.hasOwn(op, "op") && Object.hasOwn(op, "start") && Object.hasOwn(op, "end") && op["op"] === "replace" && isEventSeq(op["start"]) && isEventSeq(op["end"]);',
              V1_REPLACE_OP_SHAPE,
              V3_LEGACY_REPLACE_OP_SHAPE,
            ],
            to:
              '\tif (op === null || typeof op !== "object") return false;\n' +
              '\tconst keys = Object.keys(op);\n' +
              '\t// 跨代兼容：新核心写入的日志用 startSeq/endSeq，就地归一化为本代拼写\n' +
              '\tif (Object.hasOwn(op, "startSeq") && !Object.hasOwn(op, "start")) {\n' +
              '\t\top["start"] = op["startSeq"];\n' +
              '\t\top["end"] = op["endSeq"];\n' +
              '\t\tdelete op["startSeq"];\n' +
              '\t\tdelete op["endSeq"];\n' +
              '\t}\n' +
              '\treturn keys.length === 3 && Object.hasOwn(op, "op") && Object.hasOwn(op, "start") && Object.hasOwn(op, "end") && op["op"] === "replace" && isEventSeq(op["start"]) && isEventSeq(op["end"]);',
          },
        ],
      },
      {
        gens: [GEN_SEQ],
        pairs: [
          {
            from: [
              '\treturn Object.keys(op).length === 3 && Object.hasOwn(op, "op") && Object.hasOwn(op, "startSeq") && Object.hasOwn(op, "endSeq") && op["op"] === "replace" && isEventSeq(op["startSeq"]) && isEventSeq(op["endSeq"]);',
              V2_SEQ_REPLACE_OP_SHAPE,
              V3_SEQ_REPLACE_OP_SHAPE,
            ],
            to: V4_SEQ_REPLACE_OP_SHAPE,
          },
          {
            // surfaceOpOf 返回的 op 就是 fold 用的 op：跨代（旧日志）拼写在这里解析成本代键名
            from: [
              '\tif (!isReplaceOp(op)) throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);\n\treturn op;',
              V3_SURFACE_OP_OF,
            ],
            to: V4_SURFACE_OP_OF,
          },
        ],
      },
    ],
  },
  {
    file: SESSION_REL,
    id: 'session:clear-impact-helper',
    note: '新增 clearsToolResultContent（改写了内容的单节点 tool/result 替换 = 清除型）',
    variants: [
      {
        gens: [GEN_LEGACY, GEN_SEQ],
        pairs: [
          {
            from: [
              '/** Validate one event at its replay boundary and prepare its atomic fold transition. */\nfunction planSurfaceEvent(state, event, expectedSeq, events, baseSeq) {',
            ],
            to:
              CLEAR_IMPACT_HELPER +
              '/** Validate one event at its replay boundary and prepare its atomic fold transition. */\nfunction planSurfaceEvent(state, event, expectedSeq, events, baseSeq) {',
          },
        ],
      },
    ],
  },
  {
    file: SESSION_REL,
    id: 'session:plan-passthrough',
    note: 'planSurfaceEvent 把「内容清除」判定结果放进 plan.impact',
    variants: [
      {
        gens: [GEN_LEGACY],
        pairs: [
          {
            from: [
              '\tassertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq);\n\treturn {\n\t\tkind: "replace",\n\t\tseq: event.seq,\n\t\tstart: surfaceOp.start,\n\t\tend: surfaceOp.end,\n\t\t...range\n\t};',
              '\tassertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq);\n\treturn {\n\t\tkind: "replace",\n\t\tseq: event.seq,\n\t\tstart: surfaceOp.start,\n\t\tend: surfaceOp.end,\n\t\timpact: surfaceOp.impact,\n\t\t...range\n\t};',
            ],
            to:
              '\tassertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq);\n' +
              '\tconst impact = clearsToolResultContent(event, range.shadowedSeqs, events, baseSeq) ? "clear" : undefined;\n' +
              '\treturn {\n\t\tkind: "replace",\n\t\tseq: event.seq,\n\t\tstart: surfaceOp.start,\n\t\tend: surfaceOp.end,\n\t\timpact,\n\t\t...range\n\t};',
          },
        ],
      },
      {
        gens: [GEN_SEQ],
        pairs: [
          {
            from: [
              '\tassertSystemHeadRewrite(event, state, range.startIdx, range.shadowedSeqs, events, baseSeq);\n\treturn {\n\t\tkind: "replace",\n\t\tseq: event.seq,\n\t\tstart: surfaceOp.startSeq,\n\t\tend: surfaceOp.endSeq,\n\t\t...range\n\t};',
              '\tassertSystemHeadRewrite(event, state, range.startIdx, range.shadowedSeqs, events, baseSeq);\n\treturn {\n\t\tkind: "replace",\n\t\tseq: event.seq,\n\t\tstart: surfaceOp.startSeq,\n\t\timpact: surfaceOp.impact,\n\t\tend: surfaceOp.endSeq,\n\t\t...range\n\t};',
            ],
            to:
              '\tassertSystemHeadRewrite(event, state, range.startIdx, range.shadowedSeqs, events, baseSeq);\n' +
              '\tconst impact = clearsToolResultContent(event, range.shadowedSeqs, events, baseSeq) ? "clear" : undefined;\n' +
              '\treturn {\n\t\tkind: "replace",\n\t\tseq: event.seq,\n\t\tstart: surfaceOp.startSeq,\n\t\timpact,\n\t\tend: surfaceOp.endSeq,\n\t\t...range\n\t};',
          },
        ],
      },
    ],
  },
  {
    file: SESSION_REL,
    id: 'session:series-counter',
    note: '清除型 replace 不递增 seriesGeneration（replaceGeneration 照旧 +1）',
    variants: [
      {
        gens: [GEN_LEGACY, GEN_SEQ],
        pairs: [
          {
            from: [
              '\telse if (plan?.kind === "replace") {\n\t\tstate.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);\n\t\tstate.replaceGeneration += 1;\n\t}',
            ],
            to: '\telse if (plan?.kind === "replace") {\n\t\tstate.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);\n\t\tstate.replaceGeneration += 1;\n\t\tif (plan.impact !== "clear") state.seriesGeneration += 1;\n\t}',
          },
        ],
      },
    ],
  },
  {
    file: SESSION_REL,
    id: 'session:series-getter',
    note: 'surface 暴露 seriesGeneration getter',
    variants: [
      {
        gens: [GEN_LEGACY, GEN_SEQ],
        pairs: [
          {
            from: [
              '\t/** Monotonic count of folded positional replacements. */\n\tget replaceGeneration() {\n\t\tif (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta();\n\t\treturn this._state.replaceGeneration;\n\t}',
            ],
            to: '\t/** Monotonic count of folded positional replacements. */\n\tget replaceGeneration() {\n\t\tif (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta();\n\t\treturn this._state.replaceGeneration;\n\t}\n\t/** Monotonic count of folded positional replacements that are not clear-only. */\n\tget seriesGeneration() {\n\t\tif (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta();\n\t\treturn this._state.seriesGeneration;\n\t}',
          },
        ],
      },
    ],
  },
  {
    file: AGENT_LOOP_REL,
    id: 'agent-loop:series-generation',
    note: '系列判定改读 seriesGeneration（缺失时回退 replaceGeneration）',
    variants: [
      {
        gens: [GEN_LEGACY],
        pairs: [
          {
            from: ['const surfaceGeneration = this.session.surface.replaceGeneration;'],
            to: 'const surfaceGeneration = this.session.surface.seriesGeneration ?? this.session.surface.replaceGeneration;',
          },
        ],
      },
      {
        gens: [GEN_SEQ],
        pairs: [
          {
            // 构造期捕获
            from: ['this.requestSurfaceGeneration = session.surface.replaceGeneration;'],
            to: 'this.requestSurfaceGeneration = session.surface.seriesGeneration ?? session.surface.replaceGeneration;',
          },
          {
            // 系统提示投影处的比较
            from: ['this.requestSurfaceGeneration !== this.session.surface.replaceGeneration'],
            to: 'this.requestSurfaceGeneration !== (this.session.surface.seriesGeneration ?? this.session.surface.replaceGeneration)',
          },
          {
            // buildRequest 内的局部量（同时供比较与重新捕获）
            from: ['const surfaceGeneration = session.surface.replaceGeneration;'],
            to: 'const surfaceGeneration = session.surface.seriesGeneration ?? session.surface.replaceGeneration;',
          },
        ],
      },
    ],
  },
]

/** 定位 dsh 核心安装目录（含 node_modules/@deepseek-ai/dsh-session）。 */
/** 由内向外逐级向上探测：<profile>/node_modules/<plugin>/patches → … → 家目录。 */
function ancestorRoots() {
  const dirs = []
  let dir = fileURLToPath(new URL('.', import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    dirs.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

function readDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/** dsh 自身目录：~/.dsh、~/.dsh/profiles、~/.dsh/profiles/<name> 及其 node_modules。 */
function dshProfileRoots() {
  const home = homedir()
  const roots = [join(home, '.dsh'), join(home, '.dsh', 'profiles'), join(home, '.dsh', 'profiles', 'node_modules')]
  for (const profile of readDirs(join(home, '.dsh', 'profiles'))) {
    roots.push(profile, join(profile, 'node_modules'))
  }
  return roots
}

/** pnpm 全局目录：<prefix>/global/<vN>/<hash>/node_modules，以及提升后的 .pnpm/node_modules。 */
function pnpmGlobalRoots() {
  const prefixes = [
    join(homedir(), 'Library', 'pnpm'),
    join(homedir(), '.local', 'share', 'pnpm'),
    join(homedir(), 'AppData', 'Local', 'pnpm'),
    join(homedir(), '.pnpm'),
  ]
  const roots = []
  for (const prefix of prefixes) {
    for (const version of readDirs(join(prefix, 'global'))) {
      for (const hash of readDirs(version)) {
        const nodeModules = join(hash, 'node_modules')
        roots.push(nodeModules, join(nodeModules, '.pnpm', 'node_modules'))
      }
    }
    roots.push(join(prefix, 'global', 'node_modules'))
  }
  return roots
}

function* candidateRoots(explicit) {
  yield explicit
  yield process.env.DSH_CORE_DIR
  yield* ancestorRoots()
  yield* dshProfileRoots()
  yield '/usr/local/lib/node_modules/@deepseek-ai/dsh'
  yield '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
  if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
    yield join(npmRoot.stdout.trim(), '@deepseek-ai/dsh')
    yield npmRoot.stdout.trim()
  }
  const pnpmRoot = spawnSync('pnpm', ['root', '-g'], { encoding: 'utf8' })
  if (pnpmRoot.status === 0 && pnpmRoot.stdout.trim()) yield pnpmRoot.stdout.trim()
  yield* pnpmGlobalRoots()
}

function isCoreRoot(root) {
  return existsSync(join(root, SESSION_REL)) && existsSync(join(root, AGENT_LOOP_REL))
}

/** 列出全部候选目录及探测结果，用于排错与 --json 输出。 */
export function coreRootCandidates(explicit) {
  const seen = new Set()
  const list = []
  for (const candidate of candidateRoots(explicit)) {
    if (!candidate) continue
    const root = resolve(candidate)
    if (seen.has(root)) continue
    seen.add(root)
    list.push({ root, ok: isCoreRoot(root) })
  }
  return list
}

/** 定位 dsh 核心目录：显式 --root / DSH_CORE_DIR 优先，其次插件所在目录链、dsh profile，最后全局安装位置。 */
export function resolveCoreRoot(explicit) {
  const seen = new Set()
  for (const candidate of candidateRoots(explicit)) {
    if (!candidate) continue
    const root = resolve(candidate)
    if (seen.has(root)) continue
    seen.add(root)
    if (isCoreRoot(root)) return root
  }
  return null
}

function targetPath(root, rel) {
  return join(root, rel)
}

function backupPath(root, rel) {
  const tag = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 10)
  return join(BACKUP_DIR, `${rel.replace(/[\\/]/g, '_')}.${tag}.orig`)
}

function backupMetaPath(root, rel) {
  return `${backupPath(root, rel)}.json`
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * 由源码判定核心代数。用 isReplaceOp 的校验表达式做特征：
 * 打补丁前后、两种补丁态下都稳定，不受跨代兼容代码影响。
 */
export function generationOfSource(source) {
  return source.includes(SEQ_MARKER) ? GEN_SEQ : GEN_LEGACY
}

/** 当前核心所属代数；定位失败返回 null。 */
export function coreGeneration(root = resolveCoreRoot()) {
  if (!root) return null
  try {
    return generationOfSource(readFileSync(targetPath(root, SESSION_REL), 'utf8'))
  } catch {
    return null
  }
}

/** 当前核心的 surface op 键名（插件运行时按此构造 replace op）。 */
export function surfaceOpKeys(root = resolveCoreRoot()) {
  return KEY_NAMES[coreGeneration(root) ?? GEN_LEGACY]
}

function variantState(source, variant) {
  if (variant.pairs.every((pair) => countOccurrences(source, pair.to) === 1)) return 'applied'
  const noTarget = variant.pairs.every((pair) => countOccurrences(source, pair.to) === 0)
  const eachSource = variant.pairs.every((pair) =>
    pair.from.some((candidate) => countOccurrences(source, candidate) === 1),
  )
  if (noTarget && eachSource) return 'absent'
  return 'drift'
}

/** 变体当前处于哪种来源态：原始（0）还是某个历史补丁态（>0）。 */
function matchedSourceIndex(source, variant) {
  const indexes = variant.pairs.map((pair) =>
    pair.from.findIndex((candidate) => countOccurrences(source, candidate) === 1),
  )
  if (indexes.some((index) => index < 0)) return -1
  return Math.max(...indexes)
}

function pickEditState(source, edit) {
  const evaluated = edit.variants.map((variant) => ({ variant, state: variantState(source, variant) }))
  const applied = evaluated.find((item) => item.state === 'applied')
  const absent = evaluated.find((item) => item.state === 'absent')
  const chosen = applied ?? absent ?? evaluated[0]
  return {
    id: edit.id,
    note: edit.note,
    state: chosen.state,
    gen: chosen.variant.gens.join('/'),
    upgrade: chosen.state === 'absent' ? matchedSourceIndex(source, chosen.variant) > 0 : false,
    oldCount: countOccurrences(source, chosen.variant.pairs[0].from[0]),
    newCount: countOccurrences(source, chosen.variant.pairs[0].to),
    variants: evaluated.map((item) => ({ gen: item.variant.gens.join('/'), state: item.state })),
  }
}

/** 每个文件的补丁状态：applied / absent / partial / drift。 */
export function patchStatus(root = resolveCoreRoot()) {
  if (!root) throw new Error('未定位到 dsh 核心目录，请用 --root 指定（含 node_modules/@deepseek-ai/dsh-session 的目录）')
  const files = []
  for (const rel of [SESSION_REL, AGENT_LOOP_REL]) {
    const path = targetPath(root, rel)
    const source = readFileSync(path, 'utf8')
    const edits = EDITS.filter((edit) => edit.file === rel).map((edit) => pickEditState(source, edit))
    const states = new Set(edits.map((edit) => edit.state))
    const state = states.size === 1 ? [...states][0] : 'partial'
    files.push({ rel, path, state, edits })
  }
  const generation = generationOfSource(readFileSync(targetPath(root, SESSION_REL), 'utf8'))
  const edits = files.flatMap((file) => file.edits)
  return {
    root,
    files,
    generation,
    applied: files.every((file) => file.state === 'applied'),
    // 补丁功能是否已生效：位点处于「已应用」或「历史补丁态」都算生效
    functional: edits.every((edit) => edit.state === 'applied' || (edit.state === 'absent' && edit.upgrade)),
    upgradable: edits.some((edit) => edit.upgrade),
  }
}

function syntaxCheck(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (result.status === 0) return { ok: true }
  const message = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim()
  // ESM 文件在某些 Node 版本下无法用 --check 解析，这类报错不算补丁失败
  if (/Cannot use import statement|Unexpected token 'export'|ERR_REQUIRE_ESM|outside a module/i.test(message)) {
    return { ok: true, skipped: true, message }
  }
  return { ok: false, message }
}

/** 应用补丁；返回 { changed, files, upgraded }。任一位点失配则整体拒绝。 */
export function applyPatches(root = resolveCoreRoot()) {
  if (!root) throw new Error('未定位到 dsh 核心目录，请用 --root 指定（含 node_modules/@deepseek-ai/dsh-session 的目录）')
  const generation = coreGeneration(root)
  const plan = []
  for (const rel of [SESSION_REL, AGENT_LOOP_REL]) {
    const path = targetPath(root, rel)
    const original = readFileSync(path, 'utf8')
    let next = original
    let changed = false
    let upgraded = false
    for (const edit of EDITS.filter((item) => item.file === rel)) {
      const state = pickEditState(next, edit)
      if (state.state === 'applied') continue
      if (state.state === 'drift') {
        const detail = state.variants.map((item) => `${item.gen}:${item.state}`).join(', ')
        throw new Error(
          `补丁位点不匹配（${edit.id}）：没有变体能在 ${rel} 中唯一匹配（${detail}）。` +
            '说明该核心版本的实现已变化（可能是新的核心代数）。请勿强行应用，先更新补丁定义。',
        )
      }
      const variant = edit.variants.find((item) => variantState(next, item) === 'absent')
      if (!variant) throw new Error(`补丁位点无可应用变体（${edit.id}）。`)
      if (matchedSourceIndex(next, variant) > 0) upgraded = true
      for (const pair of variant.pairs) {
        const source = pair.from.find((candidate) => countOccurrences(next, candidate) === 1)
        if (!source) {
          throw new Error(`补丁位点不唯一（${edit.id}）：在 ${rel} 中找不到唯一的现状文本。`)
        }
        next = next.replace(source, pair.to)
      }
      changed = true
    }
    plan.push({ rel, path, original, next, changed, upgraded })
  }
  const changedFiles = plan.filter((item) => item.changed)
  if (changedFiles.length === 0) {
    return { changed: false, generation, files: plan.map((item) => item.rel), upgraded: false }
  }

  mkdirSync(BACKUP_DIR, { recursive: true })
  for (const item of changedFiles) {
    const backup = backupPath(root, item.rel)
    const meta = backupMetaPath(root, item.rel)
    // 备份必须与当前核心同代：升级/降级核心后，异代备份不可用于还原
    let reuse = false
    if (existsSync(backup) && existsSync(meta)) {
      try {
        reuse = JSON.parse(readFileSync(meta, 'utf8')).generation === generation
      } catch {
        reuse = false
      }
    }
    if (!reuse) {
      copyFileSync(item.path, backup)
      writeFileSync(meta, JSON.stringify({ generation, createdAt: new Date().toISOString() }, null, 2))
    }
    writeFileSync(item.path, item.next)
    const check = syntaxCheck(item.path)
    if (!check.ok) {
      copyFileSync(backup, item.path)
      throw new Error(`补丁写入后语法校验失败，已回滚 ${item.rel}：${check.message}`)
    }
  }
  return {
    changed: true,
    generation,
    files: changedFiles.map((item) => item.rel),
    upgraded: changedFiles.some((item) => item.upgraded),
  }
}

/**
 * 备份是否真的能当当前文件的"前身"用：
 * 除了代数一致，还要求备份含有各位点的原始文本、且当前文件确实是这些位点的补丁态。
 * 这样即使同代数内跨了小版本（锚点文本已变），也不会把异版原文写回去。
 */
function backupMatchesSites(rel, backupText, currentText) {
  return EDITS.filter((edit) => edit.file === rel).every((edit) =>
    edit.variants.some((variant) =>
      variant.pairs.every(
        (pair) =>
          pair.from.some((candidate) => backupText.includes(candidate)) && currentText.includes(pair.to),
      ),
    ),
  )
}

/** 回退补丁：优先从同代备份恢复，否则反向替换。 */
export function revertPatches(root = resolveCoreRoot()) {
  if (!root) throw new Error('未定位到 dsh 核心目录，请用 --root 指定（含 node_modules/@deepseek-ai/dsh-session 的目录）')
  const generation = coreGeneration(root)
  let changed = false
  const files = []
  const skippedBackups = []
  for (const rel of [SESSION_REL, AGENT_LOOP_REL]) {
    const path = targetPath(root, rel)
    const backup = backupPath(root, rel)
    const meta = backupMetaPath(root, rel)
    const source = readFileSync(path, 'utf8')
    if (existsSync(backup)) {
      let compatible = generationOfSource(readFileSync(backup, 'utf8')) === generation
      if (existsSync(meta)) {
        try {
          compatible = JSON.parse(readFileSync(meta, 'utf8')).generation === generation
        } catch {
          /* 元数据损坏时退回内容判定 */
        }
      }
      if (compatible && backupMatchesSites(rel, readFileSync(backup, 'utf8'), source)) {
        const original = readFileSync(backup, 'utf8')
        if (source !== original) {
          writeFileSync(path, original)
          changed = true
        }
        files.push(rel)
        continue
      }
      // 备份属于另一代核心（升级/降级过），不可还原 —— 走反向替换
      skippedBackups.push(rel)
    }
    let next = source
    let touched = false
    for (const edit of EDITS.filter((item) => item.file === rel)) {
      if (pickEditState(next, edit).state !== 'applied') continue
      const variant = edit.variants.find((item) => variantState(next, item) === 'applied')
      for (const pair of variant.pairs) {
        if (countOccurrences(next, pair.to) !== 1) continue
        next = next.replace(pair.to, pair.from[0])
      }
      touched = true
    }
    if (touched) {
      writeFileSync(path, next)
      changed = true
      files.push(rel)
    }
  }
  return { changed, generation, files, skippedBackups }
}

function formatStatus(status) {
  const label = status.generation === GEN_SEQ ? 'seq（>= 0.1.5：surface op 用 startSeq/endSeq）' : 'legacy（<= 0.1.4：surface op 用 start/end）'
  const lines = [
    `dsh 核心目录：${status.root}`,
    `核心代数：${label}`,
    `整体状态：${status.applied ? (status.upgradable ? '已应用（有可升级位点）' : '已应用') : status.functional ? '已应用（旧补丁态，建议升级）' : '未应用/不完整'}`,
    '',
  ]
  for (const file of status.files) {
    lines.push(`· ${file.rel} → ${file.state}`)
    for (const edit of file.edits) {
      const variants = edit.variants.map((item) => `${item.gen}=${item.state}`).join(' ')
      const upgrade = edit.upgrade ? '（可从旧补丁态升级）' : ''
      lines.push(`    - [${edit.state}]${upgrade} ${edit.id}：${edit.note}  {${variants}}`)
    }
  }
  lines.push('', '提示：补丁写入磁盘后需重启 dsh GUI 进程才会加载。')
  return lines.join('\n')
}

function main(argv) {
  const args = argv.slice(2)
  const command = args.find((arg) => !arg.startsWith('-')) ?? 'status'
  const rootIndex = args.findIndex((arg) => arg === '--root')
  const explicitRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined
  const asJson = args.includes('--json')
  const root = resolveCoreRoot(explicitRoot)
  if (!root) {
    console.error('未定位到 dsh 核心目录：请用 --root <dsh 安装目录> 或设置 DSH_CORE_DIR（需包含 node_modules/@deepseek-ai/dsh-session 与 dsh-agent-loop）。')
    console.error('已探测的候选目录（均不满足条件）：')
    for (const item of coreRootCandidates(explicitRoot)) console.error(`  · ${item.root}`)
    process.exitCode = 1
    return
  }
  try {
    if (command === 'status') {
      const status = patchStatus(root)
      console.log(asJson ? JSON.stringify(status, null, 2) : formatStatus(status))
      return
    }
    if (command === 'where') {
      console.log(asJson ? JSON.stringify({ root }, null, 2) : root)
      return
    }
    if (command === 'apply') {
      const result = applyPatches(root)
      if (asJson) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      if (!result.changed) {
        console.log('核心补丁已处于应用状态，无需操作。')
        return
      }
      const upgraded = result.upgraded ? '\n（检测到旧版补丁，已就地升级到当前补丁定义。）' : ''
      console.log(
        `已应用核心补丁（${result.generation}）：\n${result.files.map((file) => `  · ${file}`).join('\n')}${upgraded}\n请重启 dsh GUI 后生效。`,
      )
      return
    }
    if (command === 'revert') {
      const result = revertPatches(root)
      const skipped = result.skippedBackups?.length
        ? `\n注意：${result.skippedBackups.join('、')} 的备份属于另一代核心，已改用反向替换，未使用备份。`
        : ''
      if (asJson) {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      console.log(
        result.changed
          ? `已回退核心补丁：\n${result.files.map((file) => `  · ${file}`).join('\n')}\n请重启 dsh GUI 后生效。${skipped}`
          : `核心补丁未应用，无需回退。${skipped}`,
      )
      return
    }
    console.error(`未知命令：${command}（可用：where / status / apply / revert）`)
    process.exitCode = 1
  } catch (error) {
    console.error(`补丁操作失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv)
}
