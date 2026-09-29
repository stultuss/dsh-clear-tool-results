// C 组：落盘与索引（test-plan §3.4 C1–C12）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, session, execOf, textResult, acceptOf, post, setCursor, archive, findIndexes, findResults, readFirstIndex, tempHome, overThreshold, INLINE_MAX_BYTES } from './harness.mjs'

const BIG = (c = 'z') => overThreshold().replaceAll('x', c)

test('C1 文件名形态', async (t) => {
  const env = await boot(t)
  await archive(env, session(), BIG(), { name: 'web_fetch', turn: 1, step: 2, callId: 'call_ab12' })
  const idx = await readFirstIndex(env.home)
  assert.match(idx.results[0].relFile, /^results\/t0001-s0002-01-web_fetch-call_ab12\.txt$/)
})

test('C2 safeSegment：非法字符 → _，工具名截 16、callId 截 12', async (t) => {
  const env = await boot(t)
  await archive(env, session(), BIG(), { name: 'a b!c', callId: 'c'.repeat(200), turn: 1, step: 1 })
  await archive(env, session(), BIG(), { name: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', callId: 'd'.repeat(200), turn: 1, step: 2 })
  const idx = await readFirstIndex(env.home)
  assert.match(idx.results[0].relFile, /-a_b_c-c{12}\.txt$/)
  assert.match(idx.results[1].relFile, /-ABCDEFGHIJKLMNOP-d{12}\.txt$/)
})

test('C3 游标缺失 → t0000-s0000，不抛错', async (t) => {
  const env = await boot(t)
  await archive(env, session(), BIG(), { turn: null })
  const idx = await readFirstIndex(env.home)
  assert.match(idx.results[0].relFile, /^results\/t0000-s0000-01-/)
})

test('C4 落盘内容与原文逐字节一致', async (t) => {
  const env = await boot(t)
  const text = '中文内容 abc\n第二行\n' + BIG('q')
  await archive(env, session(), text)
  const [file] = findResults(env.home)
  assert.equal(Buffer.compare(readFileSync(file), Buffer.from(text, 'utf8')), 0)
})

test('C5 index.json 结构、字段与排序', async (t) => {
  const env = await boot(t)
  await archive(env, session(), BIG(), { turn: 2, step: 1, callId: 'c5-b' })
  await archive(env, session(), BIG(), { turn: 1, step: 1, callId: 'c5-a' })
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.schemaVersion, 3)
  for (const key of ['turn', 'step', 'callId', 'tool', 'hint', 'file', 'relFile', 'bytes', 'lines', 'time']) {
    assert.ok(Object.hasOwn(idx.results[0], key), `缺字段 ${key}`)
  }
  assert.deepEqual(idx.results.map((r) => r.turn), [1, 2], '按 turn 排序')
})

test('C6a 幂等：同 callId 二次调用只落一份', async (t) => {
  const env = await boot(t)
  const s = session()
  const callId = 'call_c6a'
  await archive(env, s, BIG(), { callId })
  await archive(env, s, BIG(), { callId })
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results.length, 1)
  assert.equal(findResults(env.home).length, 1)
})

test('C6b callId 缺失：不幂等，文件名 callId 段为空（已知缺陷）', async (t) => {
  const env = await boot(t)
  const s = session()
  setCursor(env, s, 1, 1)
  for (let i = 0; i < 2; i++) {
    const text = BIG()
    await post(env, execOf({ name: 'bash', callId: undefined, agent: { session: s } }), textResult(text), acceptOf(textResult(text).content))
  }
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results.length, 2, 'callId 缺失 ⇒ 查不到旧条目 ⇒ 每次新落一份')
  assert.equal(idx.results[0].callId, null)
  assert.match(idx.results[0].relFile, /-\.txt$/, "safeSegment 用 `?? ''`，缺失时是空段而不是 \"undefined\"")
})

test('C7 同 turn/step 的 ordinal 递增', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG(), { turn: 1, step: 1, callId: 'c7-1' })
  await archive(env, s, BIG(), { turn: 1, step: 1, callId: 'c7-2' })
  const idx = await readFirstIndex(env.home)
  assert.deepEqual(idx.results.map((r) => r.relFile.match(/-(\d{2})-/)[1]), ['01', '02'])
})

test('C8 同会话并发 5 条：5 文件、ordinal 连续、索引合法', async (t) => {
  const env = await boot(t)
  const s = session()
  setCursor(env, s, 1, 1)
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      post(env, execOf({ name: 'bash', callId: `call_c8_${i}`, agent: { session: s } }), textResult(BIG()), acceptOf(textResult(BIG()).content)),
    ),
  )
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results.length, 5)
  assert.equal(findResults(env.home).length, 5)
  const ords = idx.results.map((r) => r.relFile.match(/-(\d{2})-/)[1]).sort()
  assert.deepEqual(ords, ['01', '02', '03', '04', '05'])
})

test('C9 index.json 损坏：以空索引重建，旧 .txt 仍在', async (t) => {
  const env = await boot(t)
  const s = session()
  await archive(env, s, BIG('A'), { callId: 'c9-a' })
  const [indexFile] = findIndexes(env.home)
  const [oldTxt] = findResults(env.home)
  writeFileSync(indexFile, '{ not json', 'utf8')
  await archive(env, s, BIG('B'), { callId: 'c9-b' })
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results.length, 1, '旧条目已从索引消失')
  assert.equal(idx.results[0].callId, 'c9-b')
  assert.ok(existsSync(oldTxt), '.txt 文件仍在')
})

