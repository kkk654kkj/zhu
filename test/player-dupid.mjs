#!/usr/bin/env node
'use strict'
/**
 * R02-05b：队列里有重复 id 时，playTrack 必须能在正确的副本上播（v3.3.74）
 *
 * 背景（牌面 R02-05b / 交接 §六.5）：playTrack 以前一律
 * `queue.findIndex((t) => t.id === track.id)`。队列里同一首出现两次时（重复添加、
 * 同一 id 的两个副本），点第二条永远定位到第一条 —— 播的是另一个音频地址。
 * moveInQueue 早就用对象引用避开了这个坑（见其注释），playTrack 没跟上。
 *
 * 这里把 player.js 原样放进 vm（假 audio），跑真实代码验三层定位：
 *   显式 startIndex → 对象引用 → id 兜底（旧行为）
 *
 * 双分支同名文件（online / master 都要跑）。
 * 用法：node test/player-dupid.mjs
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

/* ---------------- 假 audio ---------------- */
function makeAudio() {
  const audio = {
    preload: '', volume: 0.8, paused: true, ended: false,
    currentTime: 0, duration: 0, error: null,
    _src: '', loads: 0, plays: 0,
    addEventListener() {}, removeAttribute(k) { if (k === 'src') audio._src = '' },
    load() { audio.loads++ },
    play() { audio.plays++; audio.paused = false; return Promise.resolve() },
    pause() { audio.paused = true }
  }
  Object.defineProperty(audio, 'src', {
    get() { return audio._src },
    set(v) { audio._src = String(v) }
  })
  return audio
}

/* ---------------- 在 vm 里跑真实 player.js ---------------- */
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Emitter: class {
    constructor() { this._listeners = Object.create(null) }
    on(name, fn) { (this._listeners[name] || (this._listeners[name] = [])).push(fn); return this }
    off(name, fn) { const a = this._listeners[name]; if (a) this._listeners[name] = a.filter((f) => f !== fn); return this }
    once(name, fn) { const w = (...a) => { this.off(name, w); fn(...a) }; return this.on(name, w) }
    emit(name, ...args) { for (const fn of (this._listeners[name] || []).slice()) fn(...args); return this }
  }
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/player.js'), 'utf8')
vm.runInContext(src + '\n;globalThis.__Player = Player\n', sandbox, { filename: 'player.js' })
const Player = sandbox.__Player
ok('player.js 能在无 DOM 环境装载出 Player', typeof Player === 'function')

/* ---------------- 数据：同一 id 的两个副本 ---------------- */
const C = { id: 'c', audio: 'http://h/c', title: '别的歌' }
const A1 = { id: 'x', audio: 'http://h/a1', title: '晴天（副本一）' }
const A2 = { id: 'x', audio: 'http://h/a2', title: '晴天（副本二）' }

const audio = makeAudio()
const player = new Player(audio, { fadeMs: 0 })
const queue = [C, A1, A2]

/** 每次用例都从「正在播 C」这个干净状态起 */
function backToC() {
  player.setQueue(queue.slice(), 0, true, true)
  return audio.src === C.audio
}

console.log('\n[1] 显式给位置：点队列第 3 条（= 第二个副本）')
ok('起点是 C', backToC())
player.playTrack(A2, queue, 2)
ok('播的是第 3 条那个地址（旧代码 findIndex 命中第 2 条 → 这里必须红）',
  audio.src === A2.audio, 'src=' + audio.src)
ok('index 指向第 3 条', player.index === 2, 'index=' + player.index)

console.log('\n[2] 不给位置、但传的就是队列里那个对象')
ok('起点回到 C', backToC())
player.playTrack(A2, queue)
ok('按对象引用定位到第 3 条（旧代码按 id 落第 2 条 → 这里必须红）',
  audio.src === A2.audio, 'src=' + audio.src)
ok('index 指向第 3 条', player.index === 2, 'index=' + player.index)

console.log('\n[3] 传给第 1 个副本：不能被「同 id」拽到别处')
ok('起点回到 C', backToC())
player.playTrack(A1, queue)
ok('定位到第 2 条', audio.src === A1.audio && player.index === 1, 'src=' + audio.src + ' index=' + player.index)

console.log('\n[4] 兜底：传的是等价新对象（不在队列引用里）→ 仍按 id 落第一条')
ok('起点回到 C', backToC())
const fresh = { id: 'x', audio: 'http://h/a9', title: '晴天（同名新对象）' }
player.playTrack(fresh, queue)
ok('按 id 兜底到第 2 条（旧行为保留）', audio.src === A1.audio && player.index === 1,
  'src=' + audio.src + ' index=' + player.index)

console.log('\n[5] 源码层')
ok('playTrack 带 startIndex 形参', /playTrack\(track,\s*queue,\s*startIndex\)/.test(src))
ok('不再用 queue.findIndex 按 id 单点定位', !/queue\.findIndex\(\(t\)\s*=>\s*t\.id\s*===\s*track\.id\)/.test(src))
ok('有对象引用定位（indexOf(track)）', /arr\.indexOf\(track\)/.test(src))

console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
process.exit(fail ? 1 : 0)
