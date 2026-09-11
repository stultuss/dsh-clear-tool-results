// DSH 宿主插件：按轮归档并清除工具结果。
// 启用时（默认，普通模式 round）：
//   1. 每轮结束，将该轮原始 tool/result 事件（来自追加式会话日志，未被改写）
//      归档到会话目录 tool-result-logs/round-NNNN.json（附 index.json 清单）；
//   2. 将已结束轮次的工具结果显示替换为占位符（注明轮次，提示 read_tool_result_log）；
//   3. 注册 read_tool_result_log 工具，模型可按轮次（可精确到 step）或时间读取归档。
// overclock 模式（激进）：在同一轮内按 step 滞后一步清除——
//   第 N 步结果仅对第 N+1 步的决策可见；第 N+1 步 step/end 时把第 N 步替换为占位符，
//   并把刚结束的 step 归档为 round-NNNN-step-MMM.json（附 index.json steps 清单），
//   需要更早步骤时模型用 read_tool_result_log(turn, step) 自行取回。
// 命令：/clear-tool-results on|off|status|overclock；状态存于 $DSH_HOME/clear-tool-results.json。
// 时机：DSH 在 turn/start 后同步组装 prompt，且 append 有重入保护，
// 故普通模式清除在上一轮 turn/end 执行；overclock 在 step/end 事件后、下一步
// prompt 组装前（queueMicrotask + 先清除后异步归档）执行。
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-clear-tool-results'
export const inject = ['commands', 'tools', 'sessionPersistence']

/** 本份代码的版本（/clear-tool-results status 显示，用于确认加载的是哪一份构建）。 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '未知'
  } catch {
    return '未知'
  }
})()

const TOOL_RESULT = 'tool/result'
const TOOL_CALL = 'tool/call'
const TURN_END = 'turn/end'
const TURN_START = 'turn/start'
const STEP_END = 'step/end'
const MODE_ROUND = 'round'
const MODE_OVERCLOCK = 'overclock'
const SCHEMA_VERSION = 2
const MODE_LABEL = {
  [MODE_ROUND]: '普通模式（每轮结束清除）',
  [MODE_OVERCLOCK]: 'overclock（每步清除，滞后一步）',
}
const UNKNOWN_TOOL = 'unknown_tool'
const LOG_DIR_NAME = 'tool-result-logs'
const INDEX_FILE = 'index.json'
const STATE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'clear-tool-results.json')
const SESSIONS_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
/** 告警日志（只在异常路径写）。 */
const WARN_LOG_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'clear-tool-results.log')

/** 载入核心补丁管理器（与本插件同仓库）；不可用时返回 null。 */
async function loadPatchManager() {
  try {
    return await import(new URL('./patches/patch-core.mjs', import.meta.url).href)
  } catch {
    return null
  }
}

/** overclock 需要核心补丁，round/off 不需要；返回可拼进命令回复的一行说明。 */
async function syncCorePatch(action) {
  const manager = await loadPatchManager()
  if (!manager) return '（未找到补丁管理器 patches/patch-core.mjs，可手动运行 npm run patch:apply）'
  try {
    const root = manager.resolveCoreRoot()
    if (!root) return '（未定位到 dsh 核心目录，可手动运行 npm run patch:apply -- --root <dsh 目录>）'
    // 顺带校准 surface op 键名：>= 0.1.5 的核心要求 startSeq/endSeq
    rememberOpKeys(manager.surfaceOpKeys?.(root))
    if (action === 'apply') {
      const result = manager.applyPatches(root)
      return result.changed ? '；核心补丁已应用，重启 dsh GUI 后生效' : '；核心补丁已处于应用状态'
    }
    const result = manager.revertPatches(root)
    return result.changed ? '；核心补丁已回退，重启 dsh GUI 后生效' : '；核心补丁未应用，无需回退'
  } catch (error) {
    return `（补丁操作失败：${String(error?.message ?? error)}；可手动运行 npm run patch:apply 或 patch:revert）`
  }
}

/** 载入时按核心源码校准 surface op 键名；校准失败时按会话头版本兜底（见 preferredOpKeys）。 */
async function calibrateSurfaceOpKeys() {
  const manager = await loadPatchManager()
  if (!manager?.surfaceOpKeys) return
  try {
    rememberOpKeys(manager.surfaceOpKeys())
  } catch {
    // 未定位到核心目录：保持未校准，写入时按会话头版本选择拼写
  }
}

/** status 命令用的补丁状态行。 */
async function corePatchStatusLine() {
  const manager = await loadPatchManager()
  if (!manager) return '\n核心补丁：未知（未找到 patches/patch-core.mjs）'
  try {
    const root = manager.resolveCoreRoot()
    if (!root) return '\n核心补丁：未知（未定位到 dsh 核心目录）'
    const status = manager.patchStatus(root)
    const label = status.applied
      ? (status.upgradable ? '已应用（有可升级位点）' : '已应用')
      : status.functional
        ? '已应用（旧补丁态，建议升级）'
        : status.files.every((file) => file.state === 'absent') ? '未应用' : '不完整'
    const detail = status.files
      .map((file) => `${file.rel.includes('agent-loop') ? 'agent-loop' : 'session'}=${file.state}`)
      .join(' ')
    const hint = status.functional ? '' : '；overclock 模式建议应用补丁（命令会自动处理）'
    return `\n核心补丁：${label}（${detail}）${hint}`
  } catch (error) {
    return `\n核心补丁：检测失败（${String(error?.message ?? error)}）`
  }
}

/**
 * 插件告警：既交给 ctx.logger，也追加到 $DSH_HOME/clear-tool-results.log。
 * 宿主默认不把 logger 写到任何可读文件，清除失败就完全看不见——排查时无据可查，
 * 所以这里自己落一份（只在异常路径写，正常路径不产生任何 I/O）。
 */
/** 追踪一行（清除决策链路的每一步），与告警写同一个文件，便于一次复现就定位。 */
function trace(message) {
  try {
    appendFileSync(WARN_LOG_FILE, `${new Date().toISOString()} [trace] ${message}\n`, 'utf8')
  } catch {
    // 追踪失败不影响主流程
  }
}

