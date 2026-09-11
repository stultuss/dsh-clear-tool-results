#!/usr/bin/env node
/**
 * dsh-clear-tool-results · 核心代数兼容性验证
 *
 * 对每个核心代数做一遍「原始 → 应用 → 功能断言 → 回退」的闭环检查，
 * 用来防止补丁定义在核心升级后静默失效，也用来回归已支持的旧代数。
 *
 * 用法
 *   # 用已解包的核心目录（离线，推荐 CI 用本地缓存）
 *   node patches/check-harness-compat.mjs --tree legacy=/path/to/0.1.2 --tree seq=/path/to/0.1.5
 *   # 从 npm 拉取指定版本（需要网络）
 *   node patches/check-harness-compat.mjs --pack 0.1.2-rc.1 --pack 0.1.5-rc.1
 *   # 额外验证「已装 v1 补丁的核心能就地升级」（传真实 dsh 安装目录，脚本只读拷贝）
 *   node patches/check-harness-compat.mjs --tree legacy=... --v1-tree /usr/local/lib/node_modules/@deepseek-ai/dsh
 *
 * tree 目录需包含 dsh-session/ 与 dsh-agent-loop/ 两个包目录。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'))
// 备份写到临时目录，避免污染用户真实的 ~/.dsh 备份（也便于 CI 运行）
process.env.DSH_CLEAR_TOOL_RESULTS_BACKUP_DIR = path.join(workRoot, 'backups')

const {
  AGENT_LOOP_REL,
  GEN_LEGACY,
  GEN_SEQ,
  SESSION_REL,
  V2_SEQ_REPLACE_OP_SHAPE,
  applyPatches,
  coreGeneration,
  patchStatus,
  revertPatches,
} = await import('./patch-core.mjs')

const args = process.argv.slice(2)
const argValues = (flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []))
const trees = argValues('--tree').map((spec) => {
  const [label, dir] = spec.split('=')
  return { label, dir }
})
const packs = argValues('--pack')
const v1Tree = argValues('--v1-tree')[0]

/** 把「包目录」组装成一个带 node_modules 布局的核心树。 */
function assembleTree(label, sourceDir) {
  const root = path.join(workRoot, label)
  const nm = path.join(root, 'node_modules', '@deepseek-ai')
  fs.mkdirSync(nm, { recursive: true })
  for (const pkg of ['dsh-session', 'dsh-agent-loop']) {
    const nested = path.join(sourceDir, 'node_modules', '@deepseek-ai', pkg)
    const source = fs.existsSync(nested) ? nested : path.join(sourceDir, pkg)
    if (!fs.existsSync(source)) throw new Error(`${label}: 找不到 ${pkg}（${source}）`)
    fs.cpSync(source, path.join(nm, pkg), { recursive: true })
  }
  return root
}

/** 截取源码里的一个顶层函数（从 function 头到下一个 "\n}"）。 */
function extractFunctionText(source, marker) {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`未找到 ${marker}`)
  const end = source.indexOf('\n}', start)
  return source.slice(start, end + 2)
}

/** 从已打补丁的 session 源码里取出 isReplaceOp / surfaceOpOf 并真跑一遍（严格模式）。 */
function loadSurfaceOpHelpers(source) {
  const isEventSeq = (value) => Number.isInteger(value) && value >= 0
  // 严格模式：冻结对象上的写入会抛错，从而暴露「就地归一化」这类写法
  const factory = new Function(
    'isEventSeq',
    'isSurfaceEligibleType',
    'KNOWN_SESSION_EVENT_TYPES',
    `"use strict";\n${extractFunctionText(source, 'function isReplaceOp(')}\n${extractFunctionText(source, 'function surfaceOpOf(')}\nreturn { isReplaceOp, surfaceOpOf }`,
  )
  return factory(isEventSeq, () => true, new Set())
}

