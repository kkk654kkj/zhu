'use strict'
/* 标题栏拖动（v2.8.27）
 *
 * 为什么不用 -webkit-app-region: drag —— Windows + 125% 缩放下，drag 区域在
 * 系统层的命中矩形会整体下移约 19px（恰好等于 SM_CYCAPTION 标题栏高度）：
 * WM_NCHITTEST 实测 y<19 返回 HTCLIENT、y>=19 全变 HTCAPTION，与 CSS 怎么写无关。
 * 结果右上角按钮的下半截被当成标题栏，点击被系统吞掉 —— 表现就是「按钮点不动，
 * 只有从窗口上边缘往下摸才行」。
 *
 * 改成 mousedown 通知主进程，由主进程按光标位移 setPosition：窗口不再有任何
 * drag 矩形，整条标题栏都是客户区，按钮怎么点都生效。
 * 拖动源：完整模式标题栏、迷你模式顶部条与卡片主体（原 .mv-head / .mv-body）。
 */

;(() => {
  // 这些容器整块可拖（内部控件除外），与原来 app-region: drag 的范围一一对应
  const HOLDERS = ['#titlebar', '#miniView .mv-head', '#miniView .mv-body']
  // 落在这些元素上时不启动拖动：按钮/输入框自己要用鼠标
  const BLOCK = 'button, input, textarea, select, a, .no-drag, .search-box, .row-act'

  let dragging = false

  const stop = () => {
    if (!dragging) return
    dragging = false
    try { window.api.dragEnd() } catch { /* 窗口已经在关 */ }
    document.body.classList.remove('win-dragging')
  }

  for (const sel of HOLDERS) {
    const el = document.querySelector(sel)
    if (!el) continue
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      if (e.target.closest(BLOCK)) return
      // 双击标题栏最大化/还原，保持系统标题栏的手感
      if (e.detail === 2) {
        window.api.toggleMaximize().catch(() => {})
        return
      }
      dragging = true
      document.body.classList.add('win-dragging')
      try { window.api.dragStart() } catch { dragging = false }
      e.preventDefault()
    })
  }

  window.addEventListener('mouseup', stop)
  window.addEventListener('blur', stop)
  // 拖到窗口外松手时 mouseup 收不到，用 ESC 兜底
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop() }, true)
})()