function warn(ctx, message) {
  const line = `${new Date().toISOString()} ${message}`
  try {
    ctx?.logger?.warn?.('dsh-clear-tool-results: ' + message)
  } catch {
    // logger 不可用时只写文件
  }
  try {
    appendFileSync(WARN_LOG_FILE, line + '\n', 'utf8')
  } catch {
    // 日志写入失败不影响主流程
  }
}

export function apply(ctx) {
  const disposers = []
  // 载入即校准 surface op 键名（<=0.1.4 → start/end，>=0.1.5 → startSeq/endSeq）
  calibrateSurfaceOpKeys().catch(() => {})
  disposers.push(ctx.commands.register({
    name: 'clear-tool-results',
    description: '工具结果归档并清除开关：普通模式每轮结束归档并清除；overclock 模式在同一轮内逐步归档并滞后一步清除，需更早结果时模型可 read_tool_result_log(turn, step) 取回。用法：/clear-tool-results on|off|status|overclock',
    input: { hint: 'on|off|status|overclock' },
    recordInput: false,
    handler: async ({ rawInput, agent }) => {
      const arg = rawInput.trim().toLowerCase()
      if (arg === 'on') {
        const patchNote = await syncCorePatch('revert')
        await writeState({ enabled: true, mode: MODE_ROUND })
        if (agent?.session) {
          queueMicrotask(() => {
            enableNow(ctx, agent.session).catch((error) => warn(ctx, String(error)))
          })
        }
        return { kind: 'success', text: '已启用（普通模式）：工具结果按轮归档，并在下一轮开始前从对话清除' + patchNote }
      }
      if (arg === 'overclock') {
        const patchNote = await syncCorePatch('apply')
        await writeState({ enabled: true, mode: MODE_OVERCLOCK })
        if (agent?.session) {
          queueMicrotask(() => {
            enableNow(ctx, agent.session).catch((error) => warn(ctx, String(error)))
          })
        }
        return { kind: 'success', text: '已启用（overclock 模式）：每一步工具结果归档后滞后一步清除，更早步骤需 read_tool_result_log(turn, step) 取回' + patchNote }
      }
      if (arg === 'off') {
        const patchNote = await syncCorePatch('revert')
        const state = await readState()
        await writeState({ enabled: false, mode: state.mode })
        return { kind: 'success', text: '已禁用：工具结果保留在对话中，不再归档' + patchNote }
      }
      if (arg === 'status') {
        const state = await readState()
        const modeText = MODE_LABEL[state.mode] ?? MODE_LABEL[MODE_ROUND]
        const text = state.enabled
          ? `当前状态：已启用（${modeText}）`
          : `当前状态：已禁用（上次模式：${modeText}）`
        return { kind: 'success', text: text + (await corePatchStatusLine()) + `\n插件版本：${PLUGIN_VERSION}` }
      }
      return { kind: 'error', text: '用法：/clear-tool-results on|off|status|overclock' }
    },
  }))
  disposers.push(ctx.on('session/event', (session, event) => {
    if (event.type === TURN_END) {
      const endedTurn = event.data.turn
      queueMicrotask(() => {
        onTurnEnd(ctx, session, endedTurn).catch((error) => warn(ctx, String(error)))
      })
    } else if (event.type === TURN_START) {
      const turn = event.data.turn
      queueMicrotask(() => {
        onTurnStart(ctx, session, turn).catch((error) => warn(ctx, String(error)))
      })
    } else if (event.type === STEP_END) {
      const turn = event.data.turn
      const step = event.data.step
      queueMicrotask(() => {
        onStepEnd(ctx, session, turn, step).catch((error) => warn(ctx, String(error)))
      })
    }
  }))
  disposers.push(ctx.tools.register(readToolResultLogTool(ctx)))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// ---------------------------------------------------------------------------
// 轮次/步骤生命周期：turn/end、turn/start、step/end、中途启用
// ---------------------------------------------------------------------------

async function onTurnEnd(ctx, session, endedTurn) {
  if (!(await readEnabled())) return
  const logsDir = logsDirOf(ctx, session)
  try {
    await enqueue(session.id, async () => {
      // 补归档之前未归档的轮次（插件关闭/重启期间）
      if (typeof endedTurn === 'number') await archiveUnarchived(session, endedTurn - 1, logsDir)
      // 刷新刚结束的轮次，保证归档完整
      if (typeof endedTurn === 'number') await archiveTurn(session, endedTurn, logsDir, true)
    })
  } catch (error) {
    // 归档失败不能连带跳过清除：否则工具结果会一直留在上下文里（0.1.5 上曾整轮不生效）
    warn(ctx, '轮末归档失败 ' + String(error))
  }
  // 普通模式清除整轮；overclock 也在此兜底清除该轮最后剩余步骤
  try {
    const cleared = clearCompletedToolResults(session, endedTurn)
    trace(`turn/end turn=${endedTurn} 清除 ${cleared?.cleared ?? '?'} 条（surface 节点 ${session.surface.nodes.length}）`)
  } catch (error) {
    warn(ctx, '轮末清除失败 ' + String(error))
  }
}

/** 记录每个会话在上一次 turn/start 时看到的系列代次，用于补齐缺失的每轮边界。 */
const lastSeriesGeneration = new WeakMap()

async function onTurnStart(ctx, session, turn) {
  // 先做同步兜底（不 await，尽量赶在首条请求组装之前），再进入需要异步读盘的归档流程。
  // overclock 需要每轮恰好一次系列边界：若上一轮结束时没有产生边界（空轮、被中断的轮），
  // 在这里补一次内容不变的替换。仅当核心补丁提供 seriesGeneration 时启用，
  // 否则旧核心会把这次替换当成新系列，重新造成每步重复展示。
  // 插件已关闭时不再产生任何写入。
  const state = readStateSync()
  if (state.enabled && state.mode === MODE_OVERCLOCK && supportsSeriesGeneration(session)) {
    const generation = session.surface.seriesGeneration
    try {
      if (lastSeriesGeneration.get(session) === generation) nudgeSeries(session, turn)
    } catch (error) {
      warn(ctx, '轮首系列边界替换失败 ' + String(error?.message ?? error))
    }
    lastSeriesGeneration.set(session, session.surface.seriesGeneration)
  }
  if (!(await readEnabled())) return
  const logsDir = logsDirOf(ctx, session)
  await enqueue(session.id, async () => {
    if (typeof turn === 'number') await archiveUnarchived(session, turn, logsDir)
  })
}

/**
 * overclock 模式的 step/end 处理：
 *   1. 先把上一步（step - 1）的工具结果替换为占位符——必须同步、先于任何 I/O 完成，
 *      保证下一步 prompt 组装（deriveMessages）时该步结果已不可见；
 *   2. 再把刚结束的这一步归档为 round-NNNN-step-MMM.json，供本轮中途自主读取。
 */
async function onStepEnd(ctx, session, turn, step) {
  // 时机敏感：同步读取缓存状态，先清除上一步，之后才允许异步磁盘归档
  const state = readStateSync()
  if (!state.enabled || state.mode !== MODE_OVERCLOCK) {
    trace(`step/end turn=${turn} step=${step} 跳过（enabled=${state.enabled} mode=${state.mode}）`)
    return
  }
  if (typeof turn !== 'number' || typeof step !== 'number') return
  try {
    const { cleared, matched } = clearStepToolResults(session, turn, step - 1)
    trace(`step/end turn=${turn} step=${step}：清除 step=${step - 1} 候选 ${matched} / 已清 ${cleared}（surface 节点 ${session.surface.nodes.length}）`)
  } catch (error) {
    // 清除失败不能拖垮归档：否则一个被拒绝的 replace 会让之后每一步都不再归档
    warn(ctx, '逐步清除失败 ' + String(error))
  }
  const logsDir = logsDirOf(ctx, session)
  await enqueue(session.id, async () => {
    await archiveStep(session, turn, step, logsDir)
  })
}

async function enableNow(ctx, session) {
  const logsDir = logsDirOf(ctx, session)
  const openTurn = currentOpenTurn(session)
  try {
    await enqueue(session.id, async () => {
      await archiveUnarchived(session, Number.MAX_SAFE_INTEGER, logsDir)
      if (openTurn !== null) await archiveTurn(session, openTurn, logsDir, true)
    })
  } catch (error) {
    warn(ctx, '启用时归档失败 ' + String(error))
  }
  try {
    if (openTurn === null) {
      clearCompletedToolResults(session, Number.MAX_SAFE_INTEGER)
    } else {
      clearCompletedToolResults(session, openTurn - 1)
    }
  } catch (error) {
    warn(ctx, '启用时清除失败 ' + String(error))
  }
}

/**
 * 兼容新旧 dsh 核心的事件数组：新核心暴露 session.log，旧核心暴露 session.events。
 */
function eventsOf(session) {
  return Array.isArray(session.log) ? session.log : session.events
}

/** 当前进行中的轮次；无则返回 null。 */
function currentOpenTurn(session) {
  let start = null
  let end = null
  for (const event of eventsOf(session)) {
    if (event.type === TURN_START) start = event.data?.turn ?? start
    else if (event.type === TURN_END) end = event.data?.turn ?? end
  }
  return start !== null && (end === null || end < start) ? start : null
}

/**
 * 将满足条件的 tool/result surface 节点替换为占位符。
 * 已是替换结果（surfaceOp !== 'append'）的节点跳过；幂等。
 * 本函数只做「内容清除」：内容被改写的单节点 tool/result 替换会被核心判定为清除型，
 * 不开启新系列，否则 Chat 界面会为每条被清除的结果渲染一次系统提示词 ——
 * 一次批量清除（启用插件、轮末清除）能瞬间产生上百个系列，直接把前端拖死。
 */
/** overclock：每轮仅注入一次"可见性规则"扩展占位符，键为 `${sessionId}:${turn}`。 */
const extendedHintRounds = new Set()

function clearToolResultsWhere(session, matches) {
  const nodes = [...session.surface.nodes]
  const overclock = readStateSync().mode === MODE_OVERCLOCK
  const hintedThisCall = new Set()
  let cleared = 0
  let matched = 0
  let skippedNotAppend = 0
  let skippedWrongType = 0
  for (const seq of nodes) {
    const original = eventsOf(session)[seq]
    if (!original || original.type !== TOOL_RESULT) {
      skippedWrongType += 1
      continue
    }
    if (original.surfaceOp !== 'append') {
      skippedNotAppend += 1
      continue
    }
    const data = original.data
    if (!matches(data)) continue
    matched += 1
    const turn = data?.turn
    const step = data?.step
    const key = overclock && typeof turn === 'number' ? `${session.id}:${turn}` : null
    const extended =
      key !== null &&
      typeof step === 'number' &&
      !extendedHintRounds.has(key) &&
      !hintedThisCall.has(key)
    if (extended) {
      extendedHintRounds.add(key)
      hintedThisCall.add(key)
    }
    // 逐条独立：某一条目标已不在 surface（被别的 replace/压缩遮蔽）时只跳过这一条，
    // 不影响本次其余清除，也不把异常抛给调用方（逐步清除后仍要归档、轮末仍要收尾）。
    try {
      replaceToolResult(session, seq, data, clearedText(turn, step, extended))
      cleared += 1
    } catch (error) {
      warn(null, `清除失败（目标 seq ${seq} 已不在 surface 或写入被拒）：${String(error?.message ?? error)}`)
    }
  }
  if (matched !== cleared || skippedWrongType > 0) {
    trace(`清除统计：候选 ${matched}、已清 ${cleared}、非 append 跳过 ${skippedNotAppend}、取不到事件 ${skippedWrongType}`)
  }
  return { cleared, matched }
}

/** 将轮次 <= untilTurn 的 tool/result 节点替换为占位符。 */
function clearCompletedToolResults(session, untilTurn) {
  const { cleared } = clearToolResultsWhere(session, (data) => typeof data?.turn === 'number' && data.turn <= untilTurn)
  // 清除型替换不再开启新系列（核心按「内容被改写」判定），所以每轮结束时补一次内容不变的替换，
  // 作为该轮唯一的系列边界（Chat 每轮展示一次系统提示词）。
  // 普通模式下没有任何可清除结果时保持旧行为（不产生边界）。
  if (cleared > 0 || readStateSync().mode === MODE_OVERCLOCK) {
    const before = supportsSeriesGeneration(session) ? session.surface.seriesGeneration : undefined
    try {
      const nudged = nudgeSeries(session, untilTurn)
      trace(`系列边界：${nudged ? '已写入 1 次内容不变的替换' : '没有可用节点，跳过'}`)
      // 边界替换必须做到「内容与原节点逐字节相同」，核心才会把它算作新系列。
      // 一旦目标的占位文本与原文不同，核心会把它当成清除型替换，本轮就没有边界了。
      if (nudged && before !== undefined && session.surface.seriesGeneration === before) {
        warn(null, '系列边界未生效：核心把这次替换判成了内容清除（替换内容与原文不一致）')
      }
    } catch (error) {
      warn(null, '系列边界替换失败 ' + String(error?.message ?? error))
    }
  }
  return { cleared }
}

/** overclock：将第 turn 轮第 step 步的工具结果替换为占位符（清除型，不开启新系列）。 */
function clearStepToolResults(session, turn, step) {
  return clearToolResultsWhere(session, (data) => data?.turn === turn && data?.step === step)
}

/**
 * 内容不变地替换一个 tool/result，用于制造一次系列边界。
 * 优先取本轮最后一个；本轮没有工具结果（空轮、被中断的轮）时退化为会话里最近的一条：
 * 内容不变地替换不改变历史展示，但同样只产生一次系列边界。
 */
function nudgeSeries(session, turn) {
  const events = eventsOf(session)
  const nodes = [...session.surface.nodes]
  let fallbackSeq = -1
  let fallbackEvent = null
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    const event = events[seq]
    if (!event || event.type !== TOOL_RESULT) continue
    if (event.data?.turn === turn) {
      replaceToolResult(session, seq, event.data, placeholderTextOf(event.data.message))
      return true
    }
    if (fallbackEvent === null) {
      fallbackSeq = seq
      fallbackEvent = event
    }
  }
  if (fallbackEvent !== null) {
    replaceToolResult(session, fallbackSeq, fallbackEvent.data, placeholderTextOf(fallbackEvent.data.message))
    return true
  }
  return false
}

