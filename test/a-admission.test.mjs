// A 组：准入判定（test-plan §3.2 A1–A15）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, session, execOf, textResult, acceptOf, post, archive, findIndexes, findResults, readFirstIndex, tempHome, overThreshold, INLINE_MAX_BYTES } from './harness.mjs'

const receiptOf = (d) => d.content[0].text
const isReceipt = (d) => d.kind === 'accept' && Array.isArray(d.content) && /^\[/.test(d.content[0].text ?? '')
/** 阈值附近的字节数转成千分位串（收据头行就是这么写的）。 */
const thousands = (n) => n.toLocaleString('en-US')

test('A0 脚手架阈值与实现一致（fixture 全部由它派生，防止阈值变动后测试失真）', async (t) => {
  const env = await boot(t)
  assert.equal(env.mod.INLINE_MAX_BYTES, INLINE_MAX_BYTES)
  assert.equal(Buffer.byteLength(overThreshold(), 'utf8'), INLINE_MAX_BYTES + 64)
})

test('A1 恰好等于阈值：原样放行（<= 边界）', async (t) => {
  const env = await boot(t)
  const text = 'a'.repeat(INLINE_MAX_BYTES)
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), decision)
  assert.equal(out, decision, '必须原样透传（同一对象）')
  assert.equal(findIndexes(env.home).length, 0, '不得落盘')
})

test('A2 阈值 + 1 字节：收据化', async (t) => {
  const env = await boot(t)
  const text = 'a'.repeat(INLINE_MAX_BYTES + 1)
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), decision)
  assert.notEqual(out, decision)
  assert.ok(isReceipt(out), '应是收据')
  assert.match(receiptOf(out), new RegExp(`${thousands(INLINE_MAX_BYTES + 1)} 字节`))
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results.length, 1)
  assert.equal(idx.results[0].bytes, INLINE_MAX_BYTES + 1)
})

test('A3 判定按字节不是字符：边界 -2B 放行 / 边界 +1B 收据化', async (t) => {
  const env = await boot(t)
  const s = session()
  const chars = Math.floor(INLINE_MAX_BYTES / 3) // 每字 3 字节
  const small = '汉'.repeat(chars)
  const smallBytes = Buffer.byteLength(small, 'utf8')
  assert.ok(smallBytes <= INLINE_MAX_BYTES, `${smallBytes} 应不超过阈值`)
  const d1 = acceptOf(textResult(small).content)
  assert.equal(await post(env, execOf({ agent: { session: s } }), textResult(small), d1), d1)

  const big = '汉'.repeat(chars + 1)
  const bigBytes = Buffer.byteLength(big, 'utf8')
  assert.ok(bigBytes > INLINE_MAX_BYTES, `${bigBytes} 应超过阈值`)
  const d2 = acceptOf(textResult(big).content)
  const out = await post(env, execOf({ agent: { session: s } }), textResult(big), d2)
  assert.ok(isReceipt(out))
  assert.match(receiptOf(out), new RegExp(`${thousands(bigBytes)} 字节`))
})

test('A4 多个 text block 无分隔符拼接后再判定', async (t) => {
  const env = await boot(t)
  const a = 'a'.repeat(INLINE_MAX_BYTES)
  const b = 'b'
  const content = [{ type: 'text', text: a }, { type: 'text', text: b }]
  const result = { isError: false, content }
  const out = await post(env, execOf({ agent: { session: session() } }), result, acceptOf(content))
  assert.ok(isReceipt(out), '拼接后越过阈值应被收据化')
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results[0].bytes, INLINE_MAX_BYTES + 1)
  const [file] = findResults(env.home)
  assert.equal(readFileSync(file, 'utf8'), a + b, '落盘内容必须是 "ab"，无分隔符')
})

test('A5 含非 text block：原样且不落盘', async (t) => {
  const env = await boot(t)
  const content = [{ type: 'text', text: overThreshold(100) }, { type: 'image', data: 'zz' }]
  const result = { isError: false, content }
  const decision = acceptOf(content)
  const out = await post(env, execOf({ agent: { session: session() } }), result, decision)
  assert.equal(out, decision)
  assert.equal(findIndexes(env.home).length, 0)
})

