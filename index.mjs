// DSH 宿主插件：按轮归档并清除工具结果。
// 启用时（默认）：
//   1. 每轮结束，将该轮原始 tool/result 事件（来自追加式会话日志，未被改写）
//      归档到会话目录 tool-result-logs/round-NNNN.json（附 index.json 清单）；
//   2. 将已结束轮次的工具结果显示替换为占位符（注明轮次，提示 read_tool_result_log）；
//   3. 注册 read_tool_result_log 工具，模型可按轮次或时间读取归档。
// 归档上限：原文超过 ARCHIVE_MAX_BYTES（UTF-8）的结果不保存，占位符提示重新执行原工具。
// 命令：/clear-tool-results on|off|status；状态存于 $DSH_HOME/clear-tool-results.json。
// 时机：DSH 在 turn/start 后同步组装 prompt，且 append 有重入保护，故清除在上一轮 turn/end 执行。
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
/** 取回工具的参数归一化：只把纯数字字符串的 turn/step 变成数字，其余原样透传。 */
function normalizeReadArgs(input) {
  const args = { ...(input ?? {}) }
  for (const key of ['turn', 'step']) {
    const raw = args[key]
    if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) args[key] = Number(raw.trim())
  }
  return args
}

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
const SCHEMA_VERSION = 2
const UNKNOWN_TOOL = 'unknown_tool'
const LOG_DIR_NAME = 'tool-result-logs'
const INDEX_FILE = 'index.json'
const STATE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'clear-tool-results.json')
const SESSIONS_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
/** 告警日志（只在异常路径写）。 */
const WARN_LOG_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'clear-tool-results.log')

/**
 * 归档上限（UTF-8 字节）。harness 的 spill 策略（`@deepseek-ai/dsh-spill-policy`，本机
 * `maxInlineBytes = 50000`）会把超过 50000 字节的结果换成「首尾预览 + 通知」并掐掉中间，
 * 所以超过本上限的结果即使归档、取回时也拿不到完整原文 —— 索性不保存：原处只留
 * 「已清除、需要就重新执行原工具」的占位符，并把这条规则写进工具描述告知 Agent。
 */
