// L5：与宿主内置 `tools/post-execute` 监听者共存（test-plan §7）。
//
// 结论性事实（读宿主源码得到，本文件把它固化成回归断言）：
//   1. cordis `EventsService.waterfall`：监听器按注册数组顺序执行，**数组头 = 最外层**；
//      `register()` 用 `prepend ? 'unshift' : 'push'`（cordis `src/events.ts`）。
//   2. 本插件用 `{prepend:true}` 注册 ⇒ 在数组头 ⇒ 最外层。
//   3. 宿主内置监听者一律**不带选项**（= append = 内层）：
//      `dsh-spill-policy`（:155）、`dsh-tool-fs-search`（:848 / :1159）、
//      `dsh-repeat-tool-reminder`（:1495）。
//   4. `dsh-tools` 的 `postExecute` 把**同一个 `result` 对象**交给每个监听器，只用最外层
//      活下来的 `decision.content` 覆盖结果 ⇒ 本插件读 `result.content` 永远拿到原文，
//      与顺序无关（这就是 5.3 的防御）；但**收据本身**会被外层监听器覆盖（见 5.3 反序用例）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  boot,
  session,
  execOf,
  textResult,
  findResults,
  addListener,
  runPostExecute,
  visibleText,
} from './harness.mjs'

const L = (n, ch = 'x') => `${ch}`.repeat(n)
// 每行 9 字符 + 换行 ⇒ n 行共 10n−1 字节。调用点必须让总量超过准入阈值
// （n ≥ 1000 ⇒ 9,999 B > 8192）；5.2b 还依赖这个换算式断言 59,999。
const bigText = (n) => Array.from({ length: n }, (_, i) => `LINE-${String(i + 1).padStart(4, '0')}`).join('\n')

/** 模拟 `dsh-spill-policy`：内层 append，把 decision.content 换成预览 + 落盘通知。 */
const spillLike = (notice) => async (exec, result, next) => {
  const decision = await next()
  if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
  if (exec.parent !== undefined || exec.name === 'read') return decision
  return { kind: 'accept', content: [{ type: 'text', text: notice }] }
}

test('5.1 本插件以 prepend 注册（= waterfall 数组头 = 最外层）', async (t) => {
  const env = await boot(t)
  const registration = env.registered.onOptions.find((row) => row.event === 'tools/post-execute')
  assert.deepEqual(registration, { event: 'tools/post-execute', options: { prepend: true } })
  // 数组头正是本插件的监听器（apply 期间注册，先于任何竞争者）
  assert.equal(env.registered.events.get('tools/post-execute').length, 1)
})

test('5.1b 内层（append）监听者改写了 content：最终仍是本插件收据', async (t) => {
  const env = await boot(t)
  addListener(env, spillLike('SPILL-PREVIEW-ONLY'))
  const s = session()
  const exec = execOf({ name: 'bash', callId: 'call_l5_b', agent: { session: s } })
  const decision = await runPostExecute(env, exec, textResult(bigText(1000)))
  const visible = visibleText(decision)
  assert.match(visible, /全文已落盘/)
  assert.ok(!visible.includes('SPILL-PREVIEW-ONLY'), '内层预览必须被丢弃')
  assert.equal(findResults(env.home).length, 1)
})

test('5.2 内层已把 decision.content 换成预览：本插件仍按 result.content 落全文', async (t) => {
  const env = await boot(t)
  addListener(env, spillLike('SPILL-PREVIEW-ONLY'))
  const s = session()
  const original = bigText(1000) // 9,999 B（大于准入阈值）
  const exec = execOf({ name: 'web_fetch', callId: 'call_l5_c', agent: { session: s } })
  const decision = await runPostExecute(env, exec, textResult(original))
  const [file] = findResults(env.home)
  assert.equal(readFileSync(file, 'utf8'), original, '落盘必须是原文全文，不是内层预览')
  const visible = visibleText(decision)
  assert.ok(visible.includes(file), '收据路径必须指向本插件自己的落盘文件')
  assert.match(visible, /LINE-0001/) // web_fetch → 头部预览
})

