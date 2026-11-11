'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= Windows 媒体控制（Media Session / SMTC，v2.1） ================= */

/**
 * Chromium 会把 navigator.mediaSession 接到 Windows 的 SMTC 上（音量浮层、锁屏、硬件媒体键）。
 * 这条链路不需要原生模块，但有个前提：必须有一个**正在播放的 <audio>**。
 * 独占模式下声音走 mpv，页面里没有播放中的 <audio>，所以额外挂一条静音流
 * （体积 0 的 8bit WAV，音量 0.001 —— 不能设 0，Chromium 认为"静音"就不算 audible）。
 */
let mediaKeepAlive = null
let silentWavCached = ''   // 静音 WAV 的 Blob URL 只建一次，避免每轮重建泄漏
let mediaPosAt = 0

function silentWavUrl(seconds = 0.2, rate = 8000) {
  const n = Math.floor(seconds * rate)
  const buf = new ArrayBuffer(44 + n)
  const dv = new DataView(buf)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true)
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true)
  w(36, 'data'); dv.setUint32(40, n, true)
  for (let i = 0; i < n; i++) dv.setUint8(44 + i, 128)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

function initMediaSession() {
  if (!('mediaSession' in navigator)) return
  const ms = navigator.mediaSession
  const set = (name, fn) => { try { ms.setActionHandler(name, fn) } catch {} }
  set('play', () => player.play())
  set('pause', () => player.pause())
  set('previoustrack', () => player.prev())
  set('nexttrack', () => player.next())
  set('stop', () => { player.pause(); player.seek(0) })
  set('seekto', (d) => { if (d && d.seekTime != null) player.seek(d.seekTime) })
  set('seekbackward', (d) => player.seek(Math.max(0, (audio.currentTime || 0) - ((d && d.seekOffset) || 10))))
  set('seekforward', (d) => player.seek((audio.currentTime || 0) + ((d && d.seekOffset) || 10)))
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || track.fileName || '未知曲目',
      artist: track.artist || '',
      album: track.album || '',
      artwork: track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }] : []
    })
  } catch {}
}

function syncMediaSessionState(playing) {
  if (!('mediaSession' in navigator)) return
  try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused' } catch {}
}

/** 进度位置：Windows 浮层的进度条靠它；1 秒一次足够，别每帧都调 */
function updateMediaPosition(cur, dur) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
  const now = Date.now()
  if (now - mediaPosAt < 1000) return
  mediaPosAt = now
  if (!(dur > 0) || !isFinite(dur)) return
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      position: Math.min(Math.max(0, cur || 0), dur),
      playbackRate: 1
    })
  } catch {}
}

function keepAliveMediaSession(playing) {
  if (!('mediaSession' in navigator)) return
  // 普通输出下 <audio> 本身就是一场活跃会话，不需要这条假流
  if (!state.exclusive) {
    if (mediaKeepAlive && !mediaKeepAlive.paused) mediaKeepAlive.pause()
    return
  }
  try {
    if (!mediaKeepAlive) {
      // 第四轮 §4.6：每次重建都新建一个 Blob URL，旧的不 revoke 也不 pause ——
      // 长会话里 error 一次就漏一份。这里复用同一个 URL，旧元素先 pause + 清 src。
      if (!silentWavCached) silentWavCached = silentWavUrl()
      mediaKeepAlive = new Audio(silentWavCached)
      mediaKeepAlive.loop = true
      mediaKeepAlive.volume = 0.001
      mediaKeepAlive.addEventListener('error', () => {
        try { mediaKeepAlive.pause() } catch (e) { /* 忽略 */ }
        mediaKeepAlive = null
      })
    }
    if (playing) {
      if (mediaKeepAlive.paused) mediaKeepAlive.play().catch(() => {})
    } else if (!mediaKeepAlive.paused) {
      mediaKeepAlive.pause()
    }
  } catch {}
}