const ARCHIVE_MAX_BYTES = 49000
/** UTF-8 字节数：归档与渲染都按字节判，中文结果不能按字符估。 */
const byteLen = (text) => Buffer.byteLength(String(text ?? ''), 'utf8')
/** 该归档条目是否值得保存：原文在字节上限内。 */
function archivable(entry) {
  return byteLen(resultTextOf(entry?.event?.data?.message)) <= ARCHIVE_MAX_BYTES
}
/**
 * 插件告警：既交给 ctx.logger，也追加到 $DSH_HOME/clear-tool-results.log（**只有异常路径写**，
 * 正常路径零 I/O）。宿主默认不把 logger 写成任何可读文件，清除失败就完全看不见——所以自己落一份。
 * 注意：0.7.0 起**不再有 per-turn/per-step 追踪**（原 `[trace]` 行），这个文件只在出错时才有内容。
 */
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
  disposers.push(ctx.commands.register({
    name: 'clear-tool-results',
    description: '工具结果归档并清除开关：每轮结束把该轮工具结果归档到会话 tool-result-logs 并从对话清除，模型可用 read_tool_result_log(turn) 取回。用法：/clear-tool-results on|off|status',
    input: { hint: 'on|off|status' },
    recordInput: false,
    handler: async ({ rawInput, agent }) => {
      const arg = rawInput.trim().toLowerCase()
      if (arg === 'on') {
        await writeState({ enabled: true })
        if (agent?.session) {
          queueMicrotask(() => {
            enableNow(ctx, agent.session).catch((error) => warn(ctx, String(error)))
          })
        }
        return { kind: 'success', text: '已启用：工具结果按轮归档，并在下一轮开始前从对话清除' }
      }
      if (arg === 'off') {
        await writeState({ enabled: false })
        return { kind: 'success', text: '已禁用：工具结果保留在对话中，不再归档' }
      }
      if (arg === 'status') {
        const state = await readState()
        const text = state.enabled ? '当前状态：已启用' : '当前状态：已禁用'
        const lines = [text, `插件版本：${PLUGIN_VERSION}`]
        return { kind: 'success', text: lines.join('\n') }
      }
      return { kind: 'error', text: '用法：/clear-tool-results on|off|status' }
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
    } else if (event.type === 'tool/ptc-dispatch') {
      // 索引行专用：run_code（PTC）内部真正干活的子调用，事件流里拿不到它们，
      // 所以在这里自己收一份，占位符索引才能显示真实动作（bash → git status）。
      try {
        recordPtcDispatch(session.id, event.data)
      } catch (error) {
        warn(ctx, '索引登记失败 ' + String(error))
      }
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
  // 清除该轮全部工具结果（含最后一步）
  try {
    clearCompletedToolResults(session, endedTurn)
  } catch (error) {
    warn(ctx, '轮末清除失败 ' + String(error))
  }
}

async function onTurnStart(ctx, session, turn) {
  // 先做同步兜底（不 await，尽量赶在首条请求组装之前），再进入需要异步读盘的归档流程。
  // 插件已关闭时不再产生任何写入。
  if (!(await readEnabled())) return
  const logsDir = logsDirOf(ctx, session)
  await enqueue(session.id, async () => {
    if (typeof turn === 'number') await archiveUnarchived(session, turn, logsDir)
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
function clearToolResultsWhere(session, matches) {
  const nodes = [...session.surface.nodes]
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
    // 逐条独立：某一条目标已不在 surface（被别的 replace/压缩遮蔽）时只跳过这一条，
    // 不影响本次其余清除，也不把异常抛给调用方（逐步清除后仍要归档、轮末仍要收尾）。
    // 索引行在这里取一次原文：占位符带上「这一步里是什么」。
    const info = describeClearedResult(session, data)
    try {
      replaceToolResult(
        session,
        seq,
        data,
        clearedText(turn, info.index, info.archived, info.overLimit, info.bytes),
      )
      cleared += 1
    } catch (error) {
      warn(null, `清除失败（目标 seq ${seq} 已不在 surface 或写入被拒）：${String(error?.message ?? error)}`)
    }
  }
  return { cleared, matched }
}

/** 将轮次 <= untilTurn 的 tool/result 节点替换为占位符。 */
function clearCompletedToolResults(session, untilTurn) {
  const { cleared } = clearToolResultsWhere(session, (data) => typeof data?.turn === 'number' && data.turn <= untilTurn)
  return { cleared }
}

/** 占位符索引专用：callId -> tool/call 事件。 */
function indexToolCalls(events) {
  const map = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const callId = event.data?.callId
    if (callId) map.set(callId, event.data)
  }
  return map
}

function callOfResult(data, callByCallId) {
  const callId = data?.message?.source?.callId ?? data?.source?.callId ?? data?.callId
  return callId ? callByCallId.get(callId) : undefined
}

function toolNameOfResult(call, data) {
  return call?.name ?? data?.message?.source?.toolName ?? data?.toolName ?? 'tool'
}

/** 关键参数一行摘要：命令/路径/查询优先，压成单行后前 40 字。 */
function callHintOf(call) {
  const raw = call?.arguments
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      args = raw
    }
  }
  if (typeof args === 'string') return squashLine(args).slice(0, 40)
  if (args && typeof args === 'object') {
    for (const field of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'code', 'prompt']) {
      const value = args[field]
      if (typeof value === 'string' && value.trim() !== '') return squashLine(value).slice(0, 40)
    }
    try {
      return squashLine(JSON.stringify(args)).slice(0, 40)
    } catch {
      return ''
    }
  }
  return ''
}

function squashLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 结果消息里的纯文本（规模统计用）。 */
function resultTextOf(message) {
  const parts = []
  const walk = (value) => {
    if (!value) return
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') parts.push(value.text)
      if (Array.isArray(value.content)) walk(value.content)
    }
  }
  walk(message?.content)
  return parts.join('\n')
}

/** 这条结果是不是失败（错误标记或非零退出码）。 */
function resultFailed(data) {
  if (data?.message?.isError === true) return true
  const text = resultTextOf(data?.message)
  return /(^|\n)\s*(exit code|退出码)\s*[:：]?\s*[1-9]/.test(text)
}

/** 同一步里的 PTC 子调用（run_code 内部的 bash/read/…）：索引行优先用它们。 */
function ptcItemsOf(events, turn, step) {
  const items = []
  for (const event of events) {
    if (event?.type !== 'tool/ptc-dispatch') continue
    if (event.data?.turn !== turn || event.data?.step !== step) continue
    items.push({ tool: event.data?.name ?? 'tool', hint: callHintOf({ arguments: event.data?.arguments }), chars: 0, failed: false })
  }
  return items
}

