// E 组：旧数据回读（test-plan §3.6 E1–E4）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, session, callRetrieve, renderRetrieve, tempHome } from './harness.mjs'

const legacyRound = (step) => ({
  toolResults: [
    {
      step,
      toolName: 'bash',
      call: { data: { arguments: '{"command":"echo hi"}' } },
      event: { data: { step, message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'LEGACY-BODY' }] }] } } },
    },
  ],
})

async function bootWithLogs(t, { index, round } = {}) {
  const home = tempHome()
  const base = join(home, 'sess')
  const logsDir = join(base, 'tool-result-logs')
  mkdirSync(logsDir, { recursive: true })
  if (index !== undefined) writeFileSync(join(logsDir, 'index.json'), JSON.stringify(index), 'utf8')
  if (round !== undefined) writeFileSync(join(logsDir, 'round-0001.json'), JSON.stringify(round), 'utf8')
  const env = await boot(t, { home, locate: () => ({ path: join(base, 's.jsonl') }) })
  return { env, logsDir }
}

test('E1 index.json 只有 rounds（0.7.0 v2）：按空结果集处理，不抛错', async (t) => {
  const { env } = await bootWithLogs(t, { index: { schemaVersion: 2, rounds: [{ turn: 1, count: 3 }] } })
  const value = await callRetrieve(env, {}, session())
  assert.match(value.note ?? '', /还没有被准入过滤落盘|没有匹配/)
})

test('E2 round-NNNN.json：从 tool-result 块拼出正文，step 过滤生效', async (t) => {
  const { env } = await bootWithLogs(t, { round: legacyRound(3) })
  const hit = await callRetrieve(env, { turn: 1, step: 3 }, session())
  assert.equal(hit.toolResults.length, 1)
  assert.equal(hit.toolResults[0].text, 'LEGACY-BODY')
  assert.equal(hit.toolResults[0].toolName, 'bash')
  assert.equal(hit.toolResults[0].hint, 'echo hi')

  const miss = await callRetrieve(env, { turn: 1, step: 9 }, session())
  assert.match(miss.error, /没有归档条目/)
})

test('E3 legacy 条目 file 为 null ⇒ 渲染不出现「路径：」', async (t) => {
  const { env } = await bootWithLogs(t, { round: legacyRound(3) })
  const args = { turn: 1 }
  const value = await callRetrieve(env, args, session())
  assert.equal(value.toolResults[0].file, null)
  const rendered = renderRetrieve(env, args, value)
  assert.ok(rendered.includes('LEGACY-BODY'))
  assert.ok(!rendered.includes('路径：'))
})

test('E4 roundSummaries：legacy 轮次以 count:0 出现，legacy 字段不外露', async (t) => {
  const { env } = await bootWithLogs(t, { round: legacyRound(3) })
  const args = {}
  const value = await callRetrieve(env, args, session())
  assert.deepEqual(value.rounds.map((r) => r.turn), [1])
  assert.equal(value.rounds[0].count, 0)
  assert.equal(value.rounds[0].stepCount, 0)
  assert.ok(!Object.hasOwn(value.rounds[0], 'legacy'), 'roundSummaries 的 .map() 丢掉了 legacy 字段（已知死字段）')
  assert.match(renderRetrieve(env, args, value), /turn 1（0 条 \/ 0 步）/)
})
