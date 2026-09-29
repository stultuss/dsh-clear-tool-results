// DSH 宿主插件：工具结果「准入过滤」（前置），取代 0.7.0 的「轮末清除」（事后）。
//
// 机制：
//   1. 在 `tools/post-execute` 上按准入规则决定每条工具结果的形态：
//      超阈值（INLINE_MAX_BYTES）的**纯文本**结果 → 全文落盘到会话目录
//      tool-result-logs/results/，模型只看到「收据 + 有界预览 + 文件路径」；
//      `read` 与 `read_tool_result_log`、失败结果、非纯文本结果一律原样放行。
//   2. 落盘发生在结果进入 surface **之前**（append 端），所以从不改写已发送的
//      前缀 —— 没有轮边界前缀重建，也不需要任何核心补丁。
//   3. `read_tool_result_log` 保留：按 turn/step/time 取回归档（含文件路径）。
//
// 与旧机制的区别：旧版在 turn/end 把已发送的 tool/result 替换成占位符（retroactive），
// 每次替换都要重建缓存前缀；本版只决定「什么内容被允许成为工具结果」。
//
// 阈值 1024 字节 / 预览 300 字节（2026-09-28 决定，取代 4096/1200）。
// 依据（本机 3,264 条原始结果复算，脚本 .sandbox/evidence/2026-09-28/l3/threshold_sim.mjs）：
//   1024/300：收据化 44.1% 的调用，净省字节 5,589 KB（+35% vs 4096/1200 的 4,148 KB），p* = 75.6%；
//   预览若保持 1200：22.9% 的收据比原文更长（1024~1500 B 档），p* 掉到 61.7%。
//   预览是**硬**上限（单行超预算按字节裁切），且收据不短于原文时不落盘。
//
// 命令：/clear-tool-results on|off|status；状态存于 $DSH_HOME/clear-tool-results.json。
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

const SCHEMA_VERSION = 3
const LOG_DIR_NAME = 'tool-result-logs'
const RESULTS_DIR_NAME = 'results'
const INDEX_FILE = 'index.json'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'clear-tool-results.json')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
/** 告警日志（只在异常路径写）。 */
const WARN_LOG_FILE = join(DSH_HOME, 'clear-tool-results.log')

/**
 * 准入阈值（UTF-8 字节）。超过它的纯文本结果被换成「收据 + 预览 + 路径」。
 * 1024 = 覆盖优先：收据化 44.1% 的调用（vs 4096 的 15.2%），依据见文件头。
 */
const INLINE_MAX_BYTES = 1024
/**
 * 预览预算（字节）。必须**显著小于** INLINE_MAX_BYTES：预览 1200 时，
 * 「收据 + 预览」会覆盖 22.9% 的收据化条数比原文更长（刚过阈值那一段）。
 * 硬上限：单行超预算时按字节裁切（`clipLine`），所以预览**永不**超过本值；
 * 再加上 `saveResult` 的「收据不更短就不落盘」护栏，收据恒短于原文。
 */
const PREVIEW_BYTES = 300
/** 取回工具的渲染预算（UTF-8 字节）：整份载荷留在 harness 的 50000 字节截断线以内。 */
const RENDER_BUDGET_BYTES = 48000

/** 预览取哪一端：尾部是最终状态与错误，头部是命中列表与正文开头。 */
const TAIL_PREVIEW_TOOLS = new Set(['bash', 'run_code'])

/**
 * 豁免工具：内容就是下一步的必需输入（`read`），或本身就是取回通道
 * （`read_tool_result_log`）——裁剪它们会造成 read → 收据 → read 的循环。
 */
const EXEMPT_TOOLS = new Set(['read', 'read_tool_result_log'])

const byteLen = (text) => Buffer.byteLength(String(text ?? ''), 'utf8')

