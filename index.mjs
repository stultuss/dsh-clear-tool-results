// Host-plane per-turn tool-result clearing switch for DeepSeek Harness.
//
// Registers the `/clear-tool-results` command and clears each completed turn's
// tool/result surface nodes when enabled. State lives in
// `$DSH_HOME/clear-tool-results.json` (default: enabled).
//
// Host-plane on purpose: preset-mounted plugins cannot reliably register
// global commands (a new preset generation would collide), and the clearing
// behavior should follow the user switch regardless of which preset a session
// uses.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-clear-tool-results'
export const inject = ['commands']

const TOOL_RESULT = 'tool/result'
const TURN_END = 'turn/end'
const CLEARED_TEXT = '[上一轮工具结果已清除]'
const STATE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'clear-tool-results.json')

export function apply(ctx) {
  const disposers = []
  disposers.push(ctx.commands.register({
    name: 'clear-tool-results',
    description: '开关：每轮结束后清除上一轮工具结果。用法：/clear-tool-results on|off|status',
    input: { hint: 'on|off|status' },
    recordInput: false,
    handler: async ({ rawInput }) => {
      const arg = rawInput.trim().toLowerCase()
      if (arg === 'on') {
        await writeEnabled(true)
        return { kind: 'success', text: '已开启：每轮结束后会清除上一轮的工具结果。' }
      }
      if (arg === 'off') {
        await writeEnabled(false)
        return { kind: 'success', text: '已关闭：保留上一轮的工具结果。' }
      }
      if (arg === 'status') {
        return { kind: 'success', text: '当前状态：' + (await readEnabled() ? '开启' : '关闭') }
      }
      return { kind: 'error', text: '用法：/clear-tool-results on|off|status' }
    },
  }))
  disposers.push(ctx.on('session/event', (session, event) => {
    if (event.type !== TURN_END) return
    const endedTurn = event.data.turn
    queueMicrotask(() => {
      readEnabled()
        .then((enabled) => {
          if (!enabled) return
          try {
            clearTurnToolResults(session, endedTurn)
          } catch (error) {
            ctx.logger.warn('dsh-clear-tool-results: ' + String(error))
          }
        })
        .catch((error) => ctx.logger.warn('dsh-clear-tool-results: ' + String(error)))
    })
  }))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

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

function clearTurnToolResults(session, endedTurn) {
  const nodes = [...session.surface.nodes]
  for (const seq of nodes) {
    const original = session.events[seq]
    if (!original || original.type !== TOOL_RESULT) continue
    if (original.surfaceOp !== 'append') continue
    if (original.data.turn !== endedTurn) continue
    session.append(TOOL_RESULT, {
      ...original.data,
      message: clearedMessage(original.data.message),
    }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
  }
}

function clearedMessage(message) {
  return {
    ...message,
    content: message.content.map((block) => ({
      ...block,
      content: [{ type: 'text', text: CLEARED_TEXT }],
    })),
  }
}
