import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 归因埋点（0.6.3 新增）：被清除的工具结果，后来究竟从哪条路被"再用"。
//
// 背景：实测（本机 5 个会话、173 条被清除结果、5191 个可辨识记号）发现模型几乎不调用
// read_tool_result_log：它要么把"具体事实"（哈希/路径/数字/报错串）转述进自己的推理，
// 要么直接重跑同一条命令把内容重新打印一遍。于是"取回"这条设计路径的实际命中率接近 0。
//
// 这个模块只做观测，不改变任何清除/取回行为，产出写 <logsDir>/usage.json：
//   read            取回（read_tool_result_log 命中该轮/该步）
//   rerun           重跑（同工具 + 同参数再次调用，内容被重新打印）
//   carryText       转述进助手可见文本
//   carryReasoning  转述进推理
//   reuseArgs       具体值被复用到新的工具入参
//   common          只被样板记号命中过（工作区路径 / index.mjs 这类到处都有的词）——不算复用证据，
//                   条目会留着等稀有记号，所以它和上面的渠道可能同时出现（诊断用）
//   none            之后再也没有被用过
//
// 用途：先在真实会话里看清四个渠道的比率，再决定要不要投入"引导取回"的改动。

/** 有辨识度的记号：含数字、或含路径/点号分隔符。用于判断"具体事实"是否被转述。 */
const TOKEN_RE = /[A-Za-z0-9_./@:-]{6,}/g
const MAX_TOKENS = 96
const MAX_ENTRIES = 120
const MAX_HINTS = 4
const PTC_MAX_KEYS = 200
const USAGE_FILE = 'usage.json'
const CHANNELS = ['read', 'rerun', 'carryText', 'carryReasoning', 'reuseArgs']

/** sessionId -> book */
const books = new Map()

export function tokens(text) {
  const seen = new Set()
  for (const token of String(text == null ? '' : text).match(TOKEN_RE) || []) {
    if (!/[0-9]/.test(token) && !token.includes('.') && !token.includes('/')) continue
    seen.add(token)
    if (seen.size >= MAX_TOKENS) break
  }
  return [...seen]
}

