/**
 * 根目录归属判断：哪些文件该留在仓库根、哪些可以移进子目录。
 * 只做判定与建议，不执行任何移动（移动是不可逆操作，交由人决定）。
 */

/** 精确匹配：必须留在根 */
const KEEP_EXACT = new Set([
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.gitmessage',
  'readme.md',
  'readme.zh.md',
  'readme.en.md',
  'license',
  'license.md',
  'changelog.md',
  'contributing.md',
  'code_of_conduct.md',
  'security.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'yarn.lock',
  'tsconfig.json',
  'claude.md',
  'agents.md',
  'makefile',
  'dockerfile',
])

/** 扩展名：属于工程/入口文件，留根 */
const KEEP_EXT = new Set([
  '.eproj',
  '.epro2',
  '.eprj',
  '.proprj',
  '.code-workspace',
  '.sln',
  '.csproj',
  '.cmd',
  '.bat',
  '.ps1',
  '.json',
  '.yml',
  '.yaml',
])

/** 分类规则：可移动的文件 → 建议目标目录 */
const MOVABLE = [
  { kind: '文档', dir: 'docs/', ext: ['.md', '.docx', '.pdf', '.pptx', '.xlsx', '.txt'] },
  { kind: '素材', dir: 'assets/', ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.m4a', '.wav'] },
  { kind: '脚本', dir: 'scripts/', ext: ['.py', '.js', '.mjs', '.cjs', '.sh'] },
  { kind: '临时', dir: 'tmp/', ext: ['.tmp', '.bak', '.log', '.jsonl', '.crdownload', '.part'] },
]

const lower = (s) => String(s).toLowerCase()

/**
 * 判断根目录下每个文件的归属。
 * @param {string[]} entries 根目录下的文件名（不含目录）
 * @returns {{keep: Array<{name, reason}>, movable: Array<{name, kind, target}>, unknown: string[]}}
 */
export function classifyRootEntries(entries = []) {
  const keep = []
  const movable = []
  const unknown = []

  for (const name of entries) {
    const low = lower(name)

    if (KEEP_EXACT.has(low)) {
      keep.push({ name, reason: '仓库元数据/说明文件，必须在根' })
      continue
    }

    const dot = low.lastIndexOf('.')
    const ext = dot > 0 ? low.slice(dot) : ''

    if (KEEP_EXT.has(ext)) {
      keep.push({ name, reason: `工程/入口文件（${ext}），留根` })
      continue
    }

    const rule = MOVABLE.find((r) => r.ext.includes(ext))
    if (rule) {
      movable.push({ name, kind: rule.kind, target: rule.dir })
      continue
    }

    unknown.push(name)
  }

  const by = (a, b) => (a.name < b.name ? -1 : 1)
  return {
    keep: keep.sort(by),
    movable: movable.sort(by),
    unknown: unknown.sort(),
  }
}

/** 便于人阅读的一行摘要 */
export function summarize(policy) {
  return `留根 ${policy.keep.length} · 可移动 ${policy.movable.length} · 需人工判断 ${policy.unknown.length}`
}
