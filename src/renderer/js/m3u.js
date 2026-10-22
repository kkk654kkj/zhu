'use strict'
/**
 * m3u / m3u8 歌单导入导出（v1.6）
 *
 * 渲染层拿不到文件的真实路径（ClientTrack 只有 lxfile:// URL），
 * 所以路径映射与文件读写全部在主进程做，这里只负责交互与状态同步。
 */

/** 导入：主进程把路径映射成 trackId，这里建歌单 */
async function importM3uPlaylist() {
  const res = await window.api.importM3u().catch((err) => ({ ok: false, error: err.message }))
  if (!res || !res.ok) {
    if (res && res.error) toast('导入失败：' + res.error, 3000)
    return
  }
  if (!res.trackIds || !res.trackIds.length) {
    toast(res.unmatched
      ? '没有匹配到曲库里的歌曲（' + res.unmatched + ' 条路径不在库中）'
      : '这个歌单是空的', 3500)
    return
  }
  const pl = await window.api.createPlaylist(res.name || '导入的歌单')
  const full = await window.api.addToPlaylist(pl.id, res.trackIds).catch(() => null)
  const saved = full || pl
  state.playlists.push(saved)
  renderPlaylists()
  switchView(saved.id)
  toast('已导入「' + saved.name + '」' + res.trackIds.length + ' 首' +
    (res.unmatched ? '（' + res.unmatched + ' 条未匹配）' : ''), 3500)
}

/** 导出：真实路径由主进程按 id 反查 */
async function exportM3uPlaylist(plId) {
  const pl = state.playlists.find((p) => p.id === plId)
  if (!pl) return
  if (!pl.trackIds || !pl.trackIds.length) { toast('歌单是空的'); return }
  const res = await window.api.exportM3u(pl.name, pl.trackIds)
    .catch((err) => ({ ok: false, error: err.message }))
  if (!res || !res.ok) {
    if (res && res.error) toast('导出失败：' + res.error, 3000)
    return
  }
  toast('已导出 ' + res.count + ' 首到 ' + res.filePath, 4000)
}