/**
 * 插件告警：既交给 ctx.logger，也追加到 $DSH_HOME/clear-tool-results.log（**只有异常路径写**，
 * 正常路径零 I/O）。宿主默认不把 logger 写成任何可读文件，落盘失败就完全看不见。
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
    description: `工具结果准入过滤开关：超过 ${INLINE_MAX_BYTES} 字节的纯文本工具结果落盘并只把收据+预览交给模型，模型用 read/grep 或 read_tool_result_log 取回全文。用法：/clear-tool-results on|off|status`,
    input: { hint: 'on|off|status' },
    recordInput: false,
    handler: async ({ rawInput }) => {
      const arg = rawInput.trim().toLowerCase()
      if (arg === 'on') {
        await writeState({ enabled: true })
        return { kind: 'success', text: `已启用：超过 ${INLINE_MAX_BYTES} 字节的工具结果落盘，模型侧只保留收据与预览` }
      }
      if (arg === 'off') {
        await writeState({ enabled: false })
        return { kind: 'success', text: '已禁用：工具结果原样进入上下文' }
      }
      if (arg === 'status') {
        const state = await readState()
        return {
          kind: 'success',
          text: [
            state.enabled ? '当前状态：已启用（准入过滤）' : '当前状态：已禁用',
            `准入阈值：${INLINE_MAX_BYTES} 字节`,
            `豁免工具：${[...EXEMPT_TOOLS].join('、')}`,
            `插件版本：${PLUGIN_VERSION}`,
          ].join('\n'),
        }
      }
      return { kind: 'error', text: '用法：/clear-tool-results on|off|status' }
    },
  }))
  // turn/step 游标：post-execute 拿不到轮次/步骤，只能从事件流维护。
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      const data = event.data
      if (data && typeof data.turn === 'number' && typeof data.step === 'number') {
        cursors.set(session.header?.id ?? session.id, { turn: data.turn, step: data.step })
      }
      if (event.type === 'tool/ptc-dispatch') {
        recordPtcDispatch(session.header?.id ?? session.id, data)
      }
    } catch (error) {
      warn(ctx, '会话事件登记失败 ' + String(error))
    }
  }))
  disposers.push(ctx.on(
    'tools/post-execute',
    (exec, result, next) => onPostExecute(ctx, exec, result, next),
    { prepend: true },
  ))
  disposers.push(ctx.tools.register(readToolResultLogTool(ctx)))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// ---------------------------------------------------------------------------
// 准入过滤：结果进入 surface 之前决定它的形态
// ---------------------------------------------------------------------------

/** sessionId -> { turn, step }，由 session/event 维护。 */
const cursors = new Map()

/** 全 text 结果拍平成一个字符串；含任何非 text block 时返回 undefined（保持原样）。 */
function flattenPlainText(content) {
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (!block || block.type !== 'text') return undefined
    text += block.text ?? ''
  }
  return text
}

/**
 * 按字节预算取首/尾若干整行（不切坏 UTF-8）。
 * 首行本身就超预算时（单行大结果，如压缩 JSON、base64）按字节**裁切该行**，
 * 而不是整行返回 —— 否则预览会等于全文，收据反而比原文更长。
 */
function takeLines(text, budgetBytes, fromEnd) {
  const lines = String(text ?? '').split('\n')
  const picked = []
  let used = 0
  let clipped = false
  const indices = fromEnd
    ? Array.from({ length: lines.length }, (_, i) => lines.length - 1 - i)
    : Array.from({ length: lines.length }, (_, i) => i)
  for (const index of indices) {
    const line = lines[index]
    const size = byteLen(line) + 1
    if (used + size > budgetBytes) {
      if (picked.length > 0) break
      picked.push(clipLine(line, budgetBytes, fromEnd))
      clipped = true
      break
    }
    picked.push(line)
    used += size
    if (used >= budgetBytes) break
  }
  if (fromEnd) picked.reverse()
  return {
    text: picked.join('\n'),
    lines: picked.length,
    total: lines.length,
    truncated: clipped || picked.length < lines.length,
    clipped,
  }
}

/** 单行超预算时按码点裁到字节预算内（永不切出半个 UTF-8 序列）。 */
function clipLine(line, budgetBytes, fromEnd) {
  const chars = Array.from(line)
  const picked = []
  let used = 0
  for (let n = 0; n < chars.length; n++) {
    const ch = chars[fromEnd ? chars.length - 1 - n : n]
    const size = byteLen(ch)
    if (used + size > budgetBytes) break
    picked.push(ch)
    used += size
  }
  if (fromEnd) picked.reverse()
  return picked.join('')
}

