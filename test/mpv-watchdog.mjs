'use strict'
/**
 * 独占输出看门狗 + 坏帧静默 + 曲末循环回归单测 · v2.8.52 / v3.3.61
 *
 * 保留：file-loaded 不来时用 _loadAt 兜底，AO 持续 null 仍能自动夺回独占。
 * 撤销：把 flac 坏帧警告升级成失败终点（实测整首只有 1 帧 / 约 93ms，mpv 会跳过
 * 继续播；升级后单曲循环被 skipToNext() 打断，用户反而没法接着听这一首）。
 * 这里不启动 mpv 进程，直接构造 MpvEngine 跑 _wdTick / _handleEvent。
 *
 * 用法：node test/mpv-watchdog.mjs
 */
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)
const { MpvEngine } = require2('../src/main/mpv.js')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// 看门狗在 LX_TEST_MUTE=1 下按设计不参与；单测进程里临时摘掉，结束还原
const savedMute = process.env.LX_TEST_MUTE
delete process.env.LX_TEST_MUTE

function makeEngine(events, over = {}) {
  const e = new MpvEngine({ exePath: 'x', onEvent: (ev) => events.push(ev) })
  Object.assign(e, {
    ready: true, exclusive: true, _paused: false, _idle: false,
    _lastFile: 'D:/music/x.flac', _aoParams: null,
    _fileLoadedAt: 0, _loadAt: Date.now() - 9000,
    _aoLostAt: Date.now() - 3000,
    _recoverAttempts: 0, _lastRecoverAt: 0,
    _recovering: false, _restarting: false, _disposed: false
  }, over)
  e.restart = async () => ({ ok: true })
  e._verifyRecover = async () => {}
  e._send = () => {}
  return e
}

/* ---------- ① file-loaded 不来时看门狗必须仍能兜住 AO 丢失 ---------- */
{
  const events = []
  const e = makeEngine(events)          // _fileLoadedAt===0（旧实现的永久豁免）
  e._wdTick()
  ok('坏 FLAC 没发 file-loaded 时也能触发 ao-lost（不再永久静默）',
    events.some((x) => x.type === 'ao-lost'), JSON.stringify(events.map((x) => x.type)))
  ok('触发时带上本次丢失时长，便于真机排查',
    events.some((x) => x.type === 'ao-lost' && /独占输出已中断/.test(x.message || '')),
    (events.find((x) => x.type === 'ao-lost') || {}).message || '')
}

/* ---------- ② 起播宽限 / 正常状态不许误杀 ---------- */
{
  const events = []
  const e = makeEngine(events, { _loadAt: Date.now(), _aoLostAt: Date.now() - 3000 })
  e._wdTick()
  ok('刚 load 的 4 秒起播宽限仍生效，不误杀慢起播',
    !events.some((x) => x.type === 'ao-lost') && e._aoLostAt === 0,
    'events=' + JSON.stringify(events.map((x) => x.type)))

  const ev2 = []
  const e2 = makeEngine(ev2, { _aoParams: { samplerate: 48000 }, _aoLostAt: Date.now() - 3000 })
  e2._wdTick()
  ok('AO 参数正常时不触发恢复流程',
    !ev2.some((x) => x.type === 'ao-lost') && e2._aoLostAt === 0)

  const ev3 = []
  const e3 = makeEngine(ev3, { _paused: true, _aoLostAt: Date.now() - 3000 })
  e3._wdTick()
  ok('暂停 / 空闲时 AO 释放属正常，不触发',
    !ev3.some((x) => x.type === 'ao-lost'))
}

/* ---------- ③ 坏帧日志保持静默：只记日志，不产生任何失败终点 ---------- */
{
  const events = []
  const e = makeEngine(events)
  const logs = [
    'flac: invalid sync code',
    'flac: invalid frame header',
    'flac: decode_frame() failed',
    'Error decoding audio.'
  ]
  for (const t of logs) e._handleEvent({ event: 'log-message', level: 'error', text: t })
  ok('4 条坏帧日志只留下 log 事件，不产生 decode-error / error / file-error',
    events.filter((x) => x.type === 'log').length === 4 &&
    !events.some((x) => ['decode-error', 'error', 'file-error'].includes(x.type)),
    JSON.stringify(events.map((x) => x.type)))

  e._send = () => {}
  const beforeLoad = e._loadAt
  e.load('D:/music/next.flac')
  ok('load() 记下 load 时刻供看门狗兜底',
    e._loadAt > beforeLoad && Date.now() - e._loadAt < 1000,
    'loadAt=' + e._loadAt + ' before=' + beforeLoad)
}

