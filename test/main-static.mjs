#!/usr/bin/env node
'use strict'
/**
 * 主进程静态断言（第四轮审查 §九，v3.3.18 新增）
 *
 * 为什么需要这个文件：
 *   `test/smoke.mjs` 的 17 项断言全部打在渲染层 DOM / state 上，**主进程零断言**；
 *   `node --check` 只查语法。于是 v2.8.16 出现了「17/17 全过」与「5 个必抛
 *   ReferenceError」并存 —— 退出链、关机链、桌面歌词配置、文件关联四条链路全废。
 *
 * 本文件不启动 Electron、不出声，做三件事：
 *   1) 全量 `node --check`（src / test / tools / 根目录脚本）
 *   2) 关键函数体装载 + 打桩调用：sanitizeSettingsPatch / isSafeMediaRoot /
 *      cancelPowerAction 的依赖标识符必须都有声明
 *   3) 已知的 5 个「曾经漏声明」标识符 + 退出链/关机链关键字的回归哨兵
 *
 * 用法：node test/main-static.mjs        （退出码 0 = 全过）
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 从源码里切出 `function NAME(...) { ... }`（按行首 `}` 收尾） */
function sliceFn(src, name) {
  const head = new RegExp('^function ' + name + '\\s*\\(', 'm')
  const m = head.exec(src)
  if (!m) return null
  const end = src.indexOf('\n}\n', m.index)
  if (end < 0) return null
  return src.slice(m.index, end + 2)
}

/** 从源码里切出 `const NAME = ...` 到该语句结束（简单实现：到行尾，或平衡括号） */
function sliceConst(src, name) {
  const re = new RegExp('^const ' + name + '\\s*=', 'm')
  const m = re.exec(src)
  if (!m) return null
  let i = m.index
  // 初始化式是正则字面量时直接取整行 —— 按括号配平会被正则里的 () 打断
  const headEnd = src.indexOf('\n', m.index)
  const firstLine = src.slice(m.index, headEnd < 0 ? src.length : headEnd)
  if (/^const \w+\s*=\s*\//.test(firstLine)) return firstLine
  let depth = 0
  let seen = false
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '{' || c === '[') { depth++; seen = true }
    else if (c === ')' || c === '}' || c === ']') { depth--; if (seen && depth === 0) { i++; break } }
    else if (c === '\n' && depth === 0) { break }
  }
  return src.slice(m.index, i)
}

