import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureBaseline, diffBaseline, filterByAge, TurnBaselines } from '../src/turn-tracker.js'
import { classifyCandidates, reportOnly, DEFAULT_RULES } from '../src/cleanup.js'
import { pickIdleSessions, limitBatch } from '../src/inactivity.js'
import { classifyRootEntries, summarize } from '../src/root-policy.js'
import { snapshotPaths } from '../src/archive.js'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-feat-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 't@example.com')
  return { dir, git, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('turn-tracker：识别本轮新增/修改/删除', async () => {
  const r = makeRepo()
  try {
    writeFileSync(join(r.dir, 'existing.md'), 'v1', 'utf8')
    r.git('add', '-A')
    r.git('commit', '-q', '-m', 'base')

    const before = await captureBaseline(r.dir)
    assert.equal(before.mode, 'mtime')
    assert.ok(before.files.has('existing.md'))

    await sleep(20)
    writeFileSync(join(r.dir, 'created.md'), 'new', 'utf8')
    writeFileSync(join(r.dir, 'existing.md'), 'v2', 'utf8')
    rmSync(join(r.dir, 'existing-copy.md'), { force: true })

    const after = await captureBaseline(r.dir)
    const diff = diffBaseline(before, after)
    assert.ok(diff.created.includes('created.md'), '应识别新增')
    assert.ok(diff.modified.includes('existing.md'), '应识别修改（mtime 变化）')
    assert.deepEqual(diff.deleted, [])
    assert.ok(diff.touched.includes('created.md'))
  } finally {
    r.dispose()
  }
})

test('TurnBaselines：无基线时返回 null，结束即清除', async () => {
  const r = makeRepo()
  try {
    const baselines = new TurnBaselines()
    assert.equal(await baselines.end(r.dir, 's1'), null)

    await baselines.begin(r.dir, 's1')
    assert.equal(baselines.has('s1'), true)
    writeFileSync(join(r.dir, 'a.md'), 'a', 'utf8')
    const diff = await baselines.end(r.dir, 's1')
    assert.deepEqual(diff.touched, ['a.md'])
    assert.equal(baselines.has('s1'), false)
  } finally {
    r.dispose()
  }
})

test('cleanup：只命中新建的缓存类文件，不碰文档', () => {
  const created = [
    'src/app.js',
    'notes.md',
    'node_modules/foo/index.js',
    'dist/bundle.js',
    'cache.tmp',
    'debug.log',
    'Thumbs.db',
    '.pytest_cache/v/cache',
    'data/output.bak',
  ]
  const { candidates, byRule } = classifyCandidates(created)
  assert.deepEqual(candidates, [
    '.pytest_cache/v/cache',
    'Thumbs.db',
    'cache.tmp',
    'data/output.bak',
    'debug.log',
    'node_modules/foo/index.js',
  ])
  assert.ok(byRule.dir.length >= 2, '目录规则应命中 node_modules 与 .pytest_cache')
  assert.ok(!candidates.includes('src/app.js'))
  assert.ok(!candidates.includes('notes.md'))
  assert.ok(DEFAULT_RULES.dirs.includes('node_modules'))
})

test('cleanup：reportOnly 声明无副作用且不改动入参', () => {
  const created = ['a.tmp', 'b.md']
  const snapshot = [...created]
  const report = reportOnly(created)
  assert.equal(report.mode, 'report')
  assert.equal(report.destructive, false)
  assert.equal(report.count, 1)
  assert.deepEqual(created, snapshot, '不得修改调用方数组')
})

test('inactivity：只挑出静默超过阈值的会话', () => {
  const now = Date.parse('2026-10-27T12:00:00Z')
  const sessions = [
    { sessionId: 'old-8d', lastActivity: '2026-10-19T12:00:00Z' },
    { sessionId: 'edge-7d', lastActivity: '2026-10-20T12:00:00Z' },
    { sessionId: 'fresh', lastActivity: '2026-10-27T11:00:00Z' },
    { sessionId: 'no-time' },
  ]
  const { idle, active, skipped } = pickIdleSessions(sessions, { idleDays: 7, now })
  assert.deepEqual(idle.map((s) => s.sessionId), ['old-8d', 'edge-7d'])
  assert.equal(active, 1)
  assert.equal(skipped, 1)
  assert.equal(idle[0].idleDays, 8)
})

test('inactivity：批量上限保护', () => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({
    sessionId: `s${i}`,
    lastActivity: '2020-01-01T00:00:00Z',
  }))
  const { idle } = pickIdleSessions(sessions, { idleDays: 7 })
  assert.equal(limitBatch(idle, 20).length, 20)
})