/* ---------- ④ 设备类错误同样只记日志，不误判成文件坏了 ---------- */
{
  const events = []
  const e = makeEngine(events)
  e._handleEvent({ event: 'log-message', level: 'error',
    text: 'Error initializing device: AUDCLNT_E_DEVICE_IN_USE (0x8889000a)' })
  ok('WASAPI 设备错误不产生失败终点（仍走 v3.3.18 的不跳曲口径）',
    !events.some((x) => ['decode-error', 'error', 'file-error'].includes(x.type)),
    JSON.stringify(events.map((x) => x.type)))
}

/* ---------- ⑤ file-loaded 仍刷新宽限基线 ---------- */
{
  const events = []
  const e = makeEngine(events, { _loadAt: Date.now() - 9000 })
  e._handleEvent({ event: 'file-loaded' })
  ok('file-loaded 到达后改用它的时刻做宽限基线',
    e._fileLoadedAt > 0 && e._fileLoadedAt >= e._loadAt,
    'loadedAt=' + e._fileLoadedAt + ' loadAt=' + e._loadAt)
}

/* ---------- ⑥ 诊断日志：早退原因可观测 + 同原因节流 ---------- */
{
  const events = []
  const e = makeEngine(events, { _paused: true, _aoLostAt: 0 })
  e._wdTick(); e._wdTick(); e._wdTick()
  const diag = events.filter((x) => x.type === 'wd-diag')
  ok('看门狗早退会留下原因与状态快照，且同原因 5 秒内只记一条',
    diag.length === 1 && diag[0].reason === 'paused-or-idle' && diag[0].state.paused === true,
    JSON.stringify(diag))
}

/* ---------- ⑦ 播放意图：区分主动停止与异常 idle ---------- */
{
  const events = []
  const e = makeEngine(events, { _aoLostAt: 0 })
  e.load('D:/music/x.flac', { paused: false })
  const afterLoad = e._wantPlaying
  e.play()
  e._wdDiag('unit-probe')
  const st = (events.find((x) => x.type === 'wd-diag') || {}).state || {}
  e.pause()
  const afterPause = e._wantPlaying
  e.stop()
  ok('load/play/pause/stop 维护 wantPlaying，并写进诊断快照',
    afterLoad === true && st.wantPlaying === true && afterPause === false && e._wantPlaying === false,
    JSON.stringify({ afterLoad, st, afterPause, afterStop: e._wantPlaying }))
}

/* ---------- ⑧ 曲末异常 idle 必须能自动恢复出声 ---------- */
{
  const events = []
  const e = makeEngine(events, { _idle: true, _paused: false, _aoLostAt: Date.now() - 3000 })
  e._wantPlaying = true
  e._lastFile = 'D:/music/x.flac'
  e._wdTick()
  ok('end-file(eof) 进 idle 但 wantPlaying=true 时不再静默跳过，2.5 秒后触发 ao-lost',
    events.some((x) => x.type === 'ao-lost') &&
    events.some((x) => x.reason === 'idle-while-want-playing'),
    JSON.stringify(events.map((x) => x.type + ':' + (x.reason || ''))))

  const ev2 = []
  const e2 = makeEngine(ev2, { _idle: true, _paused: false, _aoLostAt: Date.now() - 3000 })
  e2._wantPlaying = false
  e2._lastFile = 'D:/music/x.flac'
  e2._wdTick()
  ok('用户主动停止后的 idle 仍不触发恢复（不误杀正常空闲）',
    !ev2.some((x) => x.type === 'ao-lost') &&
    ev2.some((x) => x.reason === 'idle-after-stop'),
    JSON.stringify(ev2.map((x) => x.type + ':' + (x.reason || ''))))

  const ev3 = []
  const e3 = makeEngine(ev3, { _idle: true, _paused: false, _aoLostAt: Date.now() - 3000,
    _fileLoadedAt: Date.now() - 9000, _loadAt: Date.now() - 500 })
  e3._wantPlaying = true
  e3._wdTick()
  ok('渲染层刚发 reload 的 2 秒窗口内不抢跑 restart（宽限已过仍不误触发）',
    !ev3.some((x) => x.type === 'ao-lost') && e3._aoLostAt === 0,
    JSON.stringify(ev3.map((x) => x.reason)))
}

/* ---------- ⑨ EOF 诊断：pos/dur/seek 写进快照 ---------- */
{
  const events = []
  const e = makeEngine(events)
  e._handleProperty({ name: 'duration', data: 263.4 })
  e._handleProperty({ name: 'time-pos', data: 19.4 })
  e.seek(19.4)
  const diag = events.filter((x) => x.type === 'wd-diag')
  const st = (diag.find((x) => x.reason === 'seek') || {}).state || {}
  ok('duration / time-pos / seek 目标都写进诊断快照',
    st.dur === 263.4 && st.pos === 19.4 && st.seek === 19.4,
    JSON.stringify(st))
}

