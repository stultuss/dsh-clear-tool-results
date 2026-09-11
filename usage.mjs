import { writeFile } from 'node:fs/promises'
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
//   none            之后再也没有被用过
//
// 用途：先在真实会话里看清四个渠道的比率，再决定要不要投入"引导取回"的改动。

/** 有辨识度的记号：含数字、或含路径/点号分隔符。用于判断"具体事实"是否被转述。 */
const TOKEN_RE = /[A-Za-z0-9_./@:-]{6,}/g
const MAX_TOKENS = 96
const MAX_ENTRIES = 120
const MAX_HINTS = 4
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
    book = { sessionId, entries: [], hints: [], stats: { cleared: 0 }, startedAt: Date.now() }
    books.set(sessionId, book)
  }
  return book
}

/** 登记一条刚被清除的结果：原文只在这里读一次，之后靠记号判断是否被转述/复用。 */
export function recordCleared(sessionId, info) {
  try {
    const book = bookOf(sessionId)
    const text = String(info && info.text ? info.text : '')
    book.entries.push({
      turn: info && info.turn,
      step: info && info.step,
      tool: (info && info.tool) || '?',
      callKey: (info && info.callKey) || null,
      chars: text.length,
      tokens: tokens(text),
      hit: null,
      at: Date.now(),
    })
    if (book.entries.length > MAX_ENTRIES) book.entries.splice(0, book.entries.length - MAX_ENTRIES)
    book.stats.cleared++
  } catch {
    // 埋点失败绝不能影响清除本身
  }
}

/** 助手消息里的"具体事实"重现：每条结果只记第一次命中的渠道。 */
export function attributeText(sessionId, text, channel) {
  try {
    const book = books.get(sessionId)
    if (!book || !text || text.length < 24) return
    // 只对消息分词一次，后续用 Set 命中：避免 entries × tokens 次长文本扫描（事件热路径）
    const present = new Set(String(text).match(TOKEN_RE) || [])
    for (const entry of book.entries) {
      if (entry.hit || entry.tokens.length === 0) continue
      if (entry.tokens.some((token) => present.has(token))) {
        entry.hit = channel
        entry.hitAt = Date.now()
        book.stats[channel] = (book.stats[channel] || 0) + 1
      }
    }
  } catch {
    // 忽略
  }
}

/** 工具调用：同参重跑 -> rerun（并挂一条一次性提示）；用上早先的具体值 -> reuseArgs。 */
export function attributeCall(sessionId, toolName, argsString) {
  try {
    const book = books.get(sessionId)
    if (!book) return
    const key = callKeyOf(toolName, argsString)
    const text = String(argsString == null ? '' : argsString)
    const present = text.length >= 24 ? new Set(text.match(TOKEN_RE) || []) : new Set()
    for (const entry of book.entries) {
      if (entry.hit) continue
      if (entry.callKey && entry.callKey === key) {
        entry.hit = 'rerun'
        entry.hitAt = Date.now()
        book.stats.rerun = (book.stats.rerun || 0) + 1
        const known = book.hints.some((h) => h.turn === entry.turn && h.step === entry.step)
        if (book.hints.length < MAX_HINTS && !known) book.hints.push({ turn: entry.turn, step: entry.step, tool: entry.tool })
        continue
      }
      if (present.size > 0 && entry.tokens.some((token) => present.has(token))) {
        entry.hit = 'reuseArgs'
        entry.hitAt = Date.now()
        book.stats.reuseArgs = (book.stats.reuseArgs || 0) + 1
      }
    }
  } catch {
    // 忽略
  }
}

/** 取回命中：把引用到的轮/步标成 read。 */
export function markRead(sessionId, ref) {
  try {
    const book = books.get(sessionId)
    if (!book) return 0
    let hits = 0
    for (const entry of book.entries) {
      if (entry.hit) continue
      const byStep = ref && typeof ref.turn === 'number' && typeof ref.step === 'number' && entry.turn === ref.turn && entry.step === ref.step
      const byTurn = ref && typeof ref.turn === 'number' && typeof ref.step !== 'number' && entry.turn === ref.turn
      const byTime = ref && typeof ref.time === 'number' && Math.abs((entry.at || 0) - ref.time) < 60000
      if (byStep || byTurn || byTime) {
        entry.hit = 'read'
        entry.hitAt = Date.now()
        book.stats.read = (book.stats.read || 0) + 1
        hits++
      }
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

/** 占位符里的一行索引：让模型不必先取回就知道这一步里有什么。 */
export function indexText(items) {
  try {
    const list = (items || []).filter(Boolean)
    if (list.length === 0) return ''
    const parts = []
    for (const item of list.slice(0, 2)) {
      const chars = item.chars || 0
      const size = chars >= 1000 ? (chars / 1000).toFixed(1) + 'k 字符' : chars + ' 字符'
      parts.push(item.tool + ' → ' + (item.hint || '（无参数）') + '（' + size + (item.failed ? '，失败' : '') + '）')
    }
    if (list.length > 2) parts.push('等 ' + list.length + ' 条')
    return parts.join(' + ')
  } catch {
    return ''
  }
}

function noneCount(stats) {
  const attributed = CHANNELS.reduce((sum, channel) => sum + (stats[channel] || 0), 0)
  return Math.max(0, (stats.cleared || 0) - attributed)
}

/** status 命令里显示的一行汇总。 */
export function summaryText(sessionId) {
  try {
    const book = books.get(sessionId)
    if (!book || (book.stats.cleared || 0) === 0) return null
    const stats = book.stats
    const pct = (n) => Math.round((100 * n) / Math.max(1, stats.cleared)) + '%'
    return [
      '会话归因：清除 ' + stats.cleared + ' 条',
      '取回 ' + (stats.read || 0) + '(' + pct(stats.read || 0) + ')',
      '重跑 ' + (stats.rerun || 0) + '(' + pct(stats.rerun || 0) + ')',
      '转述·文本 ' + (stats.carryText || 0) + '(' + pct(stats.carryText || 0) + ')',
      '转述·推理 ' + (stats.carryReasoning || 0) + '(' + pct(stats.carryReasoning || 0) + ')',
      '参数复用 ' + (stats.reuseArgs || 0) + '(' + pct(stats.reuseArgs || 0) + ')',
      '未再用 ' + noneCount(stats) + '(' + pct(noneCount(stats)) + ')',
    ].join('，')
  } catch {
    return null
  }
}

/** 写 <logsDir>/usage.json（每轮末一次，失败不影响主流程）。 */
export async function persist(sessionId, logsDir) {
  try {
    const book = books.get(sessionId)
    if (!book || (book.stats.cleared || 0) === 0) return
    const payload = {
      schemaVersion: 1,
      sessionId,
      updatedAt: Date.now(),
      stats: Object.assign({}, book.stats, { none: noneCount(book.stats) }),
      entries: book.entries.map((entry) => ({
        turn: entry.turn,
        step: entry.step,
        tool: entry.tool,
        chars: entry.chars,
        channel: entry.hit || 'none',
        channelAt: entry.hitAt || null,
      })),
    }
    await writeFile(join(logsDir, USAGE_FILE), JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    // 忽略
  }
}