test('5.3 反序（竞争者 prepend 后注册 = 外层）：收据被覆盖，但全文已落盘', async (t) => {
  const env = await boot(t)
  addListener(env, spillLike('SPILL-PREVIEW-ONLY'), { prepend: true })
  const s = session()
  const original = bigText(1000)
  const exec = execOf({ name: 'bash', callId: 'call_l5_d', agent: { session: s } })
  const decision = await runPostExecute(env, exec, textResult(original))
  // 记为已知边界：本插件的正确性依赖「没有别的插件也 prepend 在我们之后」。
  assert.equal(visibleText(decision), 'SPILL-PREVIEW-ONLY')
  const [file] = findResults(env.home)
  assert.equal(readFileSync(file, 'utf8'), original, '收据虽被覆盖，全文仍可从索引路径取回')
})

test('5.2b >50000 字节结果：收据路径指向本插件全文，不是宿主 spill 预览', async (t) => {
  const env = await boot(t)
  addListener(env, spillLike('(Omitted 60000 bytes. Full formatted result stored at: /tmp/spill-xyz.txt)'))
  const s = session()
  const original = bigText(6000) // 59,999 B
  const exec = execOf({ name: 'bash', callId: 'call_l5_e', agent: { session: s } })
  const decision = await runPostExecute(env, exec, textResult(original))
  const visible = visibleText(decision)
  assert.ok(!visible.includes('spill-xyz'), '模型不该看到 spill 的路径')
  assert.ok(!visible.includes('Full formatted result stored at'))
  const [file] = findResults(env.home)
  assert.ok(visible.includes(file))
  assert.equal(readFileSync(file, 'utf8'), original)
  assert.equal(readFileSync(file, 'utf8').length, 59999)
})

test('5.6 PTC：内层子调用不落盘，外层落盘', async (t) => {
  const env = await boot(t)
  const s = session()
  const inner = execOf({ name: 'bash', callId: 'call_l5_f1', parent: 'call_outer', agent: { session: s } })
  await runPostExecute(env, inner, textResult(bigText(1000)))
  assert.equal(findResults(env.home).length, 0)
  const outer = execOf({ name: 'run_code', callId: 'call_l5_f2', agent: { session: s } })
  await runPostExecute(env, outer, textResult(bigText(1000)))
  assert.equal(findResults(env.home).length, 1)
})

test('5.4 read 读归档仍豁免：超大结果原样透传（不落盘、不加 content）', async (t) => {
  const env = await boot(t)
  const s = session()
  const exec = execOf({
    name: 'read',
    callId: 'call_l5_g',
    arguments: { file_path: '/tmp/proj/tool-result-logs/results/t0001-s0001-01-bash-call_x.txt' },
    agent: { session: s },
  })
  const decision = await runPostExecute(env, exec, textResult(L(200000, 'z')))
  assert.ok(!Object.hasOwn(decision, 'content'), '归档读取没有任何监听者改写 ⇒ 宿主保留原始 content')
  assert.equal(findResults(env.home).length, 0)
})

test('5.4b read 读普通大文件：本插件（最外层）收据化，压过内层 spill 预览', async (t) => {
  const env = await boot(t)
  addListener(env, spillLike('SPILL-PREVIEW-ONLY'))
  const s = session()
  const original = bigText(1000)
  const exec = execOf({ name: 'read', callId: 'call_l5_g2', arguments: { file_path: '/tmp/proj/src/big.ts' }, agent: { session: s } })
  const decision = await runPostExecute(env, exec, textResult(original))
  assert.match(visibleText(decision), /全文已落盘/)
  assert.ok(!visibleText(decision).includes('SPILL-PREVIEW-ONLY'), '内层预览被丢弃')
  const [file] = findResults(env.home)
  assert.equal(readFileSync(file, 'utf8'), original, '落盘的是 read 的原文')
})

test('5.7 内层 listener 合并 additionalContexts（repeat-tool-reminder 形状）后仍被保留', async (t) => {
  const env = await boot(t)
  addListener(env, async (exec, result, next) => {
    const downstream = await next()
    return { ...downstream, additionalContexts: [{ type: 'text', text: 'REPEAT-REMINDER' }] }
  })
  const s = session()
  const exec = execOf({ name: 'bash', callId: 'call_l5_h', agent: { session: s } })
  const decision = await runPostExecute(env, exec, textResult(bigText(1000)))
  assert.match(visibleText(decision), /全文已落盘/)
  assert.deepEqual(decision.additionalContexts, [{ type: 'text', text: 'REPEAT-REMINDER' }])
})