/** 从占位符消息里取出纯文本，保证 nudgeSeries 的替换内容与现状一致。 */
function placeholderTextOf(message) {
  const first = message?.content?.[0]
  if (!first) return ''
  if (first.type === 'text') return first.text ?? ''
  const inner = first.content?.[0]
  return inner?.text ?? ''
}

function clearedText(turn, step, extended) {
  const core =
    typeof turn === 'number' && typeof step === 'number'
      ? `[第 ${turn} 轮 第 ${step} 步工具结果已清除归档，可用 read_tool_result_log(turn: ${turn}, step: ${step}) 读取]`
      : typeof turn === 'number'
        ? `[第 ${turn} 轮工具结果已清除归档，可用 read_tool_result_log(turn: ${turn}) 读取]`
        : '[工具结果已清除归档，可用 read_tool_result_log 读取]'
  if (!extended || typeof turn !== 'number') return core
  const stepPart =
    typeof step === 'number'
      ? `；确实需要精确原文时，请恰好在使用它的那一步之前用 read_tool_result_log(turn: ${turn}, step: ${step}) 取回`
      : ''
  return `[第 ${turn} 轮工具结果已清除归档。可见性规则（overclock）：某一步的工具结果仅在紧随其后的下一步决策中可见，取回内容同样如此${stepPart}；若总结需引用多步内容，可在总结前用 read_tool_result_log(turn: ${turn}) 整轮取回一次。]`
}

