/**
 * 静默期判定：纯函数，不接触宿主，便于单测。
 * 用于「一周内没有新增内容 → 归档会话」。
 */

const DAY_MS = 24 * 60 * 60 * 1000

function toMillis(value) {
  if (value === null || value === undefined) return NaN
  if (typeof value === 'number') return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : NaN
}

/**
 * 挑出静默超过 idleDays 的会话。
 * @param {Array<{sessionId: string, lastActivity: string|number}>} sessions
 * @param {{idleDays?: number, now?: number}} [opts]
 * @returns {{idle: Array<{sessionId: string, lastActivity: string, idleDays: number}>, active: number, skipped: number}}
 */
export function pickIdleSessions(sessions, opts = {}) {
  const idleDays = Number(opts.idleDays ?? 7)
  const now = Number(opts.now ?? Date.now())
  const cutoff = now - idleDays * DAY_MS

  const idle = []
  let active = 0
  let skipped = 0

  for (const item of Array.isArray(sessions) ? sessions : []) {
    const sessionId = item?.sessionId ?? item?.id
    const at = toMillis(item?.lastActivity ?? item?.updatedAt)
    if (!sessionId || !Number.isFinite(at)) {
      skipped++
      continue
    }
    if (at <= cutoff) {
      idle.push({
        sessionId,
        lastActivity: new Date(at).toISOString(),
        idleDays: Number(((now - at) / DAY_MS).toFixed(1)),
      })
    } else {
      active++
    }
  }

  idle.sort((a, b) => (a.lastActivity < b.lastActivity ? -1 : 1))
  return { idle, active, skipped }
}

/** 静默期内的会话数上限保护：一次归档太多会拖慢宿主 */
export function limitBatch(idle, max = 20) {
  return idle.slice(0, Math.max(0, max))
}
