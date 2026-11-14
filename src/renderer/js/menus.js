'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 右键菜单 ================= */

function showTrackMenu(x, y, track) {
  // 右键落在「已选中的行」上 → 菜单作用于整批（v1.7）
  const multi = state.selected.has(track.id) && state.selected.size > 1
  const targets = multi
    ? Array.from(state.selected).map((id) => state.byId.get(id)).filter(Boolean)
    : [track]
  const isFav = targets.every((t) => state.favorites.has(t.id))
  // 只有真正的歌单视图才有「移除」；最近播放/专辑/最常播放都不是歌单
  const inPlaylist = state.playlists.some((p) => p.id === state.view)

  const addPlItem = {
    label: '加入歌单', icon: 'plus', act: 'noop',
    sub: state.playlists.length
      ? state.playlists.map((p) => ({ label: p.name, act: 'add-pl', arg: p.id }))
      : [{ label: '（暂无歌单）', act: 'noop' }]
  }

  let items
  if (multi) {
    items = [
      { label: '已选 ' + targets.length + ' 首', act: 'noop' },
      { sep: true },
      { label: isFav ? '取消收藏' : '加入收藏', icon: 'heart', act: 'fav' },
      addPlItem
    ]
    if (inPlaylist) items.push({ label: '从此歌单移除', icon: 'trash', act: 'remove-pl', danger: true })
    items.push({ sep: true })
    // v3.3.17：这两项以前只作用于右键那一首，菜单却写着「已选 N 首」——
    // 现在按整批执行（见 handleCtxAction 的 reveal / copy 分支）
    items.push({ label: '在文件夹中显示', icon: 'folder', act: 'reveal' })
    items.push({ label: '复制歌曲信息', act: 'copy' })
  } else {
    items = [
      { label: '播放', icon: 'play', act: 'play' },
      { label: '下一首播放', icon: 'next', act: 'play-next' },
      { sep: true },
      { label: isFav ? '取消收藏' : '加入收藏', icon: 'heart', act: 'fav' },
      addPlItem
    ]
    if (inPlaylist) items.push({ label: '从此歌单移除', icon: 'trash', act: 'remove-pl', danger: true })
    items.push({ sep: true })
    const curGain = trackGainDb(track.id)
    const gainLabel = (db) => `${db > 0 ? '+' : ''}${db} dB${db === 0 ? '（重置）' : ''}` +
      (typeof db === 'number' && db === curGain && curGain !== 0 ? ' ✓' : '')
    items.push({
      label: `音量增益（当前 ${curGain > 0 ? '+' : ''}${curGain} dB）`, icon: 'volume', act: 'noop',
      sub: [-6, -3, -1.5, 0, 1.5, 3, 6].map((db) => ({ label: gainLabel(db), act: 'set-gain', arg: String(db) }))
    })
    items.push({ label: '在文件夹中显示', icon: 'folder', act: 'reveal' })
    items.push({ label: '复制歌曲信息', act: 'copy' })
  }

  // v2.8.26（追加清单 #5）：主题色入口进右键主菜单（logo 右键之外的第二个入口）
  if (typeof Theme !== 'undefined' && Theme.menuItems) {
    items.push({ label: '主题色', icon: 'spark', act: 'noop', sub: Theme.menuItems() })
  }

  UI.showContextMenu(x, y, items)
  currentMenuTrack = track
  currentMenuTracks = targets
}

let currentMenuTrack = null
let currentMenuTracks = []

