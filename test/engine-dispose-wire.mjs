#!/usr/bin/env node
'use strict'
/**
 * R02-08：重建音频引擎前必须先把旧实例 dispose 掉（v3.3.75）
 *
 * 背景：MpvAudio 在构造函数里订阅 `window.api.onMpvEvent` 并起一个 200ms 的
 * `_tick` 定时器。R02-05a 给了它 dispose()，但当时没接线 —— createAudioEngine
 * 换了实例却不收旧的，旧实例会继续收 mpv 事件、继续跑定时器，往已经没人听的
 * audio 上 emit。本支测试钉住「接线」这件事本身。
 *
 * 为什么是静态断言而不是运行时：createAudioEngine 在 app.js 深处，依赖整页 DOM
 * 与 Electron IPC，vm 起不来；而「先 dispose 再 new」是纯结构约束，正则足够
 * 证伪（去掉那两行就红）。
 *
 * 只在 online 分支跑（master 侧同名文件同样有这段接线，静态断言可通用）。
 * 用法：node test/engine-dispose-wire.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const app = fs.readFileSync(path.join(ROOT, 'src/renderer/js/app.js'), 'utf8')
const mpv = fs.readFileSync(path.join(ROOT, 'src/renderer/js/mpvaudio.js'), 'utf8')

console.log('\n[1] app.js：createAudioEngine 入口先收旧实例')
ok('createAudioEngine 存在', /async function createAudioEngine\(settings\)/.test(app))
// 取 createAudioEngine 到下一个顶层 async/function 之间的片段
const start = app.indexOf('async function createAudioEngine(settings)')
const seg = app.slice(start, start + 4000)
ok('函数体开头就在判 dispose（旧代码没有 → 必须红）',
  /typeof audio\.dispose === 'function'/.test(seg), 'found=' + /typeof audio\.dispose === 'function'/.test(seg))
const iDispose = seg.indexOf('audio.dispose()')
const iMpvNew = seg.indexOf('audio = new MpvAudio(')
const iPlainNew = seg.indexOf('audio = new Audio()')
ok('dispose 调用在 new MpvAudio 之前', iDispose > 0 && iMpvNew > iDispose, `dispose@${iDispose} newMpv@${iMpvNew}`)
ok('dispose 调用在 new Audio 之前', iDispose > 0 && iPlainNew > iDispose, `dispose@${iDispose} newPlain@${iPlainNew}`)
ok('dispose 后把引用置空（避免半死实例被继续引用）', /audio\.dispose\(\)[\s\S]{0,160}audio = null/.test(seg))
ok('dispose 包了 try（通道已断也不能拦住建引擎）', /try \{ audio\.dispose\(\) \} catch/.test(seg))

console.log('\n[2] mpvaudio.js：dispose 真的存在且幂等')
ok('类里有 dispose()', /^\s{2}dispose\(\)\s*\{/m.test(mpv))
ok('幂等守卫（_disposed 早退）', /if \(this\._disposed\) return/.test(mpv))
ok('保留取消函数句柄', /this\._offMpvEvent = /.test(mpv))
ok('清定时器', /clearInterval\(this\._tick\)/.test(mpv))

console.log('\n[3] 不该顺手停声音')
/** 从 dispose 起点按大括号配对截出方法体（后面紧跟着 get 访问器，不能靠下一个方法名兜底） */
function methodBody(src, sig) {
  const i = src.indexOf(sig)
  if (i < 0) return ''
  const open = src.indexOf('{', i)
  let depth = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1) }
  }
  return ''
}
const dStart = mpv.indexOf('  dispose() {')
const dSeg = methodBody(mpv, '  dispose() {')
const dEnd = dStart + dSeg.length
ok('取到了 dispose 方法体', dStart > 0 && dEnd > dStart, `len=${dSeg.length}`)
ok('dispose 里没有调用 mpvStop（停声音归主进程/Player）', !/api\.mpvStop\(/.test(dSeg))

console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
process.exit(fail ? 1 : 0)
