/**
 * 归档内核：与 DSH 无关的纯 Node 实现，可单独使用。
 * 设计约束：任何失败都不得损坏仓库；永不 force push。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import net from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const STATE_ROOT = join(homedir(), '.dsh', 'dsh-auto-archive')
const RETRY_DELAYS = [5000, 15000, 30000]
const LOCK_TTL_MS = 30 * 60 * 1000
const GIT_TIMEOUT_MS = 600000

const TRANSIENT = /408|RPC failed|timed out|hung up|Could not resolve|Failed to connect|Connection reset|early EOF|transfer closed|handshake|TLS/i
const AUTH = /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|403 Forbidden|Permission denied \(publickey\)|Invalid username or password/i
const REJECTED = /non-fast-forward|fetch first|\[rejected\]|Updates were rejected/i

export class ArchiveError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ArchiveError'
    this.code = code
    this.detail = detail ?? ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const keyOf = (repo) => createHash('sha1').update(repo.toLowerCase()).digest('hex').slice(0, 16)

function stateDir() {
  mkdirSync(STATE_ROOT, { recursive: true })
  return STATE_ROOT
}

function stateFile(repo) {
  return join(stateDir(), `${keyOf(repo)}.state.json`)
}

function lockFile(repo) {
  return join(stateDir(), `${keyOf(repo)}.lock`)
}

function readState(repo) {
  try {
    return JSON.parse(readFileSync(stateFile(repo), 'utf8'))
  } catch {
    return null
  }
}

function writeState(repo, record) {
  try {
    writeFileSync(stateFile(repo), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
    /* 状态写不进去不影响归档结果 */
  }
}

async function run(cwd, args, { allowFail = true } = {}) {
  // 目录不存在时 execFile 也会抛 ENOENT，必须与「git 未安装」区分开
  if (!existsSync(cwd)) throw new ArchiveError('NOT_A_REPO', cwd)
  const options = {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_OPTIONAL_LOCKS: '1',
    },
  }
  // core.quotepath=false：否则非 ASCII 路径会被转义成 \346\224\266 形式
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], options)
    return { ok: true, out: String(stdout), err: String(stderr) }
  } catch (e) {
    if (e.code === 'ENOENT') throw new ArchiveError('GIT_MISSING', 'git executable not found on PATH')
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message ?? e)
    if (!allowFail) throw new ArchiveError('GIT_FAILED', out)
    return { ok: false, out: '', err: out, code: e.code }
  }
}

/** git 是否可用（结果缓存，避免每次工具调用都探一次） */
let gitProbe = null
export async function gitAvailable() {
  if (gitProbe === null) {
    try {
      const r = await run(process.cwd(), ['--version'])
      gitProbe = r.ok ? r.out.trim() : false
    } catch {
      gitProbe = false
    }
  }
  return gitProbe
}

function toAbsolute(repo) {
  const raw = String(repo ?? '').trim()
  if (!raw) throw new ArchiveError('REPO_REQUIRED')
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw)
}

/** 校验并返回仓库根目录；不是仓库则抛 NOT_A_REPO */
async function repoRoot(repo) {
  const abs = toAbsolute(repo)
  const r = await run(abs, ['rev-parse', '--show-toplevel'])
  if (!r.ok) throw new ArchiveError('NOT_A_REPO', abs)
  return r.out.trim() || abs
}

function acquireLock(repo) {
  const file = lockFile(repo)
  if (existsSync(file)) {
    let pid = 0
    let since = 0
    try {
      const raw = readFileSync(file, 'utf8').split('\n')
      pid = Number(raw[0])
      since = Date.parse(raw[1])
    } catch {
      /* 锁文件损坏视为陈旧 */
    }
    let alive = false
    try {
      if (pid > 0) {
        process.kill(pid, 0)
        alive = true
      }
    } catch {
      alive = false
    }
    const stale = !alive || !Number.isFinite(since) || Date.now() - since > LOCK_TTL_MS
    if (!stale) return { ok: false, holder: { pid, since } }
    try {
      unlinkSync(file)
    } catch {
      /* 已被别人清掉 */
    }
  }
  writeFileSync(file, `${process.pid}\n${new Date().toISOString()}`, 'utf8')
  return { ok: true }
}

function releaseLock(repo) {
  try {
    const pid = Number(readFileSync(lockFile(repo), 'utf8').split('\n')[0])
    if (pid === process.pid) unlinkSync(lockFile(repo))
  } catch {
    /* 锁已不在 */
  }
}

