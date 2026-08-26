// DSH 宿主插件：按轮归档并清除工具结果。
// 启用时（默认）：
//   1. 每轮结束，将该轮原始 tool/result 事件（来自追加式会话日志，未被改写）
//      归档到会话目录 tool-result-logs/round-NNNN.json（附 index.json 清单）；
//   2. 将已结束轮次的工具结果显示替换为占位符（注明轮次，提示 read_tool_result_log）；
//   3. 注册 read_tool_result_log 工具，模型可按轮次或时间自主读取归档原始数据。
// 命令：/clear-tool-results on|off|status；状态存于 $DSH_HOME/clear-tool-results.json。
// 时机：DSH 在 turn/start 后同步组装 prompt，且 append 有重入保护，
// 故清除在上一轮 turn/end 执行——新轮开始时历史工具结果已不可见，可经工具读取。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-clear-tool-results'
export const inject = ['commands', 'tools', 'sessionPersistence']

const TOOL_RESULT = 'tool/result'
const TOOL_CALL = 'tool/call'
const TURN_END = 'turn/end'
const TURN_START = 'turn/start'
const UNKNOWN_TOOL = 'unknown_tool'
const LOG_DIR_NAME = 'tool-result-logs'
const INDEX_FILE = 'index.json'
const STATE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'clear-tool-results.json')
const SESSIONS_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')