// ---------------------------------------------------------------------------
// 归档：每轮一个 JSON 文件（原始事件），附 index.json 清单；幂等
// ---------------------------------------------------------------------------

/** 按会话串行化归档写操作，避免 index.json 读写竞争。 */
const archiveQueues = new Map()
function enqueue(sessionId, task) {
  const previous = archiveQueues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  archiveQueues.set(sessionId, next.then(() => {}, () => {}))
  return next
}

/** 归档所有未归档且轮次 <= maxTurn 且有工具结果的轮次。 */
async function archiveUnarchived(session, maxTurn, logsDir) {
  const index = await readIndex(logsDir)
  const archived = new Set((index?.rounds ?? []).map((round) => round.turn))
  const turns = new Set()
  for (const event of eventsOf(session)) {
    if (event.type !== TOOL_RESULT || event.surfaceOp !== 'append') continue
    const turn = event.data?.turn
    if (typeof turn === 'number' && turn <= maxTurn) turns.add(turn)
  }
  for (const turn of [...turns].sort((a, b) => a - b)) {
    if (archived.has(turn)) continue
    await archiveTurn(session, turn, logsDir, false)
  }
}

/** 写入（或刷新）某轮归档文件并更新 index。 */
async function archiveTurn(session, turn, logsDir, overwrite) {
  const index = await readIndex(logsDir)
  if (!overwrite && index?.rounds.some((round) => round.turn === turn)) return
  const { nameByCallId, callByCallId } = callIndex(session)
  const entries = []
  for (const event of eventsOf(session)) {
    if (event.type !== TOOL_RESULT || event.surfaceOp !== 'append') continue
    if (event.data?.turn !== turn) continue
    entries.push(entryOf(event, nameByCallId, callByCallId))
  }
  if (entries.length === 0) return
  const fileName = roundFileName(turn)
  await mkdir(logsDir, { recursive: true })
  await writeFile(join(logsDir, fileName), JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.id,
    workspace: session.header.cwd ?? null,
    turn,
    timeFrom: entries[0].event.time,
    timeTo: entries[entries.length - 1].event.time,
    toolResults: entries,
  }, null, 2), 'utf8')
  const next = index ?? emptyIndex(session)
  const steps = distinctStepsOf(entries)
  const round = {
    turn,
    file: fileName,
    timeFrom: entries[0].event.time,
    timeTo: entries[entries.length - 1].event.time,
    count: entries.length,
    tools: [...new Set(entries.map((entry) => entry.toolName))],
  }
  if (steps.length > 0) round.stepCount = steps.length
  const existing = next.rounds.findIndex((candidate) => candidate.turn === turn)
  if (existing >= 0) next.rounds[existing] = round
  else next.rounds.push(round)
  next.rounds.sort((a, b) => a.turn - b.turn)
  next.updatedAt = Date.now()
  await writeFile(join(logsDir, INDEX_FILE), JSON.stringify(next, null, 2), 'utf8')
}

