import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { snapshot, status } from '../src/archive.js'

function makeRepo({ withIdentity = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  if (withIdentity) {
    git('config', 'user.name', 'Test User')
    git('config', 'user.email', 'test@example.com')
  }
  return { dir, git, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('非 git 目录抛出 NOT_A_REPO', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-plain-'))
  try {
    await assert.rejects(() => snapshot({ repo: dir }), (e) => e.code === 'NOT_A_REPO')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('干净仓库返回 up-to-date，且不产生空提交', async () => {
  const r = makeRepo()
  try {
    const out = await snapshot({ repo: r.dir })
    assert.equal(out.status, 'up-to-date')
    assert.equal(out.ok, true)
    assert.equal(r.git('rev-list', '--count', '--all').trim(), '0')
  } finally {
    r.dispose()
  }
})

test('有改动时提交到本地（push=false），再次运行为 up-to-date', async () => {
  const r = makeRepo()
  try {
    writeFileSync(join(r.dir, 'note.md'), '# hello\n', 'utf8')
    const first = await snapshot({ repo: r.dir, push: false })
    assert.equal(first.status, 'committed-only')
    assert.match(first.commit, /^[0-9a-f]{7,}$/)
    assert.equal(r.git('rev-list', '--count', 'HEAD').trim(), '1')

    const second = await snapshot({ repo: r.dir, push: false })
    assert.equal(second.status, 'up-to-date')
    assert.equal(r.git('rev-list', '--count', 'HEAD').trim(), '1', '不应产生第二个空提交')
  } finally {
    r.dispose()
  }
})

test('dry-run 报告文件但不改动仓库', async () => {
  const r = makeRepo()
  try {
    writeFileSync(join(r.dir, 'a.txt'), 'x', 'utf8')
    writeFileSync(join(r.dir, 'b.txt'), 'y', 'utf8')
    const out = await snapshot({ repo: r.dir, dryRun: true })
    assert.equal(out.status, 'dry-run')
    assert.equal(out.count, 2)
    assert.equal(out.unpushed, 0)
    assert.deepEqual(out.files.sort(), ['a.txt', 'b.txt'])
    assert.equal(r.git('rev-list', '--count', '--all').trim(), '0', 'dry-run 不允许提交')
  } finally {
    r.dispose()
  }
})

test('中文与特殊字符文件名被正确解析（porcelain 前导空格回归用例）', async () => {
  const r = makeRepo()
  try {
    writeFileSync(join(r.dir, '_收件箱说明.md'), 'x', 'utf8')
    const out = await snapshot({ repo: r.dir, dryRun: true })
    assert.deepEqual(out.files, ['_收件箱说明.md'], '首字符不能被状态位对齐吃掉')
  } finally {
    r.dispose()
  }
})

test('提交信息模板支持 {date} 与 {count}', async () => {
  const r = makeRepo()
  try {
    writeFileSync(join(r.dir, 'x.txt'), 'x', 'utf8')
    await snapshot({ repo: r.dir, push: false, message: 'snapshot {date} ({count})' })
    const subject = r.git('log', '-1', '--pretty=%s').trim()
    assert.match(subject, /^snapshot \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(1\)$/)
  } finally {
    r.dispose()
  }
})

test('未配置提交身份时返回 IDENTITY_MISSING，且仓库未被改动', async () => {
  const emptyGlobal = join(tmpdir(), 'dsa-empty-gitconfig')
  writeFileSync(emptyGlobal, '', 'utf8')
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL
  const prevSystem = process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_GLOBAL = emptyGlobal
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  const r = makeRepo({ withIdentity: false })
  try {
    writeFileSync(join(r.dir, 'y.txt'), 'y', 'utf8')
    const out = await snapshot({ repo: r.dir, push: false })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'IDENTITY_MISSING')
    assert.equal(r.git('rev-list', '--count', '--all').trim(), '0')
  } finally {
    r.dispose()
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = prevSystem
  }
})

test('status 只读：报告分支/待提交/未推送，且不提交任何东西', async () => {
  const r = makeRepo()
  try {
    writeFileSync(join(r.dir, 'z.txt'), 'z', 'utf8')
    const s = await status({ repo: r.dir })
    assert.equal(s.ok, true)
    assert.equal(s.branch, 'main')
    assert.equal(s.pendingFiles, 1)
    assert.equal(s.unpushed, 0)
    assert.equal(s.hasRemote, false)
    assert.equal(s.identityConfigured, true)
    assert.equal(r.git('rev-list', '--count', '--all').trim(), '0')
  } finally {
    r.dispose()
  }
})