export function apply(ctx) {
  const disposers = []
  disposers.push(ctx.commands.register({
    name: 'clear-tool-results',
    description: '工具结果按轮归档并清除开关：每轮结束归档原始结果，下一轮开始前从对话清除。用法：/clear-tool-results on|off|status',
    input: { hint: 'on|off|status' },
    recordInput: false,
    handler: async ({ rawInput, agent }) => {
      const arg = rawInput.trim().toLowerCase()
      if (arg === 'on') {
        await writeEnabled(true)
        if (agent?.session) {
          queueMicrotask(() => {
            enableNow(ctx, agent.session).catch((error) => ctx.logger.warn('dsh-clear-tool-results: ' + String(error)))
          })
        }
        return { kind: 'success', text: '已启用：工具结果按轮归档，并在下一轮开始前从对话清除' }
      }
      if (arg === 'off') {
        await writeEnabled(false)
        return { kind: 'success', text: '已禁用：工具结果保留在对话中，不再归档' }
      }
      if (arg === 'status') {
        return { kind: 'success', text: '当前状态：' + (await readEnabled() ? '已启用' : '已禁用') }
      }
      return { kind: 'error', text: '用法：/clear-tool-results on|off|status' }
    },
  }))
  disposers.push(ctx.on('session/event', (session, event) => {
    if (event.type === TURN_END) {
      const endedTurn = event.data.turn
      queueMicrotask(() => {
        onTurnEnd(ctx, session, endedTurn).catch((error) => ctx.logger.warn('dsh-clear-tool-results: ' + String(error)))
      })
    } else if (event.type === TURN_START) {
      const turn = event.data.turn
      queueMicrotask(() => {
        onTurnStart(ctx, session, turn).catch((error) => ctx.logger.warn('dsh-clear-tool-results: ' + String(error)))
      })
    }
  }))
  disposers.push(ctx.tools.register(readToolResultLogTool(ctx)))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// ---------------------------------------------------------------------------
// 轮次生命周期：turn/end 归档并清除，turn/start 补归档
// ---------------------------------------------------------------------------

async function onTurnEnd(ctx, session, endedTurn) {
  if (!(await readEnabled())) return
  const logsDir = logsDirOf(ctx, session)
  await enqueue(session.id, async () => {
    // 补归档之前未归档的轮次（插件关闭/重启期间）
    if (typeof endedTurn === 'number') await archiveUnarchived(session, endedTurn - 1, logsDir)
    // 刷新刚结束的轮次，保证归档完整
    if (typeof endedTurn === 'number') await archiveTurn(session, endedTurn, logsDir, true)
  })
  clearCompletedToolResults(session, endedTurn)
}

async function onTurnStart(ctx, session, turn) {
  if (!(await readEnabled())) return
  const logsDir = logsDirOf(ctx, session)
  await enqueue(session.id, async () => {
    if (typeof turn === 'number') await archiveUnarchived(session, turn, logsDir)
  })
}

async function enableNow(ctx, session) {
  const logsDir = logsDirOf(ctx, session)
  const openTurn = currentOpenTurn(session)
  await enqueue(session.id, async () => {
    await archiveUnarchived(session, Number.MAX_SAFE_INTEGER, logsDir)
    if (openTurn !== null) await archiveTurn(session, openTurn, logsDir, true)
  })
  if (openTurn === null) {
    clearCompletedToolResults(session, Number.MAX_SAFE_INTEGER)
  } else {
    clearCompletedToolResults(session, openTurn - 1)
  }
}

/** 当前进行中的轮次；无则返回 null。 */
function currentOpenTurn(session) {
  let start = null
  let end = null
  for (const event of session.events) {
    if (event.type === TURN_START) start = event.data?.turn ?? start
    else if (event.type === TURN_END) end = event.data?.turn ?? end
  }
  return start !== null && (end === null || end < start) ? start : null
}

/**
 * 将轮次 <= untilTurn 的 tool/result surface 节点替换为占位符。
 * 已是替换结果（surfaceOp !== 'append'）的节点跳过。
 */
function clearCompletedToolResults(session, untilTurn) {
  const nodes = [...session.surface.nodes]
  for (const seq of nodes) {
    const original = session.events[seq]
    if (!original || original.type !== TOOL_RESULT) continue
    if (original.surfaceOp !== 'append') continue
    const turn = original.data?.turn
    if (typeof turn === 'number' && turn > untilTurn) continue
    replaceToolResult(session, seq, original.data, clearedText(turn))
  }
}

function clearedText(turn) {
  if (typeof turn === 'number') {
    return `[第 ${turn} 轮工具结果已清除归档，可用 read_tool_result_log(turn: ${turn}) 读取]`
  }
  return '[工具结果已清除归档，可用 read_tool_result_log 读取]'
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
  for (const event of session.events) {
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
  for (const event of session.events) {
    if (event.type !== TOOL_RESULT || event.surfaceOp !== 'append') continue
    if (event.data?.turn !== turn) continue
    entries.push(entryOf(event, nameByCallId, callByCallId))
  }
  if (entries.length === 0) return
  const fileName = roundFileName(turn)
  await mkdir(logsDir, { recursive: true })
  await writeFile(join(logsDir, fileName), JSON.stringify({
    schemaVersion: 1,
    sessionId: session.id,
    workspace: session.header.cwd ?? null,
    turn,
    timeFrom: entries[0].event.time,
    timeTo: entries[entries.length - 1].event.time,
    toolResults: entries,
  }, null, 2), 'utf8')
  const next = index ?? emptyIndex(session)
  const round = {
    turn,
    file: fileName,
    timeFrom: entries[0].event.time,
    timeTo: entries[entries.length - 1].event.time,
    count: entries.length,
    tools: [...new Set(entries.map((entry) => entry.toolName))],
  }
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
  return {
    seq: event.seq,
    time: event.time,
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
  for (const event of session.events) {
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
    schemaVersion: 1,
    sessionId: session.id,
    workspace: session.header.cwd ?? null,
    updatedAt: Date.now(),
    rounds: [],
  }
}

function roundFileName(turn) {
  return `round-${String(turn).padStart(4, '0')}.json`
}

// ---------------------------------------------------------------------------
// read_tool_result_log：模型读取历史归档的工具结果
// ---------------------------------------------------------------------------

function readToolResultLogTool(ctx) {
  return {
    name: 'read_tool_result_log',
    description: '读取历史轮次中被清理的工具结果原始数据。工具结果每轮归档到会话 tool-result-logs 并从对话清除；当用户回顾某轮工具输出（如"回顾上一轮的工具结果""刚才的数据""上一轮的结果"、之前 bash/read/web 返回了什么）时调用本工具。传 turn（轮次号）或 time（时间）；都不传则返回已归档轮次列表。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turn: {
          type: 'integer',
          description: '对话轮次编号（1 起），如 turn: 3 读取第 3 轮。用户指明轮次时优先使用。',
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
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (!session) return { error: '无可用会话上下文' }
      const logsDir = logsDirOf(ctx, session)
      try {
        if (typeof args.turn === 'number') return await readByTurn(session, logsDir, args.turn)
        if (typeof args.time === 'string') return await readByTime(session, logsDir, args.time)
        return await listRounds(session, logsDir)
      } catch (error) {
        return { error: '读取工具结果日志失败：' + (error instanceof Error ? error.message : String(error)) }
      }
    },
  }
}

async function readByTurn(session, logsDir, turn) {
  if (!Number.isInteger(turn) || turn < 1) {
    return { error: '轮次编号必须为正整数' }
  }
  let data
  try {
    data = JSON.parse(await readFile(join(logsDir, roundFileName(turn)), 'utf8'))
  } catch {
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
  return {
    sessionId: session.id,
    workspace: session.header.cwd ?? null,
    query: '轮次列表',
    rounds: index?.rounds ?? [],
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

function replaceToolResult(session, seq, data, text) {
  session.append(TOOL_RESULT, {
    ...data,
    message: clearedMessage(data.message, text),
  }, {
    surfaceOp: { op: 'replace', start: seq, end: seq },
    sourceEventSeqs: [seq],
  })
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
// 状态开关
// ---------------------------------------------------------------------------

async function readEnabled() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    return JSON.parse(raw).enabled !== false
  } catch {
    return true
  }
}

async function writeEnabled(enabled) {
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify({ enabled }, null, 2), 'utf8')
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
