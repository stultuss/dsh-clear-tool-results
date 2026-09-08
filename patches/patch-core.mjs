#!/usr/bin/env node
/**
 * dsh-clear-tool-results · 核心补丁管理器（方案 C）
 *
 * 背景
 *   插件 overclock 模式每一步都会把上一步的工具结果替换为占位符（surface replace）。
 *   核心 dsh-session 每执行一次 replace 就 `replaceGeneration += 1`，而 dsh-agent-loop
 *   在两次请求之间发现该计数变化就判定「新系列」（append `request/header {reason:"series"}`），
 *   Chat 界面对每个系列都渲染一次系统提示词 —— 于是每步都重复展示一次。
 *
 * 方案
 *   双代数：
 *     · `replaceGeneration` 保持原语义（任何 replace 都 +1）—— 投影缓存、压缩轮询、
 *       客户端镜像都依赖它，绝不能改。
 *     · 新增 `seriesGeneration`：只有「非清除型」replace 才 +1。插件逐步清除时给
 *       surfaceOp 打上 `impact:"clear"`，因此不再开启新系列。
 *   agent-loop 的系列判定改读 `seriesGeneration`（缺失时回退 `replaceGeneration`，
 *   所以两个文件可以独立应用/回退，任一侧未打补丁都保持原行为）。
 *
 * 用法
 *   node patches/patch-core.mjs status            # 查看补丁状态
 *   node patches/patch-core.mjs apply             # 应用（备份到 ~/.dsh/clear-tool-results-backups/）
 *   node patches/patch-core.mjs revert            # 回退
 *   node patches/patch-core.mjs apply --root /path/to/@deepseek-ai/dsh
 *   也通过 npm run patch:status / patch:apply / patch:revert 调用。
 *
 * 注意
 *   补丁写入的是磁盘上的核心包文件，**必须重启 dsh GUI 进程**才会加载新代码。
 *   /clear-tool-results 命令已与补丁绑定：overclock → 自动 apply；on/off → 自动 revert；
 *   status 显示补丁状态。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKUP_DIR = join(homedir(), '.dsh', 'clear-tool-results-backups')

const SESSION_REL = 'node_modules/@deepseek-ai/dsh-session/lib/index.js'
const AGENT_LOOP_REL = 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'

/** 各补丁位点：old 必须逐字出现且唯一；new 为替换后的文本。 */
const EDITS = [
  {
    file: SESSION_REL,
    id: 'session:fold-state',
    note: 'fold 状态新增 seriesGeneration（系列代数，初始 0）',
    old: 'function createFoldState() {\n\treturn {\n\t\tnodes: [],\n\t\treplaceGeneration: 0\n\t};\n}',
    new: 'function createFoldState() {\n\treturn {\n\t\tnodes: [],\n\t\treplaceGeneration: 0,\n\t\tseriesGeneration: 0\n\t};\n}',
  },
  {
    file: SESSION_REL,
    id: 'session:replace-op-shape',
    note: 'isReplaceOp 放行第 4 个键 impact:"clear"',
    old: '\treturn Object.keys(op).length === 3 && Object.hasOwn(op, "op") && Object.hasOwn(op, "start") && Object.hasOwn(op, "end") && op["op"] === "replace" && isEventSeq(op["start"]) && isEventSeq(op["end"]);',
    new: '\tconst keys = Object.keys(op);\n\treturn (keys.length === 3 || (keys.length === 4 && op["impact"] === "clear")) && Object.hasOwn(op, "op") && Object.hasOwn(op, "start") && Object.hasOwn(op, "end") && op["op"] === "replace" && isEventSeq(op["start"]) && isEventSeq(op["end"]);',
  },
  {
    file: SESSION_REL,
    id: 'session:plan-passthrough',
    note: 'planSurfaceEvent 把 impact 透传进 plan',
    old: '\treturn {\n\t\tkind: "replace",\n\t\tseq: event.seq,\n\t\tstart: surfaceOp.start,\n\t\tend: surfaceOp.end,\n\t\t...range\n\t};',
    new: '\treturn {\n\t\tkind: "replace",\n\t\tseq: event.seq,\n\t\tstart: surfaceOp.start,\n\t\tend: surfaceOp.end,\n\t\timpact: surfaceOp.impact,\n\t\t...range\n\t};',
  },
  {
    file: SESSION_REL,
    id: 'session:series-counter',
    note: '清除型 replace 不递增 seriesGeneration（replaceGeneration 照旧 +1）',
    old: '\telse if (plan?.kind === "replace") {\n\t\tstate.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);\n\t\tstate.replaceGeneration += 1;\n\t}',
    new: '\telse if (plan?.kind === "replace") {\n\t\tstate.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);\n\t\tstate.replaceGeneration += 1;\n\t\tif (plan.impact !== "clear") state.seriesGeneration += 1;\n\t}',
  },
  {
    file: SESSION_REL,
    id: 'session:series-getter',
    note: 'surface 暴露 seriesGeneration getter',
    old: '\t/** Monotonic count of folded positional replacements. */\n\tget replaceGeneration() {\n\t\tif (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta();\n\t\treturn this._state.replaceGeneration;\n\t}',
    new: '\t/** Monotonic count of folded positional replacements. */\n\tget replaceGeneration() {\n\t\tif (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta();\n\t\treturn this._state.replaceGeneration;\n\t}\n\t/** Monotonic count of folded positional replacements that are not clear-only. */\n\tget seriesGeneration() {\n\t\tif (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta();\n\t\treturn this._state.seriesGeneration;\n\t}',
  },
  {
    file: AGENT_LOOP_REL,
    id: 'agent-loop:series-generation',
    note: '系列判定改读 seriesGeneration（缺失时回退 replaceGeneration）',
    old: 'const surfaceGeneration = this.session.surface.replaceGeneration;',
    new: 'const surfaceGeneration = this.session.surface.seriesGeneration ?? this.session.surface.replaceGeneration;',
  },
]

