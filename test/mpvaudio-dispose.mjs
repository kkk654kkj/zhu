#!/usr/bin/env node
'use strict'
/**
 * R02-05a：MpvAudio 的事件订阅与进度定时器必须有出口（v3.3.74）
 *
 * 背景（牌面 R02-05a / 交接 §六.5）：构造函数里 `window.api.onMpvEvent(...)` 的
 * 取消函数直接丢掉、`_tick` 的 200ms 定时器也从不清理。当前每页只建一次实例，
 * 所以今天没有实害；但一旦有人在重建引擎时再 new 一次，旧实例会继续收 mpv 事件、
 * 继续跑定时器，往已经换掉的 audio 上 emit。
 *
 * 这里用 vm 载入真实的 mpvaudio.js，把 onMpvEvent / setInterval / clearInterval
 * 换成带计数的假实现，验证：句柄被保管 → dispose() 真的取消订阅并清定时器 →
 * 幂等 → dispose 之后事件不再 emit。
 *
 * 双分支同名文件（online / master 都要跑）。
 * 用法：node test/mpvaudio-dispose.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/mpvaudio.js'), 'utf8')

/** 造一个句柄可观测的 MpvAudio */
function makeAudio() {
  const spy = { subscribe: 0, off: 0, timers: 0, cleared: 0 }
  const P = () => Promise.resolve(true)
  const api = {
    mpvLoad: P, mpvPlay: P, mpvPause: P, mpvSeek: P, mpvStop: P,
    mpvVolume: P, mpvMute: P, mpvSetAbLoop: P,
    onMpvEvent: (cb) => {
      spy.subscribe++
      spy.lastCb = cb
      return () => { spy.off++ }
    }
  }
  const sandbox = {
    window: { api },
    performance,
    console,
    setTimeout,
    clearTimeout,
    setInterval: (fn) => { spy.timers++; spy.lastTick = fn; return { id: spy.timers } },
    clearInterval: () => { spy.cleared++ },
    Promise, Date, Math, Number, String, JSON, Map, Set, Error,
    URL: { createObjectURL: () => 'blob:x' },
    Blob: function () {},
    decodeURIComponent,
    encodeURIComponent
  }
  vm.runInNewContext(src + '\nglobalThis.__MpvAudio = MpvAudio', sandbox, { filename: 'mpvaudio.js' })
  const a = new sandbox.__MpvAudio({ volume: 1 })
  return { a, spy }
}

console.log('\n[1] 构造期：订阅与定时器的句柄都要留住')
const { a, spy } = makeAudio()
ok('onMpvEvent 被订阅了 1 次', spy.subscribe === 1, 'subscribe=' + spy.subscribe)
ok('取消函数被保管（旧代码丢掉 → 这里必须红）', typeof a._offMpvEvent === 'function',
  'type=' + typeof a._offMpvEvent)
ok('200ms 定时器已建立并留了句柄', spy.timers === 1 && a._tick, 'timers=' + spy.timers)

console.log('\n[2] dispose()：真的取消订阅 + 清定时器')
let emits = 0
a.addEventListener('timeupdate', () => { emits++ })
a._paused = false
const disposeOk = typeof a.dispose === 'function'
ok('MpvAudio 有 dispose()（旧代码没有 → 这里必须红）', disposeOk)
if (disposeOk) a.dispose()
ok('dispose 调用了取消函数', spy.off === 1, 'off=' + spy.off)
ok('dispose 清了定时器', spy.cleared === 1, 'cleared=' + spy.cleared)
ok('定时器句柄置空', a._tick === null, 'tick=' + String(a._tick))
ok('_disposed 置位', a._disposed === true)

console.log('\n[3] dispose 之后：事件不再回到旧实例')
const before = emits
a._onEvent({ type: 'time', pos: 12 })
ok('迟到的 time 事件不再 emit timeupdate', emits === before, 'emits=' + emits)

console.log('\n[4] dispose 幂等')
if (disposeOk) a.dispose()
ok('再调一次不再重复取消订阅', spy.off === 1, 'off=' + spy.off)
ok('再调一次不再重复清定时器', spy.cleared === 1, 'cleared=' + spy.cleared)

console.log('\n[5] 源码层：不再有「订阅了但丢掉返回值」的裸调用')
ok('构造函数把返回值存进 this._offMpvEvent', /this\._offMpvEvent\s*=/.test(src))
ok('_onEvent 对已 dispose 的实例早退', /if\s*\(!e\s*\|\|\s*this\._disposed\)\s*return/.test(src))

console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
process.exit(fail ? 1 : 0)