test('A6 read_tool_result_log 完全豁免（按名字）', async (t) => {
  const env = await boot(t)
  const big = 'x'.repeat(200_000)
  const decision = acceptOf(textResult(big).content)
  const out = await post(env, execOf({ name: 'read_tool_result_log', agent: { session: session() } }), textResult(big), decision)
  assert.equal(out, decision, '取回通道本身必须原样放行')
  assert.equal(findIndexes(env.home).length, 0)
})

test('A7 read 不再全豁免：读普通大文件 → 收据化 + 落盘（0.8.6）', async (t) => {
  const env = await boot(t)
  const s = session('session-test', '/tmp/proj')
  const big = overThreshold(200_000)
  const decision = acceptOf(textResult(big).content)
  const exec = execOf({ name: 'read', arguments: { file_path: '/tmp/proj/src/big.ts' }, agent: { session: s } })
  const out = await post(env, exec, textResult(big), decision)
  assert.ok(isReceipt(out), '首次读大文件应被收据化')
  assert.equal(findIndexes(env.home).length, 1)
  const [file] = findResults(env.home)
  assert.equal(readFileSync(file, 'utf8'), big, '落盘必须是原文')
})

test('A7b read 读任何会话的 tool-result-logs 归档 → 豁免（取回通道）', async (t) => {
  const env = await boot(t)
  const s = session('session-test', '/tmp/proj')
  const big = overThreshold(200_000)
  const paths = [
    '/tmp/proj/tool-result-logs/results/t0001-s0001-01-bash-call_x.txt', // 本会话布局
    '/Users/someone/.dsh/sessions/--other-proj--/session-abc/tool-result-logs/index.json', // 别的会话
    '/tmp/proj/tool-result-logs/round-0001.json', // legacy 轮文件
  ]
  for (const filePath of paths) {
    const decision = acceptOf(textResult(big).content)
    const exec = execOf({ name: 'read', arguments: { file_path: filePath }, agent: { session: s } })
    const out = await post(env, exec, textResult(big), decision)
    assert.equal(out, decision, `${filePath} 必须原样放行`)
  }
  assert.equal(findIndexes(env.home).length, 0)
})

test('A7c read 同一路径第二次起放行（重复读 = 真的需要）', async (t) => {
  const env = await boot(t)
  const s = session('session-test', '/tmp/proj')
  const big = overThreshold(200_000)
  const exec = () => execOf({ name: 'read', arguments: { file_path: '/tmp/proj/src/big.ts' }, agent: { session: s } })
  const first = await post(env, exec(), textResult(big), acceptOf(textResult(big).content))
  assert.ok(isReceipt(first), '第一次收据化')
  assert.equal(findIndexes(env.home).length, 1)
  const second = acceptOf(textResult(big).content)
  const out = await post(env, exec(), textResult(big), second)
  assert.equal(out, second, '第二次原样放行（不新增归档、不再多要一轮）')
  assert.equal(findIndexes(env.home).length, 1, '没有第二条归档')
})

test('A7d read 的"第二次起放行"按会话隔离，且相对路径按 cwd 解析', async (t) => {
  const env = await boot(t)
  const a = session('session-a', '/tmp/projA')
  const b = session('session-b', '/tmp/projB')
  const big = overThreshold(200_000)
  const read = (s, p) => post(env, execOf({ name: 'read', arguments: { file_path: p }, agent: { session: s } }), textResult(big), acceptOf(textResult(big).content))
  assert.ok(isReceipt(await read(a, 'src/big.ts')), 'A 会话首次（相对路径）收据化')
  assert.ok(isReceipt(await read(b, 'src/big.ts')), 'B 会话是**另一个**会话，仍算首次')
  // 注意：要断言"原样透传"必须自己持有那个 decision 对象——read() 内部会新建一个。
  const third = acceptOf(textResult(big).content)
  const out = await post(env, execOf({ name: 'read', arguments: { file_path: '/tmp/projA/src/big.ts' }, agent: { session: a } }), textResult(big), third)
  assert.equal(out, third, 'A 会话同一文件的绝对路径写法也应命中"已收据化"')
})

