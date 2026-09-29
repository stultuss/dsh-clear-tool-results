// B 组：收据与预览（test-plan §3.3 B1–B9）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boot, session, archive, readFirstIndex } from './harness.mjs'

const L = (n, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n')
const bytes = (s) => Buffer.byteLength(s, 'utf8')

test('B1 头行格式与千分位', async (t) => {
  const env = await boot(t)
  const text = L(50)
  const out = env.mod.receiptText({ tool: 'bash', hint: 'npm test', bytes: 84231, file: '/abs/p' }, text)
  assert.match(out.split('\n')[0], /^\[bash · npm test · 84,231 字节 \/ 50 行 → 全文已落盘，此处是尾部 \d+ 行\]$/)
})

test('B2 第二行是绝对路径', async (t) => {
  const env = await boot(t)
  const out = env.mod.receiptText({ tool: 'bash', hint: 'h', bytes: 5000, file: '/abs/dir/f.txt' }, L(50))
  assert.equal(out.split('\n')[1], '路径：/abs/dir/f.txt')
  assert.match(out.split('\n')[1], /^路径：\//)
})

test('B3 全文不含「已清除」「已删除」', async (t) => {
  const env = await boot(t)
  const out = env.mod.receiptText({ tool: 'bash', hint: 'h', bytes: 5000, file: '/f' }, L(200))
  assert.ok(!out.includes('已清除'))
  assert.ok(!out.includes('已删除'))
})

test('B4 多行输入下预览 ≤300 字节', async (t) => {
  const env = await boot(t)
  const text = L(50)
  for (const fromEnd of [false, true]) {
    const cut = env.mod.takeLines(text, 300, fromEnd)
    assert.ok(bytes(cut.text) <= 300, `预览 ${bytes(cut.text)} 应 ≤300`)
  }
})

test('B5 单行 > 300 字节：按字节裁切（预览是硬上限，不再整行返回）', async (t) => {
  const env = await boot(t)
  const oneLine = 'x'.repeat(400)
  const cut = env.mod.takeLines(oneLine, 300, false)
  assert.equal(cut.lines, 1)
  assert.equal(cut.clipped, true)
  assert.ok(bytes(cut.text) <= 300, `预览 ${bytes(cut.text)} 应 ≤300`)
  assert.ok(oneLine.startsWith(cut.text), '裁切取的是开头')
})

test('B5b 单行裁切：取尾时从末尾切、CJK 不切出半个码点', async (t) => {
  const env = await boot(t)
  const tail = env.mod.takeLines('y'.repeat(400), 300, true)
  assert.equal(bytes(tail.text), 300)
  assert.equal(tail.text, 'y'.repeat(300), '尾部裁切应保留最后 300 字节（去掉首个多余字符）')
  const cjk = env.mod.takeLines('汉'.repeat(200), 301, false) // 每字 3 字节
  assert.equal(bytes(cjk.text), 300)
  assert.equal(cjk.text, '汉'.repeat(100))
})

test('B5c 多行输入下 clipped=false（整行裁剪路径不受影响）', async (t) => {
  const env = await boot(t)
  const cut = env.mod.takeLines(L(50), 300, false)
  assert.equal(cut.clipped, false)
})

test('B6 取端：bash/run_code 尾部，其余开头', async (t) => {
  const env = await boot(t)
  const text = ['FIRST-MARK', ...Array.from({ length: 200 }, (_, i) => `filler-${i}`), 'LAST-MARK'].join('\n')
  for (const tool of ['bash', 'run_code']) {
    const out = env.mod.receiptText({ tool, hint: '', bytes: 5000, file: '/f' }, text)
    assert.ok(out.includes('LAST-MARK'), `${tool} 应取尾部`)
    assert.ok(!out.includes('FIRST-MARK'), `${tool} 不应含首行`)
  }
  for (const tool of ['grep', 'web_fetch', 'glob']) {
    const out = env.mod.receiptText({ tool, hint: '', bytes: 5000, file: '/f' }, text)
    assert.ok(out.includes('FIRST-MARK'), `${tool} 应取开头`)
    assert.ok(!out.includes('LAST-MARK'), `${tool} 不应含末行`)
  }
})

test('B7 截断提示 X = total - lines', async (t) => {
  const env = await boot(t)
  const text = L(80)
  const cut = env.mod.takeLines(text, 300, false)
  const out = env.mod.receiptText({ tool: 'grep', hint: '', bytes: 5000, file: '/f' }, text)
  assert.ok(cut.truncated)
  assert.ok(out.includes(`……（中间省略 ${80 - cut.lines} 行，共 80 行）`))
})

test('B8 行数一致性：收据 / split / index.lines 三者一致', async (t) => {
  const env = await boot(t)
  const text = L(300)
  const { result } = await archive(env, session(), text)
  assert.match(result.content[0].text, /共 300 行/)
  const idx = await readFirstIndex(env.home)
  assert.equal(idx.results[0].lines, text.split('\n').length)
  assert.equal(idx.results[0].lines, 300)
})

test('B9 无 hint 时不出现多余分隔符', async (t) => {
  const env = await boot(t)
  const out = env.mod.receiptText({ tool: 'bash', hint: '', bytes: 12345, file: '/f' }, L(50))
  assert.match(out.split('\n')[0], /^\[bash · 12,345 字节 \//)
})

test('B 组补充：flattenPlainText 无分隔符拼接；含非 text 则 undefined', async (t) => {
  const env = await boot(t)
  assert.equal(env.mod.flattenPlainText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(env.mod.flattenPlainText([{ type: 'text', text: 'a' }, { type: 'image' }]), undefined)
  assert.equal(env.mod.flattenPlainText('not-an-array'), undefined)
})