/* ---------- ⑩ end-file(eof) 配对结果可区分 ---------- */
{
  const events = []
  const e = makeEngine(events)
  e._handleProperty({ name: 'eof-reached', data: true })
  e._handleEvent({ event: 'end-file', reason: 'eof' })
  ok('700ms 内 eof-reached + end-file(eof) 记为 paired',
    events.some((x) => x.reason === 'end-file-eof-paired') &&
    !events.some((x) => x.reason === 'end-file-eof-standalone'),
    JSON.stringify(events.filter((x) => x.type === 'wd-diag').map((x) => x.reason)))

  const ev2 = []
  const e2 = makeEngine(ev2)
  e2._handleEvent({ event: 'end-file', reason: 'eof' })
  ok('无 eof-reached 的独立 end-file(eof) 记为 standalone',
    ev2.some((x) => x.reason === 'end-file-eof-standalone'),
    JSON.stringify(ev2.filter((x) => x.type === 'wd-diag').map((x) => x.reason)))
}

/* ---------- ⑪ pause 轴：想播但 mpv 报 paused，仍必须能恢复 ---------- */
{
  const events = []
  // _paused=true（mpv 回报暂停 / 属性一时为 null）+ _wantPlaying=true（用户点了播放）
  // 旧写法 `if (this._paused || !this._lastFile) return` 会每秒清零 _aoLostAt → 永久无声
  const e = makeEngine(events, { _paused: true, _idle: false, _aoParams: null, _aoLostAt: 0 })
  e._wantPlaying = true
  e._lastFile = 'D:/music/x.flac'
  e._wdTick()                                  // 第一次：记下丢失起点
  e._aoLostAt = Date.now() - 3000
  e._wdTick()                                  // 第二次：应触发恢复
  ok('想播但 mpv 报 paused 时不再静默跳过（旧写法会让 _aoLostAt 永远归零）',
    events.some((x) => x.type === 'ao-lost'),
    JSON.stringify(events.map((x) => x.type)))

  const ev2 = []
  const e2 = makeEngine(ev2, { _paused: true, _aoLostAt: Date.now() - 3000 })
  e2._wantPlaying = false
  e2._wdTick()
  ok('用户主动暂停且无播放意图时照旧跳过（不误杀正常暂停）',
    !ev2.some((x) => x.type === 'ao-lost') && ev2.some((x) => x.reason === 'paused-or-idle'),
    JSON.stringify(ev2.map((x) => x.type + ':' + (x.reason || ''))))
}

/* ---------- ⑫ 顺序模式整队播完：曲末 idle 是「播完了」，不是 AO 丢失 ---------- */
{
  const events = []
  const e = makeEngine(events, { _idle: true, _paused: false, _aoLostAt: 0, _loadAt: Date.now() - 9000 })
  e._wantPlaying = true
  e._lastFile = 'D:/music/x.flac'
  e._handleEvent({ event: 'end-file', reason: 'eof' })
  e._wdTick()
  e._aoLostAt = Date.now() - 3000
  e._wdTick()
  ok('整队播完进 idle 后不再重启引擎重播末曲（ao-lost 不再误报）',
    !events.some((x) => x.type === 'ao-lost') && e._wantPlaying === false &&
    events.some((x) => x.reason === 'idle-after-eof'),
    JSON.stringify(events.map((x) => x.type + ':' + (x.reason || ''))))

  const ev2 = []
  const e2 = makeEngine(ev2, { _idle: true, _paused: false, _aoLostAt: 0, _loadAt: Date.now() - 500 })
  e2._wantPlaying = true
  e2._lastFile = 'D:/music/x.flac'
  e2._handleEvent({ event: 'end-file', reason: 'eof' })
  e2._wdTick()
  ok('新 load 的 2 秒窗口内曲末 idle 仍等 reload，不清播放意图',
    e2._wantPlaying === true && !ev2.some((x) => x.type === 'ao-lost'),
    JSON.stringify(ev2.map((x) => x.type + ':' + (x.reason || ''))))

  const e3 = makeEngine([], { _lastEndReason: 'error' })
  e3.load('D:/music/y.flac')
  ok('load() 清空上一首的停车原因（新 load = 新尝试）', e3._lastEndReason === '')
}

if (savedMute === undefined) delete process.env.LX_TEST_MUTE
else process.env.LX_TEST_MUTE = savedMute

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