test('A7e read 取不到路径（无 file_path）：按普通工具规则收据化', async (t) => {
  const env = await boot(t)
  const big = overThreshold(200_000)
  const decision = acceptOf(textResult(big).content)
  const out = await post(env, execOf({ name: 'read', arguments: {}, agent: { session: session() } }), textResult(big), decision)
  assert.ok(isReceipt(out), '没有路径就无法判定为归档读取，按普通工具处理')
})

test('A7f read 小文件（≤阈值）：放行且不落盘', async (t) => {
  const env = await boot(t)
  const small = 'x'.repeat(INLINE_MAX_BYTES)
  const decision = acceptOf(textResult(small).content)
  const out = await post(env, execOf({ name: 'read', arguments: { file_path: '/tmp/proj/small.ts' }, agent: { session: session() } }), textResult(small), decision)
  assert.equal(out, decision)
  assert.equal(findIndexes(env.home).length, 0)
})

test('A8 isError：原样放行', async (t) => {
  const env = await boot(t)
  const text = overThreshold()
  const decision = acceptOf(textResult(text, true).content)
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text, true), decision)
  assert.equal(out, decision)
  assert.equal(findIndexes(env.home).length, 0)
})

test('A9 PTC 内层（exec.parent）：原样、不落盘', async (t) => {
  const env = await boot(t)
  const text = overThreshold()
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ parent: 'outer', agent: { session: session() } }), textResult(text), decision)
  assert.equal(out, decision)
  assert.equal(findIndexes(env.home).length, 0)
})

test('A10 next 返回非 accept：原样透传', async (t) => {
  const env = await boot(t)
  const text = overThreshold()
  const decision = { kind: 'error', content: textResult(text).content }
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), decision)
  assert.equal(out, decision)
})

test('A11 next 返回含 value 的 accept：原样（Object.hasOwn 不变式）', async (t) => {
  const env = await boot(t)
  const text = overThreshold()
  const decision = { kind: 'accept', value: { structured: true }, content: textResult(text).content }
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), decision)
  assert.equal(out, decision)
  assert.equal(findIndexes(env.home).length, 0)
})

test('A12 收据化后仍带 additionalContexts', async (t) => {
  const env = await boot(t)
  const text = overThreshold()
  const additionalContexts = { keep: 'me' }
  const decision = { kind: 'accept', content: textResult(text).content, additionalContexts }
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), decision)
  assert.ok(isReceipt(out))
  assert.equal(out.additionalContexts, additionalContexts)
})

test('A13 停用态：原样且零落盘', async (t) => {
  const env = await boot(t, { state: { enabled: false } })
  const text = overThreshold()
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), decision)
  assert.equal(out, decision)
  assert.equal(findIndexes(env.home).length, 0)
  assert.equal(findResults(env.home).length, 0)
})

test('A14 落盘失败：原样放行 + warning，且不把成功调用变成错误', async (t) => {
  const home = tempHome()
  writeFileSync(join(home, 'blocker'), 'x')            // 让 results 的父路径是一个文件
  const env = await boot(t, { home, locate: () => ({ path: join(home, 'blocker', 's.jsonl') }) })
  const text = overThreshold()
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ agent: { session: session() } }), textResult(text), decision)
  assert.equal(out, decision, '必须是原决策，不得是 isError')
  assert.ok(env.warns.length >= 1, '应写 warning')
  assert.ok(existsSync(join(home, 'clear-tool-results.log')), 'warning 应落到日志文件')
})

test('A15 无 session：原样放行', async (t) => {
  const env = await boot(t)
  const text = overThreshold()
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({}), textResult(text), decision)
  assert.equal(out, decision)
  assert.equal(findIndexes(env.home).length, 0)
})

test('A 组补充：archive() 造出的收据头包含绝对路径', async (t) => {
  const env = await boot(t)
  const { result } = await archive(env, session(), overThreshold().replaceAll('x', 'y'))
  assert.ok(isReceipt(result))
  assert.match(receiptOf(result), /路径：\//)
})
