'use strict'
/**
 * v2.8.25 UI 美化：主题色模块（方案 B 的安全落地版）。
 *
 * 三种来源统一存进 settings.accent（字符串，主进程 settings-schema 的
 * 字符串白名单本来就放行，无需改 schema）：
 *   - 'green' | 'cyan' | 'purple' | 'orange'  固定预设
 *   - 'auto'                                   跟随当前曲封面主色
 *   - '#rrggbb'                                兼容旧设置里的裸色值
 *
 * 取色走主进程 nativeImage（ui:accentForTrack）：主进程本来就有封面缓冲
 * （专辑级缓存），不经过渲染层 canvas，也就没有 CSP / 跨域污染问题。
 * 在线曲目封面是远程 https 链接，主进程不联网取色 → 保持上一首歌的颜色，
 * 不会闪烁回默认绿。
 *
 * 入口：标题栏 logo 点按 = 循环切换预设；右键 logo = 弹菜单选择。
 */
const Theme = (() => {
  const PRESETS = [
    { key: 'green', label: '经典绿（默认）', hex: '#31c27c' },
    { key: 'cyan', label: '青', hex: '#22b8cf' },
    { key: 'purple', label: '紫', hex: '#a78bfa' },
    { key: 'orange', label: '橙', hex: '#f59e42' },
    { key: 'auto', label: '跟随封面', hex: '' }
  ]
  const ORDER = ['green', 'cyan', 'purple', 'orange', 'auto']

  /** 渲染层侧的取色结果缓存 { trackId: hex }（主进程还有一层进程内缓存） */
  const coverAccent = new Map()

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return null
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }

  /** 把一个 hex 写进三个主题变量（--accent 由 audiofx 频谱等直接消费） */
  function applyVars(hex) {
    const rgb = hexToRgb(hex)
    if (!rgb) return false
    const root = document.documentElement.style
    root.setProperty('--accent', hex)
    root.setProperty('--accent-soft', `rgba(${rgb.r},${rgb.g},${rgb.b},0.13)`)
    root.setProperty('--accent-dim', `rgba(${rgb.r},${rgb.g},${rgb.b},0.72)`)
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
    if (key && key[0] === '#') { applyVars(key); return }   // 兼容旧裸色值
    const p = PRESETS.find((x) => x.key === key) || PRESETS[0]
    if (p.key === 'auto') {
      const t = currentTrack()
      const hex = t ? coverAccent.get(t.id) : null
      // 没有封面色时先落默认绿，onTrack 拿到颜色后会再刷一次
      applyVars(hex || PRESETS[0].hex)
    } else {
      applyVars(p.hex)
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
      const hex = await window.api.accentForTrack(track.id)
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

  function init() {
    const logo = document.getElementById('logo')
    if (logo) {
      logo.addEventListener('click', () => {
        const i = ORDER.indexOf(currentKey())
        apply(ORDER[(i + 1) % ORDER.length])
        toast('主题色：' + (PRESETS.find((x) => x.key === currentKey()) || PRESETS[0]).label)
      })
      logo.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const cur = currentKey()
        UI.showContextMenu(e.clientX, e.clientY, PRESETS.map((p) => ({
          label: (p.key === cur ? '● ' : '○ ') + p.label,
          act: 'theme-set', arg: p.key
        })))
      })
    }
    // 主题色菜单动作（handleCtxAction 对未知 act 走 default 分支，不会报错）
    const ctxMenu = document.getElementById('ctxMenu')
    if (ctxMenu) {
      ctxMenu.addEventListener('ctx-act', (e) => {
        if (e.detail && e.detail.act === 'theme-set') apply(e.detail.arg)
      })
    }
  }

  init()

  return { apply, onTrack, applyVars, menuItems }
})()