/** overclock：把第 turn 轮第 step 步归档为 round-NNNN-step-MMM.json 并更新 index.steps。 */
async function archiveStep(session, turn, step, logsDir) {
  if (typeof turn !== 'number' || typeof step !== 'number') return
  const { nameByCallId, callByCallId } = callIndex(session)
  const entries = []
  for (const event of eventsOf(session)) {
    if (event.type !== TOOL_RESULT || event.surfaceOp !== 'append') continue
    if (event.data?.turn !== turn || event.data?.step !== step) continue
    entries.push(entryOf(event, nameByCallId, callByCallId))
  }
  if (entries.length === 0) return
  const index = await readIndex(logsDir)
  const next = index ?? emptyIndex(session)
  const fileName = stepFileName(turn, step)
  await mkdir(logsDir, { recursive: true })
  await writeFile(join(logsDir, fileName), JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.id,
    workspace: session.header.cwd ?? null,
    turn,
    step,
    timeFrom: entries[0].event.time,
    timeTo: entries[entries.length - 1].event.time,
    toolResults: entries,
  }, null, 2), 'utf8')
  const summary = {
    turn,
    step,
    file: fileName,
    timeFrom: entries[0].event.time,
    timeTo: entries[entries.length - 1].event.time,
    count: entries.length,
    tools: [...new Set(entries.map((entry) => entry.toolName))],
  }
  const steps = Array.isArray(next.steps) ? next.steps : []
  const existing = steps.findIndex((candidate) => candidate.turn === turn && candidate.step === step)
  if (existing >= 0) steps[existing] = summary
  else steps.push(summary)
  steps.sort((a, b) => a.turn - b.turn || a.step - b.step)
  next.steps = steps
  next.updatedAt = Date.now()
  await writeFile(join(logsDir, INDEX_FILE), JSON.stringify(next, null, 2), 'utf8')
}

function entryOf(event, nameByCallId, callByCallId) {
  const data = event.data
  const callId = data?.message?.source?.callId
  const turn = typeof data?.turn === 'number' ? data.turn : null
  const step = typeof data?.step === 'number' ? data.step : null
  return {
    seq: event.seq,
    time: event.time,
    turn,
    step,
    callId: callId ?? null,
    toolName: toolNameOf(data, nameByCallId),
    call: typeof callId === 'string' ? callByCallId.get(callId) ?? null : null,
    // 原始事件：type/seq/time/data/surfaceOp，message 内容原样，非清除副本
    event,
  }
}

/** callId -> 工具名 / tool/call 事件（遍历完整日志）。 */
function callIndex(session) {
  const nameByCallId = new Map()
  const callByCallId = new Map()
  for (const event of eventsOf(session)) {
    if (event.type !== TOOL_CALL) continue
    if (typeof event.data?.callId !== 'string') continue
    callByCallId.set(event.data.callId, event)
    if (typeof event.data.name === 'string') nameByCallId.set(event.data.callId, event.data.name)
  }
  return { nameByCallId, callByCallId }
}

async function readIndex(logsDir) {
  try {
    const parsed = JSON.parse(await readFile(join(logsDir, INDEX_FILE), 'utf8'))
    if (parsed && Array.isArray(parsed.rounds)) return parsed
  } catch {
    // 尚无 index
  }
  return null
}

function emptyIndex(session) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.id,
    workspace: session.header.cwd ?? null,
    updatedAt: Date.now(),
    rounds: [],
    steps: [],
  }
}

function roundFileName(turn) {
  return `round-${String(turn).padStart(4, '0')}.json`
}

function stepFileName(turn, step) {
  return `round-${String(turn).padStart(4, '0')}-step-${String(step).padStart(4, '0')}.json`
}

