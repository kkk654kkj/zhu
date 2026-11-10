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
    this._lastEndedAt = 0      // v3.3.13：同一 load 代次内曲末双事件（eof-reached + end-file eof）的 700ms 抑制窗
    this._loadEpoch = 0       // v3.3.13：每次 load() 递增，跨 load 区分不同曲末
    this._endedEpoch = -1     // 上次真正触发 ended 的 load 代次
    this._aoLost = false
    this._exclusiveLost = false

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
    // v3.3.9：seek 回去之后 mpv 会再发一次 eof（属性翻回 false 再翻 true），
    // 不清 _endedFired 的话第二次播到结尾的 ended 事件会被吞 ——
    // 单曲循环第二遍卡死 / 播完回拖重播不切歌，都是它
    this._endedFired = false
    // v3.3.13：连 700ms 抑制窗一起复位，单曲循环第二遍（短曲目）才不会被吞
    this._lastEndedAt = 0
    window.api.mpvSeek(sec).catch(() => {})
    this._emit('timeupdate')
  }

  get duration() { return this._duration }
  get paused() { return this._paused }

  /** A-B 循环（v2.1）：独占模式直接交给 mpv，循环点精确到采样，不用每 250ms 比较再 seek */
  setAbLoop(a, b) {
    window.api.mpvSetAbLoop(a == null ? null : Number(a), b == null ? null : Number(b)).catch(() => {})
  }
  get ended() { return this._ended }

  get volume() { return this._volume }
  set volume(v) {
    const val = Math.max(0, Math.min(1, Number(v) || 0))
    this._volume = val
    window.api.mpvVolume(val).catch(() => {})
  }

  get src() { return this._srcPath || '' }
  set src(v) { this._srcPath = lxUrlToPath(v) }

  load() {
    if (!this._srcPath) return
    // v3.3.13：推进 load 代次并复位曲末去重状态，跨 load 的短曲目能正常触发 ended
    this._loadEpoch++
    this._ended = false
    this._endedFired = false
    this._lastEndedAt = 0
    this._duration = 0
    this._pos = 0
    this._posStamp = performance.now()
    // 先按"暂停"加载，避免非自动播放的场景（会话恢复）先响一下
    const wantPlaying = this._wantPlaying
    // v3.3.16：回调必须校验代次。快速连点两首在线歌时，A 的 mpv:load 可能晚于
    // B 才返回；以前 A 的失败回调会把**正在播的 B** 置为暂停并 emit('error')，
    // player 侧自动跳曲 → 一次操作丢两首。
    const ep = this._loadEpoch
    window.api.mpvLoad(this._srcPath, { paused: !wantPlaying }).then((ok) => {
      if (ep !== this._loadEpoch) return
      // 主进程解析在线直链失败会返回 false：必须报错，
      // 否则界面停在这里一直"正在加载"，用户只能手动切歌
      if (ok === false) {
        this._paused = true
        this._wantPlaying = false
        this._emit('error')
        return
      }
      if (wantPlaying && this._wantPlaying) window.api.mpvPlay().catch(() => {})
    }).catch(() => {
      if (ep !== this._loadEpoch) return
      // v3.3.13：直链解析抛异常（畸形 lxstream 等）不能停死在「正在加载」
      this._paused = true
      this._wantPlaying = false
      this._emit('error')
    })
  }

  play() {
    this._wantPlaying = true
    // v3.3.9：整队播完停在曲末后再点播放，要真的从头播 ——
    // 以前只翻状态位，界面「播放中」、进度条顶死、无声
    if (this._ended && this._srcPath) {
      this._ended = false
      this._endedFired = false
      this._lastEndedAt = 0
      // v3.3.10：状态与事件同步 —— 以前重载分支不翻 _paused 也不发 play，
      // mpv 回报 unpause 之前 isPlaying 为 false，播放图标短暂回跳
      this._paused = false
      this._posStamp = performance.now()
      this.load()
      this._emit('play')
      return Promise.resolve()
    }
    this._ended = false
    this._endedFired = false
    this._lastEndedAt = 0
    this._paused = false
    this._posStamp = performance.now()
    window.api.mpvPlay().catch(() => {})
    this._emit('play')
    return Promise.resolve()
  }

  pause() {
    this._wantPlaying = false
    this._paused = true
    window.api.mpvPause().catch(() => {})
    this._emit('pause')
  }

  removeAttribute(name) {
    if (name === 'src') {
      // v3.3.18：清 src 也要推进代次，否则在途 mpv:load 回调仍会把刚停止的
      // 界面改回暂停 / emit('error') 触发自动跳曲
      this._loadEpoch++
      // 第四轮 §4.6(d)：removeAttribute 推进了 _loadEpoch，却漏了 _endedEpoch ——
      // 迟到的 eof 会被判成「新曲的曲末」（sameEpoch 误命中），停止后凭空多一次 next
      this._endedEpoch = this._loadEpoch
      this._ended = false
      this._pos = 0
      this._posStamp = performance.now()
      this._srcPath = null
      this._paused = true
      this._wantPlaying = false
      this._endedFired = false
      this._lastEndedAt = 0
      window.api.mpvStop().catch(() => {})
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

  /** v3.3.13：独占恢复后把状态机与 mpv 对齐（显式发 play，不能只翻标志位） */
  _resumeFromAo() {
    // 先记下「之前是否被 ao-lost / exclusive-lost 冻结过」，再清标志
    const wasFrozen = this._aoLost || this._exclusiveLost
    this._aoLost = false
    this._exclusiveLost = false
    // 用户主动暂停期间不准翻回播放（mpv 继续保持 paused）
    if (!this._wantPlaying) return
    // 只有之前被冻结过才需要恢复；普通 format / 迟到的 ao-recovered 不碰状态
    if (!wasFrozen) return
    // 显式下发播放命令：只翻标志位 + emit('play') 时 mpv 仍是 paused
    window.api.mpvPlay().catch(() => {})
    if (this._paused) {
      this._paused = false
      this._posStamp = performance.now()
      this._emit('play')
    }
  }

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
        this._lastEndedAt = 0
        this._pos = 0
        this._posStamp = performance.now()
        this._emit('loadedmetadata')
        break
      }
      case 'pause': {
        const paused = e.paused !== false
        if (paused !== this._paused) {
          // v3.3.9：暂停时把「上次上报 → 实际暂停」之间的插值增量折进 _pos，
          // 否则 currentTime 回跳最多 0.5~1 秒（进度条往回跳一下）
          if (paused && !this._paused) this._pos = this.currentTime
          this._paused = paused
          this._posStamp = performance.now()
          this._emit(paused ? 'pause' : 'play')
        }
        break
      }
      case 'eof':
      case 'file-eof': {
        // v3.3.13：mpv 曲末会连发 eof-reached 与 end-file(eof)。
        // 按「同一 load 代次」去重：本代次已触发过（_endedFired），或 700ms 窗口内
        // 再次到来的，都视为同一次曲末的第二个事件 → 抑制。
        // 换歌（load 代次推进 + _lastEndedAt 归零）后 700ms 窗口失效，
        // 短曲目 / 单曲循环第二遍的正常曲末不再被吞。
        const sameEpoch = this._endedEpoch === this._loadEpoch
        if (sameEpoch && (this._endedFired || Date.now() - this._lastEndedAt < 700)) break
        this._endedEpoch = this._loadEpoch
        this._lastEndedAt = Date.now()
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
        // v3.3.13：只在「之前冻结过」且参数真回来时才恢复；普通 format 事件
        // 不碰 _paused，否则用户手动暂停会被迟到的 format 翻回播放
        if (e.params && (this._aoLost || this._exclusiveLost)) this._resumeFromAo()
        this._emit('formatchange')
        break
      }
      case 'ao-lost': {
        // 独占输出被系统作废：mpv 还在解码，进度条会照走但没有声音。
        // 冻结进度插值并同步 UI 状态；恢复由 ao-recovered / format 驱动
        this._aoLost = true
        this._exclusiveLost = false
        this._paused = true
        this.lastError = e.message || '独占输出中断'
        this._emit('pause')
        break
      }
      case 'ao-recovered': {
        this._resumeFromAo()
        break
      }
      case 'exclusive-lost': {
        // 连续 3 次夺回失败：设备真被别的程序占着。保持冻结（进度如实），
        // 等设备空闲后 format 事件会解除；不发 error（error 会误触发跳曲）
        this._aoLost = false
        this._exclusiveLost = true
        this.lastError = e.message || '独占设备被占用'
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
        if (this._wantPlaying) window.api.mpvPlay().catch(() => {})
        break
      }
      case 'engine-exit': {
        // v3.3.2：引擎进程没了（被别的实例误杀 / 崩溃）时，以前什么都不做——
        // currentTime 是按「上次上报 + 本地经过时间」插值的，于是进度条继续走、
        // 却一点声音都没有。这里立刻按暂停处理，界面能如实变成「已暂停」并给出原因。
        this._paused = true
        this._wantPlaying = false
        this.lastError = '音频引擎已退出（code ' + (e.code == null ? '?' : e.code) + '）'
        console.error('[mpvaudio]', this.lastError)
        this._emit('pause')
        this._emit('error')
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