/** porcelain 输出首行的前导空格是状态位，绝不能 trim 整段输出 */
async function changedFiles(repo) {
  const r = await run(repo, ['status', '--porcelain=v1'])
  if (!r.ok) return []
  return r.out
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const p = line.slice(3).trim().replace(/^"(.*)"$/, '$1')
      return p.includes(' -> ') ? p.split(' -> ')[1] : p
    })
}

/** unborn 分支（还没有任何提交）上 rev-parse 会失败，需要逐级回退 */
async function currentBranch(repo) {
  const direct = await run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (direct.ok && direct.out.trim() && direct.out.trim() !== 'HEAD') return direct.out.trim()

  const showCurrent = await run(repo, ['branch', '--show-current'])
  if (showCurrent.ok && showCurrent.out.trim()) return showCurrent.out.trim()

  const symbolic = await run(repo, ['symbolic-ref', '--short', 'HEAD'])
  return symbolic.ok ? symbolic.out.trim() : ''
}

async function hasCommits(repo) {
  const r = await run(repo, ['rev-list', '--count', 'HEAD'])
  return r.ok && Number(r.out.trim()) > 0
}

async function unpushedCount(repo, branch) {
  if (!branch || !(await hasCommits(repo))) return 0
  const r = await run(repo, ['rev-list', '--count', `origin/${branch}..HEAD`])
  return r.ok ? Number(r.out.trim()) || 0 : 0
}

async function identityConfigured(repo) {
  const name = await run(repo, ['config', '--get', 'user.name'])
  const email = await run(repo, ['config', '--get', 'user.email'])
  return Boolean(name.ok && name.out.trim() && email.ok && email.out.trim())
}

async function hasRemote(repo) {
  const r = await run(repo, ['remote'])
  return r.ok && r.out.trim().length > 0
}

function buildMessage(files, template, maxFiles) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const head = template
    ? template.replaceAll('{date}', stamp).replaceAll('{count}', String(files.length))
    : `chore(archive): ${stamp} · ${files.length} files`
  if (!template) {
    const shown = files.slice(0, maxFiles)
    const lines = shown.map((f) => `- ${f}`)
    if (files.length > shown.length) lines.push(`- … +${files.length - shown.length}`)
    return `${head}\n\n${lines.join('\n')}\n`
  }
  return `${head}\n`
}

/** 解析 http://host:port 形式的代理地址 */
function parseProxyUrl(raw) {
  const m = String(raw ?? '').match(/^https?:\/\/([^:/]+):(\d+)/)
  return m ? { host: m[1], port: Number(m[2]) } : null
}

async function proxyOf(repo) {
  const r = await run(repo, ['config', '--get', 'http.proxy'])
  return r.ok && r.out.trim() ? r.out.trim() : ''
}

