'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 迷你模式 ================= */

/**
 * 迷你模式只切界面，窗口缩放由主进程做（同一窗口，播放状态天然连续）。
 * on 省略＝切换；返回后以主进程的实际状态为准。
 */
async function toggleMini(on) {
  const next = on == null ? !state.mini : !!on
  if (next === state.mini) return
  // 进迷你/回完整之前把浮层都收掉，免得面板卡在窄窗口里
  // v2.8.7：以前漏了音频设备/睡眠定时两个面板
  UI.toggleQueue(false)
  UI.toggleEq(false)
  UI.hideContextMenu()
  toggleAudioPanel(false)
  toggleSleepPanel(false)
  state.mini = next
  UI.setMini(next)
  try {
    const actual = await window.api.setMini(next)
    if (actual !== state.mini) {
      state.mini = actual
      UI.setMini(actual)
    }
  } catch (err) {
    console.error('[mini]', err)
    // 主进程没切成时界面不能停在迷你布局：窗口尺寸还是完整模式，卡片会被拉伸
    state.mini = !next
    UI.setMini(state.mini)
    toast('迷你模式切换失败，已还原', 2500)
    return
  }
  toast(next ? '迷你模式' : '完整模式')
}

async function toggleFavoriteCurrent() {
  if (!state.currentId) return
  let favs
  try { favs = await window.api.toggleFavorite(state.currentId) }
  catch (err) { toast('操作失败：' + (err.message || err), 2500); return }
  state.favorites = new Set(favs)
  UI.setFavorite(state.favorites.has(state.currentId))
  updateNavCounts()
  if (state.view === 'fav') renderView()
  toast(state.favorites.has(state.currentId) ? '已加入收藏' : '已取消收藏')
}