test('snapshotPaths：只提交本轮路径，其他改动留在工作区', async () => {
  const r = makeRepo()
  try {
    writeFileSync(join(r.dir, 'done.md'), 'x', 'utf8')
    writeFileSync(join(r.dir, 'unrelated.md'), 'y', 'utf8')

    const out = await snapshotPaths({ repo: r.dir, paths: ['done.md'], push: false, message: 'turn work' })
    assert.equal(out.ok, true)
    assert.equal(out.status, 'committed-only')
    assert.deepEqual(out.files, ['done.md'])

    const filesInCommit = r.git('show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n').filter(Boolean)
    assert.deepEqual(filesInCommit, ['done.md'])
    const dirty = r.git('status', '--porcelain').trim()
    assert.match(dirty, /unrelated\.md/, '未指定路径必须保持未提交')
  } finally {
    r.dispose()
  }
})

test('root-policy：区分留根 / 可移动 / 需人工判断', () => {
  const policy = classifyRootEntries([
    'README.md',
    '.gitignore',
    'package.json',
    'install.ps1',
    'today.cmd',
    '_src_new.docx',
    'build_exam2.py',
    'shot.png',
    'debug.log',
    'mystery.xyz',
  ])
  assert.deepEqual(policy.keep.map((k) => k.name).sort(), ['.gitignore', 'README.md', 'install.ps1', 'package.json', 'today.cmd'])
  const movableMap = Object.fromEntries(policy.movable.map((m) => [m.name, m.target]))
  assert.equal(movableMap['_src_new.docx'], 'docs/')
  assert.equal(movableMap['build_exam2.py'], 'scripts/')
  assert.equal(movableMap['shot.png'], 'assets/')
  assert.equal(movableMap['debug.log'], 'tmp/')
  assert.deepEqual(policy.unknown, ['mystery.xyz'])
  assert.match(summarize(policy), /留根 5 · 可移动 4 · 需人工判断 1/)
})

test('root-policy：未知扩展名不猜测，交给人工', () => {
  const policy = classifyRootEntries(['a.weird', 'b.bin'])
  assert.equal(policy.keep.length, 0)
  assert.equal(policy.movable.length, 0)
  assert.deepEqual(policy.unknown, ['a.weird', 'b.bin'])
})

test('filterByAge：跳过太新的文件，保留够旧的与已删除的', async () => {
  const r = makeRepo()
  try {
    writeFileSync(join(r.dir, 'old.md'), 'o', 'utf8')
    writeFileSync(join(r.dir, 'fresh.md'), 'f', 'utf8')
    const past = new Date(Date.now() - 10 * 60 * 1000)
    execFileSync('node', ['-e', `require('fs').utimesSync(${JSON.stringify(join(r.dir, 'old.md'))}, ${past.getTime() / 1000}, ${past.getTime() / 1000})`])

    const out = await filterByAge(r.dir, ['old.md', 'fresh.md', 'gone.md'], 120)
    assert.deepEqual(out.kept.sort(), ['gone.md', 'old.md'])
    assert.deepEqual(out.skipped, ['fresh.md'])

    const off = await filterByAge(r.dir, ['old.md', 'fresh.md'], 0)
    assert.deepEqual(off.skipped, [], 'seconds=0 时不过滤')
  } finally {
    r.dispose()
  }
})