/** 从一段对象字面量文本里抽第一个字符串字段（命令/路径优先）。 */
function stringFieldOf(body) {
  const match = body.match(/(command|file_path|path|pattern|query|description)\s*:\s*([^,\n]{1,80})/)
  if (!match) return null
  return squashLine(match[2].replace(/^[^A-Za-z0-9/._-]+|[^A-Za-z0-9/._-]+$/g, '')).slice(0, 40)
}

/** run_code 代码里直接写着的子调用（tools.bash({ command: '…' })）：事件流里看不到 PTC 子调用时的兜底。 */
function innerCallsOf(call) {
  try {
    const raw = call?.arguments
    const args = typeof raw === 'string' ? JSON.parse(raw) : raw
    const code = args?.code
    if (typeof code !== 'string') return []
    const items = []
    const re = /tools\.([a-z_]+)\s*\(\s*\{([\s\S]{0,240}?)\}\s*\)/g
    let match
    while ((match = re.exec(code)) !== null && items.length < 3) {
      items.push({ tool: match[1], hint: stringFieldOf(match[2]) ?? squashLine(match[2]).slice(0, 40), chars: 0, failed: false })
    }
    return items
  } catch {
    return []
  }
}

/** 一条被清除结果的索引信息：同一步的多条结果合并成一行，供占位符使用。 */
function describeClearedResult(session, data) {
  try {
    const events = eventsOf(session)
    const calls = indexToolCalls(events)
    const call = callOfResult(data, calls)
    const tool = toolNameOfResult(call, data)
    const siblings = []
    for (const event of events) {
      if (event?.type !== TOOL_RESULT || event.surfaceOp !== 'append') continue
      if (event.data?.turn !== data?.turn || event.data?.step !== data?.step) continue
      const siblingCall = callOfResult(event.data, calls)
      const siblingText = resultTextOf(event.data?.message)
      siblings.push({
        tool: toolNameOfResult(siblingCall, event.data),
        hint: callHintOf(siblingCall),
        chars: siblingText.length,
        bytes: byteLen(siblingText),
        failed: resultFailed(event.data),
      })
    }
    // PTC 模式下真正干活的是 run_code 里的子调用：索引行优先显示它们。
    // 三个来源依次尝试：hook 收下的子调用 -> 事件流里的子调用 -> 直接解析 run_code 的代码
    let items = ptcItems(session.id, data?.turn, data?.step)
    if (items.length === 0) items = ptcItemsOf(events, data?.turn, data?.step)
    if (items.length === 0) items = innerCallsOf(call)
    if (items.length > 0 && siblings.length > 0) {
      items[0].chars = siblings[0].chars
      items[0].failed = siblings[0].failed
    }
    const text = resultTextOf(data?.message)
    const bytes = byteLen(text)
    // 超限结果不落盘：占位符必须说清「没得取回」，而不是给一个取不回来的坐标。
    const overLimit = siblings.filter((s) => s.bytes > ARCHIVE_MAX_BYTES).length
    return {
      tool,
      text,
      bytes,
      archived: bytes <= ARCHIVE_MAX_BYTES,
      overLimit,
      callKey: callKeyOf(tool, argsText(call?.arguments)),
      index: indexText(items.length > 0 ? items : siblings),
    }
  } catch {
    return { tool: 'tool', text: '', callKey: null, index: '' }
  }
}

function clearedText(turn, index, archived = true, overLimit = 0, bytes = 0) {
  const indexPart = index ? `：${index}` : ''
  // 超限结果不归档：只说「已清除」，并让 Agent 重新执行原工具（没有可用的取回坐标）。
  // 尺寸按字节报：索引行沿用「字符」标签，对中文结果会低估（曾把 60KB 结果的 spilled 预览标成 16.8k）。
  if (!archived) {
    const wherePart = typeof turn === 'number' ? `第 ${turn} 轮` : ''
    const sizePart =
      overLimit > 1 ? `${overLimit} 条结果` : bytes > 0 ? `该结果 ${(bytes / 1000).toFixed(1)}k 字节` : '该结果'
    return `[${wherePart}工具结果已清除（${sizePart}，超过 ${ARCHIVE_MAX_BYTES} 字节上限，未归档）${indexPart}。未保存原文，如需请重新执行原工具获取。]`
  }
  const skippedPart =
    overLimit > 0 ? `（本轮另有 ${overLimit} 条超 ${ARCHIVE_MAX_BYTES} 字节的结果未归档，需要时请重新执行原工具）` : ''
  const core =
    typeof turn === 'number'
      ? `[第 ${turn} 轮工具结果已清除归档${indexPart}，可用 read_tool_result_log(turn: ${turn}) 读取]`
      : `[工具结果已清除归档${indexPart}，可用 read_tool_result_log 读取]`
  return core + skippedPart
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
    const entry = entryOf(event, nameByCallId, callByCallId)
    if (!archivable(entry)) continue
    entries.push(entry)
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
  }
}

