'use strict'
/**
 * 拖拽交互（v1.6）
 *
 * 1) 队列面板内拖拽排序（player.moveInQueue）
 * 2) 把表格行的序号格拖到左侧歌单 → 加入歌单
 *
 * 表格里只让序号格可拖，避免整行 draggable 抢走「选中曲目名文字」的行为。
 * 依赖 app.js 的全局 state / player / addTracksToPlaylist（非 module 脚本共享全局作用域）。
 */
function bindDragAndDrop() {
  const queueBody = document.getElementById('queueBody')
  const tableBody = document.getElementById('tableBody')
  const sidebar = document.getElementById('sidebar')
  if (!queueBody || !tableBody || !sidebar) return

  let dragQi = null          // 正在拖的队列索引
  let dragQId = null         // v3.3.9：被拖项的曲目 id —— 拖拽期间队列可能重渲染，索引会过期
  let dragQRef = null        // v3.3.13：被拖项的对象引用（优先用它定位，id 在重复曲目下会串位）
  let dragTrackIds = null    // 正在拖的曲目 id（多选时是整批）
  let dropEl = null          // 当前高亮的放置目标

  const clearDropMark = () => {
    if (dropEl) dropEl.classList.remove('drop-target', 'nav-drop')
    dropEl = null
  }
  const markDrop = (el, cls) => {
    if (dropEl === el) return
    clearDropMark()
    dropEl = el
    if (el) el.classList.add(cls)
  }
  const endDrag = () => {
    dragQi = null
    dragQId = null
    dragQRef = null
    dragTrackIds = null
    clearDropMark()
    document.querySelectorAll('.qp-item.dragging').forEach((el) => el.classList.remove('dragging'))
  }

  /* ---- 队列排序 ---- */
  queueBody.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.qp-item')
    if (!item || item.dataset.qi == null) return
    dragQi = Number(item.dataset.qi)
    // v3.3.13：快照曲目对象引用（重复 id 时用引用才不会串位）；id 仅作兜底
    const dragTrack = (typeof player !== 'undefined' && player && player.tracks[dragQi]) ? player.tracks[dragQi] : null
    dragQRef = dragTrack
    dragQId = dragTrack ? dragTrack.id : null
    dragTrackIds = null
    item.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    // 必须 setData，否则部分 Chromium 版本不会真正启动拖拽
    e.dataTransfer.setData('text/plain', 'queue:' + dragQi)
  })
  queueBody.addEventListener('dragover', (e) => {
    if (dragQi == null) return
    const item = e.target.closest('.qp-item')
    if (!item) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    markDrop(item, 'drop-target')
  })
  queueBody.addEventListener('drop', (e) => {
    if (dragQi == null) return
    const item = e.target.closest('.qp-item')
    if (!item || item.dataset.qi == null) { endDrag(); return }
    e.preventDefault()
    const to = Number(item.dataset.qi)
    // v3.3.13：起点优先按拖起来的那个对象引用换算当前索引（队列含重复 id 时
    // findIndex(id) 会定位到错误副本，与 player.moveInQueue 的对象引用口径一致）；
    // 引用失效（队列整体替换）时才退回 id 兜底
    let from = dragQi
    if (player) {
      let i = dragQRef ? player.tracks.indexOf(dragQRef) : -1
      if (i < 0 && dragQId) i = player.tracks.findIndex((t) => t.id === dragQId)
      if (i >= 0) from = i
    }
    endDrag()
    // 播放器按 id 重新定位 index，拖过当前曲目也不会串位
    player.moveInQueue(from, to)
  })
  queueBody.addEventListener('dragend', endDrag)

  /* ---- 表格行 → 歌单 ---- */
  tableBody.addEventListener('dragstart', (e) => {
    const num = e.target.closest('.num[draggable]')
    if (!num) return
    const row = num.closest('.tr')
    if (!row) return
    const id = row.dataset.id
    // 拖的是多选里的一项 → 整批带走（v1.7）
    dragTrackIds = state.selected.has(id) && state.selected.size > 1
      ? Array.from(state.selected)
      : [id]
    dragQi = null
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', dragTrackIds.join(','))
  })
  tableBody.addEventListener('dragend', endDrag)

  /* ---- 侧边栏歌单作为放置目标 ---- */
  sidebar.addEventListener('dragover', (e) => {
    if (!dragTrackIds) return
    const nav = e.target.closest('.nav-item[data-playlist]')
    if (!nav) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    markDrop(nav, 'nav-drop')
  })
  sidebar.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !sidebar.contains(e.relatedTarget)) clearDropMark()
  })
  sidebar.addEventListener('drop', async (e) => {
    if (!dragTrackIds) return
    const nav = e.target.closest('.nav-item[data-playlist]')
    const plId = nav ? nav.dataset.playlist : null
    const ids = dragTrackIds
    endDrag()
    if (!plId) return
    e.preventDefault()
    // 拖进歌单失败（歌单已删 / 写盘失败）不能变成 unhandled rejection：
    // 界面表现会是「拖过去毫无反应」，用户只能反复重试
    try {
      await addTracksToPlaylist(plId, ids)
    } catch (err) {
      toast('加入歌单失败：' + ((err && err.message) || err))
    }
  })
}
