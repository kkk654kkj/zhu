'use strict'
/**
 * v2.8.25 UI 美化：主题色模块（方案 B 的安全落地版）。
 *
 * 三种来源统一存进 settings.accent（字符串，主进程 settings-schema 的
 * 字符串白名单本来就放行，无需改 schema）：
 *   - 'green' | 'cyan' | 'purple' | 'orange' | 'ocean'  固定预设
 *   - 'auto'                                           跟随当前曲封面主色
 *   - '#rrggbb'                                         兼容旧设置里的裸色值
 *
 * 取色走主进程 nativeImage（ui:accentForTrack）：主进程本来就有封面缓冲
 * （专辑级缓存），不经过渲染层 canvas，也就没有 CSP / 跨域污染问题。
 * 在线曲目封面是远程 https 链接，主进程不联网取色 → 保持上一首歌的颜色，
 * 不会闪烁回默认绿。
 *
 * v3.3.29：新增第六档低饱和「海洋蓝」、外观模式（深色/浅色/跟随系统）。
 * 模式沿用 DEFAULT_SETTINGS 里已存在的 theme 键（settings-schema 白名单天然放行），
 * 同时写一份 localStorage 供启动瞬间立即生效，避免等异步 settings 回来才变色。
 *
 * 入口：标题栏 logo 点按 = 循环切换预设；右键 logo = 弹菜单选择。
 */
