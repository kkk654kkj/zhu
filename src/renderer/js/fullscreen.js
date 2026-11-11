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
      UI.setFullscreen(false)
    }
  })

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