async function remoteHostOf(repo) {
  const r = await run(repo, ['config', '--get', 'remote.origin.url'])
  if (!r.ok || !r.out) return null
  const m = r.out.trim().match(/^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)/)
  return m ? m[1] : null
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((done) => {
    const sock = net.connect({ host, port })
    const finish = (ok) => {
      sock.destroy()
      done(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

function proxyTunnelProbe(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((done) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port })
    let buf = ''
    const finish = (ok, detail) => {
      sock.destroy()
      done({ ok, detail })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`))
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1')
      if (buf.includes('\r\n')) {
        const status = buf.split('\r\n')[0].trim()
        finish(/\s200\s/.test(status), `proxy tunnel: ${status}`)
      }
    })
    sock.once('timeout', () => finish(false, 'proxy tunnel timeout'))
    sock.once('error', (e) => finish(false, `proxy error: ${e.message}`))
  })
}

/** 推前网络预检：不可达时快速失败，避免白重试三轮（约 50 秒） */
async function probeNetwork(repo) {
  const host = (await remoteHostOf(repo)) ?? 'github.com'
  const proxy = parseProxyUrl(await proxyOf(repo))
  if (proxy) return proxyTunnelProbe(proxy, host, 443, 6000)
  const ok = await tcpProbe(host, 443, 6000)
  return { ok, detail: ok ? `direct ${host}:443 reachable` : `cannot reach ${host}:443 (no proxy configured)` }
}

async function pushWithRetry(repo, branch, journal) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const r = await run(repo, ['push', 'origin', branch])

    if (r.ok) return { ok: true, attempts: attempt + 1 }
    if (AUTH.test(r.err)) throw new ArchiveError('AUTH_REQUIRED', r.err)
    if (/does not appear to be a git repository|No configured push destination|No such remote/i.test(r.err)) {
      throw new ArchiveError('NO_REMOTE', r.err)
    }

    if (REJECTED.test(r.err)) {
      journal.push({ step: 'push-rejected', detail: r.err.split('\n')[0] })
      const rb = await run(repo, ['pull', '--rebase', 'origin', branch])
      if (!rb.ok) {
        await run(repo, ['rebase', '--abort'])
        throw new ArchiveError('DIVERGED', rb.err)
      }
      const again = await run(repo, ['push', 'origin', branch])
      if (again.ok) return { ok: true, attempts: attempt + 1, rebased: true }
      if (AUTH.test(again.err)) throw new ArchiveError('AUTH_REQUIRED', again.err)
      throw new ArchiveError('PUSH_FAILED', again.err)
    }

    if (!TRANSIENT.test(r.err)) throw new ArchiveError('PUSH_FAILED', r.err)
    if (attempt < RETRY_DELAYS.length) {
      journal.push({ step: 'push-retry', detail: `attempt ${attempt + 1} failed, retrying` })
      await sleep(RETRY_DELAYS[attempt])
    }
  }
  throw new ArchiveError('PUSH_FAILED', 'retries exhausted')
}

/**
 * 对某个目录做一次归档。
 * @param {{repo: string, message?: string, push?: boolean, dryRun?: boolean, maxFiles?: number}} opts
 */
export async function snapshot(opts = {}) {
  const root = await repoRoot(opts.repo)
  const branch = await currentBranch(root)
  const files = await changedFiles(root)
  const aheadBefore = await unpushedCount(root, branch)
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 20
  const journal = []

  if (opts.dryRun) {
    return { ok: true, status: 'dry-run', repo: root, branch, files, count: files.length, unpushed: aheadBefore, journal }
  }

  if (files.length === 0 && aheadBefore === 0) {
    const record = { at: new Date().toISOString(), ok: true, status: 'up-to-date', repo: root, branch, journal }
    writeState(root, record)
    return record
  }

  const lock = acquireLock(root)
  if (!lock.ok) {
    return { ok: false, status: 'locked', repo: root, branch, holder: lock.holder, journal }
  }

  let commit = null
  try {
    if (files.length > 0) {
      if (!(await identityConfigured(root))) throw new ArchiveError('IDENTITY_MISSING', root)

      await run(root, ['add', '-A'], { allowFail: false })
      const staged = await run(root, ['diff', '--cached', '--name-only'])
      const stagedFiles = staged.ok ? staged.out.split('\n').filter(Boolean) : []

      if (stagedFiles.length > 0) {
        const msgPath = join(stateDir(), `${keyOf(root)}.commit-msg.txt`)
        writeFileSync(msgPath, buildMessage(stagedFiles, opts.message, maxFiles), 'utf8')
        const commitResult = await run(root, ['commit', '-F', msgPath, '--quiet'])
        if (!commitResult.ok) throw new ArchiveError('COMMIT_FAILED', commitResult.err)
        const head = await run(root, ['rev-parse', '--short', 'HEAD'])
        commit = head.ok ? head.out.trim() : null
        journal.push({ step: 'commit', detail: `${commit} (${stagedFiles.length} files)` })
      }
    }

    const shouldPush = opts.push !== false
    if (!shouldPush) {
      const record = { at: new Date().toISOString(), ok: true, status: 'committed-only', repo: root, branch, commit, journal }
      writeState(root, record)
      return record
    }

    const ahead = await unpushedCount(root, branch)
    if (ahead === 0) {
      const record = { at: new Date().toISOString(), ok: true, status: 'nothing-to-push', repo: root, branch, commit, journal }
      writeState(root, record)
      return record
    }
    if (!(await hasRemote(root))) throw new ArchiveError('NO_REMOTE', root)

    const netState = await probeNetwork(root)
    if (!netState.ok) throw new ArchiveError('OFFLINE', netState.detail)

    const pushResult = await pushWithRetry(root, branch, journal)
    journal.push({ step: 'push', detail: `ok on attempt ${pushResult.attempts}${pushResult.rebased ? ' (rebased)' : ''}` })

    const record = {
      at: new Date().toISOString(),
      ok: true,
      status: commit ? 'pushed' : 'pushed-pending',
      repo: root,
      branch,
      commit,
      unpushedBefore: ahead,
      attempts: pushResult.attempts,
      rebased: Boolean(pushResult.rebased),
      journal,
    }
    writeState(root, record)
    return record
  } catch (e) {
    const err = e instanceof ArchiveError ? e : new ArchiveError('INTERNAL', String(e?.message ?? e))
    const record = { at: new Date().toISOString(), ok: false, status: 'failed', code: err.code, detail: err.detail, repo: root, branch, commit, journal }
    writeState(root, record)
    return record
  } finally {
    releaseLock(root)
  }
}

/** 只读状态：不动仓库 */
export async function status(opts = {}) {
  const root = await repoRoot(opts.repo)
  const branch = await currentBranch(root)
  const files = await changedFiles(root)
  const ahead = await unpushedCount(root, branch)
  const last = readState(root)
  return {
    ok: true,
    status: 'reported',
    repo: root,
    branch,
    pendingFiles: files.length,
    unpushed: ahead,
    hasRemote: await hasRemote(root),
    identityConfigured: await identityConfigured(root),
    locked: existsSync(lockFile(root)),
    last,
  }
}

/**
 * 只提交指定路径（按轮次归属时使用），其余改动留在工作区不动。
 * @param {{repo: string, paths?: string[], message?: string, push?: boolean, maxFiles?: number}} opts
 */
export async function snapshotPaths(opts = {}) {
  const root = await repoRoot(opts.repo)
  const paths = Array.isArray(opts.paths) ? opts.paths.filter(Boolean) : []
  const journal = []

  if (paths.length === 0) {
    return { ok: true, status: 'nothing-to-commit', repo: root, paths: [], journal }
  }

  const branch = await currentBranch(root)
  const lock = acquireLock(root)
  if (!lock.ok) {
    return { ok: false, status: 'locked', repo: root, branch, holder: lock.holder, journal }
  }

  let commit = null
  try {
    if (!(await identityConfigured(root))) throw new ArchiveError('IDENTITY_MISSING', root)

    const add = await run(root, ['add', '-A', '--', ...paths])
    if (!add.ok) throw new ArchiveError('GIT_FAILED', add.err)

    const staged = await run(root, ['diff', '--cached', '--name-only'])
    const stagedFiles = staged.ok ? staged.out.split('\n').filter(Boolean) : []
    if (stagedFiles.length === 0) {
      return { ok: true, status: 'nothing-to-commit', repo: root, branch, journal }
    }

    const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : 20
    const msgPath = join(stateDir(), `${keyOf(root)}.commit-msg.txt`)
    writeFileSync(msgPath, buildMessage(stagedFiles, opts.message, maxFiles), 'utf8')
    const commitResult = await run(root, ['commit', '-F', msgPath, '--quiet'])
    if (!commitResult.ok) throw new ArchiveError('COMMIT_FAILED', commitResult.err)

    const head = await run(root, ['rev-parse', '--short', 'HEAD'])
    commit = head.ok ? head.out.trim() : null
    journal.push({ step: 'commit', detail: `${commit} (${stagedFiles.length} files)` })

    if (opts.push === false) {
      const record = { at: new Date().toISOString(), ok: true, status: 'committed-only', repo: root, branch, commit, files: stagedFiles, journal }
      writeState(root, record)
      return record
    }
    if (!(await hasRemote(root))) throw new ArchiveError('NO_REMOTE', root)

    const netState = await probeNetwork(root)
    if (!netState.ok) throw new ArchiveError('OFFLINE', netState.detail)

    const pushResult = await pushWithRetry(root, branch, journal)
    journal.push({ step: 'push', detail: `ok on attempt ${pushResult.attempts}${pushResult.rebased ? ' (rebased)' : ''}` })

    const record = {
      at: new Date().toISOString(),
      ok: true,
      status: 'pushed',
      repo: root,
      branch,
      commit,
      files: stagedFiles,
      attempts: pushResult.attempts,
      rebased: Boolean(pushResult.rebased),
      journal,
    }
    writeState(root, record)
    return record
  } catch (e) {
    const err = e instanceof ArchiveError ? e : new ArchiveError('INTERNAL', String(e?.message ?? e))
    const record = { at: new Date().toISOString(), ok: false, status: 'failed', code: err.code, detail: err.detail, repo: root, branch, commit, journal }
    writeState(root, record)
    return record
  } finally {
    releaseLock(root)
  }
}

export const internals = { STATE_ROOT, stateFile, lockFile, changedFiles, unpushedCount, repoRoot }
