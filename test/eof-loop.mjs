'use strict'
/**
 * 独占曲末单曲循环运行时单测 · v2.8.52 / v3.3.61
 *
 * 真机日志（第三轮诊断）：end-file(eof) → mpv 卸载文件进 idle → 渲染层 seek(0)
 * → 之后 16 秒 idle-while-want-playing，界面播放中但没声音。
 *
 * 这里用 vm 载入真实的 MpvAudio（不启动 mpv / Electron），复现两个序列：
 *   旧：曲末 → currentTime=0（_ended 被复位）→ play() ⇒ 只发 mpvPlay，文件不重载
 *   新：曲末 → 直接 play()（_ended 仍为 true）⇒ 走重载分支，重新 mpvLoad
 * 并在源码层断言 player.js 两处单曲循环已经改成 ended 态直接 play()。
 *
 * 用法：node test/eof-loop.mjs
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

const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/mpvaudio.js'), 'utf8')
const playerSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/js/player.js'), 'utf8')

/** 造一个带计数 stub 的 MpvAudio */
function makeAudio() {
  const calls = []
  const P = () => Promise.resolve(true)
  const api = {
    mpvLoad: () => { calls.push('load'); return P() },
    mpvPlay: () => { calls.push('play'); return P() },
    mpvPause: () => { calls.push('pause'); return P() },
    mpvSeek: () => { calls.push('seek'); return P() },
    mpvStop: () => { calls.push('stop'); return P() },
    mpvVolume: () => { calls.push('volume'); return P() },
    mpvMute: () => { calls.push('mute'); return P() },
    mpvSetAbLoop: () => { calls.push('abloop'); return P() },
    onMpvEvent: () => {}
  }
  const sandbox = {
    window: { api }, performance, console, setTimeout, clearTimeout,
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
    Promise, Date, Math, Number, String, JSON, Map, Set, Error,
    URL: { createObjectURL: () => 'blob:x' }, Blob: function () {},
    decodeURIComponent, encodeURIComponent
  }
  vm.runInNewContext(src + '\nglobalThis.__MpvAudio = MpvAudio', sandbox, { filename: 'mpvaudio.js' })
  const a = new sandbox.__MpvAudio({ volume: 1 })
  a.src = 'D:/music/Perfect - Ed Sheeran.flac'
  a.load()                              // 首次加载
  calls.length = 0
  return { a, calls }
}

/* ---------- ① 旧序列：先 seek(0) 会让 play() 失去重载分支 ---------- */
{
  const { a, calls } = makeAudio()
  a._onEvent({ type: 'file-eof' })      // 曲末：_ended = true
  const endedAtEof = a._ended
  a.currentTime = 0                     // player.seek(0) 的等价操作
  const endedAfterSeek = a._ended
  a.play()
  ok('曲末事件把 MpvAudio 置为 ended=true', endedAtEof === true)
  ok('currentTime setter 会把 _ended 复位（这就是旧写法失效的根因）',
    endedAfterSeek === false)
  ok('旧写法 seek(0)→play() 只发 mpvPlay、不重新 load ⇒ mpv idle 后永久无声',
    calls.includes('play') && !calls.includes('load'), JSON.stringify(calls))
}

/* ---------- ② 新序列：ended 态直接 play() 会重新 load ---------- */
{
  const { a, calls } = makeAudio()
  a._onEvent({ type: 'file-eof' })
  a.play()
  // load() 里 mpvLoad().then(mpvPlay) 是异步链，等一个宏任务再核对
  await new Promise((r) => setTimeout(r, 0))
  ok('新写法曲末直接 play() 会重新 mpvLoad 并接着 mpvPlay ⇒ 自动恢复出声',
    calls.includes('load') && calls.includes('play'), JSON.stringify(calls))
  ok('重载后 _ended 被复位，下一轮曲末能正常再触发',
    a._ended === false && a._endedFired === false)
}

/* ---------- ③ player.js 两处单曲循环都已改口径 ---------- */
{
  const hits = (playerSrc.match(/if \(this\.audio\.ended\) this\.play\(\)/g) || []).length
  const oldPair = /this\._endingHandled = false\n      this\.seek\(0\)/.test(playerSrc)
  ok('player.next(auto) 与 player._onEnded() 两处单曲循环都是 ended 态直接 play()',
    hits === 2 && !oldPair, 'hits=' + hits + ' oldPair=' + oldPair)
}

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
