'use strict'
/**
 * 换曲加载态由真实事件驱动（T02-04 / v3.3.71）
 *
 * 以前播放条没有任何加载态：在线曲解析要 1~7 秒，这段时间界面显示「播放中 + 0:00」，
 * 用户以为卡死；若改成固定延时（比如 800ms 后收），又会和真实情况脱节 ——
 * 慢的还在解析就显示播完了，快的早就出声还在转圈。
 *
 * 这里真跑 player.js：
 *   ① 换曲立刻进加载态（loading-change: true）
 *   ② loadedmetadata / canplay 任一到达 → 收掉（loading-change: false）
 *   ③ 出错 → 收掉（不能一直转圈）
 *   ④ stop() → 收掉
 *   ⑤ 加载态不改变 setQueue 的既有行为（同 id 早退 / force 重载），player-recover 口径不破
 *
 * 用法：node test/loading-state.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/** 带事件分发的假 audio：player 依赖的监听器都要真的能触发 */
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
    _listeners: Object.create(null),
    loads: 0,
    plays: 0,
    pauses: 0,
    addEventListener(name, fn) { (audio._listeners[name] || (audio._listeners[name] = [])).push(fn) },
    removeEventListener(name, fn) {
      const a = audio._listeners[name]
      if (a) audio._listeners[name] = a.filter((f) => f !== fn)
    },
    emit(name) { for (const fn of (audio._listeners[name] || []).slice()) fn() },
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
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'src/renderer/js/player.js'), 'utf8') + '\n;globalThis.__Player = Player\n',
  sandbox,
  { filename: 'player.js' }
)
const Player = sandbox.__Player

const audio = makeAudio()
const player = new Player(audio, { fadeMs: 0 })
const seen = []
player.on('loading-change', (v) => seen.push(v))

const t1 = { id: 'on:kw:1', audio: 'http://127.0.0.1:1/stream?src=kw&id=1', title: '晴天' }
player.setQueue([t1], 0, false)
ok('换曲立刻进加载态', player.loading === true && seen[0] === true, JSON.stringify(seen))

audio.emit('loadedmetadata')
ok('元数据到达即收掉加载态（不等固定延时）',
  player.loading === false && seen[seen.length - 1] === false, JSON.stringify(seen))

const t2 = { id: 'on:kw:2', audio: 'http://127.0.0.1:1/stream?src=kw&id=2', title: '稻香' }
player.setQueue([t1, t2], 1, false)
ok('换下一首重新进加载态', player.loading === true)
audio.emit('canplay')
ok('canplay 也能收掉加载态', player.loading === false)

const t3 = { id: 'on:kw:3', audio: 'http://127.0.0.1:1/stream?src=kw&id=3', title: '七里香' }
player.setQueue([t1, t2, t3], 2, false)
audio.error = { code: 4, message: 'bad' }
audio.emit('error')
ok('出错时收掉加载态（不一直转圈）', player.loading === false)

player.stop()
ok('停止播放时加载态归零', player.loading === false)

// 空地址（代理未就绪）：只报 NO_PROXY，不留在加载态
const t4 = { id: 'on:kw:4', audio: '', online: { source: 'kw', id: '4' }, title: '空地址' }
let noProxy = null
player.on('error', (e) => { if (e && e.code === 'NO_PROXY') noProxy = e })
player.setQueue([t4], 0, false)
ok('代理未就绪时立刻报 NO_PROXY 且退出加载态',
  !!noProxy && player.loading === false, noProxy && noProxy.message)

// 本地空地址（盘掉线 / 文件被删）：不打 NO_PROXY，要走原失败链
let localErr = null
player.on('error', (e) => { if (e && !e.code) localErr = e })
player.setQueue([{ id: 'local:gone', audio: '', title: '本地空地址' }], 0, false)
ok('本地空地址不冒充 NO_PROXY（仍交给失败链自动跳下一首）',
  !!localErr && !localErr.code && player.loading === false,
  localErr ? 'code=' + String(localErr.code) : 'no error')

// v2.8.60（A02）：从「正在播的一首」切到空地址曲 —— 早退必须把上一首的音源收干净。
// 场景必须自己造出「src 非空」的前置：上一段 stop() 之后 src 本来就是空，
// 直接断言 audio.src === '' 在旧代码下也会绿（假断言，监督 gate 抓到）。
const prevT = { id: 'local:prev', audio: 'lxfile://local/D:/m/prev.flac', title: '上一首' }
player.setQueue([prevT], 0, true)
audio.emit('loadedmetadata')
const srcBefore = audio.src
player.setQueue([{ id: 'local:gone2', audio: '', title: '空地址2' }], 0, false)
ok('空地址早退清掉上一首的 src（旧代码下 src 会残留）',
  srcBefore !== '' && audio.src === '',
  'before=' + JSON.stringify(srcBefore) + ' after=' + JSON.stringify(audio.src))
const playsBefore = audio.plays
player.play()
ok('空地址曲点播放不会放出上一首（旧代码下会真的 play）',
  audio.plays === playsBefore, 'plays ' + playsBefore + '→' + audio.plays)

// 既有 setQueue 行为不被加载态改变：同 id 早退。
// v2.8.60：原断言（旧代码下）实际换到了别的 id，只是靠「空地址分支不 load」才碰巧成立；
// 这里改成真正的同 id 场景：先正常载入一首，再对它 setQueue 一次。
const reT = { id: 'local:ok', audio: 'lxfile://local/D:/m/a.flac', title: '本地正常' }
player.setQueue([reT], 0, false)
audio.emit('loadedmetadata')
const loadsBefore = audio.loads
player.setQueue([reT], 0, false)
ok('同 id 不带 force 仍早退（player-recover 口径不变）', audio.loads === loadsBefore)

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
