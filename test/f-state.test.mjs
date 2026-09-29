// F 组：状态与命令面（test-plan §3.7 F1–F6）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, session, execOf, textResult, acceptOf, post } from './harness.mjs'

const cmd = (env) => env.registered.commands[0]
const statePath = (env) => join(env.home, 'clear-tool-results.json')
const readState = (env) => JSON.parse(readFileSync(statePath(env), 'utf8'))
const isReceipt = (d) => Array.isArray(d?.content) && /^\[/.test(d.content[0].text ?? '')

test('F1 on / off / status / 非法参数', async (t) => {
  const env = await boot(t)
  assert.equal((await cmd(env).handler({ rawInput: ' on ' })).kind, 'success')
  assert.deepEqual(readState(env), { enabled: true })
  assert.equal((await cmd(env).handler({ rawInput: 'off' })).kind, 'success')
  assert.deepEqual(readState(env), { enabled: false })
  const st = await cmd(env).handler({ rawInput: 'status' })
  assert.equal(st.kind, 'success')
  assert.match(st.text, /当前状态：已禁用/)
  assert.equal((await cmd(env).handler({ rawInput: 'nonsense' })).kind, 'error')
})

test('F2 status 的版本号来自同目录 package.json', async (t) => {
  const env = await boot(t)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const st = await cmd(env).handler({ rawInput: 'status' })
  assert.ok(st.text.includes(`插件版本：${pkg.version}`), st.text)
  assert.match(st.text, /准入阈值：1024 字节/)
  assert.match(st.text, /豁免工具：read、read_tool_result_log/)
})

test('F3 状态文件缺失：默认 enabled: true', async (t) => {
  const env = await boot(t)
  assert.ok(!existsSync(statePath(env)))
  assert.match((await cmd(env).handler({ rawInput: 'status' })).text, /当前状态：已启用/)
})

test('F4 旧状态含 mode：原样保留但不再使用', async (t) => {
  const env = await boot(t, { state: { enabled: true, mode: 'overclock' } })
  assert.match((await cmd(env).handler({ rawInput: 'status' })).text, /当前状态：已启用/)
  const text = 'x'.repeat(3000)
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), acceptOf(textResult(text).content))
  assert.ok(isReceipt(out), 'mode 不影响启用行为')
})

test('F5 禁用态：read_tool_result_log 仍被注册', async (t) => {
  const env = await boot(t, { state: { enabled: false } })
  assert.equal(env.registered.tools.length, 1)
  assert.equal(env.registered.tools[0].name, 'read_tool_result_log')
})

test('F6 外部直接改状态文件：不立即生效，走命令后刷新', async (t) => {
  const env = await boot(t, { state: { enabled: true } })
  const s = session()
  const mk = () => {
    const text = 'x'.repeat(3000)
    return post(env, execOf({ agent: { session: s } }), textResult(text), acceptOf(textResult(text).content))
  }
  assert.ok(isReceipt(await mk()), '初始为启用')

  writeFileSync(statePath(env), JSON.stringify({ enabled: false }), 'utf8')
  assert.ok(isReceipt(await mk()), '外部改动不该立刻生效（stateCache 未刷新）')

  await cmd(env).handler({ rawInput: 'status' })
  const after = await mk()
  assert.ok(!isReceipt(after), '走命令路径后缓存刷新，应放行')
})
