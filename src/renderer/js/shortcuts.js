'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 快捷键 ================= */

function handleShortcut(action) {
  switch (action) {
    case 'play-pause': player.toggle(); break
    case 'next': player.next(); break
    case 'prev': player.prev(); break
    case 'stop': player.pause(); break
    case 'volume-up': player.setVolume(Math.min(1, player.volume + 0.05)); break
    case 'volume-down': player.setVolume(Math.max(0, player.volume - 0.05)); break
    case 'dlyric': toggleDesktopLyric(); break
    case 'mini-toggle': toggleMini(); break
  }
}

function bindGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    // v3.3.20：<select> 也算输入控件。以前只认 INPUT/TEXTAREA，
    // 焦点在「音质偏好」「缓存上限」下拉上时，↓ 被当成音量 -5%、空格被当成播放/暂停，
    // 两个下拉完全没法用键盘操作。
    const ae = document.activeElement
    const inInput = /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(ae.tagName) || ae.isContentEditable
    if (e.key === 'Escape') {
      // 关机倒计时进行中：Esc 优先取消它（这一刻误触的代价最大）
      if (powerCountdownTimer) { cancelPowerCountdown(); e.preventDefault(); return }
      if (state.analyzing) {
        state.abortAnalysis = true
        e.preventDefault()
        return
      }
      UI.hideContextMenu()
      // v3.3.48：队列侧栏用 Esc 收起（滑出层，没有遮罩可点）
      if (UI.els.queuePanel && UI.els.queuePanel.classList.contains('show')) {
        UI.toggleQueue(false)
        e.preventDefault()
        return
      }
      if (typeof Diag !== 'undefined' && Diag.isOpen()) { Diag.close(); e.preventDefault(); return }
      if (!UI.els.dirModal.hidden) { UI.hideDirModal(); e.preventDefault(); return }
      if (!document.getElementById('renameModal').hidden) { closeRenameModal(); e.preventDefault(); return }
      if (inInput) { document.activeElement.blur(); e.preventDefault() }
      // 有选中项时 Esc 先清选中（v1.7）
      if (state.selected.size) { clearSelection(); e.preventDefault() }
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !inInput) {
      // 全选当前视图的可见曲目（v1.7）
      // v3.3.17：在线/专辑/文件夹视图没有「表格行」，而且 renderView 在这几个分支
      // 提前 return 不会更新 state.visible —— 以前会选中上一个本地视图的残留曲目，
      // 用户看不见却会真的被批量收藏/加入歌单。
      if (state.view === 'online' || state.view === 'albums' || state.view === 'folders') return
      e.preventDefault()
      state.selected = new Set(state.visible.map((t) => t.id))
      state.selAnchor = 0
      paintSelection()
      if (state.selected.size) toast('已选中 ' + state.selected.size + ' 首')
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      document.getElementById('searchInput').focus()
      document.getElementById('searchInput').select()
      return
    }
    if (inInput) return
    // 焦点在按钮上时，空格应激活按钮本身；全局播放/暂停不能抢走这次按键
    if (e.code === 'Space' && e.target && e.target.closest && e.target.closest('button')) return
    switch (e.code) {
      case 'Space': e.preventDefault(); player.toggle(); break
      case 'ArrowRight':
        if (e.shiftKey) player.next()
        else player.seek(audio.currentTime + 5)
        e.preventDefault()
        break
      case 'ArrowLeft':
        if (e.shiftKey) player.prev()
        else player.seek(audio.currentTime - 5)
        e.preventDefault()
        break
      case 'ArrowUp': e.preventDefault(); player.setVolume(player.volume + 0.05); break
      case 'ArrowDown': e.preventDefault(); player.setVolume(player.volume - 0.05); break
      case 'KeyM': player.setMuted(!player.muted); break
      case 'KeyL':
        document.getElementById('btnFav').click()
        break
    }
  })
}