/** 从某轮条目中取出去重后的步骤号（老核心无 step 字段时为空）。 */
function distinctStepsOf(entries) {
  const steps = [...new Set(entries.map((entry) => entry.step).filter((step) => step !== null))]
  return steps.sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// read_tool_result_log：模型读取历史归档的工具结果
// ---------------------------------------------------------------------------

function readToolResultLogTool(ctx) {
  return {
    name: 'read_tool_result_log',
    description: '读取被清理工具结果的原始数据（每轮归档到会话 tool-result-logs；overclock 模式下每步也归档）。当占位符或任务需要某步输出时调用：传 turn（轮次号）+ step（步骤号，1 起，一次模型决策为一步）可精确读取该步；只传 turn 读取整轮；传 time（ISO 8601 或毫秒时间戳）读取该时刻所在轮；都不传则返回已归档轮次列表。overclock 模式提醒：取回内容同样只存活一步，请取回后立即使用；若总结需引用多步原文，建议在总结前按轮整轮取回一次，避免中途反复小取回。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turn: {
          type: 'integer',
          description: '对话轮次编号（1 起），如 turn: 3 读取第 3 轮。用户指明轮次时优先使用。',
        },
        step: {
          type: 'integer',
          description: '步骤编号（1 起，一次模型决策即一步），需配合 turn 使用，如 turn: 3, step: 2 读取第 3 轮第 2 步。占位符注明 turn/step 时优先按此精确读取。',
        },
        time: {
          type: 'string',
          description: 'ISO 8601 时间（如 2026-08-26T10:00:00+08:00）或毫秒时间戳，读取该时刻所在轮次。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note: { type: 'string' },
          sessionId: { type: 'string' },
          workspace: { type: 'string' },
          query: { type: 'string' },
          turn: { type: 'integer' },
          step: { type: 'integer' },
          timeFrom: { type: 'number' },
          timeTo: { type: 'number' },
          toolResults: { type: 'array', items: {} },
          rounds: { type: 'array', items: {} },
          steps: { type: 'array', items: {} },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) return { error: '无可用会话上下文' }
      const logsDir = logsDirOf(ctx, session)
      let result
      try {
        if (typeof args.turn === 'number' && typeof args.step === 'number') {
          result = await readByStep(session, logsDir, args.turn, args.step)
        } else if (typeof args.step === 'number') {
          result = { error: 'step 需配合 turn 使用，如 read_tool_result_log({ turn: 3, step: 2 })' }
        } else if (typeof args.turn === 'number') {
          result = await readByTurn(session, logsDir, args.turn)
        } else if (typeof args.time === 'string') {
          result = await readByTime(session, logsDir, args.time)
        } else {
          result = await listRounds(session, logsDir)
        }
      } catch (error) {
        return { error: '读取工具结果日志失败：' + (error instanceof Error ? error.message : String(error)) }
      }
      if (
        result &&
        typeof result === 'object' &&
        !result.error &&
        Array.isArray(result.toolResults) &&
        result.toolResults.length > 0
      ) {
        result.note =
          '取回提示（overclock）：归档内容同样只在紧随其后的下一步决策中可见，请立即使用；若总结需引用多步原文，建议总结前按轮整轮取回一次。'
      }
      return result
    },
  }
}

/** 读取整轮归档：合并 round-NNNN.json 与该轮 step 文件（按 seq 去重，兼容轮次进行中）。 */
async function readByTurn(session, logsDir, turn) {
  if (!Number.isInteger(turn) || turn < 1) {
    return { error: '轮次编号必须为正整数' }
  }
  const data = await collectTurnData(session, logsDir, turn)
  if (!data) {
    const rounds = (await readIndex(logsDir))?.rounds ?? []
    return {
      sessionId: session.id,
      workspace: session.header.cwd ?? null,
      query: `第 ${turn} 轮`,
      error: `第 ${turn} 轮没有归档的工具结果（已归档轮次：${rounds.map((round) => round.turn).join(', ') || '无'}）`,
      rounds: rounds.slice(-20),
    }
  }
  return {
    sessionId: data.sessionId ?? session.id,
    workspace: data.workspace ?? session.header.cwd ?? null,
    query: `第 ${turn} 轮`,
    turn: data.turn,
    timeFrom: data.timeFrom,
    timeTo: data.timeTo,
    toolResults: data.toolResults ?? [],
  }
}

/** 读取第 turn 轮第 step 步：优先 step 文件，老数据回退到整轮文件过滤。 */
async function readByStep(session, logsDir, turn, step) {
  if (!Number.isInteger(turn) || turn < 1) return { error: '轮次编号必须为正整数' }
  if (!Number.isInteger(step) || step < 1) return { error: '步骤编号必须为正整数' }
  let data = null
  try {
    data = JSON.parse(await readFile(join(logsDir, stepFileName(turn, step)), 'utf8'))
  } catch {
    // step 文件不存在：普通模式/老数据只有整轮文件
  }
  let toolResults = []
  if (data) {
    toolResults = data.toolResults ?? []
  } else {
    const whole = await readByTurn(session, logsDir, turn)
    if (!whole.error) {
      toolResults = (whole.toolResults ?? []).filter((entry) => stepOfEntry(entry) === step)
    } else {
      const steps = (await readIndex(logsDir))?.steps ?? []
      const available = steps
        .filter((candidate) => candidate.turn === turn)
        .map((candidate) => candidate.step)
      return {
        sessionId: session.id,
        workspace: session.header.cwd ?? null,
        query: `第 ${turn} 轮 第 ${step} 步`,
        error: `第 ${turn} 轮第 ${step} 步没有归档的工具结果（该轮已归档步骤：${available.join(', ') || '无'}）`,
        steps: steps.slice(-50),
      }
    }
  }
  if (toolResults.length === 0) {
    return {
      sessionId: data?.sessionId ?? session.id,
      workspace: data?.workspace ?? session.header.cwd ?? null,
      query: `第 ${turn} 轮 第 ${step} 步`,
      turn,
      step,
      error: `第 ${turn} 轮第 ${step} 步没有工具结果`,
      toolResults: [],
    }
  }
  return {
    sessionId: data?.sessionId ?? session.id,
    workspace: data?.workspace ?? session.header.cwd ?? null,
    query: `第 ${turn} 轮 第 ${step} 步`,
    turn,
    step,
    timeFrom: toolResults[0]?.time ?? data?.timeFrom,
    timeTo: toolResults[toolResults.length - 1]?.time ?? data?.timeTo,
    toolResults,
  }
}

