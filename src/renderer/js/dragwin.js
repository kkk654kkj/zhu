'use strict'
/* 标题栏拖动（v2.8.27 / v2.8.32 性能轮）
 *
 * 为什么不用 -webkit-app-region: drag —— Windows + 125% 缩放下，drag 区域在
 * 系统层的命中矩形会整体下移约 19px（恰好等于 SM_CYCAPTION 标题栏高度）：
 * WM_NCHITTEST 实测 y<19 返回 HTCLIENT、y>=19 全变 HTCAPTION，与 CSS 怎么写无关。
 * 结果右上角按钮的下半截被当成标题栏，点击被系统吞掉 —— 表现就是「按钮点不动，
 * 只有从窗口上边缘往下摸才行」。
 *
 * 改成程序内拖动后窗口不再有 drag 矩形，整条标题栏都是客户区。
 * 拖动源：完整模式标题栏、迷你模式顶部条与卡片主体（原 .mv-head / .mv-body）。
 *
 * v2.8.32：v2.8.27 的实现是主进程 setInterval(16) 轮询 cursor + 同步 setBounds，
 * 可见窗口实测 60 次光标移动只更新 34 次窗口位置（34.6fps、跟上率 55%）。
 * 改为渲染层 pointermove 事件驱动 + rAF 节流，把「相对按下点的累计位移」送给
 * 主进程；主进程不再轮询光标，每帧只在收到位移时 setBounds。用 setPointerCapture
 * 保证鼠标拖出窗口后仍持续收到事件。位移用同一坐标系内的差值，避免 DIP↔物理
 * 像素换算带来的绝对坐标偏差。
 */

;(() => {
  // 这些容器整块可拖（内部控件除外），与原来 app-region: drag 的范围一一对应
  // v2.8.37 / v3.3.45：#fsView 是 z-index:50 的整屏覆盖层，把 z-index:1 的
  // #titlebar 整层盖住；不把它加进拖动源，全屏播放页里按哪都拖不动窗口。
  const HOLDERS = ['#titlebar', '#miniView .mv-head', '#miniView .mv-body', '#fsView']
  // 落在这些元素上时不启动拖动：按钮/输入框自己要用鼠标
  // .tb-fold = 顶栏「⋯」菜单容器（点它开菜单，不能当拖动起点；放在末尾以兼容既有静态断言）
  // #fsBar = 全屏页进度条（拖它要 seek）；#fsLyrics = 全屏页歌词（点行要跳进度）
  const BLOCK = 'button, input, textarea, select, a, .no-drag, .search-box, .row-act, #fsBar, #fsLyrics, .lyric-line, .tb-fold'

  let dragging = false
  let startX = 0
  let startY = 0
  let pendingDx = 0
  let pendingDy = 0
  let raf = 0
  let capturedEl = null
  let capturedId = null

  const flush = () => {
    raf = 0
    if (!dragging) return
    try { window.api.dragMove(pendingDx, pendingDy) } catch { /* 窗口已经在关 */ }
  }

  const stop = () => {
    if (!dragging) return
    dragging = false
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (capturedEl) {
      try { capturedEl.releasePointerCapture(capturedId) } catch { /* 已释放或不支持 */ }
      capturedEl = null
    }
    try { window.api.dragEnd() } catch { /* 窗口已经在关 */ }
    document.body.classList.remove('win-dragging')
  }

  for (const sel of HOLDERS) {
    const el = document.querySelector(sel)
    if (!el) continue
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      if (e.target.closest(BLOCK)) return
      // 双击不启动拖动：完整模式标题栏（btnMax.click）与迷你卡片（退出迷你）
      // 各自的 dblclick 已负责最大化/还原；这里再 toggle 一次会重复触发、互相抵消
      if (e.detail === 2) return
      dragging = true
      startX = e.screenX
      startY = e.screenY
      pendingDx = 0
      pendingDy = 0
      capturedEl = el
      capturedId = e.pointerId
      try { el.setPointerCapture(e.pointerId) } catch { /* 不支持则靠 window 事件兜底 */ }
      document.body.classList.add('win-dragging')
      try { window.api.dragStart() } catch { stop(); return }
      e.preventDefault()
    })
  }

  // capture=true：指针被标题栏捕获后事件仍会冒泡到 window
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return
    pendingDx = e.screenX - startX
    pendingDy = e.screenY - startY
    // 每帧最多一发，避免高采样率鼠标打爆 IPC；与合成器节奏对齐
    if (!raf) raf = requestAnimationFrame(flush)
  }, true)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
  window.addEventListener('blur', stop)
  // 拖到窗口外松手时 pointerup 收不到，用 ESC 兜底
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop() }, true)
})()