test('C10 encodeSegment：回退布局里的会话目录名', async (t) => {
  const cases = [['.', '~002E'], ['..', '~002E~002E'], ['a b', 'a~0020b'], ['a~b', 'a~007Eb']]
  for (const [id, seg] of cases) {
    const env = await boot(t)
    await archive(env, session(id, '/tmp/proj'), BIG())
    const idx = await readFirstIndex(env.home)
    assert.ok(idx.results[0].file.includes(`/${seg}/`), `${JSON.stringify(id)} → ${seg}，实际 ${idx.results[0].file}`)
  }
})

test('C10b 空 session id：抛错被兜住 → 原样放行 + warning', async (t) => {
  const env = await boot(t)
  const s = session('')
  const text = BIG()
  const decision = acceptOf(textResult(text).content)
  const out = await post(env, execOf({ agent: { session: s } }), textResult(text), decision)
  assert.equal(out, decision)
  assert.ok(env.warns.length >= 1)
  assert.equal(findIndexes(env.home).length, 0)
})

test('C11 projectKey：分隔符折叠、中文转码、超长截断', async (t) => {
  const cases = [['/a/b', '--a-b--'], ['/a//b', '--a-b--'], ['/中文', '--~4E2D~6587--']]
  for (const [cwd, key] of cases) {
    const env = await boot(t)
    await archive(env, session('session-test', cwd), BIG())
    const idx = await readFirstIndex(env.home)
    assert.ok(idx.results[0].file.includes(`/${key}/`), `${cwd} → ${key}，实际 ${idx.results[0].file}`)
  }

  const env = await boot(t)
  await archive(env, session('session-test', '/' + 'x'.repeat(400)), BIG())
  const idx = await readFirstIndex(env.home)
  const seg = idx.results[0].file.split('/sessions/')[1].split('/')[0]
  assert.equal(seg.length, 255, '2 + 251 + 2')
  assert.ok(seg.startsWith('--') && seg.endsWith('--'))
})

test('C12a persistence.locate 可用时用其父目录', async (t) => {
  const home = tempHome()
  const base = join(home, 'custom')
  const env = await boot(t, { home, locate: () => ({ path: join(base, 'x.jsonl') }) })
  await archive(env, session(), BIG())
  const idx = await readFirstIndex(env.home)
  assert.ok(idx.results[0].file.startsWith(join(base, 'tool-result-logs', 'results')), idx.results[0].file)
})

test('C12b get 抛错时回退默认布局', async (t) => {
  const env = await boot(t, { getThrows: true })
  await archive(env, session('session-test', '/tmp/proj'), BIG())
  const idx = await readFirstIndex(env.home)
  assert.ok(idx.results[0].file.includes(join('sessions', '--tmp-proj--', 'session-test', 'tool-result-logs', 'results')), idx.results[0].file)
})

test('C13 阈值 8192 下「收据不更短就不落盘」护栏不可达（算术事实；护栏保留为安全网）', async (t) => {
  // 收据的可变部分只有 hint(≤60) + 路径 + 预览(≤300) + 固定约 219 ⇒ R 上限约 1.6 KB。
  // 阈值升到 8192 后 R 不可能追上 S，因此护栏的 `return null` 分支在真实路径上不再可达
  // （0.8.2 的 1024 阈值下它是可达的，本用例原先正是在这里断言"原样透传"）。
  // 改为断言仍然成立、且更要紧的那条性质：**收据恒短于原文**（test-plan §3.8 记该分支为已记录未覆盖）。
  const home = join(tempHome(), 'h'.repeat(200))
  const env = await boot(t, { home })
  const text = 'q'.repeat(INLINE_MAX_BYTES + 1)
  const inner = acceptOf(textResult(text).content)
  const exec = execOf({ name: 'bash', callId: 'call_c13', agent: { session: session('session-test', '/' + 'x'.repeat(400)) } })
  const decision = await post(env, exec, textResult(text), inner)
  assert.notEqual(decision, inner, '超阈值 ⇒ 收据化（不再是护栏放行）')
  assert.ok(
    Buffer.byteLength(decision.content[0].text, 'utf8') < Buffer.byteLength(text, 'utf8'),
    '收据必须短于原文',
  )
  assert.equal(findResults(env.home).length, 1, '正常落盘')
  assert.deepEqual(env.warns, [], '无落盘失败')
})

test('C13b 原文更长时正常收据化（护栏只挡「收据更长」）', async (t) => {
  const home = join(tempHome(), 'h'.repeat(200))
  const env = await boot(t, { home })
  const text = 'q'.repeat(INLINE_MAX_BYTES + 4096)
  const inner = acceptOf(textResult(text).content)
  const exec = execOf({ name: 'bash', callId: 'call_c13b', agent: { session: session('session-test', '/' + 'x'.repeat(400)) } })
  const decision = await post(env, exec, textResult(text), inner)
  assert.notEqual(decision, inner)
  assert.equal(findResults(env.home).length, 1)
  assert.match(decision.content[0].text, /全文已落盘/)
  assert.ok(Buffer.byteLength(decision.content[0].text, 'utf8') < INLINE_MAX_BYTES + 4096)
})