async function handleCtxAction(act, arg) {
  // 全局动作（不依赖右键的曲目）
  switch (act) {
    case 'analyze-loudness':
      analyzeLibraryLoudness()
      return
    case 'set-lufs': {
      const v = parseInt(arg, 10)
      if (Number.isNaN(v)) return
      state.settings.targetLufs = v
      saveSettings({ targetLufs: v })
      toast(`目标响度：${v} LUFS（重新分析后生效）`)
      return
    }
    case 'clear-gains':
      clearAnalyzedGains()
      return
    case 'noop-audio-device':
      return
    case 'export-m3u':
      await exportM3uPlaylist(arg)
      return
    case 'delete-playlist':
      deletePlaylist(arg)
      return
    case 'rename-playlist':
      openRenameModal(arg)
      return
    case 'set-audio-device': {
      const name = arg || ''
      state.settings.audioDevice = name
      const r = await window.api.mpvSetDevice(name).catch((err) => ({ ok: false, error: err.message }))
      if (!r || !r.ok) toast('切换输出设备失败：' + ((r && r.error) || '未知错误'), 3000)
      else toast(r.applied ? '输出设备已切换' : '输出设备已保存（开启独占后生效）')
      return
    }
  }
  const track = currentMenuTrack
  if (!track) return
  switch (act) {
    case 'play':
      playFromVisible(track)
      break
    case 'play-next':
      player.addToQueue(track, { next: true })
      toast('已加入下一首播放')
      break
    case 'fav': {
      const targets = currentMenuTracks.length ? currentMenuTracks : [track]
      // 全已收藏 → 整批取消；否则只把没收藏的补上（v1.7 支持多选）
      const allFav = targets.every((t) => state.favorites.has(t.id))
      for (const t of targets) {
        if (allFav === state.favorites.has(t.id)) {
          const favs = await window.api.toggleFavorite(t.id)
          state.favorites = new Set(favs)
        }
      }
      updateNavCounts()
      if (state.currentId) UI.setFavorite(state.favorites.has(state.currentId))
      // v2.8.43：行内爱心就地翻状态 —— 否则要切视图/刷新才看得见（用户实报）
      UI.syncFavMarks(targets.map((t) => t.id), state.favorites)
      if (state.view === 'fav') renderView()
      toast(allFav
        ? '已取消收藏' + (targets.length > 1 ? ' ' + targets.length + ' 首' : '')
        : '已加入收藏' + (targets.length > 1 ? ' ' + targets.length + ' 首' : ''))
      break
    }
    case 'add-pl': {
      const ids = (currentMenuTracks.length ? currentMenuTracks : [track]).map((t) => t.id)
      let pl
      try { pl = await window.api.addToPlaylist(arg, ids) }
      catch (err) { toast('加入歌单失败：' + (err.message || err), 2500); break }
      if (pl) {
        const i = state.playlists.findIndex((p) => p.id === pl.id)
        if (i >= 0) state.playlists[i] = pl
        renderPlaylists()
        toast('已加入「' + pl.name + '」' + (ids.length > 1 ? ' ' + ids.length + ' 首' : ''))
      }
      break
    }
    case 'remove-pl': {
      const ids = (currentMenuTracks.length ? currentMenuTracks : [track]).map((t) => t.id)
      let pl
      try { pl = await window.api.removeFromPlaylist(state.view, ids) }
      catch (err) { toast('移除失败：' + (err.message || err), 2500); break }
      if (pl) {
        const i = state.playlists.findIndex((p) => p.id === pl.id)
        if (i >= 0) state.playlists[i] = pl
        renderPlaylists()
        clearSelection()
        renderView()
        toast('已从歌单移除' + (ids.length > 1 ? ' ' + ids.length + ' 首' : ''))
      }
      break
    }
    case 'reveal': {
      const list = (currentMenuTracks && currentMenuTracks.length ? currentMenuTracks : [track])
        .filter((t) => t.path)
      if (!list.length) { toast('在线曲目没有本地文件'); break }
      // 资源管理器定位一次只能定位一个，批量时逐个打开（上限 10，避免刷屏）
      for (const t of list.slice(0, 10)) window.api.showInFolder(t.path).catch(() => {})
      if (list.length > 10) toast('已定位前 10 个文件')
      break
    }
    case 'copy': {
      const list = (currentMenuTracks && currentMenuTracks.length ? currentMenuTracks : [track])
      const text = list.map((t) => `${t.title} - ${t.artist || ''}`.trim()).join('\n')
      navigator.clipboard.writeText(text).then(
        () => toast(list.length > 1 ? `已复制 ${list.length} 首` : '已复制'),
        () => toast('复制失败（剪贴板不可用）')
      )
      break
    }
    case 'set-gain': {
      if (eqBlocked()) { toast(EQ_BLOCKED_MSG); return }
      const db = parseFloat(arg)
      if (Number.isNaN(db)) return
      const manualGains = Object.assign({}, state.settings.manualGains || {})
      if (db === 0) delete manualGains[track.id]
      else manualGains[track.id] = db
      state.settings.manualGains = manualGains
      await window.api.patchSettings({ manualGains })
      if (state.currentId === track.id) applyTrackGain(track.id)
      toast(db === 0 ? '已重置该曲增益' : `「${track.title}」增益 ${db > 0 ? '+' : ''}${db} dB`)
      break
    }
  }
}

/* ================= 歌单改名（v2.7） ================= */

let renameTargetId = null

function openRenameModal(plId) {
  const pl = state.playlists.find((p) => p.id === plId)
  if (!pl) return
  renameTargetId = plId
  const input = document.getElementById('renameInput')
  input.value = pl.name
  document.getElementById('renameModal').hidden = false
  input.focus()
  input.select()
}

function closeRenameModal() {
  document.getElementById('renameModal').hidden = true
  renameTargetId = null
}

async function confirmRename() {
  const plId = renameTargetId
  if (!plId) return
  const name = document.getElementById('renameInput').value.trim()
  const pl = state.playlists.find((p) => p.id === plId)
  closeRenameModal()
  if (!pl || !name || name === pl.name) return
  let updated
  try { updated = await window.api.updatePlaylist(plId, { name }) }
  catch (err) { toast('重命名失败：' + (err.message || err), 2500); return }
  if (updated) {
    const i = state.playlists.findIndex((p) => p.id === plId)
    if (i >= 0) state.playlists[i] = updated
    renderPlaylists()
    if (state.view === plId) renderView()
    toast('已重命名为「' + name + '」')
  }
}

async function deletePlaylist(id) {
  // v3.3.17：删歌单是不可恢复操作（主进程只 filter 后落盘），右键菜单点一下就没。
  const pl = state.playlists.find((p) => p.id === id)
  const n = pl && Array.isArray(pl.trackIds) ? pl.trackIds.length : 0
  if (!window.confirm('删除歌单「' + (pl ? pl.name : '') + '」？' + (n ? '\n其中的 ' + n + ' 首歌曲不受影响，只是移出这个歌单。' : ''))) return
  await deletePlaylistConfirmed(id)
}

async function deletePlaylistConfirmed(id) {
  const pl = state.playlists.find((p) => p.id === id)
  if (!pl) return
  try { await window.api.removePlaylist(id) }
  catch (err) { toast('删除歌单失败：' + (err.message || err), 2500); return }
  state.playlists = state.playlists.filter((p) => p.id !== id)
  renderPlaylists()
  if (state.view === id) switchView('all')
  updateNavCounts()
  toast('已删除「' + pl.name + '」')
}

