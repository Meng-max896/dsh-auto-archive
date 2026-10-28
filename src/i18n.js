import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'locale')
const cache = new Map()

function normalize(raw) {
  const s = String(raw ?? '').toLowerCase()
  return s.startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** 解析配置里的 locale；auto 时跟随系统 */
export function resolveLocale(configured) {
  const wanted = String(configured ?? 'auto')
  if (wanted !== 'auto') return normalize(wanted)
  const env =
    process.env.DSH_LOCALE ||
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    'en'
  return normalize(env)
}

function load(locale) {
  if (cache.has(locale)) return cache.get(locale)
  let dict = {}
  try {
    dict = JSON.parse(readFileSync(join(LOCALE_DIR, `${locale}.json`), 'utf8'))
  } catch {
    if (locale !== 'en-US') return load('en-US')
  }
  cache.set(locale, dict)
  return dict
}

/** 返回 t(key, vars)；缺失键回落到 en-US，再缺则原样返回 key */
export function translator(locale) {
  const dict = load(locale)
  const fallback = load('en-US')
  return (key, vars) => {
    const tpl = dict[key] ?? fallback[key] ?? key
    if (!vars) return tpl
    return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
  }
}
