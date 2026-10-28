#!/usr/bin/env node
/**
 * dsh-auto-archive 安装体检：逐项给出 PASS/FAIL 与证据。
 * 全程只读，不提交、不推送、不改任何文件。
 *
 *   node scripts/doctor.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const PLUGIN = 'E:/DSH/dsh-auto-archive'
const STATE = join(DSH_HOME, 'dsh-auto-archive')
const REPO = 'E:/DSH'

const rows = []
const add = (ok, name, evidence) => rows.push({ ok, name, evidence })

function tryExec(cmd, args, cwd) {
  try {
    return { ok: true, out: String(execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20000 })).trim() }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message ?? e) }
  }
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// 1) 包自身完整
const pkg = readJson(join(PLUGIN, 'package.json'))
add(Boolean(pkg?.name === 'dsh-auto-archive'), '包元数据', pkg ? `${pkg.name}@${pkg.version}` : 'package.json 读取失败')
add(Boolean(pkg?.dsh?.bundle?.patch), 'bundle 声明', pkg?.dsh?.bundle?.patch ?? '缺失')
add(existsSync(join(PLUGIN, 'icon.svg')) && Boolean(pkg?.icon), '图标（插件管理器显示用）', pkg?.icon ?? '缺失')
add(existsSync(join(PLUGIN, 'locale', 'zh.json')) && existsSync(join(PLUGIN, 'locale', 'en.json')), '双语显示名', 'locale/zh.json + en.json')
add(existsSync(join(PLUGIN, 'cordis.patch.yml')), '包内挂载声明', 'cordis.patch.yml')

// 2) 源码可解析
for (const f of ['src/plugin.js', 'src/archive.js', 'src/turn-tracker.js', 'src/cleanup.js', 'src/inactivity.js', 'src/i18n.js']) {
  const r = tryExec(process.execPath, ['--check', join(PLUGIN, f)])
  add(r.ok, `语法 ${f}`, r.ok ? 'node --check 通过' : r.out.split('\n')[0])
}

// 3) 装进 profile
const prof = readJson(join(PROFILE, 'package.json'))
const deps = Object.keys(prof?.dependencies ?? {})
const bundles = prof?.dsh?.profile?.bundles ?? []
add(deps.includes('dsh-auto-archive'), 'profile 依赖声明', deps.includes('dsh-auto-archive') ? '已声明' : '未声明')
add(bundles.includes('dsh-auto-archive'), 'profile bundle 列表', bundles.includes('dsh-auto-archive') ? '已加入' : '未加入')
const linkPath = join(PROFILE, 'node_modules', 'dsh-auto-archive', 'package.json')
add(existsSync(linkPath), 'node_modules 可解析', linkPath.replace(DSH_HOME, '~/.dsh'))

// 4) 宿主是否真的加载了（痕迹 pid == 当前宿主 pid）
const trace = readJson(join(STATE, 'load-trace.json'))
const host = tryExec('powershell.exe', [
  '-NoProfile',
  '-Command',
  "(Get-NetTCPConnection -LocalPort 3080 -State Listen -EA SilentlyContinue | Select-Object -First 1).OwningProcess",
])
const hostPid = Number(String(host.out).trim())
add(trace !== null, '加载痕迹存在', trace ? `写入 ${trace.at}` : '未生成（宿主尚未加载本插件）')
add(Boolean(trace && hostPid && Number(trace.pid) === hostPid), '痕迹 pid == 当前宿主', trace ? `痕迹 ${trace.pid} / 宿主 ${hostPid || '未知'}` : '-')
add(Boolean(trace?.services?.tools), 'tools 服务注入', String(trace?.services?.tools))
add(Boolean(trace?.services?.setInterval), 'timer 服务注入（需求③依赖）', String(trace?.services?.setInterval))
add(Boolean(trace?.services?.workspaceRegistry), 'workspaceRegistry 注入（需求③依赖）', String(trace?.services?.workspaceRegistry))
const EXPECTED_TOOLS = ['archive_now', 'archive_status', 'archive_cleanup_report', 'archive_root_policy']
const haveTools = Array.isArray(trace?.tools) ? trace.tools : []
const missingTools = EXPECTED_TOOLS.filter((x) => !haveTools.includes(x))
add(
  missingTools.length === 0,
  '工具注册数量',
  haveTools.join(', ') + (missingTools.length ? ' （缺少 ' + missingTools.join(', ') + ' —— 需重启宿主加载新构建）' : ''),
)

// 5) 运行时日志（终端提示的可靠备份）
const pluginLog = join(STATE, 'plugin.log')
if (existsSync(pluginLog)) {
  const lines = readFileSync(pluginLog, 'utf8').trim().split('\n')
  add(true, '运行日志', `${lines.length} 行，最后一条：${lines[lines.length - 1].slice(0, 90)}`)
} else {
  add(false, '运行日志', 'plugin.log 未生成（说明新代码未加载）')
}

// 6) 仓库与远端
const head = tryExec('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'])
const unpushed = tryExec('git', ['-C', REPO, 'rev-list', '--count', 'origin/main..HEAD'])
const dirty = tryExec('git', ['-C', REPO, 'status', '--porcelain'])
const remote = tryExec('git', ['-C', REPO, 'config', '--get', 'remote.origin.url'])
add(head.ok, '仓库可读', head.out)
add(remote.ok && remote.out.length > 0, '远端已配置', remote.out || '无')
add(true, '未推送提交', `${unpushed.out || '?'} 个`)
add(dirty.out === '', '工作区状态', dirty.out === '' ? '干净' : `${dirty.out.split('\n').length} 个文件待提交`)

// 7) 代理/网络（只影响推送）
const proxyCfg = tryExec('git', ['-C', REPO, 'config', '--get', 'http.proxy'])
add(true, '代理配置', proxyCfg.out || '（未配置，直连）')

// 8) 归档状态文件
const states = existsSync(STATE) ? readFileSync ? null : null : null
add(existsSync(STATE), '状态目录', STATE.replace(DSH_HOME, '~/.dsh'))

// 输出
const pad = (s, n) => String(s).padEnd(n)
console.log('')
console.log('  dsh-auto-archive 安装体检')
console.log('  ' + '-'.repeat(72))
let fail = 0
for (const r of rows) {
  if (!r.ok) fail++
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.name, 34)} ${r.evidence}`)
}
console.log('  ' + '-'.repeat(72))
console.log(`  合计：${rows.length} 项，通过 ${rows.length - fail}，失败 ${fail}`)
console.log('')
process.exit(fail === 0 ? 0 : 1)