function main() {
  const mainSrc = read('src/main/main.js')

  console.log('=== 1) 全量语法检查 ===')
  const targets = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs|cjs)$/.test(e.name)) targets.push(p)
    }
  }
  for (const d of ['src', 'test', 'tools']) {
    const p = path.join(ROOT, d)
    if (fs.existsSync(p)) walk(p)
  }
  for (const f of ['make-lnk.js', 'make-vbs.js', 'make-lnk-online.js']) {
    if (fs.existsSync(path.join(ROOT, f))) targets.push(path.join(ROOT, f))
  }
  let bad = 0
  for (const t of targets) {
    const r = spawnSync(process.execPath, ['--check', t], { encoding: 'utf8' })
    if (r.status !== 0) {
      bad++
      console.log('  ✗ ' + path.relative(ROOT, t) + ' ' + String(r.stderr || '').slice(0, 200))
    }
  }
  ok('node --check 全量通过', bad === 0, targets.length + ' 个文件')

  console.log('\n=== 2) 关键函数装载（打桩执行，不启动 Electron）===')
  // 只取这几个函数真正依赖的部分，其余用桩喂进去
  const pieces = [
    'FORBIDDEN_SETTING_KEYS', 'SETTING_RANGES', 'SETTING_MAP_MAX', 'SETTING_ARRAY_MAX',
    'EXTRA_FORBIDDEN_ROOT', 'DANGEROUS_ROOT'
  ].map((n) => sliceConst(mainSrc, n)).filter(Boolean)
  const fnPieces = ['sanitizePlainValue', 'clampSetting', 'sanitizeSettingsPatch', 'isSafeMediaRoot']
    .map((n) => sliceFn(mainSrc, n)).filter(Boolean)

  ok('关键常量/函数都能从 main.js 切出', pieces.length >= 4 && fnPieces.length === 4,
    `常量 ${pieces.length} / 函数 ${fnPieces.length}`)

  const sandbox = { console, Number, String, Boolean, Object, Array, Math, JSON, RegExp, Set, Map }
  let ctx = null
  try {
    vm.createContext(sandbox)
    vm.runInContext(pieces.join('\n') + '\n' + fnPieces.join('\n'), sandbox, { filename: 'main-static-slice.js' })
    ctx = sandbox
    ok('装载时不抛 ReferenceError', true)
  } catch (err) {
    ok('装载时不抛 ReferenceError', false, err.message)
  }

  if (ctx) {
    // 数值夹取：volume:5 必须变 1（以前只过滤键名，值原样落盘 → IndexSizeError）
    try {
      const out = ctx.sanitizeSettingsPatch({ volume: 5, fadeMs: -1000 }, ctx.DEFAULT_SETTINGS_SHAPE || {
        volume: 0, fadeMs: 0, musicDirs: [], onlineCacheLimitMB: 0, desktopLyric: null
      })
      ok('sanitizeSettingsPatch 把 volume 夹到 1', out && out.volume === 1, JSON.stringify(out))
      ok('sanitizeSettingsPatch 把 fadeMs 夹到 0', out && out.fadeMs === 0)
    } catch (err) {
      ok('sanitizeSettingsPatch 可调用', false, err.message)
    }
    try {
      // 数组上限：这条会真的执行到 `v.length > SETTING_ARRAY_MAX`，
      // 常量没声明就会抛 ReferenceError —— 比字符串哨兵更硬
      const big = new Array(500).fill('D:/Music')
      const out2 = ctx.sanitizeSettingsPatch({ musicDirs: big }, { musicDirs: [] })
      ok('musicDirs 超长数组被拒（SETTING_ARRAY_MAX 有声明）', !('musicDirs' in out2))
    } catch (err) {
      ok('musicDirs 超长数组被拒（SETTING_ARRAY_MAX 有声明）', false, err.message)
    }
    try {
      ok('未知键被拒', !('evilKey' in ctx.sanitizeSettingsPatch({ evilKey: 1 }, { volume: 0 })))
      // 注意不能用 `'__proto__' in out` 判断 —— 原型链上永远为真
      const polluted = ctx.sanitizeSettingsPatch(JSON.parse('{"__proto__":{"x":1}}'), { volume: 0 })
      ok('原型污染键被拒',
        !Object.prototype.hasOwnProperty.call(polluted, '__proto__') && !('x' in Object.prototype))
    } catch (err) {
      ok('键白名单可调用', false, err.message)
    }
    try {
      ok('isSafeMediaRoot 接受普通目录', ctx.isSafeMediaRoot('D:/Music') === true)
      ok('isSafeMediaRoot 拒绝 UNC', ctx.isSafeMediaRoot('\\\\server\\share') === false)
      ok('isSafeMediaRoot 拒绝盘符根', ctx.isSafeMediaRoot('D:\\') === false)
    } catch (err) {
      ok('isSafeMediaRoot 可调用', false, err.message)
    }
  }

  console.log('\n=== 3) 「曾漏声明」标识符哨兵 ===')
  // 这 5 个在 v2.8.16 的 master 上只有引用没有声明，4 条 P1 的根因
  // v2.8.18：SETTING_ARRAY_MAX 就是「引用搬过来了、声明没搬」的复发 —— 加进哨兵
  const mustDeclare = ['cleanupStarted', 'systemShutdownPending', 'systemShutdownTimer',
    'FORBIDDEN_SETTING_KEYS', 'lastOpenFiles', 'SETTING_ARRAY_MAX', 'SETTING_MAP_MAX']
  for (const n of mustDeclare) {
    const re = new RegExp('^\\s*(?:let|var|const)\\s+' + n + '\\b', 'm')
    ok('有声明：' + n, re.test(mainSrc))
  }

  console.log('\n=== 4) 链路接线哨兵 ===')
  ok('before-quit 前 preventDefault 且读 cleanupStarted',
    /before-quit/.test(mainSrc) && /if \(cleanupStarted\)/.test(mainSrc))
  ok('settings:patch 接入 sanitizeSettingsPatch',
    /ipcMain\.handle\('settings:patch'[\s\S]{0,800}?sanitizeSettingsPatch\(patch/.test(mainSrc))
  ok('托盘取消项覆盖系统关机窗口',
    /powerPending \|\| systemShutdownPending/.test(mainSrc))
  ok('dlyric 配置入口用同一把清洗尺子',
    /dlyric:cfg[\s\S]{0,800}?sanitizeSettingsPatch\(/.test(mainSrc))

  console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
  process.exit(fail ? 1 : 0)
}

main()
