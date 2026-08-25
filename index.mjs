// Host-plane per-turn tool-result pruning switch for DeepSeek Harness.
//
// Registers the `/clear-tool-results` command and prunes each completed turn's
// tool/result surface nodes when enabled:
//   - within the just-finished turn, keep only the last result per tool name;
//   - all tool results from older turns are replaced with a placeholder.
// State lives in `$DSH_HOME/clear-tool-results.json` (default: enabled).
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
const TOOL_CALL = 'tool/call'
const TURN_END = 'turn/end'
const MID_TURN_CLEARED_TEXT = '[middle tool results cleared]'
const PREVIOUS_TURN_CLEARED_TEXT = '[previous-turn tool results cleared]'
const UNKNOWN_TOOL = 'unknown_tool'
const STATE_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'clear-tool-results.json')

export function apply(ctx) {
  const disposers = []
  disposers.push(ctx.commands.register({
    name: 'clear-tool-results',
    description: 'Toggle tool-result pruning: keep only the last result per tool in each turn and clear tool results from older turns. Usage: /clear-tool-results on|off|status',
    input: { hint: 'on|off|status' },
    recordInput: false,
    handler: async ({ rawInput }) => {
      const arg = rawInput.trim().toLowerCase()
      if (arg === 'on') {
        await writeEnabled(true)
        return { kind: 'success', text: 'Enabled: keeps only the last result of each tool per turn and clears tool results from older turns.' }
      }
      if (arg === 'off') {
        await writeEnabled(false)
        return { kind: 'success', text: 'Disabled: all tool results are kept.' }
      }
      if (arg === 'status') {
        return { kind: 'success', text: 'Current state: ' + (await readEnabled() ? 'enabled' : 'disabled') }
      }
      return { kind: 'error', text: 'Usage: /clear-tool-results on|off|status' }
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

  // Map tool-call ids to their tool names: a tool/result's data carries only
  // `message.source.callId`, the tool name lives on the matching tool/call.
  // tool/call is NOT a surface event (the model-visible surface holds only
  // user/message, assistant/message, and tool/result), so it must be looked up
  // in the full append-only event log, never in `session.surface.nodes`.
  const toolNameByCall = new Map()
  for (const original of session.events) {
    if (!original || original.type !== TOOL_CALL) continue
    if (typeof original.data?.callId !== 'string') continue
    if (typeof original.data.name !== 'string') continue
    toolNameByCall.set(original.data.callId, original.data.name)
  }

  // 1. Within this turn, group by tool name and keep the last result per tool.
  const currentToolNodes = []
  for (const seq of nodes) {
    const original = session.events[seq]
    if (!original || original.type !== TOOL_RESULT) continue
    if (original.surfaceOp !== 'append') continue
    if (original.data.turn !== endedTurn) continue
    currentToolNodes.push({ seq, original })
  }

  const lastSeqByTool = new Map()
  for (const { seq, original } of currentToolNodes) {
    lastSeqByTool.set(toolNameOf(original.data, toolNameByCall), seq)
  }
  const keepSeqs = new Set(lastSeqByTool.values())

  for (const { seq, original } of currentToolNodes) {
    if (keepSeqs.has(seq)) continue
    replaceToolResult(session, seq, original.data, MID_TURN_CLEARED_TEXT)
  }

  // 2. Clear all tool results from older turns (including the previous turn's
  //    kept results, now that the current turn has ended).
  for (const seq of nodes) {
    const original = session.events[seq]
    if (!original || original.type !== TOOL_RESULT) continue
    if (original.surfaceOp !== 'append') continue
    if (original.data.turn === endedTurn) continue
    replaceToolResult(session, seq, original.data, PREVIOUS_TURN_CLEARED_TEXT)
  }
}

function toolNameOf(data, toolNameByCall) {
  if (!data) return UNKNOWN_TOOL
  const callId = data.message?.source?.callId
  if (typeof callId === 'string' && toolNameByCall?.has(callId)) {
    return toolNameByCall.get(callId)
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
  // DSH surface rules require a tool/result replacement to keep the
  // tool-result wrapper shape and change only the inner content.
  return {
    ...message,
    content: [{
      ...first,
      content: [{ type: 'text', text }],
    }],
  }
}