/** 定位 dsh 核心安装目录（含 node_modules/@deepseek-ai/dsh-session）。 */
export function resolveCoreRoot(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_CORE_DIR) candidates.push(process.env.DSH_CORE_DIR)
  candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh')
  candidates.push('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh')
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' })
  if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
    candidates.push(join(npmRoot.stdout.trim(), '@deepseek-ai/dsh'))
  }
  for (const candidate of candidates) {
    const root = resolve(candidate)
    if (existsSync(join(root, SESSION_REL)) && existsSync(join(root, AGENT_LOOP_REL))) return root
  }
  return null
}

function targetPath(root, rel) {
  return join(root, rel)
}

function backupPath(root, rel) {
  const tag = createHash('sha1').update(resolve(root)).digest('hex').slice(0, 10)
  return join(BACKUP_DIR, `${rel.replace(/[\\/]/g, '_')}.${tag}.orig`)
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** 每个文件的补丁状态：applied / absent / partial / drift。 */
export function patchStatus(root = resolveCoreRoot()) {
  if (!root) throw new Error('未定位到 dsh 核心目录，请用 --root 指定（含 node_modules/@deepseek-ai/dsh-session 的目录）')
  const files = []
  for (const rel of [SESSION_REL, AGENT_LOOP_REL]) {
    const path = targetPath(root, rel)
    const source = readFileSync(path, 'utf8')
    const edits = EDITS.filter((edit) => edit.file === rel).map((edit) => {
      const oldCount = countOccurrences(source, edit.old)
      const newCount = countOccurrences(source, edit.new)
      // 追加式补丁的 new 文本包含 old，因此以 new 的出现次数为准
      let state = 'drift'
      if (newCount === 1) state = 'applied'
      else if (oldCount === 1 && newCount === 0) state = 'absent'
      return { id: edit.id, note: edit.note, state, oldCount, newCount }
    })
    const states = new Set(edits.map((edit) => edit.state))
    let state = 'partial'
    if (states.size === 1) state = [...states][0]
    files.push({ rel, path, state, edits })
  }
  return { root, files, applied: files.every((file) => file.state === 'applied') }
}

function syntaxCheck(path) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (result.status === 0) return { ok: true }
  const message = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim()
  // ESM 文件在某些 Node 版本下无法用 --check 解析，这类报错不算补丁失败
  if (/Cannot use import statement|Unexpected token 'export'|ERR_REQUIRE_ESM|outside a module/i.test(message)) {
    return { ok: true, skipped: true, message }
  }
  return { ok: false, message }
}

