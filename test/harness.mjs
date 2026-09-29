// L1 测试脚手架：每个用例一份全新的插件模块实例 + 隔离的 DSH_HOME。
//
// 为什么必须"新鲜实例"：`DSH_HOME`（模块顶层常量）与 `stateCache`（import 时读盘）
// 都在模块求值期定型，中途改 process.env 无效（见 test-plan §3.1 的两条陷阱）。
// 用 `?v=N` 查询串让 ESM 每次都返回新实例。
import { readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_SRC = fileURLToPath(new URL('../index.mjs', import.meta.url))
const PLUGIN_URL = pathToFileURL(PLUGIN_SRC).href
let seq = 0

/**
 * 准入阈值。**从源码读**，避免为了取一个常量而多求值一个模块实例。
 * fixture 一律用 `overThreshold()` 构造（而不是写死字节数），否则阈值一变，
 * 测试会"因为文本不再超阈值"而失真——可能变红，也可能**变成假绿**（见 C13）。
 */
export const INLINE_MAX_BYTES = Number(/const INLINE_MAX_BYTES = (\d+)/.exec(readFileSync(PLUGIN_SRC, 'utf8'))[1])

/** 造一条必然超过准入阈值的纯文本（默认比阈值多 64 字节）。 */
export const overThreshold = (extra = 64) => 'x'.repeat(INLINE_MAX_BYTES + extra)

export const tempHome = () => mkdtempSync(join(tmpdir(), 'dsh-ctr-'))

/** 载入插件并 apply 到一个 mock ctx。t 存在时自动清理临时目录。 */
export async function boot(t, { home = tempHome(), state = null, locate, getThrows = false, loggerWarnThrows = false } = {}) {
  process.env.DSH_HOME = home
  if (state !== null) writeFileSync(join(home, 'clear-tool-results.json'), JSON.stringify(state), 'utf8')
  const mod = await import(`${PLUGIN_URL}?v=${seq++}`)

  const warns = []
  const registered = { commands: [], events: new Map(), tools: [], onOptions: [] }
  const ctx = {
    commands: { register(cmd) { registered.commands.push(cmd); return () => {} } },
    // 复刻 cordis EventsService.on：`{prepend:true}` → unshift（数组头 = waterfall 最外层）。
    on(event, handler, options) {
      registered.onOptions.push({ event, options })
      const list = eventList(registered, event)
      if (options?.prepend) list.unshift(handler)
      else list.push(handler)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    tools: { register(tool) { registered.tools.push(tool); return () => {} } },
    get(name) {
      if (name !== 'sessionPersistence') return undefined
      if (getThrows) throw new Error('no persistence available')
      return locate ? { locate } : undefined
    },
    logger: { warn(m) { if (loggerWarnThrows) throw new Error('logger unavailable'); warns.push(m) } },
  }
  const dispose = mod.apply(ctx)
  if (t) t.after(() => { try { dispose() } catch {} ; rmSync(home, { recursive: true, force: true }) })
  return { mod, home, ctx, registered, warns }
}

// ---------------------------------------------------------------- 事件驱动

export const session = (id = 'session-test', cwd = '/tmp/proj') => ({ id, header: { id, cwd } })

export const execOf = (o) => ({ name: 'bash', callId: `call_${seq++}`, arguments: {}, parent: undefined, ...o })

export const textResult = (text, isError = false) => ({ isError, content: [{ type: 'text', text }] })

export const acceptOf = (content) => ({ kind: 'accept', content })

const postHandler = (env) => env.registered.events.get('tools/post-execute')[0]

/** 跑一次 post-execute；`decision` 就是 next() 的返回值（用于断言"原样透传"）。 */
export function post(env, exec, result, decision) {
  return postHandler(env)(exec, result, async () => decision)
}

// ------------------------------------------------- L5：真实 waterfall 语义
//
// cordis 的 `EventsService.waterfall`：监听器按数组顺序执行，**数组头 = 最外层**；
// `register()` 里 `prepend ? 'unshift' : 'push'`。`dsh-tools` 的 `postExecute` 把同一个
// `result` 对象交给每个监听器，只用最外层活下来的 `decision.content` 覆盖结果。
// 所以「数组顺序」是可断言的宿主语义，这里原样复刻。

function eventList(registered, event) {
  if (!registered.events.has(event)) registered.events.set(event, [])
  return registered.events.get(event)
}

/** 在插件之后追加一个监听器（默认 append = 内层，即宿主内置监听者的注册方式）。 */
export function addListener(env, handler, { prepend = false, event = 'tools/post-execute' } = {}) {
  const list = eventList(env.registered, event)
  if (prepend) list.unshift(handler)
  else list.push(handler)
  return () => {
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }
}

/** 按 waterfall 顺序跑完整条链，返回最外层监听器的 decision。 */
export function runPostExecute(env, exec, result, inner = async () => ({ kind: 'accept' })) {
  const chain = env.registered.events.get('tools/post-execute') ?? []
  let index = -1
  const next = () => {
    index += 1
    const handler = chain[index]
    return handler ? handler(exec, result, next) : inner()
  }
  return next()
}

/** 模型最终看到的文本（最外层 decision 的 content 拍平）。 */
export const visibleText = (decision) =>
  (decision?.content ?? []).map((block) => (block?.type === 'text' ? block.text ?? '' : `<${block?.type}>`)).join('')

/** 推进 turn/step 游标（`session/event` 监听器签名是 (session, event)）。 */
export function setCursor(env, s, turn, step) {
  env.registered.events.get('session/event')[0](s, { data: { turn, step } })
}

/** 造一条会被收据化的大结果并落盘，返回 { decision, session }。 */
export async function archive(env, s, text, { name = 'bash', turn = 1, step = 1, callId, args } = {}) {
  if (turn != null) setCursor(env, s, turn, step)
  const decision = acceptOf(textResult(text).content)
  const result = await post(env, execOf({ name, callId: callId ?? `call_${seq++}`, arguments: args ?? {}, agent: { session: s } }), textResult(text), decision)
  return { decision, result }
}

// ---------------------------------------------------------------- 文件探查

export function findUnder(root, predicate) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (predicate(p)) out.push(p)
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

export const findIndexes = (home) => findUnder(home, (p) => p.endsWith('/index.json'))
export const findResults = (home) => findUnder(home, (p) => p.includes('/tool-result-logs/results/'))

export async function readFirstIndex(home) {
  const [file] = findIndexes(home)
  if (!file) return null
  const { readFileSync } = await import('node:fs')
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 取回工具对象（ctx.tools.register 收到的那个）。 */
export const retrieveTool = (env) => env.registered.tools[0]

export const callRetrieve = (env, args, s) => {
  const exec = { agent: { session: s ?? session() } }
  return retrieveTool(env).execute(args, exec)
}

export const renderRetrieve = (env, args, value) => retrieveTool(env).output.render(args, value)[0].text

export { dirname }
