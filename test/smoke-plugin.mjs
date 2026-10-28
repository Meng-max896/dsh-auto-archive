/**
 * 插件层冒烟测试：用假 ctx 驱动 apply()，验证工具注册、轮次归档、缓存报告。
 * 需要宿主包可解析（node_modules 已链接到 DSH runtime 提供的副本）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, Config, name, inject } = await import('../src/plugin.js')

const registered = []
const listeners = new Map()

// 模拟 Cordis：只有注入/内置的属性可读，其余一律抛错。
// 这正是真实宿主里 "cannot get property timer without inject" 的成因。
const timers = []
const CORE = {
  tools: { register: (tool) => { registered.push(tool); return () => {} } },
  logger: { warn: (m) => console.log('  [host warn]', m), info: (m) => console.log('  [host info]', m) },
  on: (event, handler) => { listeners.set(event, handler); return () => {} },
  effect: (fn) => { const d = fn(); return () => {} },
  // 按需注入：只有被请求的服务才出现在 scoped ctx 上，模拟真实宿主
  inject: (deps, cb) =>
    cb({
      setInterval: (fn, ms) => { timers.push({ fn, ms }); return () => {} },
      effect: (fn) => { fn(); return () => {} },
      workspaceRegistry: { archiveSession: async () => {} },
    }),
}
const ctx = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop in CORE) return CORE[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
    has(_target, prop) { return prop in CORE },
  },
)

assert.equal(name, 'dsh-auto-archive')
assert.deepEqual(inject, ['tools'])

const parsed = new Config({})
assert.equal(parsed.turnArchive, true)
assert.equal(parsed.cleanup.enabled, true)
assert.equal(parsed.inactivity.idleDays, 7, 'schema 默认值应由 Config 填充')
assert.equal(parsed.inactivity.scanMinutes, 60)

apply(ctx, { locale: 'zh-CN' })
assert.equal(registered.length, 4, '应注册四个工具')
assert.deepEqual(registered.map((t) => t.name).sort(), ['archive_cleanup_report', 'archive_now', 'archive_root_policy', 'archive_status'])
assert.ok(listeners.has('session/event'), '必须监听 session/event')

for (const tool of registered) {
  assert.ok(tool.description?.length > 10, `${tool.name} 缺少 description`)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output?.render, 'function')
}

const dir = mkdtempSync(join(tmpdir(), 'dsa-smoke2-'))
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
const session = { header: { id: 'sess-1', cwd: dir } }
const emit = async (type, extra = {}) => listeners.get('session/event')(session, { type, ...extra })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Smoke')
  git('config', 'user.email', 'smoke@example.com')
  writeFileSync(join(dir, 'seed.md'), '# seed\n', 'utf8')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')

  // ── 轮次 1：产生两个文档 + 一个缓存
  await emit('turn/start', { turn: 1 })
  await sleep(20)
  writeFileSync(join(dir, 'doc-a.md'), 'a', 'utf8')
  writeFileSync(join(dir, 'doc-b.md'), 'b', 'utf8')
  writeFileSync(join(dir, 'debug.log'), 'log', 'utf8')
  await emit('turn/end', { turn: 1, reason: 'success' })
  await sleep(300)

  const committed = git('show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n').filter(Boolean)
  assert.deepEqual(committed.sort(), ['doc-a.md', 'doc-b.md'], '只提交文档，缓存不得入仓')
  const dirty = git('status', '--porcelain')
  assert.match(dirty, /debug\.log/, '缓存应保留在工作区（只报告不删除）')

  // ── 缓存报告工具
  const cleanupTool = registered.find((t) => t.name === 'archive_cleanup_report')
  const report = await cleanupTool.execute({ repo: dir }, {})
  assert.equal(report.ok, true)
  assert.equal(report.mode, 'report')
  assert.equal(report.destructive, false)
  assert.deepEqual(report.candidates, ['debug.log'])
  assert.match(report.summary, /只报告，不删除/)

  // ── 轮次 2：只有缓存 → 不产生新提交
  const before = git('rev-list', '--count', 'HEAD').trim()
  await emit('turn/start', { turn: 2 })
  await sleep(20)
  writeFileSync(join(dir, 'cache.tmp'), 'x', 'utf8')
  await emit('turn/end', { turn: 2, reason: 'success' })
  await sleep(300)
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), before, '纯缓存轮次不应产生提交')

  // ── status 工具仍可用
  const statusTool = registered.find((t) => t.name === 'archive_status')
  const st = await statusTool.execute({ repo: dir }, {})
  assert.equal(st.ok, true)
  assert.equal(st.branch, 'main')
  assert.match(st.summary, /归档状态/)

  console.log('SMOKE OK — 4 tools, turn-scoped commit, cache report-only')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
