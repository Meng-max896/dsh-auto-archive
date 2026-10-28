/**
 * 缓存噪音识别：只判定，不执行删除。
 * 决策依据是「本轮新建 + 命中规则」，绝不对历史文件下手。
 */

/** 默认规则：保守，只覆盖公认的可再生垃圾 */
export const DEFAULT_RULES = {
  /** 目录名（任意层级） */
  dirs: ['node_modules', '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.next', '.turbo', '.cache'],
  /** 扩展名 */
  extensions: ['.tmp', '.bak', '.pyc', '.pyo', '.log', '.swp', '.swo', '.crdownload', '.part'],
  /** 文件名（精确匹配） */
  names: ['.DS_Store', 'Thumbs.db', 'desktop.ini'],
  /** 路径 glob（简单前缀/包含匹配，不引入依赖） */
  globs: [],
}

const normalize = (p) => p.replaceAll('\\', '/')

function matchesDir(rel, dirs) {
  const parts = normalize(rel).split('/')
  // 最后一段是文件名，其余是目录
  return parts.slice(0, -1).some((seg) => dirs.includes(seg))
}

function matchesExt(rel, extensions) {
  const lower = normalize(rel).toLowerCase()
  return extensions.some((ext) => lower.endsWith(ext))
}

function matchesName(rel, names) {
  const base = normalize(rel).split('/').pop()
  return names.includes(base)
}

function matchesGlob(rel, globs) {
  const norm = normalize(rel)
  return globs.some((g) => {
    const pattern = normalize(g)
    if (pattern.startsWith('*') && pattern.endsWith('*')) return norm.includes(pattern.slice(1, -1))
    if (pattern.startsWith('*')) return norm.endsWith(pattern.slice(1))
    if (pattern.endsWith('*')) return norm.startsWith(pattern.slice(0, -1))
    return norm === pattern
  })
}

/**
 * 从本轮新建的文件里挑出命中噪音规则的候选。
 * @param {string[]} created 本轮新建的相对路径
 * @param {object} [rules] 覆盖 DEFAULT_RULES 的部分字段
 * @returns {{candidates: string[], byRule: Record<string, string[]>, mode: string}}
 */
export function classifyCandidates(created, rules = {}) {
  const merged = {
    dirs: rules.dirs ?? DEFAULT_RULES.dirs,
    extensions: rules.extensions ?? DEFAULT_RULES.extensions,
    names: rules.names ?? DEFAULT_RULES.names,
    globs: rules.globs ?? DEFAULT_RULES.globs,
  }
  const candidates = []
  const byRule = { dir: [], ext: [], name: [], glob: [] }

  for (const rel of created) {
    if (matchesDir(rel, merged.dirs)) {
      candidates.push(rel)
      byRule.dir.push(rel)
      continue
    }
    if (!rel) continue
    const ext = `.${normalize(rel).split('.').pop().toLowerCase()}`
    if (merged.extensions.includes(ext) || matchesExt(rel, merged.extensions)) {
      candidates.push(rel)
      byRule.ext.push(rel)
      continue
    }
    if (matchesName(rel, merged.names)) {
      candidates.push(rel)
      byRule.name.push(rel)
      continue
    }
    if (matchesGlob(rel, merged.globs)) {
      candidates.push(rel)
      byRule.glob.push(rel)
    }
  }

  return { candidates: candidates.sort(), byRule, mode: 'report' }
}

/**
 * 只报告，不删除。返回可直接展示给人看的条目。
 * @param {string[]} created 本轮新建路径
 * @param {object} [rules]
 */
export function reportOnly(created, rules) {
  const { candidates, byRule } = classifyCandidates(created, rules)
  return {
    mode: 'report',
    count: candidates.length,
    candidates,
    byRule,
    /** 明确声明本函数不产生任何副作用，便于调用方与审计 */
    destructive: false,
  }
}
