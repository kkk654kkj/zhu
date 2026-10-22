'use strict'
/**
 * 播放器内核：队列、播放模式、淡入淡出、音量、进度。
 * 事件：track-change / state-change / time / mode-change / queue-change / ended
 */

class Player extends Emitter {
  constructor(audio, opts = {}) {
    super()
    this.audio = audio
    this.tracks = []            // 当前队列（ClientTrack 数组）
    this.index = -1             // 队列内索引
    this.mode = 'list'          // list(列表循环) | single(单曲) | shuffle(随机) | order(顺序)
    this.fadeMs = opts.fadeMs ?? 350
    this.volume = opts.volume ?? 0.8
    this.muted = opts.muted ?? false
    this._fadeTimer = null
    this._fadeTimeout = null     // 淡出结束后执行 pause 的延时器（必须可取消，否则连点会自停）
    this._fadeDir = null         // 'in' | 'out'，淡入时目标跟随 this.volume
    this._shuffleHistory = []
    this._shufflePool = []
    this._pendingSeek = null
    this._endingHandled = false
    this._loadedTrack = null     // 上一次真正 load 进 audio 的曲目（用于切歌时上报播放位置）

    audio.preload = 'auto'
    audio.volume = this.muted ? 0 : this.volume

    audio.addEventListener('timeupdate', () => {
      this.emit('time', audio.currentTime, audio.duration || 0)
    })
    audio.addEventListener('durationchange', () => {
      this.emit('time', audio.currentTime, audio.duration || 0)
    })
    audio.addEventListener('loadedmetadata', () => {
      if (this._pendingSeek != null) {
        try { audio.currentTime = this._pendingSeek } catch {}
        this._pendingSeek = null
      }
      this.emit('time', audio.currentTime, audio.duration || 0)
    })
    audio.addEventListener('play', () => this.emit('state-change', true))
    audio.addEventListener('pause', () => this.emit('state-change', false))
    audio.addEventListener('ended', () => this._onEnded())
    audio.addEventListener('error', () => {
      const err = audio.error
      console.error('[player] 音频错误:', err && err.code, err && err.message)
      this.emit('error', err)
    })
  }

  get current() {
    return this.index >= 0 ? this.tracks[this.index] || null : null
  }

  get isPlaying() {
    return !this.audio.paused && !this.audio.ended
  }

  /* ---------- 队列 ---------- */

  /**
   * 设置队列并开始播放
   * @param {Array} tracks
   * @param {number} startIndex
   * @param {boolean} autoplay
   */
  setQueue(tracks, startIndex = 0, autoplay = true) {
    const prevId = this.current ? this.current.id : null
    this.tracks = tracks.slice()
    this._buildShufflePool()

    const target = this.tracks.length
      ? Math.max(0, Math.min(startIndex, this.tracks.length - 1))
      : -1
    const targetId = target >= 0 ? this.tracks[target].id : null

    this.index = target
    this.emit('queue-change', this.tracks, this.index)

    if (target < 0) { this.stop(); return }
    if (targetId === prevId && this.audio.src) {
      // 目标就是当前这首：不重新加载，只在需要时恢复播放
      if (autoplay && this.audio.paused) this.play()
      return
    }
    this._loadCurrent(autoplay)
  }

  addToQueue(track, { next = false } = {}) {
    if (!track) return
    if (next && this.index >= 0) {
      this.tracks.splice(this.index + 1, 0, track)
      this._buildShufflePool()
      this.emit('queue-change', this.tracks, this.index)
    } else {
      this.tracks.push(track)
      this._buildShufflePool()
      this.emit('queue-change', this.tracks, this.index)
    }
  }

  removeFromQueue(index) {
    if (index < 0 || index >= this.tracks.length) return
    const wasCurrent = index === this.index
    this.tracks.splice(index, 1)
    if (index < this.index) this.index--
    else if (wasCurrent) this.index = Math.min(this.index, this.tracks.length - 1)
    this._buildShufflePool()
    this.emit('queue-change', this.tracks, this.index)
    if (wasCurrent) {
      if (this.index >= 0) this._loadCurrent(this.isPlaying)
      else this.stop()
    }
  }

  /** 队列内拖拽排序：移动一项，并让 index 继续指向"正在播的那首" */
  moveInQueue(from, to) {
    if (from === to) return
    const len = this.tracks.length
    if (from < 0 || to < 0 || from >= len || to >= len) return
    const curId = this.current ? this.current.id : null
    const [item] = this.tracks.splice(from, 1)
    this.tracks.splice(to, 0, item)
    // 不能用「index 加减 delta」推算：拖过当前项时方向会算反。直接按 id 重新定位。
    if (curId) {
      const idx = this.tracks.findIndex((t) => t.id === curId)
      if (idx >= 0) this.index = idx
    }
    this._buildShufflePool()
    this.emit('queue-change', this.tracks, this.index)
  }