const Theme = (() => {
  const PRESETS = [
    { key: 'green', label: '经典绿（默认）', hex: '#31c27c' },
    { key: 'cyan', label: '青', hex: '#22b8cf' },
    { key: 'purple', label: '紫', hex: '#a78bfa' },
    { key: 'orange', label: '橙', hex: '#f59e42' },
    { key: 'ocean', label: '海洋蓝（低饱和）', hex: '#4a90d9' },
    { key: 'auto', label: '跟随封面', hex: '' }
  ]
  const ORDER = ['green', 'cyan', 'purple', 'orange', 'ocean', 'auto']
  const MODES = [
    { key: 'dark', label: '深色' },
    { key: 'light', label: '浅色' },
    { key: 'system', label: '跟随系统' }
  ]
  const MODE_KEY = 'uix.themeMode'

  /** 渲染层侧的取色结果缓存 { trackId: hex }（主进程还有一层进程内缓存） */
  const coverAccent = new Map()
  let mode = 'dark'
  let mql = null

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return null
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }

  /* ---------------- v3.3.48：tonal palette（OKLCH 保色相派生） ----------------
     封面主色直接拿来当 UI 强调色有两个坑：暗封面（黑胶、暗调照片）取出来的
     主色会把按钮/进度条压成一片黑，浅色封面又会糊在白底上。这里用 OKLCH 只调
     明度 L 与彩度 C，色相 h 原样保留 —— 「跟随封面」听起来还是那张封面的颜色，
     但一定落在可读区间里。派生后的 6 档表面色交给 css 的 color-mix 消费。 */

  function srgbToLinear(c) {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  function linearToSrgb8(v) {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
    return Math.max(0, Math.min(255, Math.round(c * 255)))
  }
  function rgbToOklab(rgb) {
    const R = srgbToLinear(rgb.r)
    const G = srgbToLinear(rgb.g)
    const B = srgbToLinear(rgb.b)
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
    return {
      L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    }
  }
  function oklabToRgb(lab) {
    const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b
    const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b
    const s_ = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b
    const l = l_ * l_ * l_
    const m = m_ * m_ * m_
    const s = s_ * s_ * s_
    return {
      r: linearToSrgb8(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      g: linearToSrgb8(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      b: linearToSrgb8(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    }
  }
  const toHex = (rgb) => '#' + [rgb.r, rgb.g, rgb.b]
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')

  /** 相对亮度（WCAG）：用来决定强调色上面压黑字还是白字 */
  function luminance(rgb) {
    return 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b)
  }

  /**
   * 把任意主色规范到「能当 UI 强调色」的区间。
   * 深色主题要亮一点（否则压在 #12151a 上看不见），浅色主题要暗一点。
   */
  function normalize(hex) {
    const rgb = hexToRgb(hex)
    if (!rgb) return null
    const lab = rgbToOklab(rgb)
    const C0 = Math.sqrt(lab.a * lab.a + lab.b * lab.b)
    const h = Math.atan2(lab.b, lab.a)
    const light = document.documentElement.getAttribute('data-theme') === 'light'
    // 深色底：L 0.64~0.88；浅色底：L 0.44~0.62。彩度保留但夹上下限，
    // 免得灰封面（C≈0）选出来像没上色、荧光封面（C>0.2）刺眼
    let L = light
      ? Math.min(0.62, Math.max(0.44, lab.L))
      : Math.min(0.88, Math.max(0.64, lab.L))
    const C = Math.min(0.20, Math.max(C0 < 0.02 ? 0.04 : C0, 0.05))
    const out = oklabToRgb({ L, a: Math.cos(h) * C, b: Math.sin(h) * C })
    return out
  }

  /** 强调色上的文字色：按 WCAG 对比度二选一，不再写死「22% 黑」 */
  function inkFor(rgb) {
    const L = luminance(rgb)
    // 0.36 是黑白字切换的经验分界（深色主题的亮 accent 用近黑字，浅色主题的暗 accent 用白字）
    return L > 0.36 ? '#0b0e13' : '#ffffff'
  }

  /** 把一个 hex 写进主题变量（--accent 由音频频谱等直接消费）
   *  keep=true 时不规范化：用户手选的预设色就是他想要的那个色，别替他改。 */
  function applyVars(hex, keep) {
    const raw = hexToRgb(hex)
    if (!raw) return false
    const tone = keep ? raw : (normalize(hex) || raw)
    const norm = toHex(tone)
    const rgb = hexToRgb(norm)
    const root = document.documentElement.style
    root.setProperty('--accent', norm)
    root.setProperty('--accent-soft', `rgba(${rgb.r},${rgb.g},${rgb.b},0.14)`)
    root.setProperty('--accent-dim', toHex(oklabToRgb({
      L: Math.max(0.28, rgbToOklab(rgb).L * 0.72),
      a: rgbToOklab(rgb).a * 0.85,
      b: rgbToOklab(rgb).b * 0.85
    })))
    root.setProperty('--on-accent', inkFor(rgb))
    return true
  }

  function currentKey() {
    const v = state && state.settings ? state.settings.accent : ''
    return v || 'green'
  }

  function currentTrack() {
    return typeof player !== 'undefined' && player ? player.current : null
  }

  /**
   * 应用一个 accent 值。
   * @param {string} key 预设名 / 'auto' / 裸 hex
   * @param {boolean} save true=写回设置（用户主动选择）；启动应用存量设置时传 false
   */
  function apply(key, save = true) {
    if (key && key[0] === '#') { applyVars(key, true); return }   // 兼容旧裸色值
    const p = PRESETS.find((x) => x.key === key) || PRESETS[0]
    if (p.key === 'auto') {
      const t = currentTrack()
      const hex = t ? coverAccent.get(t.id) : null
      // 没有封面色时先落默认绿，onTrack 拿到颜色后会再刷一次
      applyVars(hex || PRESETS[0].hex, !hex)
    } else {
      applyVars(p.hex, true)
    }
    if (save && state && state.settings) {
      state.settings.accent = p.key
      if (typeof saveSettings === 'function') saveSettings({ accent: p.key })
    }
  }

  /** 换曲钩子（ui.js renderNowPlaying 调用）：仅 auto 模式拉取封面主色 */
  async function onTrack(track) {
    if (!track || currentKey() !== 'auto') return
    if (coverAccent.has(track.id)) { applyVars(coverAccent.get(track.id)); return }
    if (!window.api || !window.api.accentForTrack) return
    try {
      const hex = await window.api.accentForTrack(track.id, track.cover || '')
      if (!hex) return   // 本地无内嵌封面 / 在线曲：保持现状色
      if (coverAccent.size > 500) coverAccent.clear()
      coverAccent.set(track.id, hex)
      // 等待期间用户可能已切走曲目或切走模式，回写前再核对一次
      const cur = currentTrack()
      if (cur && cur.id === track.id && currentKey() === 'auto') applyVars(hex)
    } catch { /* 取色失败静默：主题色是纯装饰 */ }
  }

  /** v2.8.26（追加清单 #5）：给右键主菜单用的主题色子菜单项（标当前项） */
  function menuItems() {
    const cur = currentKey()
    return PRESETS.map((p) => ({
      label: (p.key === cur ? '● ' : '○ ') + p.label,
      act: 'theme-set', arg: p.key
    }))
  }

  /* ---------------- v3.3.29 外观模式 ---------------- */

  function readMode() {
    try {
      const v = localStorage.getItem(MODE_KEY)
      return MODES.some((m) => m.key === v) ? v : 'dark'
    } catch { return 'dark' }
  }

  function effective(m) {
    if (m !== 'system') return m
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark' } catch { return 'dark' }
  }

  function onSysChange() {
    if (mode === 'system') {
      document.documentElement.setAttribute('data-theme', effective('system'))
      // v3.3.48：明暗变了要重算 tonal（同一封面色在深/浅底上夹取的亮度区间不同）
      if (typeof state !== 'undefined' && state && state.settings) apply(currentKey(), false)
    }
  }

  function setMode(next, save = true) {
    if (!MODES.some((m) => m.key === next)) return
    mode = next
    try { localStorage.setItem(MODE_KEY, next) } catch { /* 隐私模式下忽略 */ }
    document.documentElement.setAttribute('data-theme', effective(next))
    // v3.3.48：tonal 的亮度夹取依赖当前明暗，切完模式立刻重算一次（不写设置）
    if (typeof state !== 'undefined' && state && state.settings) apply(currentKey(), false)
    if (mql) {
      try { mql.removeEventListener('change', onSysChange) } catch { /* 老 API */ }
      mql = null
    }
    if (next === 'system' && window.matchMedia) {
      try {
        mql = window.matchMedia('(prefers-color-scheme: light)')
        if (mql.addEventListener) mql.addEventListener('change', onSysChange)
        else if (mql.addListener) mql.addListener(onSysChange)
      } catch { mql = null }
    }
    if (save && typeof state !== 'undefined' && state && state.settings) {
      state.settings.theme = next
      if (typeof saveSettings === 'function') saveSettings({ theme: next })
    }
  }

  function cycleMode() {
    const i = MODES.findIndex((m) => m.key === mode)
    const next = MODES[(i + 1) % MODES.length]
    setMode(next.key)
    return next.label
  }

  function modeItems() {
    return MODES.map((m) => ({
      label: (m.key === mode ? '● ' : '○ ') + m.label,
      act: 'theme-mode', arg: m.key
    }))
  }

  function currentMode() { return mode }

  function init() {
    // 启动瞬间先按本地缓存落一次，不等 loadInitialData 的异步 settings
    setMode(readMode(), false)
    const logo = document.getElementById('logo')
    if (logo) {
      logo.addEventListener('click', () => {
        const i = ORDER.indexOf(currentKey())
        apply(ORDER[(i + 1) % ORDER.length])
        toast('主题色：' + (PRESETS.find((x) => x.key === currentKey()) || PRESETS[0]).label)
      })
      logo.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        UI.showContextMenu(e.clientX, e.clientY, [
          ...menuItems(),
          { sep: true },
          { label: '外观模式', sub: modeItems() }
        ])
      })
    }
    // 主题色 / 外观模式菜单动作（handleCtxAction 对未知 act 走 default 分支，不会报错）
    const ctxMenu = document.getElementById('ctxMenu')
    if (ctxMenu) {
      ctxMenu.addEventListener('ctx-act', (e) => {
        if (!e.detail) return
        if (e.detail.act === 'theme-set') apply(e.detail.arg)
        else if (e.detail.act === 'theme-mode') setMode(e.detail.arg)
      })
    }
  }

  init()

  return { apply, onTrack, applyVars, menuItems, setMode, cycleMode, modeItems, currentMode }
})()
