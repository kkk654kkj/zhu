'use strict'
/**
 * v2.8.25 UI 美化：全屏播放页接线（方案 C 附，参照 Feishin / YesPlayMusic）。
 *
 * 只做交互接线，不做任何业务决策：
 *  - 状态镜像（封面/标题/进度/歌词单行/按钮图标）全部由 ui.js 的既有更新点写入；
 *  - 控制键直接转发点击到主播放条对应按钮，复用全部播放逻辑（含空队列自动开播）；
 *  - 进度条复用 app.js 的 bindBar（与主进度条同一套拖拽实现）。
 *  - 迷你模式下 CSS 强制隐藏 #fsView（body.mini #fsView{display:none}）。
 */
;(function () {
  const $ = (id) => document.getElementById(id)

  // 展开入口：播放条封面（hover 有放大反馈，见 app.css .pb-cover）
  const pbCover = $('pbCover')
  if (pbCover) pbCover.addEventListener('click', () => UI.setFullscreen())

  // 收起：右上角按钮 / Esc
  const fsClose = $('fsClose')
  if (fsClose) fsClose.addEventListener('click', () => UI.setFullscreen(false))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && UI.isFullscreen()) {
      e.preventDefault()
      // v3.3.67：Esc 在这里只防了默认行为。全屏页开着时同一个 Esc 还会被
      // 主界面的全局快捷键/弹层处理再吃一遍（关面板、清搜索、取消关机倒计时），
      // 一次按键做两件事。全屏的「退出」优先，截住这次事件。
      e.stopPropagation()
      UI.setFullscreen(false)
    }
  }, true)

  /* v3.3.70 / v2.8.57：右上角窗口控制条（独占输出 / 最小化 / 最大化 / 关闭）。
     全屏页是 inset:0 的覆盖层，标题栏被整层压住 —— 以前进来就没有窗口出口。
     这里一个业务分支都不写，全部转发到标题栏同名按钮：最大化图标同步、
     退出前串行落盘、独占开关的释放/重载都只有 app.js 那一份。 */
  const fsWin = (fromId, toId, before) => {
    const from = $(fromId)
    if (!from) return
    from.addEventListener('click', () => {
      if (before) { try { before() } catch (e) { /* 忽略 */ } }
      const to = $(toId)
      if (to) to.click()
    })
  }
  fsWin('fsMin', 'btnMin')
  fsWin('fsMax', 'btnMax')
  fsWin('fsWinClose', 'btnClose')
  // 独占开关走的是「释放 → 落盘 → location.reload()」的整页重载，全屏页会被一起冲掉。
  // 点之前记一笔，重载后把页面展开回来，用户不会莫名其妙掉回主界面。
  fsWin('fsHifi', 'btnHifi', () => {
    if (UI.isFullscreen()) sessionStorage.setItem('lx_fs_reopen', '1')
  })

  /* 重载后恢复全屏页（只在「从全屏页里点了独占」时才有标记，其它路径不受影响） */
  let reopenFs = false
  try {
    reopenFs = sessionStorage.getItem('lx_fs_reopen') === '1'
    if (reopenFs) sessionStorage.removeItem('lx_fs_reopen')
  } catch (e) { /* 无 sessionStorage（隐私模式）：当作没标记 */ }
  if (reopenFs) {
    const openFs = () => { try { UI.setFullscreen(true) } catch (e) { /* 忽略 */ } }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openFs, { once: true })
    else openFs()
  }

  /* v2.8.37 / v3.3.45：全屏页自己的播放队列入口。
     复用主界面的 #queuePanel（同一份 UI.renderQueue / 清空 / 行尾 ×），
     CSS 用 body.fs-open 把它抬到 #fsView 之上并挪到页面右侧。
     必须 stopPropagation：app.js 的 document click 会把「不在 #queuePanel /
     #btnQueue 内的点击」当成点外部，立刻把刚打开的抽屉又关掉。 */
  const fsQueue = $('fsQueue')
  const queuePanel = $('queuePanel')
  // v3.3.48：队列改成右侧滑出侧栏后，开态是 .show 类而不是 hidden
  //（hidden 在关闭过渡结束才补上，盯它会慢 240ms）
  const syncQueueBtn = () => {
    if (fsQueue && queuePanel) fsQueue.classList.toggle('on', queuePanel.classList.contains('show'))
  }
  if (fsQueue) {
    fsQueue.addEventListener('click', (e) => {
      e.stopPropagation()
      UI.toggleQueue()
      syncQueueBtn()
    })
    if (queuePanel && typeof MutationObserver === 'function') {
      new MutationObserver(syncQueueBtn).observe(queuePanel, {
        attributes: true, attributeFilter: ['class', 'hidden']
      })
    }
    syncQueueBtn()
  }

  // 控制键镜像
  const fwd = (fromId, toId) => {
    const from = $(fromId)
    const to = $(toId)
    if (!from || !to) return
    from.addEventListener('click', () => to.click())
  }
  fwd('fsPlay', 'btnPlay')
  fwd('fsPrev', 'btnPrev')
  fwd('fsNext', 'btnNext')
  fwd('fsMode', 'btnMode')
  fwd('fsFav', 'btnFav')

  // 进度条拖拽 / 点按 seek：与主进度条完全同一套实现
  const fsBar = $('fsBar')
  if (fsBar && typeof bindBar === 'function') {
    bindBar(fsBar,
      (ratio) => player.seekRatio(ratio),
      (ratio) => UI.setProgress(ratio * (audio.duration || 0), audio.duration || 0),
      () => UI.setProgress(audio.currentTime, audio.duration || 0)
    )
  }
})()