const failures = []
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failures.push(`${label}${detail ? `：${detail}` : ''}`)
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` —— ${detail}`}`)
  return ok
}

function exercise(label, treeRoot, expectation) {
  console.log(`\n【${label}】${treeRoot}`)
  const sessionPath = path.join(treeRoot, SESSION_REL)
  const loopPath = path.join(treeRoot, AGENT_LOOP_REL)
  const before = { session: fs.readFileSync(sessionPath, 'utf8'), loop: fs.readFileSync(loopPath, 'utf8') }

  const pristine = patchStatus(treeRoot)
  check('代数识别', pristine.generation === expectation.generation, `期望 ${expectation.generation}，实际 ${pristine.generation}`)
  check('原始态所有位点可打', pristine.files.every((file) => file.state === 'absent'),
    pristine.files.flatMap((file) => file.edits.filter((edit) => edit.state !== 'absent').map((edit) => `${edit.id}=${edit.state}`)).join(', '))

  const applied = applyPatches(treeRoot)
  check('应用成功', applied.changed)
  const patched = patchStatus(treeRoot)
  check('应用后状态为 applied', patched.applied)

  // ---- 功能断言：补丁后的 isReplaceOp 真能接受/拒绝预期形状 ----
  const { isReplaceOp, surfaceOpOf } = loadSurfaceOpHelpers(fs.readFileSync(sessionPath, 'utf8'))
  const canonical = expectation.generation === GEN_SEQ ? { start: 'startSeq', end: 'endSeq' } : { start: 'start', end: 'end' }
  const foreign = expectation.generation === GEN_SEQ ? { start: 'start', end: 'end' } : { start: 'startSeq', end: 'endSeq' }

  // 核心写入前会 deepFreeze 事件，surfaceOp 是冻结对象：全部用例都按冻结对象测
  const caseCanonical = Object.freeze({ op: 'replace', [canonical.start]: 3, [canonical.end]: 9 })
  check('接受本代规范 op（冻结对象）', isReplaceOp(caseCanonical) === true)

  const caseImpact = Object.freeze({ op: 'replace', [canonical.start]: 3, [canonical.end]: 9, impact: 'clear' })
  // 浏览器端 wire 校验（dsh-api-session-controller 的 assertSessionWireEvent）要求恰好 3 个键，
  // 第 4 个键会让 follow 流整块报 “invalid replace surfaceOp”，所以宿主必须拒绝它
  check('拒绝带 impact 的 4 键 op（客户端只接受 3 键）', isReplaceOp(caseImpact) === false)

  const caseForeign = Object.freeze({ op: 'replace', [foreign.start]: 3, [foreign.end]: 9 })
  const foreignAccepted = isReplaceOp(caseForeign) === true
  check('接受另一代键拼写（历史日志重放，冻结对象不抛错）', foreignAccepted)
  check('不改写调用方对象',
    Object.keys(caseForeign).join(',') === ['op', foreign.start, foreign.end].join(','),
    Object.keys(caseForeign).join(','))

  // 跨代拼写由 surfaceOpOf 解析成本代键名后交给 fold（不能就地改冻结对象）
  const normalized = surfaceOpOf({ type: 'tool/result', surfaceOp: caseForeign })
  check('surfaceOpOf 把另一代拼写解析成本代键名',
    normalized[canonical.start] === 3 && normalized[canonical.end] === 9 && normalized[foreign.start] === undefined,
    JSON.stringify(normalized))
  // v3 及更早的补丁把 impact 放在 surfaceOp 上；v4 起标记改放事件 data，op 上出现 impact 必须被拒绝
  let impactRejected = false
  try {
    surfaceOpOf({
      type: 'tool/result',
      surfaceOp: Object.freeze({ op: 'replace', [canonical.start]: 3, [canonical.end]: 9, impact: 'clear' }),
    })
  } catch {
    impactRejected = true
  }
  check('surfaceOpOf 拒绝带 impact 的 op（失败即拒绝该次清除，不影响会话）', impactRejected)
  check('本代拼写原样返回（不额外复制）', surfaceOpOf({ type: 'tool/result', surfaceOp: caseCanonical }) === caseCanonical)

  // 「清除型」判定必须来自内容比对：事件上既不能多 surfaceOp 键，也不能多 data 字段
  const sessionSource = fs.readFileSync(sessionPath, 'utf8')
  check('新增内容比对判定函数', sessionSource.includes('function clearsToolResultContent(event, shadowedSeqs, events, baseSeq)'))
  check('plan 层用内容比对结果作为 impact',
    sessionSource.includes('const impact = clearsToolResultContent(event, range.shadowedSeqs, events, baseSeq) ? "clear" : undefined;'))
  check('plan 层不再从 surfaceOp 读取 impact', sessionSource.includes('impact: surfaceOp.impact') === false)

  check('拒绝 5 键 op', isReplaceOp({ op: 'replace', [canonical.start]: 3, [canonical.end]: 9, impact: 'clear', extra: 1 }) === false)
  check('拒绝非法 impact 值', isReplaceOp({ op: 'replace', [canonical.start]: 3, [canonical.end]: 9, impact: 'other' }) === false)
  check('拒绝非 replace op', isReplaceOp({ op: 'splice', [canonical.start]: 3, [canonical.end]: 9 }) === false)
  check('拒绝非法 seq', isReplaceOp({ op: 'replace', [canonical.start]: -1, [canonical.end]: 9 }) === false)
  check('拒绝非对象', isReplaceOp(null) === false)

  // ---- agent-loop：系列判定必须改读 seriesGeneration（带回退） ----
  const loopSource = fs.readFileSync(loopPath, 'utf8')
  const fallbackCount = (loopSource.match(/seriesGeneration \?\?/g) ?? []).length
  check(`agent-loop 系列判定全部改读 seriesGeneration（${fallbackCount}/${expectation.loopFallbacks} 处）`,
    fallbackCount === expectation.loopFallbacks)
  check('agent-loop 保留 replaceGeneration 回退', loopSource.includes('.replaceGeneration'))

  // ---- 回退必须逐字节还原 ----
  const reverted = revertPatches(treeRoot)
  check('回退成功', reverted.changed)
  check('回退走的是备份恢复路径（非反向替换）', (reverted.skippedBackups ?? []).length === 0)
  check('回退后 session 原始字节一致', fs.readFileSync(sessionPath, 'utf8') === before.session)
  check('回退后 agent-loop 原始字节一致', fs.readFileSync(loopPath, 'utf8') === before.loop)
  check('回退后状态回到 absent', patchStatus(treeRoot).files.every((file) => file.state === 'absent'))
}

/** 已装旧版补丁的核心：应能就地升级，且回退仍回到原始文件。 */
function exerciseUpgrade(label, sourceRoot) {
  console.log(`\n【${label}】${sourceRoot}（旧补丁态 → 就地升级）`)
  const treeRoot = assembleTree(`${label}-upgrade`, sourceRoot)
  const sessionPath = path.join(treeRoot, SESSION_REL)
  const preState = patchStatus(treeRoot)
  check('识别为已应用（含旧补丁态）', preState.files.flatMap((file) => file.edits).some((edit) => edit.state === 'applied') || preState.applied,
    preState.files.flatMap((file) => file.edits.map((edit) => `${edit.id}=${edit.state}`)).join(', '))
  const before = fs.readFileSync(sessionPath, 'utf8')
  const result = applyPatches(treeRoot)
  check('可就地升级而非报错', result.changed)
  check('升级被标记', result.upgraded === true)
  check('升级后状态为 applied', patchStatus(treeRoot).applied)
  const { isReplaceOp } = loadSurfaceOpHelpers(fs.readFileSync(sessionPath, 'utf8'))
  const gen = coreGeneration(treeRoot)
  const canonical = gen === GEN_SEQ ? { start: 'startSeq', end: 'endSeq' } : { start: 'start', end: 'end' }
  const foreign = gen === GEN_SEQ ? { start: 'start', end: 'end' } : { start: 'startSeq', end: 'endSeq' }
  check('升级后接受跨代拼写（冻结对象）', isReplaceOp(Object.freeze({ op: 'replace', [foreign.start]: 1, [foreign.end]: 2 })) === true)
  check('升级后仍接受规范 op', isReplaceOp(Object.freeze({ op: 'replace', [canonical.start]: 1, [canonical.end]: 2 })) === true)
  check('升级后拒绝旧版 4 键 op', isReplaceOp(Object.freeze({ op: 'replace', [canonical.start]: 1, [canonical.end]: 2, impact: 'clear' })) === false)
  check('升级后 session 内容已变化', fs.readFileSync(sessionPath, 'utf8') !== before)
}

/**
 * 合成「已装 v2 补丁（>=0.1.5 就地归一化版）」的核心树：
 * 先打到本次补丁态，再把 replace-op-shape 退回 v2 文本、surfaceOpOf 退回原始文本。
 * 这是真实升级路径的回归夹具（v2 在冻结的 op 上写 startSeq，会抛 TypeError）。
 */
function makeV2Fixture(label, pristineSource) {
  const root = assembleTree(label, pristineSource)
  const sessionPath = path.join(root, SESSION_REL)
  const pristineSurfaceOpOf = extractFunctionText(fs.readFileSync(sessionPath, 'utf8'), 'function surfaceOpOf(')
  applyPatches(root)
  let text = fs.readFileSync(sessionPath, 'utf8')
  text = text.replace(
    extractFunctionText(text, 'function isReplaceOp('),
    `function isReplaceOp(value) {\n\tconst op = value;\n${V2_SEQ_REPLACE_OP_SHAPE}\n}`,
  )
  text = text.replace(extractFunctionText(text, 'function surfaceOpOf('), pristineSurfaceOpOf)
  fs.writeFileSync(sessionPath, text)
  const status = patchStatus(root)
  check(`${label}：夹具处于「可升级」态`, status.upgradable && !status.applied,
    status.files.flatMap((file) => file.edits.map((edit) => `${edit.id}=${edit.state}`)).join(', '))
  return root
}

const FIXTURES = {
  [GEN_LEGACY]: { generation: GEN_LEGACY, loopFallbacks: 1 },
  [GEN_SEQ]: { generation: GEN_SEQ, loopFallbacks: 3 },
}

for (const tree of trees) {
  if (!fs.existsSync(tree.dir)) {
    console.log(`跳过 ${tree.label}：目录不存在（${tree.dir}）`)
    continue
  }
  const assembled = assembleTree(tree.label, tree.dir)
  const generation = coreGeneration(assembled) ?? GEN_LEGACY
  exercise(tree.label, assembled, FIXTURES[generation])
}

for (const version of packs) {
  try {
    const cache = path.join(os.tmpdir(), 'dsh-compat-pkgs')
    fs.mkdirSync(cache, { recursive: true })
    const source = path.join(cache, version)
    if (!fs.existsSync(source)) {
      fs.mkdirSync(source, { recursive: true })
      for (const pkg of ['dsh-session', 'dsh-agent-loop']) {
        const tarball = execFileSync('npm', ['pack', `@deepseek-ai/${pkg}@${version}`, '--cache', path.join(cache, '.npm')], {
          cwd: cache,
          encoding: 'utf8',
        })
          .trim()
          .split('\n')
          .pop()
        const target = path.join(source, pkg)
        fs.mkdirSync(target, { recursive: true })
        execFileSync('tar', ['xzf', path.join(cache, tarball), '-C', target, '--strip-components=1'])
        fs.rmSync(path.join(cache, tarball), { force: true })
      }
    }
    const assembled = assembleTree(`pack-${version}`, source)
    const generation = coreGeneration(assembled) ?? GEN_LEGACY
    exercise(`npm:${version}`, assembled, FIXTURES[generation])
    // >=0.1.5 还要验证：已装 v2 补丁（就地归一化版）的核心能就地升级到只解析不改写的版本
    if (generation === GEN_SEQ) exerciseUpgrade(`npm:${version} + v2 补丁态`, makeV2Fixture(`v2-${version}`, source))
  } catch (error) {
    console.log(`跳过 ${version}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

if (v1Tree) exerciseUpgrade('已装 v1 补丁', v1Tree)

console.log(`\n${failures.length === 0 ? '全部通过 ✅' : `失败 ${failures.length} 项 ❌`}`)
for (const failure of failures) console.log(`  · ${failure}`)
process.exitCode = failures.length === 0 ? 0 : 1
