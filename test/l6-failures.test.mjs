// L6 组：失败路径与并发（test-plan §8）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, session, execOf, textResult, acceptOf, post, setCursor, archive, findIndexes, findResults, readFirstIndex, callRetrieve, tempHome, overThreshold } from './harness.mjs'

// 默认即"刚过阈值"（阈值 +64 字节），所有用例都是"必须被收据化"的场景。
const BIG = (c = 'z') => overThreshold().replaceAll('x', c)
const isReceipt = (d) => Array.isArray(d?.content) && /^\[/.test(d.content[0].text ?? '')

/** 把 index.json 换成同名目录 ⇒ 写入必然失败（可移植，不依赖权限）。 */
async function breakIndex(env, s) {
  await archive(env, s, BIG(), { callId: 'break-seed' })
  const [indexFile] = findIndexes(env.home)
  rmSync(indexFile)
  mkdirSync(indexFile)
  return indexFile
}

test('6.1 results 不可写：原样放行、结果不是 isError、warning 落盘', async (t) => {
  const home = tempHome()
  writeFileSync(join(home, 'blocker'), 'x')
  const env = await boot(t, { home, locate: () => ({ path: join(home, 'blocker', 's.jsonl') }) })
  const text = BIG()
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), decision)
  assert.equal(out, decision)
  assert.notEqual(out.kind, 'error')
  assert.ok(env.warns.length >= 1)
  assert.ok(existsSync(join(home, 'clear-tool-results.log')))
})

test('6.2 index.json 非法 JSON：以空索引重建，.txt 保留', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG('A'), { callId: 'c6-2-a' })
  const [indexFile] = findIndexes(env.home)
  const [oldTxt] = findResults(env.home)
  writeFileSync(indexFile, 'not json at all', 'utf8')
  await archive(env, s, BIG('B'), { callId: 'c6-2-b' })
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results.length, 1)
  assert.equal(idx.results[0].callId, 'c6-2-b')
  assert.ok(existsSync(oldTxt))
})

test('6.3 index.json 写入失败：原样放行 + warning', async (t) => {
  const env = await boot(t)
  const s = session()
  await breakIndex(env, s)
  const text = BIG()
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ name: 'bash', callId: 'c6-3', agent: { session: s } }), textResult(text), decision)
  assert.equal(out, decision)
  assert.ok(env.warns.length >= 1)
})

test('6.4 同会话并行 5 条：5 文件 + ordinal 连续 + 索引合法', async (t) => {
  const env = await boot(t)
  const s = session()
  setCursor(env, s, 1, 1)
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      post(env, execOf({ name: 'bash', callId: `c6-4-${i}`, agent: { session: s } }), textResult(BIG()), acceptOf(textResult(BIG()).content)),
    ),
  )
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results.length, 5)
  assert.equal(findResults(env.home).length, 5)
  assert.deepEqual(idx.results.map((r) => r.relFile.match(/-(\d{2})-/)[1]).sort(), ['01', '02', '03', '04', '05'])
})

test('6.5 同 callId 并发重复：只落一份', async (t) => {
  const env = await boot(t)
  const s = session()
  setCursor(env, s, 1, 1)
  await Promise.all(
    Array.from({ length: 3 }, () =>
      post(env, execOf({ name: 'bash', callId: 'c6-5', agent: { session: s } }), textResult(BIG()), acceptOf(textResult(BIG()).content)),
    ),
  )
  assert.equal((await readFirstIndex(env.home)).results.length, 1)
  assert.equal(findResults(env.home).length, 1)
})

test('6.6 超长工具名/callId：截断到 16/12，文件名不超限', async (t) => {
  const env = await boot(t)
  await archive(env, session(), BIG(), { name: 'T'.repeat(200), callId: 'c'.repeat(200), turn: 1, step: 1 })
  const idx = await readFirstIndex(env.home)
  const name = idx.results[0].relFile.split('/').pop()
  assert.ok(name.includes('-T'.padEnd(1) + 'T'.repeat(15)), name)
  assert.match(name, /-T{16}-c{12}\.txt$/)
  assert.ok(name.length < 255)
})

test('6.7 游标时序：turn/step 正确落到索引，并可精确定位', async (t) => {
  const env = await boot(t)
  const s = session()
  const text = BIG('A')
  await archive(env, s, text, { turn: 7, step: 2, callId: 'c6-7' })
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results[0].turn, 7)
  assert.equal(idx.results[0].step, 2)
  const value = await callRetrieve(env, { turn: 7, step: 2 }, s)
  assert.equal(value.toolResults[0].text, text)
})

test('6.8 warn() 自身失败（logger 抛错 + 日志路径不可写）不得抛出', async (t) => {
  const home = tempHome()
  mkdirSync(join(home, 'clear-tool-results.log'))       // 日志文件位置被目录占住 ⇒ appendFileSync 失败
  const env = await boot(t, { home, loggerWarnThrows: true })
  const s = session()
  await breakIndex(env, s)
  const text = BIG()
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ name: 'bash', callId: 'c6-8', agent: { session: s } }), textResult(text), decision)
  assert.equal(out, decision, 'warn 自身失败也必须原样返回，不得抛出')
})

test('6.9 DSH_HOME 不存在：默认启用，落盘时自建目录', async (t) => {
  const outer = tempHome()
  const home = join(outer, 'deep', 'nested')
  t.after(() => rmSync(outer, { recursive: true, force: true }))
  const env = await boot(t, { home })
  assert.match((await env.registered.commands[0].handler({ rawInput: 'status' })).text, /当前状态：已启用/)
  await archive(env, session(), BIG())
  assert.equal(findResults(env.home).length, 1)
})

test('6.10 非 ASCII cwd：projectKey 转义后仍可定位', async (t) => {
  const env = await boot(t)
  await archive(env, session('session-test', '/Users/中文 空格/proj'), BIG())
  const idx = await readFirstIndex(env.home)
  assert.ok(idx.results[0].file.includes('~4E2D~6587~0020'), idx.results[0].file)
  assert.ok(existsSync(idx.results[0].file))
  assert.equal(readFileSync(idx.results[0].file, 'utf8').length, BIG().length)
})
