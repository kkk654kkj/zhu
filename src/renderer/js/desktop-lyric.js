'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 桌面歌词 ================= */

let _dlKey = ''

/** 把当前歌词行推给桌面歌词窗口（内容没变就不发） */
function pushDesktopLyric(force) {
  const cfg = state.settings.desktopLyric
  if (!cfg || !cfg.enabled) return
  const t = player && player.current
  let line = ''
  let next = ''
  if (t) {
    const st = UI.lyricState
    if (!st.plain && st.lines.length) {
      const idx = st.index
      if (idx >= 0 && st.lines[idx]) line = st.lines[idx].text || ''
      // 还没进第一句时不要预告"下一句"（否则会拿 lines[-1] 之类的错行当预览）
      if (idx >= 0 && idx + 1 < st.lines.length && st.lines[idx + 1] && st.lines[idx + 1].t != null) {
        next = st.lines[idx + 1].text || ''
      }
    }
    if (!line) line = t.title + (t.artist ? ' — ' + t.artist : '')
  }
  const playing = !!(player && player.isPlaying)
  const key = (t ? t.id : '') + '|' + line + '|' + next + '|' + (playing ? 1 : 0)
  if (!force && key === _dlKey) return
  _dlKey = key
  window.api.dlyricState({
    line, next,
    title: t ? t.title : '',
    artist: t ? (t.artist || '') : '',
    playing
  }).catch(() => {})
}

/** 标题栏按钮语义：关着→打开；开着且锁定→解锁；开着未锁→关闭 */
async function toggleDesktopLyric() {
  try {
    if (await window.api.dlyricIsOpen()) {
      const cfg = state.settings.desktopLyric || {}
      if (cfg.locked) {
        state.settings.desktopLyric = await window.api.dlyricUnlock()
        toast('桌面歌词已解除锁定')
      } else {
        const prevCfg = state.settings.desktopLyric || {}
        await window.api.dlyricClose()
        // v3.3.17：渲染层配置也要落成 false —— 否则 pushDesktopLyric 的开关判定仍通过，
        // 关窗后每秒还在发 4~5 次 dlyricState IPC，直到重启应用。
        state.settings.desktopLyric = { ...prevCfg, enabled: false }
        // 第四轮 §4.3 #1：只改内存不够，必须落盘 —— 以前重启后读回 enabled:true，
        // 5~10Hz 的推送又开始了。写盘失败则回滚内存，别让界面与磁盘各说一套。
        const okSave = await window.api.patchSettings({ desktopLyric: { enabled: false } })
          .then(() => true, () => false)
        if (!okSave) {
          state.settings.desktopLyric = prevCfg
          toast('桌面歌词已关闭，但状态保存失败（重启后可能自动恢复）')
          return
        }
        toast('桌面歌词已关闭')
      }
    } else {
      state.settings.desktopLyric = await window.api.dlyricOpen()
      toast('桌面歌词已打开')
      pushDesktopLyric(true)
      // 窗口是异步加载的，首帧那次推送可能早于页面就绪；主进程会在就绪时补发，
      // 这里再补一次只是兜底（force=true 会绕过内容去重）
      setTimeout(() => { if (state.settings.desktopLyric && state.settings.desktopLyric.enabled) pushDesktopLyric(true) }, 420)
    }
  } catch (err) {
    console.error('[dlyric]', err)
  }
}

function setTracks(list) {
  state.tracks = list
  state.byId = new Map(list.map((t) => [t.id, t]))
  updateLibStat()
}

function updateLibStat() {
  const n = state.tracks.length
  if (!n) { UI.setLibStat('曲库为空'); return }
  const totalSec = state.tracks.reduce((a, t) => a + (t.duration || 0), 0)
  const h = Math.floor(totalSec / 3600)
  const m = Math.round((totalSec % 3600) / 60)
  UI.setLibStat(`${n} 首 · ${h ? h + ' 小时 ' : ''}${m} 分钟`)
}

function updateNavCounts() {
  const albumSet = new Set(state.tracks.map((t) => t.album || '未知专辑'))
  const dirSet = new Set(state.tracks.map((t) => t.dir || '').filter(Boolean))
  UI.renderNavCounts({
    all: state.tracks.length,
    fav: state.favorites.size,
    recent: state.history.length,
    added: countRecentlyAdded(),
    most: state.tracks.filter((t) => (state.playCounts[t.id] || 0) > 0).length,
    folders: dirSet.size,
    albums: albumSet.size
  })
}

/** 最近 7 天入库的数量（v1.9）：侧栏徽章用，和「最近添加」视图里的总数不是一回事 */
const RECENT_ADDED_DAYS = 7
function countRecentlyAdded(days = RECENT_ADDED_DAYS) {
  const since = Date.now() - days * 86400000
  let n = 0
  for (const t of state.tracks) if ((t.addedAt || 0) >= since) n++
  return n
}

/** 数值型排序键（v1.9 起统一判断，别再用 if (key === 'duration') 一个个加） */
const NUMERIC_SORT_KEYS = new Set(['duration', 'quality', 'sampleRate', 'bitsPerSample', 'bitrate', 'addedAt', 'year'])
/** 首次点击就用降序的列 */
const SORT_DESC_FIRST = new Set(['quality', 'addedAt'])

function renderPlaylists() {
  UI.renderPlaylists(state.playlists)
  const builtin = ['all', 'fav', 'recent', 'added', 'most', 'albums', 'folders']
  if (state.view.startsWith('folder:')) UI.setActiveNav('folders')
  else if (!builtin.includes(state.view)) UI.setActiveNav(state.view)
}

/** 批量加入歌单（拖拽、右键都用它），本地状态与界面同步刷新 */
async function addTracksToPlaylist(plId, trackIds) {
  if (!plId || !trackIds || !trackIds.length) return
  // v3.3.17：不要在这里吞异常 —— dragdrop 的拖放回调已经包了 try/catch 想给提示，
  // 内部 .catch(() => null) 会让那个兜底永远收不到错误，表现是「拖过去毫无反应」。
  const pl = await window.api.addToPlaylist(plId, trackIds)
  if (!pl) return
  const i = state.playlists.findIndex((p) => p.id === pl.id)
  if (i >= 0) state.playlists[i] = pl
  renderPlaylists()
  // 正在看这个歌单时刷新表格，否则刚加进去的歌看不到
  if (state.view === pl.id) renderView()
  toast('已加入「' + pl.name + '」' + (trackIds.length > 1 ? ' ' + trackIds.length + ' 首' : ''))
}

// m3u 导入导出见 js/m3u.js（importM3uPlaylist / exportM3uPlaylist）