/** 收据 + 预览：模型看到的全部内容。刻意不写「已清除/已删除」——实测模型会读成「没了」。 */
function receiptText(entry, text) {
  const where = TAIL_PREVIEW_TOOLS.has(entry.tool) ? '尾部' : '开头'
  const cut = takeLines(text, PREVIEW_BYTES, TAIL_PREVIEW_TOOLS.has(entry.tool))
  const head = cut.clipped
    ? `……（该行过长，此处仅显示${where} ${byteLen(cut.text).toLocaleString('en-US')} 字节 / 共 ${entry.bytes.toLocaleString('en-US')} 字节）`
    : cut.truncated
      ? `……（中间省略 ${Math.max(0, cut.total - cut.lines)} 行，共 ${cut.total} 行）`
      : ''
  const body = cut.truncated && !TAIL_PREVIEW_TOOLS.has(entry.tool) ? `${cut.text}\n${head}` : `${head ? head + '\n' : ''}${cut.text}`
  return [
    `[${entry.tool}${entry.hint ? ` · ${entry.hint}` : ''} · ${entry.bytes.toLocaleString('en-US')} 字节 / ${cut.total} 行 → 全文已落盘，此处是${where} ${cut.lines} 行]`,
    `路径：${entry.file}`,
    `取全文：read 该路径（可用 offset/limit 分页），或 grep 该路径检索。`,
    '',
    body,
  ].join('\n')
}

async function onPostExecute(ctx, exec, result, next) {
  const decision = await next()
  try {
    // 走同步缓存：准入判定在每次工具调用上跑，不该多一次磁盘读。
    if (!stateCache.enabled) return decision
    if (!decision || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    if (exec.parent !== undefined) return decision // PTC 子调用不进模型上下文
    if (EXEMPT_TOOLS.has(exec.name)) return decision
    if (result?.isError === true) return decision // 失败结果不裁剪：报错内容是排障必需
    const session = exec.agent?.session
    if (!session) return decision
    // 始终用**原始结果**（result.content）判定与落盘，而不是 decision.content：
    // 同一条瀑布上还有别的监听者（如 spill-policy）可能已经改写过模型可见内容。
    const text = flattenPlainText(result.content)
    if (text === undefined) return decision
    const bytes = byteLen(text)
    if (bytes <= INLINE_MAX_BYTES) return decision
    const logsDir = logsDirOf(ctx, session)
    const entry = await saveResult(ctx, session, logsDir, exec, text, bytes)
    if (!entry) return decision // 落盘失败 → 保持原样（绝不把成功调用变成错误）
    const content = [{ type: 'text', text: receiptText(entry, text) }]
    return decision.additionalContexts ? { kind: 'accept', content, additionalContexts: decision.additionalContexts } : { kind: 'accept', content }
  } catch (error) {
    warn(ctx, '准入过滤失败 ' + String(error))
    return decision
  }
}

// ---------------------------------------------------------------------------
// 落盘与索引
// ---------------------------------------------------------------------------

/** 按会话串行化索引写操作，避免 index.json 读写竞争。 */
const writeQueues = new Map()
function enqueue(sessionId, task) {
  const previous = writeQueues.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  writeQueues.set(sessionId, next.then(() => {}, () => {}))
  return next
}

function safeSegment(value, limit) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, limit)
}

/** 把原文写成纯文本文件并登记进 index.json。返回 null = 不放行收据（写失败，或收据不比原文短）。 */
async function saveResult(ctx, session, logsDir, exec, text, bytes) {
  const sessionId = session.header?.id ?? session.id
  const cursor = cursors.get(sessionId) ?? {}
  const turn = typeof cursor.turn === 'number' ? cursor.turn : 0
  const step = typeof cursor.step === 'number' ? cursor.step : 0
  const dir = join(logsDir, RESULTS_DIR_NAME)
  try {
    return await enqueue(sessionId, async () => {
      const index = (await readIndex(logsDir)) ?? emptyIndex(session)
      const known = index.results.find((item) => item.callId === exec.callId)
      if (known) return known // 幂等：同一次调用只落一份
      const ordinal = index.results.filter((item) => item.turn === turn && item.step === step).length + 1
      const fileName = `${RESULTS_DIR_NAME}/t${String(turn).padStart(4, '0')}-s${String(step).padStart(4, '0')}-${String(ordinal).padStart(2, '0')}-${safeSegment(exec.name, 16)}-${safeSegment(exec.callId, 12)}.txt`
      const entry = {
        turn,
        step,
        callId: typeof exec.callId === 'string' ? exec.callId : null,
        tool: exec.name,
        hint: hintOfArgs(exec.arguments),
        file: join(logsDir, fileName),
        relFile: fileName,
        bytes,
        lines: text.split('\n').length,
        time: Date.now(),
      }
      // 收据若不比原文更短（只有超长 cwd 才会发生），不落盘、原样放行：
      // 准入过滤永不把上下文变大。null 让调用方走「保持原样」分支。
      if (byteLen(receiptText(entry, text)) >= bytes) return null
      await mkdir(dir, { recursive: true })
      await writeFile(join(logsDir, fileName), text, 'utf8')
      index.results.push(entry)
      index.results.sort((a, b) => a.turn - b.turn || a.step - b.step || a.time - b.time)
      index.sessionId = sessionId
      index.workspace = session.header?.cwd ?? null
      index.updatedAt = Date.now()
      await writeFile(join(logsDir, INDEX_FILE), JSON.stringify(index, null, 2), 'utf8')
      return entry
    })
  } catch (error) {
    warn(ctx, '工具结果落盘失败（保持原样）：' + String(error))
    return null
  }
}

