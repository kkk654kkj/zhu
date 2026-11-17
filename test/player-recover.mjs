#!/usr/bin/env node
'use strict'
/**
 * 在线换源兜底：setQueue 的「同一 id 早退」回归（v3.3.66）
 *
 * 场景来自实跑复现：error → recoverOnlineTrack 换到新地址、为保住队列位置与
 * 收藏关系刻意保留原 id，然后 setQueue(tracks, idx, true)。以前 setQueue 只比 id
 * 就「同一首，不重载」早退 —— 新地址从未赋给 audio，只对死链又 play 一次，
 * 界面 toast「已换源继续播放」，几秒后再次失败，然后直接跳下一首。
 *
 * 这里把 player.js 原样放进 vm（假 audio 记录 src / load / play），跑真实代码：
 *   · 同 id 不带 force  → 不重载（旧行为，避免误改其它 setQueue 调用点）
 *   · 同 id 带 force    → 必须重新加载新地址
 * 并静态钉住 app.js 的调用点确实传了 force。
 *
 * 用法：node test/player-recover.mjs
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

/* ---------------- 假 audio：只实现 player 真正用到的那部分 ---------------- */

function makeAudio() {
  const audio = {
    preload: '',
    volume: 0.8,
    paused: true,
    ended: false,
    currentTime: 0,
    duration: 0,
    error: null,
    _src: '',
    plays: 0,
    loads: 0,
    pauses: 0,
    addEventListener() {},
    removeAttribute(k) { if (k === 'src') audio._src = '' },
    load() { audio.loads++ },
    play() { audio.plays++; audio.paused = false; return Promise.resolve() },
    pause() { audio.pauses++; audio.paused = true }
  }
  Object.defineProperty(audio, 'src', {
    get() { return audio._src },
    set(v) { audio._src = String(v) }
  })
  return audio
}

/* ---------------- 在 vm 里跑真实 player.js ---------------- */

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Emitter: class {
    constructor() { this._listeners = Object.create(null) }
    on(name, fn) { (this._listeners[name] || (this._listeners[name] = [])).push(fn); return this }
    off(name, fn) { const a = this._listeners[name]; if (a) this._listeners[name] = a.filter((f) => f !== fn); return this }
    once(name, fn) { const w = (...a) => { this.off(name, w); fn(...a) }; return this.on(name, w) }
    emit(name, ...args) {
      for (const fn of (this._listeners[name] || []).slice()) fn(...args)
      return this
    }
  }
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/player.js'), 'utf8')
vm.runInContext(src + '\n;globalThis.__Player = Player\n', sandbox, { filename: 'player.js' })
const Player = sandbox.__Player
ok('player.js 能在无 DOM 环境装载出 Player', typeof Player === 'function')

/* ---------------- 用例 ---------------- */

const audio = makeAudio()
const player = new Player(audio, { fadeMs: 0 })
const order = []
player.on('track-change', (t) => order.push(t.audio))

const oldTrack = { id: 'on:kw:1', audio: 'http://127.0.0.1:1/stream?src=kw&id=1', title: '晴天' }
player.setQueue([oldTrack], 0, true)
ok('首播正常加载原地址', audio.src === oldTrack.audio && audio.loads === 1,
  `src=${audio.src} loads=${audio.loads}`)

// 换源结果：id 保持不变（recoverOnlineTrack 的做法），只有 audio 变了
const freshTrack = { id: 'on:kw:1', audio: 'http://127.0.0.1:1/stream?src=kg&id=9', title: '晴天', onlineMeta: { id: 'on:kw:1' } }
const playsBefore = audio.plays
player.setQueue([freshTrack], 0, true)
ok('不带 force：同一 id 仍然早退（其它调用点行为不变）',
  audio.src === oldTrack.audio && audio.loads === 1,
  `src=${audio.src} loads=${audio.loads}`)
ok('不带 force：只是恢复播放，没有加载新地址', audio.plays === playsBefore)

player.setQueue([freshTrack], 0, true, true)
ok('带 force：同一 id 也重新加载新地址',
  audio.src === freshTrack.audio && audio.loads === 2,
  `src=${audio.src} loads=${audio.loads}`)
ok('带 force：队列里那一首已换成新地址', player.current && player.current.audio === freshTrack.audio)
ok('带 force：track-change 照常上报，id 没变（队列位置/收藏关系不动）',
  order.length === 2 && order[1] === freshTrack.audio,
  `emits=${order.length}`)

// 换到不同 id 的曲目：本来就会重载，force 不影响
const other = { id: 'on:kw:2', audio: 'http://127.0.0.1:1/stream?src=kw&id=2', title: '稻香' }
player.setQueue([freshTrack, other], 1, true)
ok('换到别的曲目照常加载', audio.src === other.audio && audio.loads === 3)

/* ---------------- 调用点：app.js 必须传 force ---------------- */

const appSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/js/app.js'), 'utf8')
ok('recoverOnlineTrack 调 setQueue 时带 force',
  /player\.setQueue\(tracks, idx, true, true\)/.test(appSrc))

console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
process.exit(fail ? 1 : 0)