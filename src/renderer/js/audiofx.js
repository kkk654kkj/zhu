'use strict'
/**
 * 音频特效：10 段均衡器 + 频谱可视化。
 *
 * 音频链（在 app.js 里 init 一次）：
 *   <audio> → MediaElementSource → trackGain（音量均衡/手动增益）
 *           → preamp（EQ 自动补偿）→ 10×BiquadFilter → Analyser → destination
 *
 * 注意：createMediaElementSource 对同一个 audio 元素只能调用一次；
 * 一旦接入，音频永远走这条链（EQ 全 0 且关闭时等同于原声）。
 */

/** 10 段中心频率（首段 lowshelf、末段 highshelf、中间 8 段 peaking） */
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const EQ_FREQ_LABEL = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']
const EQ_MAX_DB = 12

/** 预设（dB 数组，顺序同 EQ_FREQS） */
const EQ_PRESETS = {
  flat: { label: '平直', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  pop: { label: '流行', bands: [-1, 0, 1.5, 3, 4, 3.5, 2, 0, -1, -1.5] },
  rock: { label: '摇滚', bands: [4.5, 3.5, 2, 0, -1, -0.5, 1, 2.5, 3.5, 4] },
  classical: { label: '古典', bands: [3, 2, 1, 0, -1, -1, 0, 1.5, 2.5, 3] },
  jazz: { label: '爵士', bands: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  bass: { label: '低音增强', bands: [6, 5, 4, 2, 0, 0, -1, -2, -3, -4] },
  vocal: { label: '人声', bands: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -2] },
  electronic: { label: '电子', bands: [5, 4, 2, 0, -1, 1, 2, 3, 4, 5] }
}

const AudioFx = {
  ctx: null,
  srcNode: null,
  trackGain: null,
  preamp: null,
  filters: [],
  analyser: null,
  failed: false,

  /** 建立整条链路。返回是否成功（失败则全程原声，播放不受影响）。 */
  init(audio) {
    if (this.ctx || this.failed) return !!this.ctx
    if (!window.AudioContext) { this.failed = true; return false }
    // v3.3.10：let 提到 try 外 —— 上一版兜底在 catch 里引用块级 const，
    // typeof src 恒为 'undefined'，兜底是死代码（createMediaElementSource 成功后
    // 建链失败的场景救不了 = 整机静音）
    let ctx = null
    let src = null
    try {
      ctx = new AudioContext()
      src = ctx.createMediaElementSource(audio)

      const trackGain = ctx.createGain()
      const preamp = ctx.createGain()

      const filters = EQ_FREQS.map((freq, i) => {
        const n = ctx.createBiquadFilter()
        if (i === 0) {
          n.type = 'lowshelf'
          n.frequency.value = 62
        } else if (i === EQ_FREQS.length - 1) {
          n.type = 'highshelf'
          n.frequency.value = 12000
        } else {
          n.type = 'peaking'
          n.frequency.value = freq
          n.Q.value = 1.1
        }
        n.gain.value = 0
        return n
      })

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.78

      // 串联：src → trackGain → preamp → f0 → f1 → … → analyser → out
      src.connect(trackGain)
      trackGain.connect(preamp)
      let last = preamp
      for (const f of filters) {
        last.connect(f)
        last = f
      }
      last.connect(analyser)
      analyser.connect(ctx.destination)

      this.ctx = ctx
      this.srcNode = src
      this.trackGain = trackGain
      this.preamp = preamp
      this.filters = filters
      this.analyser = analyser

      const tryResume = () => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      }
      // Electron 默认 autoplayPolicy=no-user-gesture-required，正常是直接 running；
      // 仍留 resume 兜底，防止个别环境停在 suspended 时整条链没声。
      audio.addEventListener('play', tryResume)
      audio.addEventListener('timeupdate', tryResume)

      return true
    } catch (err) {
      console.warn('[audiofx] WebAudio 接入失败，均衡器不可用:', err && err.message)
      if (src && ctx) {
        // v3.3.9：createMediaElementSource 已成功，元素被这条 ctx 捕获 ——
        // 链路没连 destination 会整机静音，直连一次兜底。这条链是活的，绝不能 close。
        try { src.connect(ctx.destination) } catch (e2) { /* 真没辙 */ }
      } else if (ctx) {
        // new AudioContext() 成功但 createMediaElementSource(audio) 同步抛错：
        // ctx 还没接任何节点却已在 running，必须关掉，否则泄漏一个空 AudioContext
        try { ctx.close() } catch (e2) { /* 已关闭 */ }
      }
      this.failed = true
      this.ctx = null
      return false
    }
  },

  /** 每曲增益（dB）——音量均衡/手动增益都走这里 */
  setTrackGain(db) {
    if (!this.ctx || !this.trackGain) return
    // 第四轮 §4.6：NaN 会一路穿透 —— Math.min(20, NaN) 仍是 NaN，
    // setTargetAtTime(NaN) 会让整条链静音且不报错
    if (!Number.isFinite(Number(db))) return
    const lin = Math.pow(10, Math.max(-20, Math.min(20, Number(db))) / 20)
    this.trackGain.gain.setTargetAtTime(lin, this.ctx.currentTime, 0.05)
  },

  /**
   * 应用均衡器设置。
   * @param {{enabled:boolean, bands:number[]}} cfg
   * 自动补偿：所有段都为正增益时按最大提升量整体衰减，避免削波（等价于自动 preamp）
   */
  applyEq(cfg) {
    if (!this.ctx) return
    const enabled = !!(cfg && cfg.enabled)
    const bands = cfg && Array.isArray(cfg.bands) ? cfg.bands : []
    let maxBoost = 0
    const gains = EQ_FREQS.map((_, i) => {
      const v = Number(bands[i])
      const g = enabled && Number.isFinite(v) ? Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, v)) : 0
      if (g > maxBoost) maxBoost = g
      return g
    })
    const t = this.ctx.currentTime
    this.preamp.gain.setTargetAtTime(Math.pow(10, -maxBoost / 20), t, 0.03)
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(gains[i], t, 0.03))
  },

  /* ---------------- 频谱 ---------------- */

  _canvas: null,
  _cctx: null,
  _freq: null,
  _peaks: null,
  _raf: 0,
  // v3.3.29：全屏页第二画布（与歌词面板频谱共用同一个 Analyser，不新建音频链）
  _extra: [],
  _beatAt: 0,

  /** 注册/注销附加频谱画布。没有 analyser 时也可提前注册，_draw 里自然不会绘制。 */
  addSpectrumTarget(canvas) {
    if (!canvas || !canvas.getContext || this._extra.some((x) => x.canvas === canvas)) return
    const item = { canvas, ctx: null, w: 0, h: 0, ro: null }
    this._extra.push(item)
    // 与主画布同口径：尺寸交给 ResizeObserver，帧内只读缓存，避免 60fps 强制布局
    if (typeof ResizeObserver === 'function') {
      const sync = () => { item.w = canvas.clientWidth; item.h = canvas.clientHeight }
      sync()
      item.ro = new ResizeObserver(sync)
      item.ro.observe(canvas)
    }
  },
  removeSpectrumTarget(canvas) {
    for (const x of this._extra) if (x.canvas === canvas && x.ro) x.ro.disconnect()
    this._extra = this._extra.filter((x) => x.canvas !== canvas)
  },

  startSpectrum(canvas) {
    if (!this.analyser || !canvas) return
    this._canvas = canvas
    this._cctx = canvas.getContext('2d')
    this._freq = new Uint8Array(this.analyser.frequencyBinCount)
    this._peaks = null
    this._resizeCanvas()
    // v3.3.16：尺寸交给 ResizeObserver。以前每帧读 clientWidth/clientHeight，
    // 每次都是强制布局查询（60fps 下等于每秒 120 次），和频谱本身的开销同量级
    if (typeof ResizeObserver === 'function') {
      if (this._ro) this._ro.disconnect()
      this._ro = new ResizeObserver(() => this._resizeCanvas())
      this._ro.observe(canvas)
    }
    // 防止重复调用叠出多条 rAF 循环
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
    // 第四轮 §4.6：隐藏期间 _loop 不再排帧，回到可见时必须有人把它拉起来
    if (!this._visBound) {
      this._visBound = true
      document.addEventListener('visibilitychange', () => {
        // v3.3.20：_spectrumOn 才拉起。以前只看 canvas 和 raf —— 频谱已 stop 后
        // 任何一次切窗口都会把 60fps 的循环复活，面板关着也一直空转画
        if (!document.hidden && this._spectrumOn && this._canvas && !this._raf) this._loop()
      })
    }
    this._spectrumOn = true
    this._loop()
  },

  stopSpectrum() {
    this._spectrumOn = false   // v3.3.20：见上，visibilitychange 的拉起判据
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
    if (this._ro) { this._ro.disconnect(); this._ro = null }
  },

  _resizeCanvas() {
    const c = this._canvas
    if (!c || !this._cctx) return   // 第四轮 §4.6：上下文已释放时不再访问
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(c.clientWidth))
    const h = Math.max(1, Math.round(c.clientHeight))
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
      this._peaks = null
      this._accentGrad = null   // 渐变坐标与高度绑定，尺寸变了必须重建
    }
    this._cctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this._w = w
    this._h = h
  },

  _loop() {
    // 第四轮 §4.6：窗口隐藏时不再排下一帧 —— 以前只跳过绘制，rAF 仍在 60fps 空转，
    // 笔记本合盖/最小化后仍在烧 CPU。恢复可见时由 visibilitychange 重新拉起。
    if (document.hidden) { this._raf = 0; return }
    // v3.3.20：已 stop 就不再排帧（visibilitychange 拉起判据的兜底）
    if (!this._spectrumOn) { this._raf = 0; return }
    this._raf = requestAnimationFrame(() => this._loop())
    const c = this._canvas
    if (!c) return
    this._draw()
  },

  /** 释放音频链与 rAF（v3.3.18，第四轮 §4.6）：切引擎/关窗口时不再泄漏 AudioContext */
  dispose() {
    if (this._raf) { try { cancelAnimationFrame(this._raf) } catch (e) { /* 忽略 */ } this._raf = 0 }
    if (this._ro) { try { this._ro.disconnect() } catch (e) { /* 忽略 */ } this._ro = null }
    try { if (this.ctx && this.ctx.state !== 'closed') this.ctx.close() } catch (e) { /* 忽略 */ }
    this.ctx = null
    this.srcNode = null
    this.trackGain = null
    this.preamp = null
    this.analyser = null
    this.filters = []
    this.failed = false
    this._canvas = null
    this._cctx = null
    this._extra = []
  },

  _draw() {
    const ctx2d = this._cctx
    if (!ctx2d) return
    const canvasEl = this._canvas
    // 兜底：没有 ResizeObserver 时仍然每帧比一次（只是不再读布局，读的是上次算好的值）
    if (!this._ro && canvasEl && (canvasEl.clientWidth !== this._w || canvasEl.clientHeight !== this._h)) {
      this._resizeCanvas()
    }
    // 歌词面板隐藏时画布宽度会缩到很小，直接跳过
    if (this._w < 24 || this._h < 8) return

    const w = this._w
    const h = this._h
    const bins = this._freq
    this.analyser.getByteFrequencyData(bins)
    // v3.3.29：附加画布与节拍光晕放在尺寸检查之前 —— 歌词面板收起时主画布虽小，
    // 全屏页仍应拿到同一份真实频谱数据。无 analyser 时 _loop 根本不会跑。
    this._drawExtra(bins)
    this._updateBeat(bins)

    // v3.3.16：帧间隔归一化 —— 峰值帽的落速以前写死「每帧 0.008*h」，
    // 120Hz 屏幕上落得比 60Hz 快一倍，窗口高度变化时步长还会跳变
    const nowMs = performance.now()
    const dt = this._lastDrawAt ? Math.min(0.1, (nowMs - this._lastDrawAt) / 1000) : 0.016
    this._lastDrawAt = nowMs

    const barCount = Math.max(24, Math.min(72, Math.floor(w / 9)))
    if (!this._peaks || this._peaks.length !== barCount) this._peaks = new Float32Array(barCount)

    ctx2d.clearRect(0, 0, w, h)

    const nyq = this.ctx.sampleRate / 2
    const fMin = 30
    const fMax = 16000
    const gap = w / barCount > 14 ? 2 : 1
    const barW = (w - gap * (barCount - 1)) / barCount
    // v3.3.9：accent+'55' 只对 6 位 hex 成立 —— 主题色若被设成 rgba()/8位hex/命名色，
    // addColorStop 每帧抛 SyntaxError，频谱永久卡死
    // v3.3.16：主题色一秒取一次就够，getComputedStyle 会强制一次样式重算
    if (!this._accentAt || nowMs - this._accentAt > 1000) {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#31c27c'
      this._accent = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : '#31c27c'
      this._accentAt = nowMs
      this._accentGrad = null
    }
    const accent = this._accent
    // 渐变坐标对所有柱子都一样，建一次复用 —— 以前每帧每柱新建
    // 72 个渐变对象（约 4300 个/秒，全是垃圾）
    if (!this._accentGrad) {
      this._accentGrad = ctx2d.createLinearGradient(0, h, 0, 0)
      this._accentGrad.addColorStop(0, accent)
      this._accentGrad.addColorStop(1, accent + '55')
    }
    const grad = this._accentGrad
    ctx2d.fillStyle = grad
    ctx2d.globalAlpha = 0.85

    for (let i = 0; i < barCount; i++) {
      const f0 = fMin * Math.pow(fMax / fMin, i / barCount)
      const f1 = fMin * Math.pow(fMax / fMin, (i + 1) / barCount)
      let b0 = Math.floor((f0 / nyq) * bins.length)
      let b1 = Math.ceil((f1 / nyq) * bins.length)
      b0 = Math.max(0, Math.min(bins.length - 1, b0))
      b1 = Math.max(b0 + 1, Math.min(bins.length, b1))
      // 该频段取平均能量；getByteFrequencyData 把 -100~-30dB 映射到 0~255，
      // 音乐基本都在高位，直接画会一片顶满 → 用 2 次幂做对比度压缩
      let sum = 0
      for (let b = b0; b < b1; b++) sum += bins[b]
      const avg = sum / (b1 - b0)
      const ratio = avg / 255
      const shaped = ratio * ratio
      const bh = Math.max(1, shaped * (h - 2))
      const x = i * (barW + gap)
      const y = h - bh

      ctx2d.fillRect(x, y, barW, bh)

      // 峰值帽：缓慢下落（0.48*h/秒，与帧率无关）
      const pk = Math.max(bh, this._peaks[i] - h * 0.48 * dt)
      this._peaks[i] = pk
      ctx2d.globalAlpha = 0.9
      ctx2d.fillStyle = accent
      ctx2d.fillRect(x, h - pk - 1.5, barW, 1.5)
      ctx2d.fillStyle = grad
      ctx2d.globalAlpha = 0.85
    }
    ctx2d.globalAlpha = 1
  },

  /** v3.3.29（P3 #19）：把同一份 FFT 数据画到全屏页的第二画布。
   *  低频到高频按幂律分桶；只读 bins，不改主绘制的 peaks/渐变状态。 */
  _drawExtra(bins) {
    if (!this._extra.length) return
    const accent = this._accent || '#31c27c'
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    for (const item of this._extra) {
      const c = item.canvas
      if (!c || !c.isConnected) continue
      const w = item.ro ? item.w : c.clientWidth
      const h = item.ro ? item.h : c.clientHeight
      if (w < 24 || h < 8) { c.style.visibility = 'hidden'; continue }
      c.style.visibility = ''
      const pw = Math.round(w * dpr)
      const ph = Math.round(h * dpr)
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph }
      const g = item.ctx || (item.ctx = c.getContext('2d'))
      if (!g) continue
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      g.fillStyle = accent
      g.globalAlpha = 0.5
      const n = 56
      const gap = 2
      const bw = (w - gap * (n - 1)) / n
      const top = Math.min(bins.length - 1, Math.floor(bins.length * 0.55))
      for (let i = 0; i < n; i++) {
        const b0 = Math.floor(Math.pow(i / n, 1.7) * top)
        const b1 = Math.max(b0 + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * top))
        let s = 0
        for (let b = b0; b < b1; b++) s += bins[b]
        const ratio = (s / (b1 - b0)) / 255
        const bh = Math.max(1, ratio * ratio * (h - 2))
        g.fillRect(i * (bw + gap), h - bh, bw, bh)
      }
      g.globalAlpha = 1
    }
  },

  /** 低频能量 → --beat（0..1），限流 10Hz；CSS 用它调全屏页光晕亮度 */
  _updateBeat(bins) {
    const now = performance.now()
    if (now - this._beatAt < 100) return
    this._beatAt = now
    const n = Math.min(24, bins.length)
    let s = 0
    for (let i = 0; i < n; i++) s += bins[i]
    const v = Math.min(1, (s / n) / 200)
    // 只被 #fsView::after 消费：写在根元素上会让整棵 DOM 的自定义属性继承链失效
    const fsView = document.getElementById('fsView')
    if (fsView) fsView.style.setProperty('--beat', v.toFixed(2))
  }
}
