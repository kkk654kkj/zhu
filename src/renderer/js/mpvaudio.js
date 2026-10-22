'use strict'
/**
 * 独占输出用的"伪 audio 元素"（v1.5）。
 *
 * 目的：让 player.js 一行都不用改就能跑在 mpv 上。
 * 这里实现的是 HTMLMediaElement 里 Player 实际用到的那个子集：
 *   src / load() / play() / pause() / removeAttribute('src') / currentTime /
 *   duration / paused / ended / volume / preload / addEventListener()
 *
 * 时钟：mpv 的 time-pos 上报大约 1~2Hz，直接拿来画进度条会一跳一跳，
 * 所以 currentTime 用「最近一次上报 + 本地经过时间」插值，收到新上报就校准。
 */
class MpvAudio {
  constructor(opts = {}) {
    this.noFade = true          // 独占模式禁用淡入淡出（软件音量渐变必然破坏位完美）
    this.isExclusive = true     // 独占失败回退共享时会置 false
    this.format = null          // mpv 的 audio-out-params：{samplerate, format:'s16', channels}
    this.fallbackMessage = ''
    this.lastError = null
    this.preload = 'auto'

    this._listeners = new Map()
    this._paused = true
    this._ended = false
    this._duration = 0
    this._pos = 0
    this._posStamp = performance.now()
    this._volume = opts.volume ?? 1
    this._srcPath = null
    this._wantPlaying = false
    this._lastEmit = 0
    this._endedFired = false

    window.api.onMpvEvent((e) => this._onEvent(e))

    // 200ms 一次：进度条与歌词都够用，又不至于让渲染层忙
    this._tick = setInterval(() => {
      if (!this._paused && !this._ended) this._emit('timeupdate')
    }, 200)
  }

  /* ---------------- HTMLMediaElement 子集 ---------------- */

  get currentTime() {
    if (this._paused || this._ended) return this._pos
    const dt = (performance.now() - this._posStamp) / 1000
    const t = this._pos + dt
    if (this._duration > 0) return Math.min(t, this._duration)
    return t
  }

  set currentTime(v) {
    const sec = Math.max(0, Number(v) || 0)
    this._pos = sec
    this._posStamp = performance.now()
    this._ended = false
    window.api.mpvSeek(sec)
    this._emit('timeupdate')
  }

  get duration() { return this._duration }
  get paused() { return this._paused }
  get ended() { return this._ended }

  get volume() { return this._volume }
  set volume(v) {
    const val = Math.max(0, Math.min(1, Number(v) || 0))
    this._volume = val
    window.api.mpvVolume(val)
  }

  get src() { return this._srcPath || '' }
  set src(v) { this._srcPath = lxUrlToPath(v) }

  load() {
    if (!this._srcPath) return
    this._ended = false
    this._endedFired = false
    this._duration = 0
    this._pos = 0
    this._posStamp = performance.now()
    // 先按"暂停"加载，避免非自动播放的场景（会话恢复）先响一下
    window.api.mpvLoad(this._srcPath, { paused: !this._wantPlaying })
    if (this._wantPlaying) window.api.mpvPlay()
  }

  play() {
    this._wantPlaying = true
    this._ended = false
    this._paused = false
    this._posStamp = performance.now()
    window.api.mpvPlay()
    this._emit('play')
    return Promise.resolve()
  }

  pause() {
    this._wantPlaying = false
    this._paused = true
    window.api.mpvPause()
    this._emit('pause')
  }

  removeAttribute(name) {
    if (name === 'src') {
      this._srcPath = null
      this._paused = true
      this._wantPlaying = false
      this._endedFired = false
      window.api.mpvStop()
    }
  }

  /**
   * 注意必须支持 options.once：app.js 恢复会话位置用的是
   * `addEventListener('loadedmetadata', fn, { once: true })`，
   * 不实现 once 的话每次换曲都会被跳回上次退出的时间。
   */
  addEventListener(type, fn, opts) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    const once = !!(opts && typeof opts === 'object' && opts.once)
    this._listeners.get(type).push({ fn, once })
  }

  removeEventListener(type, fn) {
    const arr = this._listeners.get(type)
    if (!arr) return
    const i = arr.findIndex((e) => e.fn === fn)
    if (i >= 0) arr.splice(i, 1)
  }

  _emit(type) {
    const arr = this._listeners.get(type)
    if (!arr || !arr.length) return
    for (const entry of arr.slice()) {
      try { entry.fn({ type, target: this }) } catch (err) { console.error('[mpvaudio]', err) }
      if (entry.once) this.removeEventListener(type, entry.fn)
    }
  }

  /* ---------------- 主进程事件 ---------------- */

  _onEvent(e) {
    if (!e) return
    switch (e.type) {
      case 'time': {
        const pos = typeof e.pos === 'number' ? e.pos : 0
        this._pos = pos
        this._posStamp = performance.now()
        // mpv 有时会成串上报，压到 100ms 一次，避免 UI 抖动
        const now = performance.now()
        if (now - this._lastEmit >= 100) {
          this._lastEmit = now
          this._emit('timeupdate')
        }
        break
      }
      case 'duration': {
        const d = typeof e.duration === 'number' ? e.duration : 0
        if (d > 0 && Math.abs(d - this._duration) > 0.01) {
          this._duration = d
          this._emit('durationchange')
        }
        break
      }
      case 'loaded': {
        this._ended = false
        this._endedFired = false
        this._pos = 0
        this._posStamp = performance.now()
        this._emit('loadedmetadata')
        break
      }
      case 'pause': {
        const paused = e.paused !== false
        if (paused !== this._paused) {
          this._paused = paused
          this._posStamp = performance.now()
          this._emit(paused ? 'pause' : 'play')
        }
        break
      }
      case 'eof':
      case 'file-eof': {
        if (this._endedFired) break
        this._endedFired = true
        this._ended = true
        this._paused = true
        if (this._duration > 0) this._pos = this._duration
        this._emit('timeupdate')
        this._emit('ended')
        break
      }
      case 'format': {
        this.format = e.params || null
        this._emit('formatchange')
        break
      }
      case 'volume': {
        if (typeof e.volume === 'number') this._volume = Math.max(0, Math.min(1, e.volume / 100))
        break
      }
      case 'fallback': {
        this.isExclusive = false
        this.fallbackMessage = e.message || ''
        this._emit('fallback')
        if (this._wantPlaying) window.api.mpvPlay()
        break
      }
      case 'error': {
        this.lastError = e.message || 'mpv 错误'
        console.error('[mpvaudio]', this.lastError)
        this._emit('error')
        break
      }
      case 'file-error': {
        this.lastError = e.message || '无法播放该文件'
        this._emit('error')
        break
      }
    }
  }
}

/** lxfile://local/D:/音乐/x.flac → D:/音乐/x.flac（shim 直接吃本地路径） */
function lxUrlToPath(u) {
  if (!u) return null
  const s = String(u)
  if (!s.startsWith('lxfile://')) return s
  let rest = s.slice('lxfile://'.length)
  rest = rest.replace(/^local\//, '')
  try { return decodeURIComponent(rest) } catch { return rest }
}