/** 工具入参统一成可比字符串（重跑判定与"值复用"都用它）。 */
export function argsText(args) {
  if (args == null) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

export function callKeyOf(toolName, argsString) {
  return String(toolName == null ? '?' : toolName) + '|' + String(argsString == null ? '' : argsString).replace(/\s+/g, ' ').trim().slice(0, 80)
}

function bookOf(sessionId) {
  let book = books.get(sessionId)
  if (!book) {
    book = { sessionId, entries: [], hints: [], ptc: new Map(), df: new Map(), stats: { cleared: 0 }, startedAt: Date.now() }
    books.set(sessionId, book)
  }
  return book
}

function rebuildDf(book) {
  book.df = new Map()
  for (const entry of book.entries) {
    for (const token of entry.tokens) book.df.set(token, (book.df.get(token) || 0) + 1)
  }
}

/** 稀有记号：在已登记结果里出现 <=30% 的记号。样板词（工作区路径、index.mjs、run_code…）不算。 */
function isRare(book, token) {
  const limit = Math.max(1, Math.floor(book.entries.length * 0.3))
  return (book.df.get(token) || 0) <= limit
}

/** 从工具入参里抽一行关键参数（命令/路径/模式优先），供占位符索引使用。 */
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
export function recordPtcDispatch(sessionId, data) {
  try {
    const turn = data && data.turn
    const step = data && data.step
    if (typeof turn !== 'number' || typeof step !== 'number') return
    const book = bookOf(sessionId)
    const key = turn + ':' + step
    const list = book.ptc.get(key) || []
    list.push({ tool: (data && data.name) || 'tool', hint: hintOfArgs(data && data.arguments), chars: 0, failed: false })
    if (list.length > 8) list.splice(0, list.length - 8)
    book.ptc.delete(key)
    book.ptc.set(key, list)
    while (book.ptc.size > PTC_MAX_KEYS) book.ptc.delete(book.ptc.keys().next().value)
  } catch {
    // 忽略
  }
}

/** 取某一步登记过的 PTC 子调用（没有则空数组）。 */
export function ptcItems(sessionId, turn, step) {
  try {
    const book = books.get(sessionId)
    if (!book || typeof turn !== 'number' || typeof step !== 'number') return []
    const list = book.ptc.get(turn + ':' + step)
    return list ? list.map((item) => Object.assign({}, item)) : []
  } catch {
    return []
  }
}

/** 登记一条刚被清除的结果：原文只在这里读一次，之后靠记号判断是否被转述/复用。 */
export function recordResult(sessionId, info) {
  try {
    const book = bookOf(sessionId)
    const turn = numberOrNull(info?.turn)
    const step = numberOrNull(info?.step)
    const callKey = info?.callKey ? String(info.callKey) : null
    const dup = book.entries.find(
      (entry) => entry.turn === turn && entry.step === step && (callKey ? entry.callKey === callKey : true),
    )
    if (dup) return dup
    const text = String(info?.text ?? '')
    const entry = {
      turn,
      step,
      tool: String(info?.tool ?? ''),
      callKey,
      chars: text.length,
      tokens: tokens(text),
      at: Date.now(),
      cleared: false,
      commonSeen: false,
      hit: null,
      hitAt: null,
      hitTurn: null,
      hitStep: null,
      channels: [],
    }
    book.entries.push(entry)
    while (book.entries.length > MAX_ENTRIES) book.entries.shift()
    rebuildDf(book)
    return entry
  } catch {
    return null
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** first hit wins for channel/hitTurn/hitStep; later hits only append to channels */
function stamp(entry, channel, ref) {
  if (!entry.channels) entry.channels = []
  if (!entry.channels.includes(channel)) entry.channels.push(channel)
  if (entry.hit) return false
  entry.hit = channel
  entry.hitAt = Date.now()
  entry.hitTurn = numberOrNull(ref?.turn)
  entry.hitStep = numberOrNull(ref?.step)
  return true
}

export function markCleared(sessionId, info) {
  try {
    const book = bookOf(sessionId)
    const turn = numberOrNull(info?.turn)
    const step = numberOrNull(info?.step)
    const callKey = info?.callKey ? String(info.callKey) : null
    let entry = callKey
      ? book.entries.find((item) => item.turn === turn && item.step === step && item.callKey === callKey)
      : null
    if (!entry) {
      const same = book.entries.filter((item) => item.turn === turn && item.step === step && !item.cleared)
      if (same.length === 1) entry = same[0]
    }
    if (!entry) entry = recordResult(sessionId, info)
    if (entry && !entry.cleared) {
      entry.cleared = true
      book.stats.cleared = (book.stats.cleared ?? 0) + 1
    }
    return entry
  } catch {
    return null
  }
}

function match(book, entry, found) {
  if (!entry.tokens || entry.tokens.length === 0) return 'none'
  let hit = false
  for (const token of entry.tokens) {
    if (!found.has(token)) continue
    hit = true
    if (isRare(book, token)) return 'rare'
  }
  return hit ? 'common' : 'none'
}

function touch(book, found, channel, ref) {
  let hits = 0
  for (const entry of book.entries) {
    const verdict = match(book, entry, found)
    if (verdict === 'none') continue
    if (verdict === 'common') {
      entry.commonSeen = true
      continue
    }
    if (stamp(entry, channel, ref)) hits += 1
  }
  return hits
}




function summarize(book) {
  const channels = {}
  let cleared = 0
  let attributed = 0
  let common = 0
  let window = 0
  for (const entry of book.entries) {
    if (!entry.cleared) continue
    cleared += 1
    if (entry.hit) {
      attributed += 1
      channels[entry.hit] = (channels[entry.hit] ?? 0) + 1
      if (entry.hitTurn !== null && entry.hitTurn === entry.turn && entry.hitStep === (entry.step ?? -9) + 1) window += 1
    } else if (entry.commonSeen) {
      common += 1
    }
  }
  return { results: book.entries.length, cleared, attributed, none: cleared - attributed - common, common, window, channels }
}



/** 助手消息里的"具体事实"重现：每条结果只记第一次命中的渠道。 */
export function attributeText(sessionId, text, channel, ref) {
  try {
    if (!text) return 0
    const book = bookOf(sessionId)
    const found = new Set(tokens(String(text)))
    if (found.size === 0) return 0
    return touch(book, found, channel, ref)
  } catch {
    return 0
  }
}
/** 工具调用：同参重跑 -> rerun（并挂一条一次性提示）；用上早先的具体值 -> reuseArgs。 */
export function attributeCall(sessionId, toolName, argsString, ref) {
  try {
    const book = bookOf(sessionId)
    const name = String(toolName ?? '')
    const text = String(argsString ?? '')
    const found = new Set(tokens(text))
    if (found.size === 0) return 0
    const key = callKeyOf(name, text)
    let hits = 0
    for (const entry of book.entries) {
      const verdict = match(book, entry, found)
      if (verdict === 'none') continue
      if (verdict === 'common') {
        entry.commonSeen = true
        continue
      }
      const channel = entry.callKey && key && entry.callKey === key ? 'rerun' : 'reuseArgs'
      if (stamp(entry, channel, ref)) hits += 1
    }
    return hits
  } catch {
    return 0
  }
}
/** 取回命中：把引用到的轮/步标成 read。 */
export function markRead(sessionId, ref, cursor) {
  try {
    const book = bookOf(sessionId)
    const turn = numberOrNull(ref?.turn)
    const step = numberOrNull(ref?.step)
    const at = cursor && typeof cursor.turn === 'number' ? cursor : ref
    let hits = 0
    for (const entry of book.entries) {
      if (turn !== null && entry.turn !== turn) continue
      if (step !== null && entry.step !== step) continue
      if (stamp(entry, 'read', at)) hits += 1
    }
    return hits
  } catch {
    return 0
  }
}
/** 取走待注入的重跑提示（一次性，最多两条）。 */
export function takeHint(sessionId) {
  try {
    const book = books.get(sessionId)
    if (!book || book.hints.length === 0) return ''
    const taken = book.hints.splice(0, 2)
    return taken
      .map((h) => '第 ' + h.turn + ' 轮第 ' + h.step + ' 步的 ' + h.tool + ' 结果已在归档里，同一输出无需重跑：read_tool_result_log(turn: ' + h.turn + ', step: ' + h.step + ')')
      .join('；')
  } catch {
    return ''
  }
}

function shortText(value, limit) {
  const text = String(value == null ? '' : value)
  return text.length > limit ? text.slice(0, Math.max(1, limit - 1)) + '…' : text
}

/** 占位符里的一行索引：让模型不必先取回就知道这一步里有什么；整行压到 60 字以内。 */
export function indexText(items) {
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


/** status 命令里显示的一行汇总。 */
export function summaryText(sessionId) {
  try {
    const stats = summarize(bookOf(sessionId))
    const total = stats.cleared > 0 ? stats.cleared : 1
    const share = (n) => '(' + Math.round((n / total) * 100) + '%)'
    const count = (name) => stats.channels[name] ?? 0
    return (
      '归因 已清除 ' + stats.cleared + ' 条：命中 ' + stats.attributed +
      '（可见窗口内 ' + stats.window + '）  取回 ' + count('read') + share(count('read')) +
      '  重跑 ' + count('rerun') + share(count('rerun')) +
      '  转述·文本 ' + count('carryText') + share(count('carryText')) +
      '  转述·推理 ' + count('carryReasoning') + share(count('carryReasoning')) +
      '  参数复用 ' + count('reuseArgs') + share(count('reuseArgs')) +
      '，样板词命中 ' + stats.common + share(stats.common) + '，未复用 ' + stats.none
    )
  } catch {
    return ''
  }
}/** 写 <logsDir>/usage.json（每轮末一次）。不做兜底：写失败要让调用方看见并记录。 */
export async function persist(sessionId, logsDir) {
  const book = bookOf(sessionId)
  const stats = summarize(book)
  if (stats.cleared === 0 && book.entries.length === 0) return null
  const payload = {
    schemaVersion: 3,
    sessionId,
    updatedAt: Date.now(),
    stats,
    entries: book.entries.map((entry) => ({
      turn: entry.turn,
      step: entry.step,
      tool: entry.tool,
      callKey: entry.callKey,
      chars: entry.chars,
      cleared: entry.cleared,
      channel: entry.hit,
      channels: (entry.channels ?? []).slice(),
      hitTurn: entry.hitTurn,
      hitStep: entry.hitStep,
      common: !!entry.commonSeen,
    })),
    hints: book.hints.slice(),
  }
  const file = join(logsDir, USAGE_FILE)
  await mkdir(logsDir, { recursive: true })
  await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return file
}