  clearQueue() {
    this.stop()
    this.tracks = []
    this.index = -1
    this._buildShufflePool()
    this.emit('queue-change', this.tracks, this.index)
  }

  _buildShufflePool() {
    this._shufflePool = this.tracks.map((_, i) => i)
    for (let i = this._shufflePool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[this._shufflePool[i], this._shufflePool[j]] = [this._shufflePool[j], this._shufflePool[i]]
    }
  }

  /* ---------- 播放控制 ---------- */

  playTrack(track, queue) {
    if (!track) return
    if (queue && queue.length) {
      const idx = queue.findIndex((t) => t.id === track.id)
      this.setQueue(queue, idx >= 0 ? idx : 0, true)
      return
    }
    if (this.current && this.current.id === track.id) {
      this.play()
      return
    }
    const idx = this.tracks.findIndex((t) => t.id === track.id)
    if (idx >= 0) {
      this.index = idx
      this._loadCurrent(true)
    } else {
      this.addToQueue(track)
      this.index = this.tracks.length - 1
      this._loadCurrent(true)
    }
  }

  _loadCurrent(autoplay = true) {
    const track = this.current
    if (!track) { this.stop(); return }
    // 切走之前把上一首的播放位置报出去（长音轨断点续播要靠它）
    if (this._loadedTrack && this._loadedTrack.id !== track.id) {
      this.emit('track-leave', this._loadedTrack, this.audio.currentTime || 0)
    }
    this._loadedTrack = track
    this._endingHandled = false
    this._pendingSeek = null
    this.audio.src = track.audio
    this.audio.load()
    this.emit('track-change', track)
    if (autoplay) this.play()
    else this.audio.pause()
  }

  play() {
    if (!this.current) {
      if (this.tracks.length) { this.index = 0; this._loadCurrent(true) }
      return
    }
    const p = this.audio.play()
    if (p && p.catch) p.catch((err) => {
      if (err && err.name !== 'AbortError') console.warn('[player] play 失败:', err.message)
    })
    this._fadeIn()
  }

  pause() {
    this._fadeOut(() => this.audio.pause())
  }

  toggle() {
    if (this.isPlaying) this.pause()
    else this.play()
  }

  stop() {
    this._clearFade()
    this.audio.pause()
    this.audio.removeAttribute('src')
    try { this.audio.load() } catch {}
    this.emit('state-change', false)
  }

  next(auto = false) {
    if (!this.tracks.length) return
    if (this.mode === 'single' && auto) {
      this.seek(0)
      this.play()
      return
    }
    if (this.mode === 'shuffle') {
      this.index = this._nextShuffleIndex(1)
    } else {
      this.index = this.index + 1
      if (this.index >= this.tracks.length) {
        if (this.mode === 'list') {
          this.index = 0
          // 列表循环绕过一圈也算"播完一轮"——「播放结束后关机」要的就是这个时刻
          if (auto) this.emit('queue-end')
        } else { this.index = this.tracks.length - 1; this.stop(); return }
      }
    }
    this._loadCurrent(true)
  }

  prev() {
    if (!this.tracks.length) return
    // 播放超过 3 秒时，"上一首"回到本曲开头
    if (this.audio.currentTime > 3) { this.seek(0); return }
    if (this.mode === 'shuffle') {
      this.index = this._nextShuffleIndex(-1)
    } else {
      this.index = this.index - 1
      if (this.index < 0) this.index = this.tracks.length - 1
    }
    this._loadCurrent(true)
  }

  _nextShuffleIndex(dir) {
    if (!this._shufflePool.length) this._buildShufflePool()
    const pos = this._shufflePool.indexOf(this.index)
    let p = pos + dir
    if (p < 0) p = this._shufflePool.length - 1
    if (p >= this._shufflePool.length) {
      // 一轮放完：重新洗牌，避免立刻重复当前曲
      this._buildShufflePool()
      const np = this._shufflePool.indexOf(this.index)
      p = np >= 0 ? np + 1 : 0
      if (p >= this._shufflePool.length) p = 0
    }
    const target = this._shufflePool[p]
    return target >= 0 && target < this.tracks.length ? target : 0
  }

