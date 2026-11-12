'use strict'
/**
 * v3.3.29 UI 增强轮 · 运行时挂载层
 *
 * 设计约束（与仓库既有不变量一致）：
 *  - 无打包器、无内联脚本（CSP script-src 'self'），经典全局脚本，放在 app.js 之后；
 *  - 不动虚拟滚动（TABLE_ROW_H=40 / _rowHtml / 头尾增删），不碰窗口拖动；
 *  - 所有新 DOM 由本文件运行时创建，index.html 只放必须静态存在的容器；
 *  - 每个功能独立 try/catch，单项失败不影响其余功能与播放主链路；
 *  - UI 偏好存 localStorage（settings-schema 顶层白名单只放行 DEFAULT_SETTINGS 已有键），
 *    外观模式例外：theme 键本就存在，由 Theme.setMode 双写。
 */
const UIX = (() => {
  const LS = {
    fx: 'uix.fsEffect',
    fs: 'uix.fsLyricFs',
    align: 'uix.fsLyricAlign',
    fxoff: 'uix.fxOff'
  }
  const get = (k, d) => {
    try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d }
  }
  const set = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 隐私模式忽略 */ } }
  const $ = (id) => document.getElementById(id)
  const q = (sel) => document.querySelector(sel)
  const safe = (fn) => { try { fn() } catch (e) { /* 单项装饰失败不影响主链路 */ } }

  /* ---------------- P1 #4 主题感知骨架屏 ----------------
     pointer-events:none 在 CSS 里已声明，覆盖期间任何点击都会穿透到真实控件。 */
  let skeleton = null
  function mountSkeleton() {
    if (!document.body || $('bootSkeleton')) return
    skeleton = document.createElement('div')
    skeleton.id = 'bootSkeleton'
    skeleton.innerHTML = '<div class="bs-card"><i></i><i></i><i></i><i></i></div>'
    document.body.appendChild(skeleton)
  }
  function dropSkeleton() {
    if (!skeleton) return
    const el = skeleton
    skeleton = null
    el.classList.add('out')
    setTimeout(() => { try { el.remove() } catch { /* 已移除 */ } }, 260)
  }
  mountSkeleton()
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(dropSkeleton, 260)
    setTimeout(dropSkeleton, 900)   // DOMContentLoaded 已触发过的兜底
  })
  setTimeout(dropSkeleton, 1600)    // 极端兜底：绝不让遮罩常驻

  /* ---------------- P1 #2 键盘可达 / title ---------------- */
  const TITLES = {
    btnScan: '扫描音乐文件夹', btnLyricToggle: '显示/隐藏歌词面板',
    btnDLyric: '桌面歌词', btnHifi: '独占输出', btnMini: '迷你模式', btnDiag: '诊断',
    btnMin: '最小化', btnMax: '最大化/还原', btnClose: '关闭',
    btnFav: '收藏', btnMode: '播放模式', btnPrev: '上一首', btnPlay: '播放/暂停',
    btnNext: '下一首', btnQueue: '播放队列', btnAb: 'A-B 循环',
    btnSleep: '睡眠定时', btnEq: '均衡器', btnNorm: '音量均衡', btnMute: '静音',
    btnQueueClose: '收起队列', btnEqClose: '收起均衡器',
    fsMode: '播放模式', fsPrev: '上一首', fsPlay: '播放/暂停', fsNext: '下一首', fsFav: '收藏',
    logo: '切换主题色（右键可外观设置）'
  }
  function injectTitles() {
    for (const id of Object.keys(TITLES)) {
      const el = $(id)
      if (!el) continue
      if (!el.getAttribute('title')) el.setAttribute('title', TITLES[id])
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', TITLES[id])
    }
    document.querySelectorAll('button').forEach((b) => {
      if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', b.getAttribute('title') || b.id || '按钮')
      if (!b.getAttribute('type')) b.setAttribute('type', 'button')
    })
  }

  /* ---------------- 运行时按钮 ---------------- */
  function addBtn(hostSel, id, label, title, first) {
    const host = q(hostSel)
    if (!host || $(id)) return null
    const b = document.createElement('button')
    b.className = 'uix-btn'
    b.id = id
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.setAttribute('aria-label', title)
    if (first && host.firstChild) host.insertBefore(b, host.firstChild)
    else host.appendChild(b)
    return b
  }

  function bindButtons() {
    const modeBtn = addBtn('.tb-right', 'btnThemeMode', '◐', '外观模式（深色 / 浅色 / 跟随系统）', true)
    if (modeBtn) modeBtn.addEventListener('click', () => {
      if (typeof Theme !== 'undefined' && typeof Theme.cycleMode === 'function') toast('外观：' + Theme.cycleMode())
    })
    const locateBtn = addBtn('.pb-right', 'btnLocate', '⌖', '定位到当前播放曲目', true)
    if (locateBtn) locateBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('uix:locate'))
    })
    const galleryBtn = addBtn('.tb-right', 'btnGallery', '▦', '封面画廊', true)
    if (galleryBtn) galleryBtn.addEventListener('click', openGallery)
  }

  /* ---------------- P3 #18 全屏特效 / 歌词排版工具 ---------------- */
  const FX = ['none', 'vinyl', 'cd', 'tape']
  const FX_LABEL = { none: '无', vinyl: '黑胶唱片', cd: 'CD', tape: '磁带' }
  const SIZES = [15, 17, 19, 21]

  function bindFullscreenTools() {
    const cover = $('fsCover')
    const fs = $('fsView')

    let fx = get(LS.fx, 'none')
    if (FX.indexOf(fx) < 0) fx = 'none'
    const applyFx = () => {
      if (!cover) return
      if (fx === 'none') delete cover.dataset.fx
      else cover.dataset.fx = fx
      set(LS.fx, fx)
      const b = $('fsFx')
      if (b) b.classList.toggle('on', fx !== 'none')
    }
    applyFx()
    const fxBtn = $('fsFx')
    if (fxBtn) fxBtn.addEventListener('click', () => {
      fx = FX[(FX.indexOf(fx) + 1) % FX.length]
      applyFx()
      toast('封面特效：' + FX_LABEL[fx])
    })

    let fsi = SIZES.indexOf(Number(get(LS.fs, '17')))
    if (fsi < 0) fsi = 1
    const applyFs = () => {
      document.documentElement.style.setProperty('--fs-lyric-fs', SIZES[fsi] + 'px')
      set(LS.fs, String(SIZES[fsi]))
      toast('全屏歌词字号：' + SIZES[fsi] + 'px')
    }
    document.documentElement.style.setProperty('--fs-lyric-fs', SIZES[fsi] + 'px')
    const sizeBtn = $('fsLyricSize')
    if (sizeBtn) sizeBtn.addEventListener('click', () => { fsi = (fsi + 1) % SIZES.length; applyFs() })

    let align = get(LS.align, 'center') === 'left' ? 'left' : 'center'
    const applyAlign = () => {
      document.documentElement.style.setProperty('--fs-lyric-align', align)
      set(LS.align, align)
      toast('全屏歌词对齐：' + (align === 'left' ? '左' : '居中'))
    }
    document.documentElement.style.setProperty('--fs-lyric-align', align)
    const alignBtn = $('fsLyricAlign')
    if (alignBtn) alignBtn.addEventListener('click', () => { align = align === 'center' ? 'left' : 'center'; applyAlign() })

    let off = get(LS.fxoff, '0') === '1'
    const applyOff = () => {
      if (fs) fs.dataset.fxoff = off ? '1' : '0'
      set(LS.fxoff, off ? '1' : '0')
      const b = $('fsFxOff')
      if (b) b.classList.toggle('on', !off)
      toast(off ? '频谱光效已关闭' : '频谱光效已开启')
    }
    if (fs) fs.dataset.fxoff = off ? '1' : '0'
    const offBtn = $('fsFxOff')
    if (offBtn) {
      offBtn.classList.toggle('on', !off)
      offBtn.addEventListener('click', () => { off = !off; applyOff() })
    }

    // 逐行偏移校准：复用歌词面板已有的 setOffset 链路（按曲目持久化），
    // 不在全屏页另起一套状态，避免两处偏移互相踩。
    const minus = $('fsOffsetMinus')
    const plus = $('fsOffsetPlus')
    if (minus) minus.addEventListener('click', () => { const b = $('btnLyricEarlier'); if (b) b.click() })
    if (plus) plus.addEventListener('click', () => { const b = $('btnLyricLater'); if (b) b.click() })

    const gBtn = $('fsGallery')
    if (gBtn) gBtn.addEventListener('click', openGallery)
  }

  /* ---------------- P3 #19 全屏第二频谱画布 ----------------
     与歌词面板共用 AudioFx 的 Analyser，不新建音频链。
     mpv 独占 / 音频图未建立时没有 FFT 数据 → 画布保持 hidden（不造假动画）。 */
  function bindSpectrum() {
    const c = $('fsSpectrum')
    const fs = $('fsView')
    if (!c || !fs) return
    c.hidden = true
    if (typeof AudioFx !== 'undefined' && AudioFx.addSpectrumTarget) AudioFx.addSpectrumTarget(c)
    const sync = () => {
      const open = fs.classList.contains('open')
      const hasData = typeof AudioFx !== 'undefined' && !!AudioFx.analyser
      c.hidden = !(open && hasData && fs.dataset.fxoff !== '1')
      // 歌词面板收起时 _spectrumOn 会被关掉，但全屏页仍要数据：复用主画布拉起同一循环
      if (open && hasData && !AudioFx._spectrumOn && typeof UI !== 'undefined' && UI.els && UI.els.spectrum) {
        safe(() => AudioFx.startSpectrum(UI.els.spectrum))
      }
    }
    if (typeof MutationObserver === 'function') {
      new MutationObserver(sync).observe(fs, { attributes: true, attributeFilter: ['class', 'data-fxoff'] })
    }
    const timer = setInterval(sync, 900)
    setTimeout(() => clearInterval(timer), 15000)
    sync()
  }

  /* ---------------- P2 #16 队列数量徽标 ---------------- */
  function bindQueueBadge() {
    const body = $('queueBody')
    const btn = $('btnQueue')
    if (!body || !btn || btn.querySelector('.uix-badge')) return
    const b = document.createElement('span')
    b.className = 'uix-badge'
    b.textContent = '0'
    btn.appendChild(b)
    // v3.3.32：空队列时 renderQueue 会插一个没有 data-qi 的占位块，按 children 数会显示 1
    const upd = () => { b.textContent = String(body.querySelectorAll('.qp-item[data-qi]').length) }
    if (typeof MutationObserver === 'function') new MutationObserver(upd).observe(body, { childList: true })
    upd()
  }

  /* ---------------- P3 #20 无限封面画廊 ---------------- */
  function collectCovers() {
    const out = []
    const seen = new Set()
    safe(() => {
      const list = (typeof state !== 'undefined' && state && state.tracks) || []
      for (const t of list) {
        if (out.length >= 48) break
        if (!t || !t.cover || seen.has(t.cover)) continue
        seen.add(t.cover)
        out.push({ src: t.cover, id: t.id, name: t.title || t.name || '' })
      }
    })
    if (!out.length) {
      document.querySelectorAll('.ac-cover img, .vh-cover img, #pbCover img').forEach((im) => {
        if (out.length >= 48 || !im.src || seen.has(im.src)) return
        seen.add(im.src)
        out.push({ src: im.src, id: null, name: '' })
      })
    }
    return out
  }

  function openGallery() {
    // v3.3.32：双击播放条封面 = 两次 click（fullscreen.js 各 toggle 一次全屏）+ dblclick。
    // 这里统一收起全屏页，画廊才有干净的底层；单击展开仍是即时响应，不加延时。
    try { UI.setFullscreen(false) } catch (e) { /* 忽略 */ }
    const gv = $('galleryView')
    const track = $('gvTrack')
    if (!gv || !track) return
    const items = collectCovers()
    if (!items.length) { toast('曲库里还没有可用封面'); return }
    const html = items.map((it) =>
      `<div class="gv-item" data-id="${esc(it.id || '')}" title="${esc(it.name)}">` +
      `<img src="${esc(it.src)}" alt="" draggable="false" /></div>`).join('')
    track.innerHTML = html + html   // 两份拼接 + translateX(-50%) 实现无缝循环
    gv.classList.add('open')
  }

  function closeGallery() {
    const gv = $('galleryView')
    if (gv) gv.classList.remove('open')
  }

  function bindGallery() {
    const gv = $('galleryView')
    const track = $('gvTrack')
    const pb = $('pbCover')
    if (!gv || !track) return
    if (pb) pb.addEventListener('dblclick', openGallery)
    gv.addEventListener('click', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('.gv-item') : null
      if (!item) { closeGallery(); return }
      const id = item.dataset.id
      closeGallery()
      if (!id) { toast('该封面没有关联曲目'); return }
      safe(() => {
        const list = (typeof state !== 'undefined' && state && state.tracks) || []
        const idx = list.findIndex((t) => t.id === id)
        if (idx >= 0 && typeof player !== 'undefined' && player && player.setQueue) {
          player.setQueue(list.slice(), idx, true)
          toast('已播放：' + (list[idx].title || '当前曲目'))
        }
      })
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && gv.classList.contains('open')) closeGallery()
    })
  }

  function init() {
    safe(injectTitles)
    safe(bindButtons)
    safe(bindFullscreenTools)
    safe(bindSpectrum)
    safe(bindQueueBadge)
    safe(bindGallery)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()

  return { openGallery, closeGallery }
})()
