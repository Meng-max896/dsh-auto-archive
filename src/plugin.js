/**
 * dsh-auto-archive —— DSH 插件入口
 *
 * 三条行为：
 *  ① 每轮对话结束（turn/end）只归档本轮产生的文件
 *  ② 本轮产生的缓存是「只报告不删除」（mode: report）
 *  ③ 静默超过 N 天的会话：先做一次工作区最终快照，再归档会话
 *
 * 设计原则：任何一步能力缺失都降级并记录，绝不中断宿主。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { internals as archiveInternals, ArchiveError, gitAvailable, snapshot, snapshotPaths, status } from './archive.js'
import { reportOnly } from './cleanup.js'
import { limitBatch, pickIdleSessions } from './inactivity.js'
import { resolveLocale, translator } from './i18n.js'
import { classifyRootEntries } from './root-policy.js'
import { filterByAge, TurnBaselines } from './turn-tracker.js'

const STATE_DIR = archiveInternals.STATE_ROOT
const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version

export const name = 'dsh-auto-archive'
export const inject = ['tools']

const NoiseRules = z.object({
  dirs: z.array(z.string()),
  extensions: z.array(z.string()),
  names: z.array(z.string()),
  globs: z.array(z.string()),
})

export const Config = z.object({
  /** auto | zh-CN | en-US */
  locale: z.union(['auto', 'zh-CN', 'en-US']).default('auto'),
  /** 默认是否推送 */
  push: z.boolean().default(true),
  /** 归档目标目录；留空则使用会话自身的 cwd */
  repo: z.string().default(''),
  /** 每轮结束自动归档 */
  turnArchive: z.boolean().default(true),
  /** 跳过最近 N 秒内改动过的文件（0 = 不过滤；文件可能仍在被写入） */
  minFileAgeSeconds: z.number().default(0),
  /** 缓存识别（只报告，不删除） */
  cleanup: z
    .object({
      enabled: z.boolean().default(true),
      rules: NoiseRules,
    })
    .default({ enabled: true }),
  /** 静默期归档 */
  inactivity: z
    .object({
      enabled: z.boolean().default(true),
      idleDays: z.number().default(7),
      scanMinutes: z.number().default(60),
      maxBatch: z.number().default(20),
      /** 归档会话时是否请求停止其正在运行的工作 */
      stopActivity: z.boolean().default(true),
    })
    .default({}),
  /** 定时归档的仓库列表（原有能力，保留） */
  repos: z
    .array(
      z.object({
        repo: z.string(),
        push: z.boolean().default(true),
        message: z.string(),
        intervalMinutes: z.number().default(0),
        maxFiles: z.number().default(20),
      }),
    )
    .default([]),
  /** 加载痕迹：apply 成功时写一个标记文件，便于诊断宿主是否真的挂载了本插件 */
  traceLoad: z.boolean().default(false),
})

const DEFAULTS = {
  locale: 'auto',
  push: true,
  repo: '',
  turnArchive: true,
  minFileAgeSeconds: 0,
  cleanup: { enabled: true },
  inactivity: {},
  repos: [],
}

const SESSION_METHOD_CANDIDATES = ['listSessions', 'list', 'sessions', 'orderedSessions', 'headers']

function sessionIdOf(session) {
  return session?.header?.id ?? session?.id ?? session?.sessionId ?? null
}

function cwdOf(session) {
  return session?.header?.cwd ?? session?.cwd ?? null
}

/** 运行时探测：宿主是否有可枚举会话的能力 */
function sessionLister(registry) {
  if (!registry) return null
  for (const method of SESSION_METHOD_CANDIDATES) {
    if (typeof registry[method] === 'function') return (args) => registry[method](args)
  }
  return null
}

function toSessionRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .map((row) => {
      const header = row?.header ?? row
      return {
        sessionId: header?.id ?? row?.sessionId ?? row?.id,
        lastActivity: header?.updatedAt ?? header?.createdAt ?? row?.updatedAt ?? row?.lastActivity,
      }
    })
    .filter((row) => row.sessionId)
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const inactivity = { ...DEFAULTS.inactivity, ...(cfg.inactivity ?? {}) }
  const cleanupCfg = { ...DEFAULTS.cleanup, ...(cfg.cleanup ?? {}) }
  const t = translator(resolveLocale(cfg.locale))
  const tracker = new TurnBaselines()
  /** sessionId → 上一轮的归档与清理结论（只读工具会用到） */
  const lastTurn = new Map()
  const warned = new Set()

  /**
   * 宿主未注入某服务时，Cordis 在「读取属性」这一步就会抛错，
   * 因此可选服务一律经过 try/catch，绝不让 apply 抛异常。
   */
  const tryRead = (read) => {
    try {
      return read()
    } catch {
      return undefined
    }
  }
  /**
   * 直接写宿主 stdout：ctx.logger 在未注入时读取即抛错，
   * 若只走 logger，"终端要有运行提示"这条需求会静默失效。
   */
  const writeLine = (message) => {
    // 三通道兜底：宿主可能只把 stderr 或日志文件呈现给人，stdout 未必可见
    const line = `${message}\n`
    try {
      process.stderr.write(line)
    } catch {}
    try {
      process.stdout.write(line)
    } catch {}
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(join(STATE_DIR, 'plugin.log'), `${new Date().toISOString()} ${message}\n`, { flag: 'a' })
    } catch {}
  }
  const log = {
    warn: (message) => writeLine(message),
    info: (message) => writeLine(message),
  }
  /** 可选服务的运行期状态；通过 Cordis 按需注入获得，服务缺失时保持 falsy */
  const optional = { timer: false, registry: null }

  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    log.warn(`[dsh-auto-archive] ${message}`)
  }

  /** 已注册的工具名，供加载痕迹记录 */
  const registeredNames = []

  const register = (definition) => {
    try {
      const dispose = ctx.tools.register(defineTool(definition))
      registeredNames.push(definition.name)
      return dispose
    } catch (e) {
      warnOnce(`tool:${definition.name}`, `注册工具 ${definition.name} 失败: ${e?.message ?? e}`)
      return () => {}
    }
  }

  /** 诊断用：证明宿主确实执行了 apply，并记录它拿到了哪些服务 */
  const traceLoad = () => {
    if (!cfg.traceLoad) return
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(
        join(STATE_DIR, 'load-trace.json'),
        `${JSON.stringify(
          {
            at: new Date().toISOString(),
            pid: process.pid,
            node: process.version,
            locale: cfg.locale,
            tools: registeredNames,
            services: {
              tools: typeof ctx.tools?.register === 'function',
              setInterval: Boolean(optional.timer),
              workspaceRegistry: Boolean(optional.registry),
              sessionEvent: typeof ctx.on === 'function',
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch {
      /* 痕迹写不进去不影响插件 */
    }
  }

  const outputShape = {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean', required: true },
        status: { type: 'string', required: true },
        summary: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  }

  const targetRepo = (explicit) => explicit?.trim() || cfg.repo || process.cwd()

  // ───────────────────────── 工具 ─────────────────────────

  register({
    name: 'archive_now',
    description: t('tool.archive_now.description'),
    parameters: {
      repo: { type: 'string', description: t('tool.archive_now.param.repo') },
      message: { type: 'string', description: t('tool.archive_now.param.message') },
      push: { type: 'boolean', description: t('tool.archive_now.param.push') },
      dry_run: { type: 'boolean', description: t('tool.archive_now.param.dry_run') },
    },
    output: outputShape,
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const repo = targetRepo(args.repo)
      try {
        if (!(await gitAvailable())) throw new ArchiveError('GIT_MISSING')
        const result = await snapshot({ repo, message: args.message, push: args.push ?? cfg.push, dryRun: args.dry_run === true })
        return shapeResult(result, t)
      } catch (e) {
        return failure(e, repo, t)
      }
    },
  })

  register({
    name: 'archive_status',
    description: t('tool.archive_status.description'),
    parameters: { repo: { type: 'string', description: t('tool.archive_status.param.repo') } },
    output: outputShape,
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.()
      const repo = targetRepo(args.repo)
      try {
        if (!(await gitAvailable())) throw new ArchiveError('GIT_MISSING')
        const s = await status({ repo })
        const keys = [...lastTurn.keys()]
        const turnLine = keys.length
          ? keys.map((k) => `${k}: ${lastTurn.get(k).touched.length} files`).join('; ')
          : t('render.turnNone')
        const summary =
          t('render.status', {
            repo: s.repo,
            branch: s.branch || '(none)',
            pendingFiles: s.pendingFiles,
            unpushed: s.unpushed,
            hasRemote: s.hasRemote ? t('render.yes') : t('render.no'),
            identityConfigured: s.identityConfigured ? t('render.yes') : t('render.no'),
            last: s.last?.at ? `${s.last.status} @ ${s.last.at}` : t('render.never'),
          }) + (s.locked ? t('render.statusLocked') : '') + t('render.turnSummary', { detail: turnLine })
        return { ok: true, status: s.status, summary, ...s }
      } catch (e) {
        return failure(e, repo, t)
      }
    },
  })

  register({
    name: 'archive_cleanup_report',
    description: t('tool.archive_cleanup_report.description'),
    parameters: {
      repo: { type: 'string', description: t('tool.archive_cleanup_report.param.repo') },
      dry_run: { type: 'boolean', description: t('tool.archive_cleanup_report.param.dry_run') },
    },
    output: outputShape,
    execute: async (args) => {
      const repo = targetRepo(args.repo)
      const keys = [...lastTurn.keys()]
      const rows = keys.map((k) => lastTurn.get(k)).filter(Boolean)
      const candidates = rows.flatMap((r) => r.cleanup?.candidates ?? [])
      const unique = [...new Set(candidates)].sort()
      const summary = t('render.cleanupReport', {
        repo,
        mode: cleanupCfg.enabled ? t('render.cleanupModeReport') : t('render.cleanupDisabled'),
        count: unique.length,
        list: unique.length ? unique.map((c) => `  - ${c}`).join('\n') : t('render.dryRunNoFiles'),
      })
      return { ok: true, status: 'cleanup-report', summary, repo, mode: 'report', candidates: unique, destructive: false }
    },
  })

  register({
    name: 'archive_root_policy',
    description: t('tool.archive_root_policy.description'),
    parameters: { repo: { type: 'string', description: t('tool.archive_root_policy.param.repo') } },
    output: outputShape,
    execute: async (args) => {
      const repo = targetRepo(args.repo)
      try {
        const names = readdirSync(repo, { withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => d.name)
        const policy = classifyRootEntries(names)
        const fmt = (list) => (list.length ? list.map((x) => '  - ' + x).join('\n') : t('render.dryRunNoFiles'))
        const movableLines = policy.movable.map((m) => '  - ' + m.name + ' → ' + m.target + '（' + m.kind + '）').join('\n')
        const summary = t('render.rootPolicy', {
          repo,
          keep: policy.keep.length,
          movable: policy.movable.length,
          unknown: policy.unknown.length,
          keepList: policy.keep.map((k) => '  - ' + k.name + '（' + k.reason + '）').join('\n') || t('render.dryRunNoFiles'),
          movableList: movableLines || t('render.dryRunNoFiles'),
          unknownList: fmt(policy.unknown),
        })
        return { ok: true, status: 'root-policy', summary, repo, ...policy, destructive: false }
      } catch (e) {
        return failure(e, repo, t)
      }
    },
  })

  // ─────────────────── ① ② 每轮结束归档 + 缓存报告 ───────────────────

  ctx.on?.('session/event', async (session, event) => {
    if (!cfg.turnArchive) return
    try {
      const sessionId = sessionIdOf(session)
      if (!sessionId) return
      // 显式配置的 repo 优先：会话 cwd 可能是宿主工作目录而非工作区
      const repo = cfg.repo || cwdOf(session) || process.cwd()

      if (event?.type === 'turn/start') {
        await tracker.begin(repo, sessionId)
        return
      }
      if (event?.type !== 'turn/end') return

      const diff = await tracker.end(repo, sessionId)
      if (!diff) {
        // 插件中途加载：这一轮没有基线，从下一轮开始生效
        warnOnce(`nobase:${sessionId}`, `会话 ${sessionId} 缺少轮次基线，本轮跳过归档（下一轮开始生效）`)
        return
      }
      if (diff.touched.length === 0) return

      const cleanup = cleanupCfg.enabled ? reportOnly(diff.created, cleanupCfg.rules ?? {}) : null
      const noise = new Set(cleanup?.candidates ?? [])
      const candidates = diff.touched.filter((p) => !noise.has(p))
      const fresh = await filterByAge(diff.repo, candidates, cfg.minFileAgeSeconds)
      const pathsToCommit = fresh.kept

      lastTurn.set(sessionId, { at: new Date().toISOString(), touched: diff.touched, cleanup })

      if (pathsToCommit.length === 0) return
      if (!(await gitAvailable())) return

      const turnNo = event?.data?.turn ?? event?.turn ?? '?'
      const result = await snapshotPaths({
        repo: diff.repo,
        paths: pathsToCommit,
        message: `chore(archive): turn ${turnNo} · {count} files`,
        push: cfg.push,
      })
      log.info(
        `[dsh-auto-archive] turn ${turnNo}: ${result.status}${result.code ? ` (${result.code})` : ''}` +
          (result.commit ? ` ${result.commit}` : '') +
          ` · ${pathsToCommit.length} 个文件` +
          (cleanup?.count ? ` · 缓存 ${cleanup.count} 个（仅报告）` : '') +
          (fresh.skipped.length ? ` · 太新跳过 ${fresh.skipped.length} 个` : ''),
      )
    } catch (e) {
      warnOnce(`turn:${sessionIdOf(session)}`, `轮次归档失败: ${e?.message ?? e}`)
    }
  })

  // ─────────────────── ③ 静默期归档 ───────────────────

  const sweepIdle = async () => {
    if (!inactivity.enabled) return
    try {
      const lister = sessionLister(registry)
      if (!lister) {
        warnOnce('inactivity', '宿主未提供会话枚举能力，静默期归档已跳过')
        return
      }
      const rows = toSessionRows(await lister())
      const { idle } = pickIdleSessions(rows, { idleDays: inactivity.idleDays })
      if (idle.length === 0) return

      const batch = limitBatch(idle, inactivity.maxBatch)
      const repo = targetRepo()
      if (await gitAvailable()) {
        await snapshot({ repo, push: cfg.push, message: `chore(archive): idle snapshot · {count} files` })
      }
      for (const item of batch) {
        try {
          await optional.registry.archiveSession?.(item.sessionId, { stopActivity: inactivity.stopActivity })
        } catch (e) {
          warnOnce(`archive:${item.sessionId}`, `归档会话 ${item.sessionId} 失败: ${e?.message ?? e}`)
        }
      }
      log.info(`[dsh-auto-archive] 静默期归档完成：${batch.length} 个会话`)
    } catch (e) {
      warnOnce('sweep', `静默期扫描失败: ${e?.message ?? e}`)
    }
  }

  /** 注入是异步的：每次注入落地后都重报一次状态，最终那次才是准确的 */
  const reportStatus = () => {
    log.info(
      `[dsh-auto-archive] 已加载 v${VERSION} · 工具 ${registeredNames.length} 个` +
        ` · 轮次归档=${cfg.turnArchive ? '开' : '关'}` +
        ` · 静默扫描=${inactivity.enabled ? `${inactivity.scanMinutes} 分钟（阈值 ${inactivity.idleDays} 天）` : '关'}` +
        ` · 会话归档=${optional.registry ? '可用' : '不可用'}` +
        ` · 定时器=${optional.timer ? '可用' : '不可用'}`,
    )
    traceLoad()
  }
  setTimeout(reportStatus, 50)

  // ── 可选服务：按需注入。服务缺失时回调不执行，插件其余能力照常工作 ──
  tryRead(() =>
    ctx.inject(['workspaceRegistry'], (sctx) => {
      optional.registry = sctx.workspaceRegistry ?? null
      reportStatus()
    }),
  )

  tryRead(() =>
    ctx.inject(['timer'], (sctx) => {
      optional.timer = true
      if (inactivity.enabled) {
        const every = Math.max(5, Number(inactivity.scanMinutes) || 60) * 60 * 1000
        const dispose = sctx.setInterval(sweepIdle, every)
        sctx.effect(() => dispose, 'dsh-auto-archive: inactivity sweep')
      }
      for (const entry of cfg.repos) {
        const minutes = Number(entry?.intervalMinutes ?? 0)
        if (!entry?.repo || !(minutes > 0)) continue
        const dispose = sctx.setInterval(async () => {
          try {
            await snapshot({ repo: entry.repo, message: entry.message, push: entry.push ?? cfg.push, maxFiles: entry.maxFiles })
          } catch (e) {
            warnOnce(`interval:${entry.repo}`, `定时归档失败: ${e?.message ?? e}`)
          }
        }, minutes * 60 * 1000)
        sctx.effect(() => dispose, `dsh-auto-archive: interval ${entry.repo}`)
      }
      reportStatus()
    }),
  )

}

// ───────────────────────── 结果整形 ─────────────────────────

function shapeResult(result, t) {
  const mk = (summary) => ({ ok: result.ok !== false, status: result.status, summary, ...result })
  switch (result.status) {
    case 'pushed':
      return mk(
        t('render.pushed', {
          repo: result.repo,
          branch: result.branch,
          commit: result.commit ?? '(none)',
          attempts: result.attempts ?? 1,
          rebased: result.rebased ? t('render.rebased') : '',
        }),
      )
    case 'pushed-pending':
      return mk(
        t('render.pushedPending', {
          repo: result.repo,
          branch: result.branch,
          unpushedBefore: result.unpushedBefore ?? 0,
          attempts: result.attempts ?? 1,
          rebased: result.rebased ? t('render.rebased') : '',
        }),
      )
    case 'committed-only':
      return mk(t('render.committedOnly', { repo: result.repo, branch: result.branch, commit: result.commit ?? '(none)' }))
    case 'nothing-to-commit':
      return mk(t('render.nothingToCommit', { repo: result.repo }))
    case 'up-to-date':
      return mk(t('render.upToDate', { repo: result.repo, branch: result.branch }))
    case 'nothing-to-push':
      return mk(t('render.nothingToPush', { repo: result.repo, branch: result.branch }))
    case 'dry-run': {
      const fileList = result.files.length > 0 ? result.files.map((f) => `  - ${f}`).join('\n') : t('render.dryRunNoFiles')
      return mk(t('render.dryRun', { repo: result.repo, branch: result.branch, count: result.count, unpushed: result.unpushed, fileList }))
    }
    case 'locked':
      return mk(t('render.locked', { repo: result.repo, pid: result.holder?.pid ?? '?' }))
    default:
      return mk(JSON.stringify(result))
  }
}

function failure(err, repo, t) {
  const code = err instanceof ArchiveError ? err.code : 'INTERNAL'
  const detail = err instanceof ArchiveError ? err.detail : String(err?.message ?? err)
  const message = t(`error.${code}`, { detail })
  return { ok: false, status: 'failed', code, message, summary: t('render.error', { message, repo }), repo }
}