  _onEnded() {
    if (this._endingHandled) return
    this._endingHandled = true
    this.emit('ended', this.current)
    if (this.mode === 'single') {
      this.seek(0)
      this.play()
      return
    }
    if (this.mode === 'order' && this.index >= this.tracks.length - 1) {
      this.emit('state-change', false)
      // v2.1：整队播完（顺序模式停在最后一首）——主进程据此决定要不要关机/休眠
      this.emit('queue-end')
      return
    }
    this.next(true)
  }

  /* ---------- 进度 ---------- */

  seek(sec) {
    const dur = this.audio.duration || 0
    if (!dur) { this._pendingSeek = sec; return }
    this.audio.currentTime = Math.max(0, Math.min(sec, dur - 0.05))
    this.emit('time', this.audio.currentTime, dur)
  }

  seekRatio(r) {
    const dur = this.audio.duration || 0
    if (!dur) return
    this.seek(dur * Math.max(0, Math.min(1, r)))
  }

  /* ---------- 音量 / 淡入淡出 ---------- */

  setVolume(v, silent = false) {
    this.volume = Math.max(0, Math.min(1, v))
    // 正在淡入时不要直写 audio.volume：渐变 tick 会跟随 this.volume，
    // 直写反而被下一次 tick 按旧曲线覆盖（表现为拖音量弹回去）
    if (!this.muted && this._fadeDir !== 'in') this.audio.volume = this.volume
    if (!silent) this.emit('vol-change', this.volume, this.muted)
  }

  setMuted(m) {
    this.muted = !!m
    this.audio.volume = this.muted ? 0 : this.volume
    this.emit('vol-change', this.volume, this.muted)
  }

  setFadeMs(ms) {
    this.fadeMs = Math.max(0, Math.min(3000, ms | 0))
  }

  _clearFade() {
    if (this._fadeTimer) {
      clearInterval(this._fadeTimer)
      this._fadeTimer = null
    }
    if (this._fadeTimeout) {
      clearTimeout(this._fadeTimeout)
      this._fadeTimeout = null
    }
    this._fadeDir = null
  }

  _fadeTo(target, dir = 'in') {
    this._clearFade()
    const dur = this.fadeMs
    if (!dur) { this.audio.volume = target; return }
    if (Math.abs(this.audio.volume - target) < 0.005) { this.audio.volume = target; return }
    this._fadeDir = dir
    const stepMs = 20
    const steps = Math.max(1, Math.round(dur / stepMs))
    let i = 0
    this._fadeTimer = setInterval(() => {
      i++
      // 目标动态取值：淡入时跟随 this.volume，所以拖动音量滑块能即时生效，
      // 不会被闭包里那份旧 target 覆盖（旧实现会在 350ms 内把滑块拉回去）
      const goal = this._fadeDir === 'in' && !this.muted ? this.volume : 0
      const remain = Math.max(1, steps - i + 1)
      const next = this.audio.volume + (goal - this.audio.volume) / remain
      this.audio.volume = Math.max(0, Math.min(1, next))
      if (i >= steps) this._clearFade()
    }, stepMs)
  }

  _fadeIn() {
    // 独占输出（mpv）：任何软件音量渐变都会破坏位完美，直接跳过
    if (this.audio.noFade || this.muted) return
    this.audio.volume = 0
    this._fadeTo(this.volume, 'in')
  }

  _fadeOut(done) {
    if (this.audio.noFade || this.muted || !this.fadeMs) { done && done(); return }
    const from = this.audio.volume
    if (from <= 0.01) { done && done(); return }
    this._fadeTo(0, 'out')
    // 延时器必须存下来：用户点暂停后 350ms 内又点播放时，_fadeIn() 会调 _clearFade()
    // 把它取消掉，否则会出现「点了播放，过一会儿自己停了」
    this._fadeTimeout = setTimeout(() => {
      this._fadeTimeout = null
      done && done()
    }, this.fadeMs + 30)
  }

  setMode(mode) {
    this.mode = mode
    if (mode === 'shuffle') this._buildShufflePool()
    this.emit('mode-change', mode)
  }

  cycleMode() {
    const order = ['list', 'single', 'shuffle', 'order']
    const i = order.indexOf(this.mode)
    this.setMode(order[(i + 1) % order.length])
    return this.mode
  }
}

const MODE_LABEL = {
  list: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
  order: '顺序播放'
}
const MODE_ICON = {
  list: 'i-list',
  single: 'i-repeat-one',
  shuffle: 'i-shuffle',
  order: 'i-repeat'
}