/** 应用补丁；返回 { changed, skipped, files }。 */
export function applyPatches(root = resolveCoreRoot()) {
  if (!root) throw new Error('未定位到 dsh 核心目录，请用 --root 指定（含 node_modules/@deepseek-ai/dsh-session 的目录）')
  const plan = []
  for (const rel of [SESSION_REL, AGENT_LOOP_REL]) {
    const path = targetPath(root, rel)
    const original = readFileSync(path, 'utf8')
    let next = original
    let changed = false
    for (const edit of EDITS.filter((item) => item.file === rel)) {
      if (countOccurrences(next, edit.new) === 1) continue // 已应用（追加式补丁的 new 含 old）
      const oldCount = countOccurrences(next, edit.old)
      if (oldCount !== 1) {
        throw new Error(
          `补丁位点不匹配（${edit.id}）：在 ${rel} 中找到 ${oldCount} 处目标文本，` +
          '说明核心版本已变化。请勿强行应用，先联系插件作者更新补丁定义。',
        )
      }
      next = next.replace(edit.old, edit.new)
      changed = true
    }
    plan.push({ rel, path, original, next, changed })
  }
  const changedFiles = plan.filter((item) => item.changed)
  if (changedFiles.length === 0) return { changed: false, files: plan.map((item) => item.rel) }

  mkdirSync(BACKUP_DIR, { recursive: true })
  for (const item of changedFiles) {
    const backup = backupPath(root, item.rel)
    if (!existsSync(backup)) copyFileSync(item.path, backup)
    writeFileSync(item.path, item.next)
    const check = syntaxCheck(item.path)
    if (!check.ok) {
      copyFileSync(backup, item.path)
      throw new Error(`补丁写入后语法校验失败，已回滚 ${item.rel}：${check.message}`)
    }
  }
  return { changed: true, files: changedFiles.map((item) => item.rel) }
}

/** 回退补丁：优先从备份恢复，否则反向替换。 */
export function revertPatches(root = resolveCoreRoot()) {
  if (!root) throw new Error('未定位到 dsh 核心目录，请用 --root 指定（含 node_modules/@deepseek-ai/dsh-session 的目录）')
  let changed = false
  const files = []
  for (const rel of [SESSION_REL, AGENT_LOOP_REL]) {
    const path = targetPath(root, rel)
    const backup = backupPath(root, rel)
    if (existsSync(backup)) {
      const current = readFileSync(path, 'utf8')
      const original = readFileSync(backup, 'utf8')
      if (current !== original) {
        writeFileSync(path, original)
        changed = true
      }
      files.push(rel)
      continue
    }
    let source = readFileSync(path, 'utf8')
    let touched = false
    for (const edit of EDITS.filter((item) => item.file === rel)) {
      if (countOccurrences(source, edit.new) === 1) {
        source = source.replace(edit.new, edit.old)
        touched = true
      }
    }
    if (touched) {
      writeFileSync(path, source)
      changed = true
      files.push(rel)
    }
  }
  return { changed, files }
}

function formatStatus(status) {
  const lines = [`dsh 核心目录：${status.root}`, `整体状态：${status.applied ? '已应用' : '未应用/不完整'}`, '']
  for (const file of status.files) {
    lines.push(`· ${file.rel} → ${file.state}`)
    for (const edit of file.edits) lines.push(`    - [${edit.state}] ${edit.id}：${edit.note}`)
  }
  lines.push('', '提示：补丁写入磁盘后需重启 dsh GUI 进程才会加载。')
  return lines.join('\n')
}

function main(argv) {
  const args = argv.slice(2)
  const command = args.find((arg) => !arg.startsWith('-')) ?? 'status'
  const rootIndex = args.findIndex((arg) => arg === '--root')
  const explicitRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined
  const asJson = args.includes('--json')
  const root = resolveCoreRoot(explicitRoot)
  if (!root) {
    console.error('未定位到 dsh 核心目录：请用 --root <dsh 安装目录> 或设置 DSH_CORE_DIR。')
    process.exitCode = 1
    return
  }
  try {
    if (command === 'status') {
      const status = patchStatus(root)
      console.log(asJson ? JSON.stringify(status, null, 2) : formatStatus(status))
      return
    }
    if (command === 'apply') {
      const result = applyPatches(root)
      console.log(asJson ? JSON.stringify(result, null, 2) : result.changed
        ? `已应用核心补丁：\n${result.files.map((file) => `  · ${file}`).join('\n')}\n请重启 dsh GUI 后生效。`
        : '核心补丁已处于应用状态，无需操作。')
      return
    }
    if (command === 'revert') {
      const result = revertPatches(root)
      console.log(asJson ? JSON.stringify(result, null, 2) : result.changed
        ? `已回退核心补丁：\n${result.files.map((file) => `  · ${file}`).join('\n')}\n请重启 dsh GUI 后生效。`
        : '核心补丁未应用，无需回退。')
      return
    }
    console.error(`未知命令：${command}（可用：status / apply / revert）`)
    process.exitCode = 1
  } catch (error) {
    console.error(`补丁操作失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv)
}