async function readIndex(logsDir) {
  try {
    const parsed = JSON.parse(await readFile(join(logsDir, INDEX_FILE), 'utf8'))
    if (parsed && Array.isArray(parsed.results)) return parsed
    // v2（0.7.0 的按轮归档）：只有 rounds，没有 results —— 视为空索引，旧数据由 collectLegacyTurn 兜底。
    if (parsed && Array.isArray(parsed.rounds)) return { ...emptyIndex(null), ...parsed, results: [] }
  } catch {
    // 尚无索引
  }
  return null
}

function emptyIndex(session) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: session?.header?.id ?? session?.id ?? null,
    workspace: session?.header?.cwd ?? null,
    updatedAt: Date.now(),
    results: [],
  }
}

// ---------------------------------------------------------------------------
// read_tool_result_log：模型按轮/步/时间取回归档
// ---------------------------------------------------------------------------

function readToolResultLogTool(ctx) {
  return {
    name: 'read_tool_result_log',
    description: `读取被准入过滤落盘的工具结果原文。当收据给出路径、或任务需要某轮输出时调用：传 turn（轮次号）读取该轮全部归档；传 turn+step 读取该轮该步；传 time（ISO 8601 或毫秒时间戳）读取该时刻所在轮；都不传则返回已归档清单（含文件路径）。每条结果的收据里已直接给出文件路径，也可用 read/grep 直接访问该路径。返回体是纯文本，超过输出预算时按条跳过并提示精确取回。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turn: { type: ['integer', 'string'], description: '对话轮次编号（1 起），如 turn: 3。' },
        step: { type: ['integer', 'string'], description: '可选：步骤编号（1 起），需配合 turn，如 turn: 2, step: 5。' },
        time: { type: 'string', description: 'ISO 8601 时间或毫秒时间戳，读取该时刻所在轮次。' },
        offset: { type: ['integer', 'string'], description: '可选：从**每条结果各自**的第几行开始返回（1 起）。' },
        limit: { type: ['integer', 'string'], description: '可选：每条结果最多返回多少行（配合 offset 取段）。' },
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
      const args = normalizeReadArgs(rawArgs)
      const session = exec.agent?.session
      if (!session) return { error: '无可用会话上下文' }
      const logsDir = logsDirOf(ctx, session)
      try {
        if (typeof args.turn === 'number') return await readByTurn(session, logsDir, args.turn, args.step)
        if (typeof args.time === 'string') return await readByTime(session, logsDir, args.time)
        return await listResults(session, logsDir)
      } catch (error) {
        return { error: '读取归档失败：' + (error instanceof Error ? error.message : String(error)) }
      }
    },
  }
}

function renderRetrieval(args, value) {
  if (value && typeof value.error === 'string') return `错误：${value.error}`
  const parts = []
  if (typeof value?.query === 'string' && value.query !== '') parts.push(`查询：${value.query}`)
  const rounds = Array.isArray(value?.rounds) ? value.rounds : []
  if (rounds.length > 0) {
    parts.push(
      `已归档：${rounds
        .map((round) => `turn ${round?.turn ?? '?'}（${round?.count ?? 0} 条 / ${round?.stepCount ?? 0} 步）`)
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
    const text = typeof entry?.text === 'string' ? entry.text : ''
    const lines = text.split('\n')
    const from = Math.min(offset, lines.length)
    const to = limit > 0 ? Math.min(from + limit - 1, lines.length) : lines.length
    const head =
      `--- turn ${entry?.turn ?? '?'} step ${entry?.step ?? '?'} · ${entry?.toolName ?? 'tool'}` +
      `${entry?.hint ? ` · ${entry.hint}` : ''} · 第 ${from}-${to} 行 / 共 ${lines.length} 行 · ${byteLen(text)} 字节` +
      `${entry?.file ? `\n    路径：${entry.file}` : ''} ---`
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
    parts.push(`⚠️ 还有 ${skipped} 条未显示：输出预算 ${RENDER_BUDGET_BYTES} 字节已到上限。请缩小 turn+step 范围，或用 read 直接读上面给出的文件路径。`)
  }
  return parts.join('\n\n')
}

async function collectTurnData(session, logsDir, turn, step) {
  const index = await readIndex(logsDir)
  const entries = []
  for (const item of index?.results ?? []) {
    if (item.turn !== turn) continue
    if (typeof step === 'number' && item.step !== step) continue
    let text = ''
    try {
      text = await readFile(item.file, 'utf8')
    } catch {
      continue // 文件被清理：跳过，不谎报可读
    }
    entries.push({ turn: item.turn, step: item.step, toolName: item.tool, hint: item.hint, file: item.file, text })
  }
  if (entries.length === 0) entries.push(...(await readLegacyTurn(logsDir, turn, step)))
  return entries
}

/** ≤0.7.0 的按轮归档（round-NNNN.json）仍可读回，避免升级后旧数据看起来消失。 */
async function readLegacyTurn(logsDir, turn, step) {
  let aggregate
  try {
    aggregate = JSON.parse(await readFile(join(logsDir, `round-${String(turn).padStart(4, '0')}.json`), 'utf8'))
  } catch {
    return []
  }
  const out = []
  for (const item of aggregate?.toolResults ?? []) {
    const raw = typeof item?.step === 'number' ? item.step : item?.event?.data?.step
    const resolved = typeof raw === 'number' ? raw : null
    if (typeof step === 'number' && resolved !== step) continue
    let text = ''
    for (const block of item?.event?.data?.message?.content ?? []) {
      if (block?.type !== 'tool-result') continue
      for (const piece of block.content ?? []) if (piece?.type === 'text') text += piece.text ?? ''
    }
    if (text === '') continue
    out.push({
      turn,
      step: resolved,
      toolName: item?.toolName ?? 'tool',
      hint: hintOfArgs(item?.call?.data?.arguments),
      file: null,
      text,
    })
  }
  return out
}

async function readByTurn(session, logsDir, turn, step) {
  if (!Number.isInteger(turn) || turn < 1) return { error: '轮次编号必须为正整数' }
  const entries = await collectTurnData(session, logsDir, turn, step)
  if (entries.length === 0) {
    const rounds = await roundSummaries(logsDir)
    return {
      sessionId: session.header?.id ?? session.id,
      workspace: session.header?.cwd ?? null,
      query: typeof step === 'number' ? `第 ${turn} 轮 第 ${step} 步` : `第 ${turn} 轮`,
      error: `第 ${turn} 轮${typeof step === 'number' ? `第 ${step} 步` : ''}没有归档条目（已归档：${rounds.map((round) => `turn ${round.turn}`).join('、') || '无'}）`,
      rounds,
    }
  }
  return {
    sessionId: session.header?.id ?? session.id,
    workspace: session.header?.cwd ?? null,
    query: typeof step === 'number' ? `第 ${turn} 轮 第 ${step} 步` : `第 ${turn} 轮`,
    turn,
    toolResults: entries,
  }
}

async function readByTime(session, logsDir, time) {
  let at
  const trimmed = time.trim()
  if (/^-?\d+$/.test(trimmed)) at = Number(trimmed)
  else {
    const parsed = new Date(time)
    if (Number.isNaN(parsed.getTime())) return { error: `无法解析时间 "${time}" — 请用 ISO 8601 或毫秒时间戳` }
    at = parsed.getTime()
  }
  const rounds = await roundSummaries(logsDir)
  const index = await readIndex(logsDir)
  const hit = (index?.results ?? []).find((item) => Math.abs((item.time ?? 0) - at) < 30 * 60 * 1000)
  if (!hit) {
    return {
      sessionId: session.header?.id ?? session.id,
      workspace: session.header?.cwd ?? null,
      query: time,
      error: `没有归档条目覆盖 ${new Date(at).toISOString()}（已归档轮次：${rounds.map((round) => round.turn).join('、') || '无'}）`,
      rounds,
    }
  }
  return readByTurn(session, logsDir, hit.turn)
}

async function roundSummaries(logsDir) {
  const index = await readIndex(logsDir)
  const byTurn = new Map()
  for (const item of index?.results ?? []) {
    const record = byTurn.get(item.turn) ?? { turn: item.turn, count: 0, steps: new Set(), bytes: 0, tools: new Set() }
    record.count += 1
    record.steps.add(item.step)
    record.bytes += item.bytes ?? 0
    record.tools.add(item.tool)
    byTurn.set(item.turn, record)
  }
  for (const turn of await legacyRoundTurns(logsDir)) {
    if (!byTurn.has(turn)) byTurn.set(turn, { turn, count: 0, steps: new Set(), bytes: 0, tools: new Set(), legacy: true })
  }
  return [...byTurn.values()]
    .sort((a, b) => a.turn - b.turn)
    .map((record) => ({ turn: record.turn, count: record.count, stepCount: record.steps.size, bytes: record.bytes, tools: [...record.tools] }))
}

/** 旧版按轮归档文件里的轮次号。 */
async function legacyRoundTurns(logsDir) {
  try {
    return (await readdir(logsDir))
      .map((file) => /^round-(\d{4})\.json$/.exec(file))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

async function listResults(session, logsDir) {
  const index = await readIndex(logsDir)
  const rounds = await roundSummaries(logsDir)
  if (rounds.length === 0) {
    return {
      sessionId: session.header?.id ?? session.id,
      workspace: session.header?.cwd ?? null,
      query: '归档清单',
      rounds: [],
      note: '本会话还没有被准入过滤落盘的工具结果（未超过阈值的、豁免工具与失败结果都不落盘）。',
    }
  }
  // 清单模式：给出最近 40 条的坐标与路径，不返回正文（正文用 turn/step 或直接 read 路径取）。
  const recent = (index?.results ?? []).slice(-40)
  return {
    sessionId: session.header?.id ?? session.id,
    workspace: session.header?.cwd ?? null,
    query: '归档清单',
    rounds,
    toolResults: recent.map((item) => ({
      turn: item.turn,
      step: item.step,
      toolName: item.tool,
      hint: item.hint,
      file: item.file,
      text: `（清单模式不返回正文）${item.bytes.toLocaleString('en-US')} 字节 / ${item.lines} 行`,
    })),
    note: '上面每条都带路径，可直接 read/grep；要看正文也可用 turn（+可选 step）取回。',
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
  const next = { enabled: parsed.enabled !== false }
  if (parsed.mode !== undefined) next.mode = parsed.mode // 旧状态文件的遗留字段：原样带着，不再使用
  return next
}

let stateCache = (() => {
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch {
    return defaultState()
  }
})()

async function readState() {
  try {
    stateCache = normalizeState(JSON.parse(await readFile(STATE_FILE, 'utf8')))
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
// 会话目录解析与路径编码（与 dsh-session-persistence-jsonl 一致）
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
  return join(SESSIONS_ROOT, projectKey(session.header.cwd), encodeSegment(session.header.id), LOG_DIR_NAME)
}

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
// 收据里的参数摘要：bash → git status 这类可读提示。
// PTC（run_code）内部真正干活的子调用在事件流里看不到，所以在 tool/ptc-dispatch 里自己收。
// ---------------------------------------------------------------------------

const PTC_MAX_KEYS = 200
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
      return String(args).replace(/\s+/g, ' ').trim().slice(0, 60)
    }
  }
  if (value && typeof value === 'object') {
    for (const field of ['command', 'file_path', 'path', 'pattern', 'query', 'description', 'prompt', 'url']) {
      const raw = value[field]
      if (typeof raw === 'string' && raw.trim() !== '') return raw.replace(/\s+/g, ' ').trim().slice(0, 60)
    }
  }
  return ''
}

function recordPtcDispatch(sessionId, data) {
  try {
    const turn = data && data.turn
    const step = data && data.step
    if (typeof turn !== 'number' || typeof step !== 'number') return
    const book = ptcBookOf(sessionId)
    const key = turn + ':' + step
    const list = book.get(key) || []
    list.push({ tool: (data && data.name) || 'tool', hint: hintOfArgs(data && data.arguments) })
    if (list.length > 8) list.splice(0, list.length - 8)
    book.delete(key)
    book.set(key, list)
    while (book.size > PTC_MAX_KEYS) book.delete(book.keys().next().value)
  } catch {
    // 忽略
  }
}

/** 取某一步登记过的 PTC 子调用（没有则空数组）。 */
export function ptcItems(sessionId, turn, step) {
  try {
    const book = ptcBooks.get(sessionId)
    if (!book || typeof turn !== 'number' || typeof step !== 'number') return []
    const list = book.get(turn + ':' + step)
    return list ? list.map((item) => Object.assign({}, item)) : []
  } catch {
    return []
  }
}

export { flattenPlainText, takeLines, receiptText, INLINE_MAX_BYTES, EXEMPT_TOOLS }
