// D 组：read_tool_result_log（test-plan §3.5 D1–D12）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { boot, session, archive, findResults, readFirstIndex, callRetrieve, renderRetrieve, retrieveTool } from './harness.mjs'

const LP = (n, pad = 60) => Array.from({ length: n }, (_, i) => `line-${i}-` + 'x'.repeat(pad)).join('\n')
const BIG = (n = 3000, c = 'Z') => c.repeat(n)

test('D1 无参：清单模式，不返回正文', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG(), { turn: 1, step: 1, callId: 'd1-a' })
  await archive(env, s, BIG(), { turn: 2, step: 1, callId: 'd1-b' })
  const value = await callRetrieve(env, {}, s)
  assert.equal(value.rounds.length, 2)
  assert.ok(value.toolResults.length >= 2)
  for (const item of value.toolResults) assert.match(item.text, /^（清单模式不返回正文）/)
  assert.match(renderRetrieve(env, {}, value), /已归档：turn 1/)
})

test('D1b 清单模式头行报**真实**尺寸，不再冒充占位串尺寸', async (t) => {
  const env = await boot(t)
  const s = session()
  const text = LP(80) // 80 行，远大于 1024 字节
  await archive(env, s, text, { turn: 1, step: 1, callId: 'd1b-a' })
  const value = await callRetrieve(env, {}, s)
  const idx = await readFirstIndex(env.home)
  const entry = value.toolResults[0]
  assert.equal(entry.bytes, idx.results[0].bytes)
  assert.equal(entry.lines, idx.results[0].lines)
  const out = renderRetrieve(env, {}, value)
  const head = out.split('\n').find((line) => line.startsWith('--- turn 1 step 1'))
  assert.match(head, new RegExp(`${idx.results[0].lines.toLocaleString('en-US')} 行`))
  assert.match(head, new RegExp(`${idx.results[0].bytes.toLocaleString('en-US')} 字节`))
  assert.ok(!head.includes('第 1-1 行'), `清单模式不该声明行窗：${head}`)
})

test('D1c 轮次模式头行格式不变（行窗仍在）', async (t) => {
  const env = await boot(t)
  const s = session()
  const text = LP(80)
  await archive(env, s, text, { turn: 1, step: 1, callId: 'd1c-a' })
  const value = await callRetrieve(env, { turn: 1 }, s)
  const out = renderRetrieve(env, { turn: 1 }, value)
  assert.match(out, /第 1-80 行 \/ 共 80 行 · \d+ 字节/)
})

test('D2 {turn:1}：取回该轮正文与路径', async (t) => {
  const env = await boot(t)
  const s = session()
  const text = BIG(2500, 'A')
  await archive(env, s, text, { turn: 1, step: 1, callId: 'd2-a' })
  const value = await callRetrieve(env, { turn: 1 }, s)
  assert.equal(value.toolResults.length, 1)
  assert.equal(value.toolResults[0].text, text)
  assert.ok(value.toolResults[0].file)
  assert.match(renderRetrieve(env, { turn: 1 }, value), /路径：\//)
})

test('D3 {turn, step}：只取该步', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG(2000, 'A'), { turn: 2, step: 3, callId: 'd3-a' })
  await archive(env, s, BIG(2000, 'B'), { turn: 2, step: 4, callId: 'd3-b' })
  const value = await callRetrieve(env, { turn: 2, step: 3 }, s)
  assert.equal(value.toolResults.length, 1)
  assert.equal(value.toolResults[0].step, 3)
})

test('D4 offset/limit 对每条各自生效', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, LP(20), { turn: 5, step: 1, callId: 'd4-a' })
  await archive(env, s, LP(30), { turn: 5, step: 2, callId: 'd4-b' })
  const args = { turn: 5, offset: 5, limit: 3 }
  const rendered = renderRetrieve(env, args, await callRetrieve(env, args, s))
  assert.equal(rendered.match(/第 5-7 行/g).length, 2, '两条都应该从第 5 行取到第 7 行')
})

test('D5 limit 越界：给出续取提示', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, LP(20), { turn: 1, step: 1, callId: 'd5-a' })
  const args = { turn: 1, limit: 3 }
  const rendered = renderRetrieve(env, args, await callRetrieve(env, args, s))
  assert.match(rendered, /本结果还有 17 行未显示；续取：offset=4, limit=3/)
})

test('D6 合计超 48000：整条跳过并告警', async (t) => {
  const env = await boot(t)
  const s = session()
  for (let i = 0; i < 3; i++) await archive(env, s, BIG(20000), { turn: 1, step: i + 1, callId: `d6-${i}` })
  const args = { turn: 1 }
  const rendered = renderRetrieve(env, args, await callRetrieve(env, args, s))
  assert.match(rendered, /⚠️ 还有 \d+ 条未显示/)
  assert.match(rendered, /已显示 2 条/)
})

test('D7 turn 非正整数：报错', async (t) => {
  const env = await boot(t)
  const s = session()
  for (const turn of [0, -1, 1.5]) {
    const value = await callRetrieve(env, { turn }, s)
    assert.equal(value.error, '轮次编号必须为正整数')
    assert.equal(renderRetrieve(env, { turn }, value), '错误：轮次编号必须为正整数')
  }
})

test('D8 不存在的 turn：报错并列出已归档轮次', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG(), { turn: 1, step: 1, callId: 'd8-a' })
  const value = await callRetrieve(env, { turn: 99 }, s)
  assert.match(value.error, /没有归档条目/)
  assert.match(value.error, /已归档：turn 1/)
})

test('D9 time：毫秒串 / ISO 8601 / 不可解析', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG(), { turn: 4, step: 1, callId: 'd9-a' })
  const idx = await readFirstIndex(env.home)
  const at = idx.results[0].time
  assert.equal((await callRetrieve(env, { time: String(at) }, s)).turn, 4)
  assert.equal((await callRetrieve(env, { time: new Date(at).toISOString() }, s)).turn, 4)
  const bad = await callRetrieve(env, { time: 'not-a-time' }, s)
  assert.match(bad.error, /无法解析时间/)
})

test('D10 归档 .txt 被删除：跳过该条，不谎报可读', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG(2000, 'A'), { turn: 1, step: 1, callId: 'd10-a' })
  await archive(env, s, BIG(2000, 'B'), { turn: 1, step: 2, callId: 'd10-b' })
  const files = findResults(env.home).sort()
  rmSync(files[0])
  const value = await callRetrieve(env, { turn: 1 }, s)
  assert.equal(value.toolResults.length, 1)
})

test('D11 {turn:"3"} 字符串：归一化后命中', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG(), { turn: 3, step: 1, callId: 'd11-a' })
  const value = await callRetrieve(env, { turn: '3' }, s)
  assert.equal(value.turn, 3)
  assert.equal(value.toolResults.length, 1)
})

test('D12 无 session：明确报错', async (t) => {
  const env = await boot(t)
  const value = await retrieveTool(env).execute({}, {})
  assert.equal(value.error, '无可用会话上下文')
  assert.equal(renderRetrieve(env, {}, value), '错误：无可用会话上下文')
})

test('D 组补充：条目全不存在时回退 legacy 后报"没有归档条目"', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG(), { turn: 1, step: 1, callId: 'd13-a' })
  for (const f of findResults(env.home)) rmSync(f)
  const value = await callRetrieve(env, { turn: 1 }, s)
  assert.match(value.error, /没有归档条目/)
})
