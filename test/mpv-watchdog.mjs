'use strict'
/**
 * 独占输出看门狗 + 坏帧静默回归单测 · v2.8.51 / v3.3.60
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

if (savedMute === undefined) delete process.env.LX_TEST_MUTE
else process.env.LX_TEST_MUTE = savedMute

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
