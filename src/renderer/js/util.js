'use strict'
/* 通用工具函数 */

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function icon(name) {
  return '<svg><use href="#i-' + name + '"/></svg>'
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60)
  return m + ':' + String(s).padStart(2, '0')
}

function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '--:--'
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60)
  return m + ':' + String(s).padStart(2, '0')
}

function fmtSize(bytes) {
  if (!bytes) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i]
}

/* ---- 音质显示（v1.9）：无损看位深/采样率，有损看码率 ---- */

/** 44.1 / 96 / 192 —— 去掉多余的 .0 */
function fmtKHz(sr) {
  const k = sr / 1000
  return (Math.round(k * 10) / 10).toString()
}

/** 表格里的紧凑写法：24/96 表示 24bit/96kHz；有损显示码率；DSD 显示 DSD64/128/256 */
function fmtQuality(t) {
  if (!t) return '—'
  // DSD（v2.0）：位深恒为 1、采样率是 2.8224MHz 的整数倍，按"倍数"叫法更清楚
  if (t.isDsd) {
    const mult = t.sampleRate ? Math.round(t.sampleRate / 44100) : 0
    return mult ? 'DSD' + mult : 'DSD'
  }
  // 有损优先给码率：MP3 的"44.1k"对判断音质没用，128k 才有意义
  if (!t.lossless && t.bitrate) return Math.round(t.bitrate / 1000) + 'k'
  if (t.bitsPerSample && t.sampleRate) return t.bitsPerSample + '/' + fmtKHz(t.sampleRate)
  if (t.sampleRate) return fmtKHz(t.sampleRate) + 'k'
  if (t.bitrate) return Math.round(t.bitrate / 1000) + 'k'
  return '—'
}

/** 悬停提示：把能拿到的参数都摊开，避免"24/96 是什么"这种疑问 */
function qualityTitle(t) {
  if (!t) return ''
  const bits = []
  if (t.isDsd) {
    const mult = t.sampleRate ? Math.round(t.sampleRate / 44100) : 0
    bits.push('DSD' + (mult || '') + (t.sampleRate ? ' · ' + (t.sampleRate / 1000000).toFixed(4) + ' MHz' : ''))
    bits.push('普通输出无法解码，需独占输出')
  } else {
    if (t.bitsPerSample) bits.push(t.bitsPerSample + ' bit')
    if (t.sampleRate) bits.push(fmtKHz(t.sampleRate) + ' kHz')
    if (t.codec) bits.push(String(t.codec).toUpperCase())
    if (t.bitrate) bits.push(Math.round(t.bitrate / 1000) + ' kbps')
    if (t.lossless) bits.push('无损')
  }
  // ReplayGain 标签（v2.0）：有标签就不需要整库分析，顺手在这里标出来
  if (typeof t.rgTrackDb === 'number') {
    bits.push('ReplayGain ' + (t.rgTrackDb >= 0 ? '+' : '') + t.rgTrackDb + ' dB')
  }
  return bits.join(' · ') || '未知'
}

/** 高解析（hires）：24bit 以上或采样率高于 48k —— 用来在列表里把真高清挑出来 */
function isHires(t) {
  if (!t) return false
  if (t.isDsd) return true
  return (t.bitsPerSample >= 24) || (t.sampleRate > 48000)
}

function debounce(fn, ms) {
  let t = null
  return function (...args) {
    clearTimeout(t)
    t = setTimeout(() => fn.apply(this, args), ms)
  }
}

function throttle(fn, ms) {
  let last = 0
  let timer = null
  // v3.3.9：尾随触发要用**最后一次**调用的参数 —— 以前保留的是排定时器那次
  // 的闭包参数，搜索输入节流时最后敲的字不会被搜
  let pendingArgs = null
  let pendingThis = null
  const run = function () {
    timer = null
    last = Date.now()
    const a = pendingArgs
    const t = pendingThis
    pendingArgs = null
    pendingThis = null
    fn.apply(t, a)
  }
  return function (...args) {
    const now = Date.now()
    const gap = now - last
    if (gap >= ms) {
      last = now
      fn.apply(this, args)
    } else {
      pendingArgs = args
      pendingThis = this
      if (!timer) timer = setTimeout(run, ms - gap)
    }
  }
}

let toastTimer = null
let toastHideTimer = null
function toast(msg, ms = 1800) {
  const el = $('#toast')
  if (!el) return
  el.textContent = msg
  el.hidden = false
  el.classList.add('show')
  clearTimeout(toastTimer)
  // v3.3.9：内层隐藏定时器也要管理 —— 以前上一条的 200ms 隐藏定时器
  // 会把新弹的 toast 提前 hidden
  if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null }
  toastTimer = setTimeout(() => {
    el.classList.remove('show')
    toastHideTimer = setTimeout(() => { el.hidden = true }, 200)
  }, ms)
}

/** 极简事件器 */
class Emitter {
  constructor() { this._h = Object.create(null) }
  on(evt, fn) {
    ;(this._h[evt] || (this._h[evt] = [])).push(fn)
    return () => this.off(evt, fn)
  }
  off(evt, fn) {
    const arr = this._h[evt]
    if (!arr) return
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
  emit(evt, ...args) {
    const arr = this._h[evt]
    if (arr) for (const fn of arr.slice()) {
      try { fn(...args) } catch (err) { console.error('[emit]', evt, err) }
    }
  }
}

/** 按多字段模糊匹配 */
function matchQuery(track, q) {
  if (!q) return true
  const needle = q.toLowerCase()
  if ((track.title || '').toLowerCase().includes(needle)) return true
  if ((track.artist || '').toLowerCase().includes(needle)) return true
  if ((track.album || '').toLowerCase().includes(needle)) return true
  if ((track.fileName || '').toLowerCase().includes(needle)) return true
  // 拼音：全拼（zhoujielun）与首字母（zjl），字段由主进程在扫描时算好。
  // 按空格分段比较：py/pyf 里 标题、歌手、专辑是分开的，逐段判断能避免
  // 「上一段结尾 + 下一段开头」拼出假匹配（搜 zj 命中一大片）
  const compact = needle.replace(/\s+/g, '')
  if (compact) {
    const hit = (field) => String(field || '').split(/\s+/).some((seg) => seg.includes(compact))
    if (hit(track.py)) return true
    if (hit(track.pyf)) return true
  }
  return false
}

function sameTrackIds(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
