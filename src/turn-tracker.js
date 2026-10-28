/**
 * 轮次归属：在 turn/start 记录工作区基线，turn/end 时 diff 出「本轮产生的文件」。
 *
 * 为什么不用 git status 的集合差：本轮开始前就已存在的脏文件，在前后两次
 * status 里都是同一条记录，集合差会把「本轮又改了一次」误判为「本轮没动」。
 * 因此基线记录每个受管文件的 mtime，用 mtime 变化判定修改。
 */
import { stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 超过这个文件数就退化为只记录 git status 集合差（避免巨大仓库每轮全量 stat） */
const FULL_SCAN_LIMIT = 50000

async function gitList(repo, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    return String(stdout).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 抓取工作区基线。
 * @param {string} repo 仓库根目录
 * @returns {Promise<{mode: 'mtime'|'status'|'overflow', files: Map<string, number>, status: Set<string>, at: string}>}
 */
export async function captureBaseline(repo) {
  const at = new Date().toISOString()
  const tracked = await gitList(repo, ['ls-files'])
  const untracked = await gitList(repo, ['ls-files', '--others', '--exclude-standard'])
  const statusLines = await gitList(repo, ['status', '--porcelain=v1'])
  const status = new Set(statusLines.map((line) => line.slice(3).trim()))

  const all = [...tracked, ...untracked]
  if (all.length > FULL_SCAN_LIMIT) {
    return { mode: 'overflow', files: new Map(), status, at }
  }

  const files = new Map()
  const CONCURRENCY = 64
  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const slice = all.slice(i, i + CONCURRENCY)
    const stats = await Promise.all(
      slice.map(async (rel) => {
        try {
          const s = await stat(join(repo, rel))
          return [rel, s.mtimeMs]
        } catch {
          return [rel, -1]
        }
      }),
    )
    for (const [rel, mtime] of stats) files.set(rel, mtime)
  }
  return { mode: 'mtime', files, status, at }
}

/**
 * 比较两个基线，返回本轮创建/修改/删除的路径。
 * @returns {{created: string[], modified: string[], deleted: string[], touched: string[]}}
 */
export function diffBaseline(before, after) {
  const created = []
  const modified = []
  const deleted = []

  if (before.mode === 'overflow' || after.mode === 'overflow') {
    // 退化模式：只能给出「本轮结束后仍处于变更状态」的路径集合差
    for (const p of after.status) if (!before.status.has(p)) created.push(p)
    return { created: created.sort(), modified: [], deleted: [], touched: created.sort() }
  }

  for (const [rel, mtime] of after.files) {
    const prev = before.files.get(rel)
    if (prev === undefined) created.push(rel)
    else if (prev !== mtime) modified.push(rel)
  }
  for (const rel of before.files.keys()) {
    if (!after.files.has(rel)) deleted.push(rel)
  }

  const touched = [...created, ...modified, ...deleted].sort()
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort(), touched }
}

/** 每个会话 → 最近一次基线，供插件在 turn/start / turn/end 之间持有 */
export class TurnBaselines {
  #bySession = new Map()

  async begin(repo, sessionId) {
    const baseline = await captureBaseline(repo)
    this.#bySession.set(sessionId, { repo, baseline })
    return baseline
  }

  has(sessionId) {
    return this.#bySession.has(sessionId)
  }

  /** 结束一轮并返回差异；没有基线（例如插件中途加载）时返回 null */
  async end(repo, sessionId) {
    const record = this.#bySession.get(sessionId)
    this.#bySession.delete(sessionId)
    if (!record) return null
    const after = await captureBaseline(record.repo || repo)
    return { ...diffBaseline(record.baseline, after), repo: record.repo || repo }
  }

  clear(sessionId) {
    this.#bySession.delete(sessionId)
  }
}

/**
 * 文件年龄过滤：跳过最近 N 秒内改动过的文件（可能仍在被写入）。
 * @param {string} repo 仓库根
 * @param {string[]} paths 相对路径
 * @param {number} seconds 0 表示不过滤
 * @returns {Promise<{kept: string[], skipped: string[]}>}
 */
export async function filterByAge(repo, paths, seconds) {
  if (!(seconds > 0)) return { kept: paths, skipped: [] }
  const cutoff = Date.now() - seconds * 1000
  const kept = []
  const skipped = []
  for (const rel of paths) {
    try {
      const s = await stat(join(repo, rel))
      if (s.mtimeMs > cutoff) skipped.push(rel)
      else kept.push(rel)
    } catch {
      kept.push(rel)
    }
  }
  return { kept, skipped }
}