/** 合并某轮所有归档来源：round-NNNN.json + round-NNNN-step-MMM.json，按 seq 去重排序。 */
async function collectTurnData(session, logsDir, turn) {
  const bySeq = new Map()
  let sessionId = null
  let workspace = null
  try {
    const aggregate = JSON.parse(await readFile(join(logsDir, roundFileName(turn)), 'utf8'))
    sessionId = aggregate.sessionId
    workspace = aggregate.workspace
    for (const entry of aggregate.toolResults ?? []) {
      if (typeof entry?.seq === 'number') bySeq.set(entry.seq, entry)
    }
  } catch {
    // 无整轮文件：可能只有 step 文件（轮次进行中）
  }
  const prefix = `round-${String(turn).padStart(4, '0')}-step-`
  let files = []
  try {
    files = (await readdir(logsDir))
      .filter((file) => file.startsWith(prefix) && file.endsWith('.json'))
      .sort()
  } catch {
    files = []
  }
  for (const file of files) {
    try {
      const chunk = JSON.parse(await readFile(join(logsDir, file), 'utf8'))
      sessionId ??= chunk.sessionId
      workspace ??= chunk.workspace
      for (const entry of chunk.toolResults ?? []) {
        if (typeof entry?.seq === 'number') bySeq.set(entry.seq, entry)
      }
    } catch {
      // 跳过损坏/半写的 step 文件
    }
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  if (entries.length === 0) return null
  const times = entries.map((entry) => entry.time).filter((time) => typeof time === 'number').sort((a, b) => a - b)
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: sessionId ?? session.id,
    workspace: workspace ?? session.header.cwd ?? null,
    turn,
    timeFrom: times[0],
    timeTo: times[times.length - 1],
    toolResults: entries,
  }
}

/** 兼容 v1 归档条目：step 可能在 entry.step（v2）或 entry.event.data.step（v1）。 */
function stepOfEntry(entry) {
  if (typeof entry?.step === 'number') return entry.step
  const step = entry?.event?.data?.step
  return typeof step === 'number' ? step : null
}

async function readByTime(session, logsDir, time) {
  let at
  const trimmed = time.trim()
  if (/^-?\d+$/.test(trimmed)) {
    at = Number(trimmed)
  } else {
    const parsed = new Date(time)
    if (Number.isNaN(parsed.getTime())) {
      return { error: `无法解析时间 "${time}" — 请用 ISO 8601（如 2026-08-26T10:00:00+08:00）或毫秒时间戳` }
    }
    at = parsed.getTime()
  }
  const rounds = (await readIndex(logsDir))?.rounds ?? []
  const match = rounds.find((round) => round.timeFrom <= at && at <= round.timeTo)
  if (!match) {
    return {
      sessionId: session.id,
      workspace: session.header.cwd ?? null,
      query: time,
      error: `没有归档轮次覆盖 ${new Date(at).toISOString()}（已归档轮次：${rounds.map((round) => `${round.turn}@${new Date(round.timeFrom).toISOString()}`).join(', ') || '无'}）`,
      rounds: rounds.slice(-20),
    }
  }
  return readByTurn(session, logsDir, match.turn)
}

async function listRounds(session, logsDir) {
  const index = await readIndex(logsDir)
  const rounds = [...(index?.rounds ?? [])]
  const known = new Set(rounds.map((round) => round.turn))
  // overclock：当前轮次尚未生成 round-NNNN.json 但已有 step 文件——按轮汇总后也列出来，
  // 避免模型不带参数查询时误以为没有归档可用
  const byTurn = new Map()
  for (const step of index?.steps ?? []) {
    if (!step || known.has(step.turn)) continue
    const group = byTurn.get(step.turn) ?? {
      turn: step.turn,
      inProgress: true,
      count: 0,
      stepCount: 0,
      tools: new Set(),
      timeFrom: Infinity,
      timeTo: -Infinity,
    }
    group.count += step.count ?? 0
    group.stepCount += 1
    for (const tool of step.tools ?? []) group.tools.add(tool)
    if (typeof step.timeFrom === 'number') group.timeFrom = Math.min(group.timeFrom, step.timeFrom)
    if (typeof step.timeTo === 'number') group.timeTo = Math.max(group.timeTo, step.timeTo)
    byTurn.set(step.turn, group)
  }
  for (const group of byTurn.values()) {
    rounds.push({
      turn: group.turn,
      inProgress: true,
      count: group.count,
      stepCount: group.stepCount,
      timeFrom: group.timeFrom === Infinity ? undefined : group.timeFrom,
      timeTo: group.timeTo === -Infinity ? undefined : group.timeTo,
      tools: [...group.tools],
    })
  }
  rounds.sort((a, b) => a.turn - b.turn)
  return {
    sessionId: session.id,
    workspace: session.header.cwd ?? null,
    query: '轮次列表',
    rounds,
  }
}

// ---------------------------------------------------------------------------
// 公共辅助：会话目录解析、工具名映射、surface 改写
// ---------------------------------------------------------------------------

/**
 * 会话目录（JSONL 布局）+ tool-result-logs 子目录。
 * 优先用 persistence.locate 以尊重配置的 root；回退到默认 ~/.dsh/sessions 布局。
 */
function logsDirOf(ctx, session) {
  try {
    const persistence = ctx.get('sessionPersistence')
    if (persistence && typeof persistence.locate === 'function') {
      const located = persistence.locate(session.header)
      if (located && typeof located.path === 'string') return join(dirname(located.path), LOG_DIR_NAME)
    }
  } catch {
    // 回退到默认布局
  }
  return join(SESSIONS_ROOT, projectKey(session.header.cwd), encodeSegment(session.id), LOG_DIR_NAME)
}

function toolNameOf(data, nameByCallId) {
  if (!data) return UNKNOWN_TOOL
  const callId = data.message?.source?.callId
  if (typeof callId === 'string' && nameByCallId?.has(callId)) {
    return nameByCallId.get(callId)
  }
  return data.toolName
    ?? data.name
    ?? data.tool
    ?? data.meta?.toolName
    ?? data.meta?.name
    ?? UNKNOWN_TOOL
}

/** 核心代数决定 surface op 的键名：<=0.1.4 用 start/end，>=0.1.5 用 startSeq/endSeq。 */
const OP_KEYS_LEGACY = { start: 'start', end: 'end' }
const OP_KEYS_SEQ = { start: 'startSeq', end: 'endSeq' }
/**
 * 核心拒绝这次拼写的两种信号（失败的尝试不会进入会话日志，重试是安全的）：
 *   · 另一代核心的 isReplaceOp 直接拒绝：invalid replace surfaceOp；
 *   · 旧补丁态核心的就地归一化碰到深冻结的 op：not extensible（>=0.1.5 冻结事件后才校验）。
 */