function roundFileName(turn) {
  return `round-${String(turn).padStart(4, '0')}.json`
}

/** 从某轮条目中取出去重后的步骤号（老核心无 step 字段时为空）。 */
function distinctStepsOf(entries) {
  const steps = [...new Set(entries.map((entry) => entry.step).filter((step) => step !== null))]
  return steps.sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// read_tool_result_log：模型读取历史归档的工具结果
// ---------------------------------------------------------------------------

/** 输出预算（UTF-8 字节）：harness 的 spill 策略在 50000 字节处把结果换成「首尾预览 + 通知」并
 *  **掐掉中间**（2026-09-14 实测：未截断的最大 49,656 字节、截断后预览 50,049 / 50,050 字节；
 *  早先记的「约 31k 字符」是同一堵墙的字符侧读数）。used 从表头起算、末尾通知约 400 字节，
 *  故整份载荷 ≤ 48400 字节，永不触发 harness 截断；插件自己按行切分并给出续取坐标，
 *  也不落 spill（spill 是契约禁止的旁路通道）。 */
const RENDER_BUDGET_BYTES = 48000

/** 把归档条目渲染成紧凑纯文本（0.6.8）。
 *  旧做法是 `JSON.stringify(条目, null, 2)`，而条目不只含 `text`，还带 `call`（整条工具调用事件）、
 *  逐行 `meta`、以及重复的 seq/time/turn/step —— 同一个原文被塞了两遍，再叠上 JSON 转义与缩进，
 *  实测返回体是原文的 3~4 倍（两份归档：11.4k → 44,889 字符；14.5k → 45,029），
 *  直接撞上 harness 的截断线：29/63 次取回因此拿不全，并诱发 spill 绕道。
 *  现在只输出：坐标 + 工具名 + 参数摘要 + 行窗口 + 原文，并受 RENDER_BUDGET_BYTES 约束。 */
function renderRetrieval(args, value) {
  if (value && typeof value.error === 'string') return `错误：${value.error}`
  const parts = []
  if (typeof value?.query === 'string' && value.query !== '') parts.push(`查询：${value.query}`)
  const rounds = Array.isArray(value?.rounds) ? value.rounds : []
  if (rounds.length > 0) {
    parts.push(
      `已归档轮次：${rounds
        .map((round) => `turn ${round?.turn ?? '?'}（${round?.stepCount ?? 0} 步，${round?.count ?? '?'} 条）`)
        .join('、')}`,
    )
  }
  const entries = Array.isArray(value?.toolResults) ? value.toolResults : []
  const offset = Math.max(1, Number(args?.offset ?? 1) || 1)
  const limit = Number(args?.limit ?? 0) || 0
  let used = byteLen(parts.join('\n'))
  let shown = 0
  let skipped = 0
  for (const entry of entries) {
    const text =
      typeof entry?.text === 'string' && entry.text !== ''
        ? entry.text
        : String(resultTextOf(entry?.event?.data?.message) ?? '')
    const lines = text.split('\n')
    const outOfRange = offset > lines.length
    const from = Math.min(offset, lines.length)
    const to = limit > 0 ? Math.min(from + limit - 1, lines.length) : lines.length
    const argsHint =
      typeof entry?.call?.data?.arguments === 'string'
        ? entry.call.data.arguments.replace(/\s+/g, ' ').slice(0, 120)
        : ''
    const head =
      `--- turn ${entry?.turn ?? '?'} step ${entry?.step ?? '?'} · ${entry?.toolName ?? 'tool'}` +
      `${argsHint === '' ? '' : ` · ${argsHint}`} · ${
        outOfRange ? `第 ${lines.length} 行之后无内容（共 ${lines.length} 行）` : `第 ${from}-${to} 行 / 共 ${lines.length} 行`
      } · ${text.length} 字符 / ${byteLen(text)} 字节 ---`
    const body = lines.slice(from - 1, to).join('\n')
    const tail = to < lines.length ? `\n…（本结果还有 ${lines.length - to} 行未显示；续取：offset=${to + 1}${limit > 0 ? `, limit=${limit}` : ''}）` : ''
    const block = `${head}\n${body}${tail}`
    if (used + byteLen(block) > RENDER_BUDGET_BYTES) {
      skipped += 1
      continue
    }
    parts.push(block)
    used += byteLen(block) + 1
    shown += 1
  }
  if (entries.length === 0 && rounds.length === 0) parts.push('（没有匹配的归档条目）')
  if (shown > 0 && entries.length > 0) parts.push(`（共 ${entries.length} 条匹配，已显示 ${shown} 条）`)
  if (skipped > 0) {
    parts.push(
      `⚠️ 还有 ${skipped} 条未显示：输出预算 ${RENDER_BUDGET_BYTES} 字节已到上限（harness 在 50000 字节处会掐掉中间并落盘）。` +
        `请用 turn+step 精确取回，或用 offset/limit 分段取。`,
    )
  }
  if (typeof value?.note === 'string' && value.note !== '') parts.push(value.note)
  return parts.join('\n\n')
}

function readToolResultLogTool(ctx) {
  return {
    name: 'read_tool_result_log',
    description: `读取被清理工具结果的原始数据（每轮归档到会话 tool-result-logs，每轮结束写入 round-NNNN.json）。当占位符或任务需要某轮输出时调用：传 turn（轮次号）读取该轮；传 time（ISO 8601 或毫秒时间戳）读取该时刻所在轮；都不传则返回已归档轮次列表。归档上限：原文超过 ${ARCHIVE_MAX_BYTES} 字节（UTF-8；harness 在 50000 字节处会截断落盘）的结果**不保存**——其占位符会写明「已清除、未归档」，这种结果只能重新执行原工具获取，本工具取不回来。返回体是纯文本，超过输出预算时按行截断并给出 offset 续取坐标。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turn: {
          type: ['integer', 'string'],
          description: '对话轮次编号（1 起），如 turn: 3 读取第 3 轮。用户指明轮次时优先使用。',
        },
        time: {
          type: 'string',
          description: 'ISO 8601 时间（如 2026-08-26T10:00:00+08:00）或毫秒时间戳，读取该时刻所在轮次。',
        },
        offset: {
          type: ['integer', 'string'],
          description: '可选：从原文第几行开始返回（1 起）。大结果只取一段时用，避免一次取回过大。',
        },
        limit: {
          type: ['integer', 'string'],
          description: '可选：最多返回多少行（配合 offset 精确取段）。不传则尽量多返回，受输出预算约束。',
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
          timeFrom: { type: 'number' },
          timeTo: { type: 'number' },
          toolResults: { type: 'array', items: {} },
          rounds: { type: 'array', items: {} },
          error: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderRetrieval(args, value) }],
    },
    async execute(rawArgs, exec) {
    // 0.6.7：core 传进来的参数可能是冻结对象，直接赋值会被静默忽略 —— 复制一份再归一化。
    const args = normalizeReadArgs(rawArgs)
      const session = exec.agent?.session
      if (!session) return { error: '无可用会话上下文' }
      const logsDir = logsDirOf(ctx, session)
      let result
      try {
        if (typeof args.turn === 'number') {
          result = await readByTurn(session, logsDir, args.turn)
        } else if (typeof args.step === 'number') {
          result = { error: '已不再保留逐步归档：请用 turn 取回整轮，如 read_tool_result_log({ turn: 3 })' }
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
        result.note = '取回提示：归档在每轮结束时写入，之后随时可读；如需引用多轮原文，可在总结前逐轮取回。'
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
    note: '原文在 event.data.message（取回时已展开为纯文本）。',
  }
}


/** 读取某轮归档：round-NNNN.json（每轮结束时写入）。 */
async function collectTurnData(session, logsDir, turn) {
  let aggregate
  try {
    aggregate = JSON.parse(await readFile(join(logsDir, roundFileName(turn)), 'utf8'))
  } catch {
    return null
  }
  const entries = (aggregate.toolResults ?? [])
    .filter((entry) => typeof entry?.seq === 'number')
    .sort((a, b) => a.seq - b.seq)
  if (entries.length === 0) return null
  const times = entries
    .map((entry) => entry.time)
    .filter((time) => typeof time === 'number')
    .sort((a, b) => a - b)
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: aggregate.sessionId ?? session.id,
    workspace: aggregate.workspace ?? session.header.cwd ?? null,
    turn,
    timeFrom: times[0],
    timeTo: times[times.length - 1],
    toolResults: entries,
  }
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

/** 本次写入该用哪代键名：按会话头版本（<3 用 start/end，>=3 用 startSeq/endSeq）。 */
function preferredOpKeys(session) {
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
// 状态开关：{ enabled: boolean }
// ---------------------------------------------------------------------------

function defaultState() {
  return { enabled: true }
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== 'object') return defaultState()
  return { enabled: parsed.enabled !== false }
}

/** 进程内缓存：step/end 时机敏感，须同步读、先清除后 I/O。 */
let stateCache = (() => {
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch {
    return defaultState()
  }
})()


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


// ---------------------------------------------------------------------------
// 占位符索引：让模型不必先取回就知道被清除的那一步里有什么。
// 形如 `bash → git status（1.2k，失败）`；PTC（run_code）内部真正干活的子调用在事件流里
// 看不到，所以在 tool/ptc-dispatch 里自己收一份。0.7.0 由 usage.mjs 内联而来——
// 归因埋点、rare-token 判定与每轮 usage.json 落盘已全部删除。
// ---------------------------------------------------------------------------

const PTC_MAX_KEYS = 200
/** sessionId -> Map<'turn:step', items[]>（登记顺序即 LRU） */
const ptcBooks = new Map()

function ptcBookOf(sessionId) {
  let book = ptcBooks.get(sessionId)
  if (!book) {
    book = new Map()
    ptcBooks.set(sessionId, book)
  }
  return book
}

function hintOfArgs(args) {
  let value = args
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return String(args).replace(/\s+/g, ' ').trim().slice(0, 40)
    }
  }
  if (value && typeof value === 'object') {
    for (const field of ['command', 'file_path', 'path', 'pattern', 'query', 'description', 'prompt']) {
      const raw = value[field]
      if (typeof raw === 'string' && raw.trim() !== '') return raw.replace(/\s+/g, ' ').trim().slice(0, 40)
    }
  }
  return ''
}

/** PTC 子调用登记：run_code 内部真正的 bash/read/…（事件流里看不到，所以在 hook 里自己收）。 */
function recordPtcDispatch(sessionId, data) {
  try {
    const turn = data && data.turn
    const step = data && data.step
    if (typeof turn !== 'number' || typeof step !== 'number') return
    const book = ptcBookOf(sessionId)
    const key = turn + ':' + step
    const list = book.get(key) || []
    list.push({ tool: (data && data.name) || 'tool', hint: hintOfArgs(data && data.arguments), chars: 0, failed: false })
    if (list.length > 8) list.splice(0, list.length - 8)
    book.delete(key)
    book.set(key, list)
    while (book.size > PTC_MAX_KEYS) book.delete(book.keys().next().value)
  } catch {
    // 忽略
  }
}

/** 取某一步登记过的 PTC 子调用（没有则空数组）。 */
function ptcItems(sessionId, turn, step) {
  try {
    const book = ptcBooks.get(sessionId)
    if (!book || typeof turn !== 'number' || typeof step !== 'number') return []
    const list = book.get(turn + ':' + step)
    return list ? list.map((item) => Object.assign({}, item)) : []
  } catch {
    return []
  }
}

function shortText(value, limit) {
  const text = String(value == null ? '' : value)
  return text.length > limit ? text.slice(0, Math.max(1, limit - 1)) + '…' : text
}

/** 占位符里的一行索引；整行压到 60 字以内。 */
function indexText(items) {
  try {
    const list = (items || []).filter(Boolean)
    if (list.length === 0) return ''
    const build = (hintLimit) => {
      const parts = []
      for (const item of list.slice(0, 2)) {
        const name = shortText(item.tool, 12)
        const hint = item.hint ? shortText(item.hint, hintLimit) : '无参数'
        const chars = item.chars || 0
        const size = chars > 0 ? (chars >= 1000 ? (chars / 1000).toFixed(1) + 'k' : String(chars)) : ''
        const tail = [size, item.failed ? '失败' : ''].filter(Boolean).join('，')
        parts.push(name + ' → ' + hint + (tail ? '（' + tail + '）' : ''))
      }
      if (list.length > 2) parts.push('等 ' + list.length + ' 条')
      return parts.join(' + ')
    }
    let text = build(26)
    if (text.length > 60) text = build(12)
    if (text.length > 60) text = text.slice(0, 59) + '…'
    return text
  } catch {
    return ''
  }
}

function argsText(args) {
  if (args == null) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

function callKeyOf(toolName, argsString) {
  return String(toolName == null ? '?' : toolName) + '|' + String(argsString == null ? '' : argsString).replace(/\s+/g, ' ').trim().slice(0, 80)
}
