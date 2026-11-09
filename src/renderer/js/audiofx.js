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
    const lin = Math.pow(10, Math.max(-20, Math.min(20, db)) / 20)
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

  startSpectrum(canvas) {
    if (!this.analyser || !canvas) return
    this._canvas = canvas
    this._cctx = canvas.getContext('2d')
    this._freq = new Uint8Array(this.analyser.frequencyBinCount)
    this._peaks = null
    this._resizeCanvas()
    // 防止重复调用叠出多条 rAF 循环
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
    this._loop()
  },

  stopSpectrum() {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
  },

  _resizeCanvas() {
    const c = this._canvas
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(c.clientWidth))
    const h = Math.max(1, Math.round(c.clientHeight))
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
      this._peaks = null
    }
    this._cctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this._w = w
    this._h = h
  },

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop())
    const c = this._canvas
    if (!c) return
    if (document.hidden) return
    this._draw()
  },

  _draw() {
    const ctx2d = this._cctx
    if (!ctx2d) return
    const canvasEl = this._canvas
    if (canvasEl.clientWidth !== this._w || canvasEl.clientHeight !== this._h) this._resizeCanvas()
    // 歌词面板隐藏时画布宽度会缩到很小，直接跳过
    if (this._w < 24 || this._h < 8) return

    const w = this._w
    const h = this._h
    const bins = this._freq
    this.analyser.getByteFrequencyData(bins)

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
    const accentRaw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#31c27c'
    const accent = /^#[0-9a-fA-F]{6}$/.test(accentRaw) ? accentRaw : '#31c27c'

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

      const grad = ctx2d.createLinearGradient(0, h, 0, 0)
      grad.addColorStop(0, accent)
      grad.addColorStop(1, accent + '55')
      ctx2d.fillStyle = grad
      ctx2d.globalAlpha = 0.85
      ctx2d.fillRect(x, y, barW, bh)

      // 峰值帽：缓慢下落
      const pk = Math.max(bh, this._peaks[i] - h * 0.008)
      this._peaks[i] = pk
      ctx2d.globalAlpha = 0.9
      ctx2d.fillStyle = accent
      ctx2d.fillRect(x, h - pk - 1.5, barW, 1.5)
    }
    ctx2d.globalAlpha = 1
  }
}