const OP_KEY_REJECTED = /invalid replace surfaceOp|not extensible/i
// 默认按当前代数（>=0.1.5）；载入后按核心源码校准一次，见 rememberOpKeys()。
let surfaceOpKeyNames = OP_KEYS_SEQ
/**
 * 核心代数：`seq`（>= 0.1.5）/ `legacy`（<= 0.1.4）/ undefined（未校准）。
 * 未校准时用会话头的格式版本兜底（`header.version >= 3` 即 >= 0.1.5）。
 */
const GEN_SEQ = 'seq'
const GEN_LEGACY = 'legacy'
let coreGeneration

/** 记住校准结果（由补丁管理器给出的两代键名反推代数）。 */
function rememberOpKeys(keys) {
  if (keys !== OP_KEYS_LEGACY && keys !== OP_KEYS_SEQ) return
  surfaceOpKeyNames = keys
  coreGeneration = keys === OP_KEYS_LEGACY ? GEN_LEGACY : GEN_SEQ
}

/** 本次写入该用哪代键名。 */
function preferredOpKeys(session) {
  if (coreGeneration !== undefined) return surfaceOpKeyNames
  const version = session?.header?.version
  return typeof version === 'number' && version < 3 ? OP_KEYS_LEGACY : OP_KEYS_SEQ
}

/**
 * 构造 replace op。
 *
 * 恒为 3 键的原生形态，且事件上不带任何额外标记 —— 两条路都被封死了：
 *   · surfaceOp 放第 4 个键 → 浏览器端 wire 校验（assertSessionWireEvent → isReplaceOp
 *     要求恰好 3 个键）会抛 `session event "tool/result" carries an invalid replace surfaceOp`，
 *     这一帧走所有会话共用的 follow 流，整块 UI 一起卡死；
 *   · data 放额外字段 → 核心的 assertToolResultRewrite 要求替换只允许改
 *     `message.content[0].content`，其它任何差异都会被拒。
 * 所以「这次替换只是内容清除」由核心自己判定：内容被改写的单节点 tool/result 替换
 * 不开新系列；本插件用来划系列边界的那次替换内容不变，照旧开新系列。
 */
function buildSurfaceOp(keys, seq) {
  return { op: 'replace', [keys.start]: seq, [keys.end]: seq }
}

function replaceToolResult(session, seq, data, text) {
  const payload = { ...data, message: clearedMessage(data.message, text) }
  const write = (keys) =>
    session.append(TOOL_RESULT, payload, {
      surfaceOp: buildSurfaceOp(keys, seq),
      sourceEventSeqs: [seq],
    })
  const keys = preferredOpKeys(session)
  try {
    write(keys)
  } catch (error) {
    if (!OP_KEY_REJECTED.test(String(error?.message ?? error))) throw error
    // 只有核心确实是旧代时才改用 start/end。>=0.1.5 的日志若写成 start/end，
    // 序列化层（dsh-session-log-deepseek 的 wireSurfaceOp）会把它换算成
    // { startSeq: Number(undefined), endSeq: Number(undefined) } = NaN，
    // 重放/加载历史时直接报 “session event "tool/result" carries an invalid replace surfaceOp”。
    // 所以本代核心上宁可这次清除失败（由调用方记 warning），也不写另一种拼写污染会话日志。
    if (keys === OP_KEYS_LEGACY) {
      write(OP_KEYS_SEQ)
      return
    }
    throw error
  }
}

/** 核心补丁（seriesGeneration 双代数）是否已在当前进程生效。 */
function supportsSeriesGeneration(session) {
  return typeof session?.surface?.seriesGeneration === 'number'
}

function clearedMessage(message, text) {
  if (!message) return { content: [{ type: 'text', text }] }
  const first = message.content?.[0]
  if (!first || first.type !== 'tool-result') {
    return { ...message, content: [{ type: 'text', text }] }
  }
  // DSH surface 规则：tool/result 替换须保持 tool-result 包装结构，仅改内层内容
  return {
    ...message,
    content: [{
      ...first,
      content: [{ type: 'text', text }],
    }],
  }
}

// ---------------------------------------------------------------------------
// 状态开关：{ enabled, mode: 'round' | 'overclock' }；旧文件只有 enabled 时按普通模式
// ---------------------------------------------------------------------------

function defaultState() {
  return { enabled: true, mode: MODE_ROUND }
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== 'object') return defaultState()
  const mode = parsed.mode === MODE_OVERCLOCK ? MODE_OVERCLOCK : MODE_ROUND
  return { enabled: parsed.enabled !== false, mode }
}

/** 进程内缓存：step/end 时机敏感，须同步读、先清除后 I/O。 */
let stateCache = (() => {
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch {
    return defaultState()
  }
})()

/**
 * 同步读取状态文件。
 *
 * step/end 的清除是时序敏感的（必须在下一步组装 prompt 之前完成，不能 await），
 * 因此这里必须**直接读文件**：只要文件里是 overclock，逐步清除就按 overclock 走。
 * 只读内存缓存会与另一边 `readState()`（turn/end、turn/start 用）不一致——
 * 表现就是「overclock 打开后，逐步清除不生效，只有轮末才清除」：
 * 同步路径看到的是过期的 round，异步路径读到的是 overclock。
 * 读失败（文件暂不可读）时保留上一次已知状态，避免中途静默切换模式。
 */
function readStateSync() {
  try {
    stateCache = normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch {
    // 保留 stateCache
  }
  return stateCache
}

async function readState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    stateCache = normalizeState(JSON.parse(raw))
  } catch {
    stateCache = defaultState()
  }
  return stateCache
}

async function readEnabled() {
  return (await readState()).enabled
}

async function writeState(next) {
  const normalized = normalizeState(next)
  const previous = stateCache
  stateCache = normalized
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(normalized, null, 2), 'utf8')
  } catch (error) {
    stateCache = previous
    throw error
  }
}

// ---------------------------------------------------------------------------
// 路径编码辅助，与 dsh-session-persistence-jsonl 一致
// ---------------------------------------------------------------------------

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('不能编码空路径段')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('不能编码空项目路径')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
