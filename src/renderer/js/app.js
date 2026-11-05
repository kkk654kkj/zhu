'use strict'
/* 应用主控：状态、视图切换、交互接线 */

const state = {
  tracks: [],            // 全部曲目（client 结构）
  byId: new Map(),
  favorites: new Set(),
  history: [],           // [{id, at}]
  playlists: [],
  playCounts: {},
  settings: {},
  view: 'all',           // all | fav | recent | albums | album:<name> | <playlistId>
  query: '',
  sortKey: 'default',
  sortDir: 'asc',
  visible: [],           // 当前视图可见曲目
  currentId: null,
  lyricCache: new Map(),
  lyricOffset: 0,
  counted: false,
  mini: false,           // 迷你模式（窗口尺寸由主进程管，这里管布局）
  exclusive: false,      // 独占输出（mpv 后端）是否生效
  resumePos: {},         // 长音轨断点位置 {trackId: 秒}（v1.6）
  restoringSession: false,// 正在恢复上次会话（此时不要叠加断点续播）
  selected: new Set(),   // 列表多选（v1.7）
  selAnchor: null,       // Shift 范围选的起点下标
  onlineFails: 0,        // 在线曲目连续播放失败次数（防连跳）
  sessionTimer: null
}

let player = null
let audio = null

/* ================= 启动 ================= */

async function boot() {
  UI.init()

  // 上次退出时是迷你模式 → 先在界面侧切好布局，别让 320px 宽的窗口里闪一下完整界面
  state.mini = await window.api.isMini().catch(() => false)
  UI.setMini(state.mini)

  // 主进程若正在建库，lib:list 会等它结束；超时先给个遮罩，避免空等白屏
  const slowTimer = setTimeout(() => UI.showScan('正在载入音乐库…'), 400)

  const [settings, tracks, favs, hist, playlists, counts, session] = await Promise.all([
    window.api.getSettings(),
    window.api.listTracks(),
    window.api.getFavorites(),
    window.api.getHistory(),
    window.api.getPlaylists(),
    window.api.getPlayCounts(),
    window.api.getSession()
  ])
  clearTimeout(slowTimer)
  UI.hideScan()

  state.settings = settings
  state.resumePos = Object.assign({}, (settings && settings.resumePos) || {})
  state.favorites = new Set(favs || [])
  state.history = hist || []
  state.playlists = playlists || []
  state.playCounts = counts || {}
  state.lyricOffset = settings.lyricOffset || 0

  applySettings()

  // 引擎选择（v1.5）：独占输出走 mpv + WASAPI exclusive，其余情况仍是原来的 HTML5 + WebAudio
  let exclusiveOK = false
  if (settings.exclusiveOutput === true) {
    const r = await window.api.mpvStart(true).catch((err) => ({ ok: false, error: err && err.message }))
    if (r && r.ok) {
      exclusiveOK = true
      audio = new MpvAudio({ volume: settings.volume ?? 0.8 })
      audio.addEventListener('formatchange', updateHifiBadge)
      audio.addEventListener('fallback', () => {
        toast('独占输出失败，已回退共享输出（不再是位完美）')
        updateHifiBadge()
      })
      audio.addEventListener('error', () => {
        if (audio.lastError) toast(audio.lastError)
      })
    } else {
      state.settings.exclusiveOutput = false
      window.api.patchSettings({ exclusiveOutput: false }).catch(() => {})
      toast('独占输出启动失败：' + ((r && r.error) || '未知错误') + '（已改用普通输出）')
    }
  }
  state.exclusive = exclusiveOK
  if (!exclusiveOK) {
    audio = new Audio()
    audio.preload = 'auto'
  }

  player = new Player(audio, {
    volume: settings.volume ?? 0.8,
    muted: settings.muted ?? false,
    fadeMs: exclusiveOK ? 0 : (settings.fadeMs ?? 350)
  })

  UI.initEq()
  if (exclusiveOK) {
    // 独占模式下 EQ / 音量均衡 / 频谱全部禁用：任何软件处理都会破坏位完美
    UI.setEqDisabled(true)
    UI.setSpectrumVisible(false)
  } else {
    // 音量均衡：把 <audio> 接进 WebAudio（source → gain → EQ ×10 → analyser → 输出）
    setupAudioGraph()
    // 均衡器界面 + 频谱（音频链失败时 initEq 仍渲染，只是不生效）
    applyEq(eqSettings(), { persist: false })
    if (AudioFx.analyser) AudioFx.startSpectrum(UI.els.spectrum)
  }

  setTracks(tracks || [])

  bindPlayer()
  bindUI()
  bindDirModal()
  bindGlobalKeys()
  if (typeof Diag !== 'undefined') Diag.init()   // v1.8 诊断面板

  // v2.1：Windows 媒体控制（锁屏/音量浮层/硬件媒体键）
  initMediaSession()
  updateAbUi()
  window.api.onPowerAction((p) => {
    if (p && p.kind) showPowerCountdown(p.kind, p.delay || 15)
    else { clearInterval(powerCountdownTimer); powerCountdownTimer = null }
  })
  window.api.onDeviceLost((p) => {
    if (!p) return
    if (p.restored) toast('输出设备已接回：' + p.device + '（独占已自动切回）', 4000)
    else toast('输出设备已断开：' + p.device + '\n已切回系统默认设备（独占仍在）', 5000)
    updateHifiBadge()
  })

  UI.setVolume(player.volume, player.muted)
  UI.setMode(player.mode)
  UI.setLyricOffset(state.lyricOffset)
  UI.setLyricPanelVisible(settings.showLyricPanel !== false)
  UI.setNorm(settings.normalizeVolume === true)
  updateHifiBadge()
  window.api.dlyricIsOpen().then((open) => {
    UI.setDLyric(open, open && settings.desktopLyric && settings.desktopLyric.locked)
  })
  // 歌词窗口那边改了锁定/自行关闭，主进程会推最新状态过来
  window.api.onDlyricOpenState((st) => {
    const open = st && typeof st === 'object' ? !!st.open : !!st
    const locked = st && typeof st === 'object' ? !!st.locked : false
    if (typeof st === 'object' && st.locked !== undefined) {
      state.settings.desktopLyric = { ...(state.settings.desktopLyric || {}), locked: !!st.locked }
    }
    UI.setDLyric(open, open && locked)
  })
  updateNavCounts()
  renderPlaylists()

  // 恢复上次会话（不自动播放）
  if (session && Array.isArray(session.queueIds) && session.queueIds.length) {
    const queue = session.queueIds.map((id) => state.byId.get(id)).filter(Boolean)
    if (queue.length) {
      state.restoringSession = true
      player.setQueue(queue, session.index || 0, false)
      state.restoringSession = false
      player.mode = session.mode || 'list'
      UI.setMode(player.mode)
      if (session.currentTime) {
        audio.addEventListener('loadedmetadata', () => {
          try { audio.currentTime = session.currentTime } catch {}
        }, { once: true })
      }
    }
  }

  switchView('all')

  if (!state.tracks.length) {
    UI.showEmpty('曲库为空，先扫描音乐文件夹')
    setTimeout(() => doScan(), 300)
  }

  window.api.onScanProgress(onScanProgress)
  window.api.onScanDone(onScanDone)
  window.api.onShortcut((action) => handleShortcut(action))
  // 睡眠定时到点：player.pause() 会走正常的淡出，不会突然静音（v1.7）
  window.api.onSleepTimer(() => {
    if (player && player.isPlaying) player.pause()
    toast('睡眠定时已到，播放已暂停', 4000)
  })
  // 睡眠定时状态（v2.2：入口从托盘移到 app 内播放条）
  window.api.getSleepState().then((st) => renderSleepState(st))
  window.api.onSleepState((st) => renderSleepState(st))
  // 托盘/快捷键改迷你状态时，主进程会推过来，界面跟着切
  window.api.onMiniState((st) => {
    state.mini = !!(st && st.mini !== undefined ? st.mini : st)
    UI.setMini(state.mini)
  })

  window.addEventListener('beforeunload', saveSession)
  setInterval(saveSession, 10000)

  document.getElementById('btnMax').innerHTML = icon(window.api.isMaximized ? 'restore' : 'max')
}

/** 当前曲目的歌词偏移（v1.7）：优先本曲设置，没有则用全局默认 */
function offsetFor(id) {
  const map = (state.settings && state.settings.lyricOffsetById) || {}
  if (id && map[id] != null) return Number(map[id]) || 0
  return Number(state.settings && state.settings.lyricOffset) || 0
}

/* ================= 睡眠定时（v2.2：入口从托盘移到 app 内播放条） ================= */

const sleepUi = { minutes: 0, endsAt: null, tick: null }

/** 主进程推来的最新定时状态 → 刷新按钮高亮 / 选项勾选 / 倒计时 */
function renderSleepState(st) {
  sleepUi.minutes = (st && Number(st.minutes)) || 0
  sleepUi.endsAt = (st && st.endsAt) || null
  document.getElementById('btnSleep').classList.toggle('active', sleepUi.minutes > 0)
  document.querySelectorAll('#sleepOpts .sp-chip').forEach((chip) => {
    chip.classList.toggle('on', Number(chip.dataset.min) === sleepUi.minutes)
  })
  updateSleepCountdown()
  clearInterval(sleepUi.tick)
  if (sleepUi.minutes > 0) sleepUi.tick = setInterval(updateSleepCountdown, 1000)
}

function updateSleepCountdown() {
  const el = document.getElementById('sleepCount')
  if (!sleepUi.minutes || !sleepUi.endsAt) {
    el.textContent = '未设置'
    el.classList.add('off')
    return
  }
  el.classList.remove('off')
  const left = Math.max(0, Math.round((sleepUi.endsAt - Date.now()) / 1000))
  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  const s = left % 60
  el.textContent = h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0')
}

function toggleSleepPanel(show) {
  const panel = document.getElementById('sleepPanel')
  const target = show === undefined ? panel.hidden : !!show
  panel.hidden = !target
  if (target) updateSleepCountdown()
}

/* ================= 列表多选（v1.7） ================= */

function paintSelection() {
  document.querySelectorAll('#tableBody .tr').forEach((row) => {
    row.classList.toggle('selected', state.selected.has(row.dataset.id))
  })
  // 多选工具条（v2.6）：有选中才浮现
  const bar = document.getElementById('selBar')
  const n = state.selected.size
  bar.hidden = n === 0
  document.getElementById('selCount').textContent = '已选 ' + n + ' 首'
}

function clearSelection() {
  if (!state.selected.size && state.selAnchor == null) return
  state.selected.clear()
  state.selAnchor = null
  paintSelection()
}

function toggleSelection(id, index) {
  if (state.selected.has(id)) state.selected.delete(id)
  else state.selected.add(id)
  state.selAnchor = index
  paintSelection()
}

/** Shift 范围选：从上一次点击处到当前行（含两端） */
function selectRange(index) {
  const from = state.selAnchor == null ? index : state.selAnchor
  const [a, b] = from <= index ? [from, index] : [index, from]
  for (let i = a; i <= b; i++) {
    const t = state.visible[i]
    if (t) state.selected.add(t.id)
  }
  paintSelection()
}

/** 当前选中的曲目（右键批量操作 / 拖拽用） */
function selectedTracks() {
  return Array.from(state.selected).map((id) => state.byId.get(id)).filter(Boolean)
}

function applySettings() {
  const s = state.settings
  if (s.lyricFontSize) UI.setLyricFontSize(s.lyricFontSize)
  if (s.accent) document.documentElement.style.setProperty('--accent', s.accent)
  player && player.setFadeMs(s.fadeMs ?? 350)
}

/* ================= 音量均衡 / 均衡器 ================= */

/**
 * 把 audio 元素接进 WebAudio（链路由 audiofx.js 建：source → trackGain → preamp
 * → 10×BiquadFilter → analyser → destination）。失败则全程原声，功能降级不影响播放。
 */
function setupAudioGraph() {
  const ok = AudioFx.init(audio)
  if (!ok) toast('音频特效不可用，将以原声播放')
  return ok
}

/** 当前曲目应施加的增益（dB）：手动优先，其次按开关取分析值 */
function trackGainDb(id) {
  if (!id) return 0
  const s = state.settings
  const manual = s.manualGains && s.manualGains[id]
  if (typeof manual === 'number') return Math.max(-20, Math.min(20, manual))
  if (s.normalizeVolume) {
    const g = s.trackGains && s.trackGains[id]
    if (typeof g === 'number') return Math.max(-20, Math.min(20, g))
    // v2.0：没有分析数据就用文件自带的 ReplayGain 标签。
    // 分析结果优先于标签——分析是按你这套目标响度（targetLufs）算的，更贴合，
    // 标签是别人写的、目标响度不一定和这里一致
    const t = state.byId.get(id)
    if (t && typeof t.rgTrackDb === 'number') return Math.max(-20, Math.min(20, t.rgTrackDb))
  }
  return 0
}

function applyTrackGain(id) {
  AudioFx.setTrackGain(trackGainDb(id))
}

/* ---------------- 均衡器 / 频谱 ---------------- */

function eqSettings() {
  const s = state.settings.eq
  return {
    enabled: !!(s && s.enabled),
    preset: (s && s.preset) || 'flat',
    bands: s && Array.isArray(s.bands) && s.bands.length === EQ_FREQS.length
      ? s.bands.slice()
      : EQ_PRESETS.flat.bands.slice()
  }
}

/** 应用 EQ 设置到音频链 + 刷新界面 + 落盘（落盘可关） */
function applyEq(cfg, { persist = true } = {}) {
  const next = {
    enabled: cfg.enabled !== undefined ? !!cfg.enabled : eqSettings().enabled,
    preset: cfg.preset !== undefined ? cfg.preset : eqSettings().preset,
    bands: cfg.bands !== undefined ? cfg.bands.slice() : eqSettings().bands
  }
  state.settings.eq = next
  AudioFx.applyEq(next)
  UI.renderEq(next)
  if (persist) saveSettings({ eq: next })
}

function setEqBand(index, value) {
  const cfg = eqSettings()
  cfg.bands[index] = Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, Number(value) || 0))
  // 手改滑块 = 自定义，取消预设高亮（除非数值刚好等于某个预设）
  const match = Object.entries(EQ_PRESETS).find(([, p]) => p.bands.every((v, i) => v === cfg.bands[i]))
  cfg.preset = match ? match[0] : 'custom'
  // 一动滑块就自动开启，否则用户拖了没反应
  cfg.enabled = true
  applyEq(cfg)
}

function applyEqPreset(key) {
  const p = EQ_PRESETS[key]
  if (!p) return
  applyEq({ enabled: true, preset: key, bands: p.bands.slice() })
  toast('音效：' + p.label)
}

/** 是否已有可用分析数据 */
function hasAnalyzedGains() {
  const g = state.settings.trackGains
  return !!g && Object.keys(g).length > 0
}

/**
 * 曲库响度分析：逐首解码 → BS.1770 近似响度 → 增益写回 settings.trackGains。
 * Esc 可中断。ape/wma/dsf 等解码器不支持的格式自动跳过。
 */
async function analyzeLibraryLoudness() {
  if (state.analyzing) { toast('正在分析中…'); return }
  const all = state.tracks
  const byExt = all.filter((t) => LOUDNESS_OK_EXT.has((t.ext || '').toLowerCase()))
  // v2.0：带 ReplayGain 标签的直接跳过——标签就是别人算好的响度，
  // 再花几分钟解一遍纯属浪费（用户想覆盖时可以先用「清除分析数据」）
  const tagCount = byExt.filter((t) => typeof t.rgTrackDb === 'number').length
  const list = byExt.filter((t) => typeof t.rgTrackDb !== 'number')
  const skipped = all.length - list.length
  if (!list.length) {
    toast(tagCount ? `所有可分析曲目都自带 ReplayGain 标签（${tagCount} 首），无需分析` : '曲库里没有可分析的格式', 3000)
    return
  }

  state.analyzing = true
  state.abortAnalysis = false
  UI.showScan('正在分析响度…')
  const target = state.settings.targetLufs || LUFS_DEFAULT_TARGET
  const gains = Object.assign({}, state.settings.trackGains || {})
  let done = 0
  let failed = 0
  try {
    for (const t of list) {
      if (state.abortAnalysis) break
      UI.updateScan({ phase: 'parse', done, total: list.length, name: t.title, label: '正在分析响度' })
      try {
        const r = await analyzeLoudness(t.audio, target)
        gains[t.id] = r.gain
      } catch (err) {
        failed++
        console.warn('[loudness] 跳过', t.title, err && err.message)
      }
      done++
      // 给 UI 喘口气，也让 GC 有机会回收解码缓冲
      await new Promise((r) => setTimeout(r, 20))
    }
    state.settings.trackGains = gains
    await window.api.patchSettings({ trackGains: gains })
    applyTrackGain(state.currentId)
    if (state.abortAnalysis) toast('响度分析已中断（已完成部分已保存）')
    else toast(`响度分析完成：${done} 首` +
      (skipped ? `，跳过 ${skipped} 首（无解码器 / 自带 ReplayGain）` : '') +
      (failed ? `，${failed} 首失败` : '') +
      (tagCount ? `，${tagCount} 首直接用标签` : ''), 4000)
  } catch (err) {
    console.error('[loudness]', err)
    toast('响度分析失败：' + (err && err.message))
  } finally {
    state.analyzing = false
    UI.hideScan()
  }
}

function clearAnalyzedGains() {
  state.settings.trackGains = {}
  window.api.patchSettings({ trackGains: {} })
  applyTrackGain(state.currentId)
  toast('已清除响度分析数据')
}

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
        await window.api.dlyricClose()
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
  const pl = await window.api.addToPlaylist(plId, trackIds).catch(() => null)
  if (!pl) return
  const i = state.playlists.findIndex((p) => p.id === pl.id)
  if (i >= 0) state.playlists[i] = pl
  renderPlaylists()
  toast('已加入「' + pl.name + '」' + (trackIds.length > 1 ? ' ' + trackIds.length + ' 首' : ''))
}

// m3u 导入导出见 js/m3u.js（importM3uPlaylist / exportM3uPlaylist）

/* ================= 视图 ================= */

function computedList() {
  let list = []

  if (state.view === 'all') list = state.tracks.slice()
  else if (state.view === 'fav') list = Array.from(state.favorites).map((id) => state.byId.get(id)).filter(Boolean)
  else if (state.view === 'recent') {
    list = state.history.map((h) => state.byId.get(h.id)).filter(Boolean)
  } else if (state.view === 'added') {
    // 最近添加（v1.9）：全部曲目按入库时间倒序，新歌永远在最上面。
    // 不设时间窗口——窗口会让"上个月整理的那批歌"凭空消失，用户只会觉得是 bug
    list = state.tracks.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
  } else if (state.view === 'most') {
    // 最常播放（v1.7）：只列有播放记录的，按次数降序
    list = state.tracks
      .filter((t) => (state.playCounts[t.id] || 0) > 0)
      .sort((a, b) => (state.playCounts[b.id] || 0) - (state.playCounts[a.id] || 0))
  } else if (state.view === 'folders') {
    list = []   // 目录网格自渲染，不走表格
  } else if (state.view.startsWith('folder:')) {
    const dir = state.view.slice(7)
    list = state.tracks.filter((t) => (t.dir || '') === dir)
  } else if (state.view.startsWith('album:')) {
    const name = state.view.slice(6)
    list = state.tracks.filter((t) => (t.album || '未知专辑') === name)
  } else {
    const pl = state.playlists.find((p) => p.id === state.view)
    if (pl) list = pl.trackIds.map((id) => state.byId.get(id)).filter(Boolean)
  }

  if (state.query) list = list.filter((t) => matchQuery(t, state.query))

  if (state.sortKey !== 'default') {
    const key = state.sortKey
    const dir = state.sortDir === 'asc' ? 1 : -1
    // 音质排序（v1.9）：先采样率、再位深。同一采样率下 24bit 排在 16bit 前面，
    // 这样"按音质排"= 直接把真高清顶到最上面，不用在两列之间来回点
    const pick = (t) => (key === 'quality'
      ? (t.sampleRate || 0) * 100 + (t.bitsPerSample || 0)
      : t[key])
    const numeric = NUMERIC_SORT_KEYS.has(key)
    list.sort((a, b) => {
      let va = pick(a)
      let vb = pick(b)
      if (numeric) { va = Number(va) || 0; vb = Number(vb) || 0 }
      else {
        va = String(va || '').toLowerCase()
        vb = String(vb || '').toLowerCase()
      }
      if (va < vb) return -1 * dir
      if (va > vb) return 1 * dir
      return 0
    })
  }

  return list
}

function switchView(view) {
  state.view = view
  UI.setActiveNav(view)
  renderView()
}

function renderView() {
  clearSelection()          // 列表重建后旧选中已失效
  // 在线搜索是独立面板：不复用本地表格（列不一样，多出「音源 / 下载」）
  const isOnline = state.view === 'online'
  document.getElementById('viewHeader').hidden = isOnline
  document.getElementById('onlinePane').hidden = !isOnline
  if (isOnline) {
    UI.renderTableHeadVisible(false)
    UI.renderTable([])
    UI.hideEmpty()
    // hideEmpty 会把 tableBody 显示出来，所以必须放在它后面：
    // tableBody 是 flex:1，不隐藏的话会把在线面板挤到下面（顶部一大片空白）
    document.getElementById('tableBody').hidden = true
    Online.init().then(() => {
      Online.render()
      if (!Online.list.length) {
        const inp = document.getElementById('opInput')
        if (inp) inp.focus()
      }
    })
    return
  }
  const list = computedList()
  state.visible = list

  if (state.view === 'albums') {
    const map = new Map()
    for (const t of state.tracks) {
      const name = t.album || '未知专辑'
      if (!map.has(name)) map.set(name, { name, count: 0, cover: null, artist: t.artist })
      const a = map.get(name)
      a.count++
      if (!a.cover && t.cover) a.cover = t.cover
    }
    const albums = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    UI.renderHeader({
      title: '专辑',
      sub: albums.length + ' 张专辑',
      cover: null,
      showPlayAll: false,
      showRemove: false,
      isAlbum: true
    })
    UI.renderTableHeadVisible(false)
    UI.hideEmpty()
    UI.renderAlbumGrid(albums, (name) => switchView('album:' + name))
    return
  }

  if (state.view === 'folders') {
    // 按所在目录分组（v1.7）：本地曲库标签常常不全，按文件夹找歌是最可靠的兜底
    const map = new Map()
    for (const t of state.tracks) {
      const dir = t.dir || ''
      if (!dir) continue
      if (!map.has(dir)) map.set(dir, { dir, name: dir.split(/[\\/]/).pop() || dir, count: 0, cover: null })
      const g = map.get(dir)
      g.count++
      if (!g.cover && t.cover) g.cover = t.cover
    }
    const groups = Array.from(map.values()).sort((a, b) => a.dir.localeCompare(b.dir, 'zh'))
    UI.renderHeader({
      title: '文件夹',
      sub: groups.length + ' 个目录',
      cover: null,
      showPlayAll: false,
      showRemove: false,
      isAlbum: true
    })
    UI.renderTableHeadVisible(false)
    if (!groups.length) {
      UI.renderTable([])
      UI.showEmpty('曲库为空，先扫描音乐文件夹')
      return
    }
    UI.hideEmpty()
    UI.renderFolderGrid(groups, (dir) => switchView('folder:' + dir))
    return
  }

  UI.renderTableHeadVisible(true)

  if (state.view.startsWith('album:')) {
    const name = state.view.slice(6)
    UI.renderHeader({
      title: name,
      sub: `${list.length} 首 · ${list[0] ? list[0].artist : ''}`,
      cover: list[0] ? list[0].cover : null,
      showPlayAll: true,
      showRemove: false,
      isAlbum: true
    })
  } else if (state.view === 'all') {
    UI.renderHeader({
      title: '全部音乐', sub: `${list.length} 首歌曲`, cover: null,
      showPlayAll: true, showRemove: false
    })
  } else if (state.view === 'fav') {
    UI.renderHeader({
      title: '我的收藏', sub: `${list.length} 首歌曲`, cover: null,
      showPlayAll: true, showRemove: false
    })
  } else if (state.view === 'recent') {
    UI.renderHeader({
      title: '最近播放', sub: `${list.length} 首歌曲`, cover: null,
      showPlayAll: true, showRemove: false
    })
  } else if (state.view === 'added') {
    const recent = countRecentlyAdded()
    UI.renderHeader({
      title: '最近添加',
      sub: `共 ${list.length} 首 · 最近 ${RECENT_ADDED_DAYS} 天新增 ${recent} 首（按入库时间倒序）`,
      cover: null, showPlayAll: true, showRemove: false
    })
  } else if (state.view === 'most') {
    UI.renderHeader({
      title: '最常播放', sub: `${list.length} 首歌曲（按播放次数）`, cover: null,
      showPlayAll: true, showRemove: false
    })
  } else if (state.view.startsWith('folder:')) {
    const dir = state.view.slice(7)
    UI.renderHeader({
      title: dir.split(/[\\/]/).pop() || dir,
      sub: `${list.length} 首歌曲`,
      cover: list[0] ? list[0].cover : null,
      showPlayAll: list.length > 0,
      showRemove: false,
      isAlbum: true
    })
  } else {
    const pl = state.playlists.find((p) => p.id === state.view)
    UI.renderHeader({
      title: pl ? pl.name : '歌单',
      sub: `${list.length} 首歌曲`,
      cover: list[0] ? list[0].cover : null,
      showPlayAll: list.length > 0,
      showRemove: true,
      isAlbum: true
    })
  }

  if (!list.length) {
    const msg = state.query ? '没有匹配的歌曲'
      : state.view === 'fav' ? '还没有收藏歌曲'
        : state.view === 'recent' ? '还没有播放记录'
          : state.view === 'added' ? '曲库为空，先扫描音乐文件夹'
            : state.view === 'most' ? '还没有播放记录'
              : state.tracks.length ? '这里还没有歌曲' : '曲库为空，先扫描音乐文件夹'
    UI.renderTable([], { currentId: state.currentId })
    UI.showEmpty(msg)
    return
  }

  UI.hideEmpty()
  UI.renderTable(list, {
    currentId: state.currentId,
    playing: player && player.isPlaying,
    favorites: state.favorites,
    playCounts: state.playCounts,
    showCounts: state.view === 'most',   // 只在「最常播放」里显示次数，其他视图不挤
    sortKey: state.sortKey,
    sortDir: state.sortDir
  })
}

/* ================= 播放接线 ================= */

function bindPlayer() {
  player.on('track-change', (track) => {
    state.currentId = track.id
    state.counted = false
    state.onlineFails = 0          // 能切到这首说明上一首没失败
    if (track.online) Online.markPlaying(track.id)
    resetAb()                       // A-B 是"这一首之内"的事，换歌就作废
    updateMediaSession(track)
    applyTrackGain(track.id)
    UI.renderNowPlaying(track, player.isPlaying)
    UI.setPlayIcon(player.isPlaying)
    UI.setFavorite(state.favorites.has(track.id))
    UI.setRowPlaying(track.id, true)
    loadLyric(track)
    window.api.addHistory(track.id)
    state.history = [{ id: track.id, at: Date.now() }]
      .concat(state.history.filter((h) => h.id !== track.id)).slice(0, 300)
    updateNavCounts()
    if (state.view === 'recent') renderView()
    UI.renderQueue(player.tracks, player.index, state.currentId)
    // 换曲后切成这首歌自己的歌词偏移（v1.7）
    state.lyricOffset = offsetFor(track.id)
    UI.setLyricOffset(state.lyricOffset)
    // 换曲后音频参数会变（96k / 44.1k 等），清掉旧标签等 mpv 重新上报
    if (state.exclusive) { audio.format = null; updateHifiBadge() }
    restoreResumePos(track)
  })

  // 切走上一首时把位置记下来（比 10 秒一次的定时保存更准）
  player.on('track-leave', (prev, pos) => {
    if (prev) rememberResume(prev.id, pos)
  })

  player.on('state-change', (playing) => {
    UI.setPlayIcon(playing)
    if (player.current) UI.renderNowPlaying(player.current, playing)
    UI.renderQueue(player.tracks, player.index, state.currentId)
    pushDesktopLyric()
    if (!playing) saveSession()
    // 任务栏缩略图的播放/暂停按钮要跟着变
    window.api.setPlayState(playing)
    syncMediaSessionState(playing)
    // 独占模式下 mpv 不是 <audio>，得另外挂一条静音流让 Windows 上出现媒体会话
    keepAliveMediaSession(playing)
  })

  player.on('time', (cur, dur) => {
    UI.setProgress(cur, dur)
    UI.updateLyricIndex(cur + state.lyricOffset)
    pushDesktopLyric()
    enforceAbLoop(cur)
    if (state.ab.a != null) updateAbUi()
    updateMediaPosition(cur, dur)
    // 播放到 30s 或一半计入播放次数
    if (!state.counted && player.current) {
      const half = dur > 60 ? dur * 0.5 : 30
      if (cur >= Math.min(half, dur * 0.9)) {
        state.counted = true
        const id = player.current.id
        window.api.incPlayCount(id).then((n) => {
          state.playCounts[id] = n
          // 正在看「最常播放」时顺序会变，立即重排
          if (state.view === 'most') renderView()
        })
      }
    }
  })

  // 整队播完（v2.1）：交给主进程决定要不要关机/休眠
  player.on('queue-end', () => window.api.notifyQueueEnd())

  player.on('mode-change', (mode) => {
    UI.setMode(mode)
    toast(MODE_LABEL[mode])
    saveSettings({ playMode: mode })
  })

  player.on('queue-change', (tracks, index) => {
    UI.renderQueue(tracks, index, state.currentId)
  })

  player.on('vol-change', (v, muted) => {
    UI.setVolume(v, muted)
    saveSettings({ volume: v, muted })
    if (state.exclusive) updateHifiBadge()
    // 音量面板开着时实时同步（拖主音量条 / 媒体键改音量，面板数字跟着走）
    if (!document.getElementById('audioPanel').hidden) paintExclusiveVolume()
  })

  player.on('error', () => {
    const cur = player.current
    // 在线曲目失败和本地文件不同：多半是版权/直链失效，跳过才有意义。
    // 但不能无脑连跳——连跳 3 首就停，否则一路把搜索结果的队列跳光。
    if (cur && cur.online) {
      state.onlineFails = (state.onlineFails || 0) + 1
      if (state.onlineFails >= 3) {
        state.onlineFails = 0
        toast('连续多首在线歌曲无法播放，已停止自动跳过（试试换音源）', 4000)
        player.pause()
        return
      }
      toast('这首在线歌曲放不出来（版权或音源失效），已跳过', 2500)
      setTimeout(() => player.next(true), 500)
      return
    }
    state.onlineFails = 0
    // 独占模式下多半是声卡/引擎问题（设备被占用、格式不支持），不是这个文件坏了：
    // 此时绝不能自动跳曲，否则会一路把整个队列跳完
    if (state.exclusive) {
      toast('音频输出失败：' + ((audio && audio.lastError) || '设备不可用，已暂停'))
      player.pause()
      return
    }
    // DSD（v2.0）：普通输出（Chromium）没有 DSD 解码器，报错信息必须说清楚原因，
    // 否则用户只会以为文件坏了
    toast(cur && cur.isDsd
      ? 'DSD 文件需要独占输出才能播放：点标题栏波形按钮开启（已跳过）'
      : '该歌曲无法播放，已跳过', cur && cur.isDsd ? 4000 : 1800)
    setTimeout(() => player.next(true), 400)
  })
}

function playFromVisible(track) {
  // DSD 在普通输出下必然失败，直接拦下来给明确提示，别让它先播报错再跳曲
  if (track && track.isDsd && !state.exclusive) {
    toast('DSD（' + fmtQuality(track) + '）需要独占输出：点标题栏波形按钮开启后再放', 4000)
    return
  }
  const idx = state.visible.findIndex((t) => t.id === track.id)
  player.setQueue(state.visible, idx >= 0 ? idx : 0, true)
}

function shuffleAll() {
  const list = state.visible.slice()
  if (!list.length) return
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  player.setMode('shuffle')
  player.setQueue(list, 0, true)
}

/* ================= 独占输出（WASAPI 位完美） ================= */

/** mpv 的 audio-out-params → 简短标签，如 44.1k/16bit */
function audioFormatLabel(f) {
  if (!f || !f.samplerate) return ''
  const sr = Number(f.samplerate)
  const kHz = (sr / 1000).toFixed(sr % 1000 ? 1 : 0)
  const raw = String(f.format || '')
  const depth = raw.startsWith('s16') ? '16bit'
    : raw.startsWith('s24') ? '24bit'
      : raw.startsWith('s32') ? '32bit'
        : raw.startsWith('float') ? 'float' : raw
  return `${kHz}k/${depth}`
}

/** 是否真的处于位完美状态：独占 + 未被回退 + 输出格式已知且与源一致 + 音量 100% */
function isBitPerfect() {
  if (!state.exclusive) return false
  if (!audio || audio.isExclusive === false) return false
  if (!player || player.muted) return false
  if (player.volume < 0.999) return false
  const f = audio.format
  if (!f || !f.samplerate) return false
  const src = player.current && player.current.sampleRate
  return !src || Number(f.samplerate) === Number(src)
}

function updateHifiBadge() {
  const on = state.settings.exclusiveOutput === true
  if (!on) { UI.setHifi({ on: false }); return }

  const fmt = audio && audio.format ? audioFormatLabel(audio.format) : ''
  const srcRate = player.current ? player.current.sampleRate : 0
  const shared = !!(audio && audio.isExclusive === false)
  const resampled = !!(audio && audio.format && srcRate && Number(audio.format.samplerate) !== Number(srcRate))

  let state_ = 'perfect'
  let text = ''
  let hint = ''

  if (shared) {
    state_ = 'warn'
    text = '已回退共享'
    hint = '独占输出失败，当前是 WASAPI 共享模式，不再是位完美' +
      (audio.fallbackMessage ? '：' + audio.fallbackMessage : '')
  } else if (!player.current) {
    state_ = 'idle'
    text = '独占输出 · 待播放'
    hint = 'WASAPI 独占已就绪，开始播放后这里显示实际输出格式'
  } else if (!fmt) {
    state_ = 'probing'
    text = '位完美 · 检测中…'
    hint = '正在等待声卡以文件原生格式打开'
  } else if (resampled) {
    state_ = 'warn'
    text = '已重采样 · ' + fmt + '（源 ' + (srcRate / 1000).toFixed(srcRate % 1000 ? 1 : 0) + 'k）'
    hint = '声卡不接受源采样率，mpv 已重采样，此时不是位完美'
  } else if (player.muted || player.volume < 0.999) {
    state_ = 'warn'
    text = '非位完美 · 音量 ' + Math.round((player.volume || 0) * 100) + '%'
    hint = '软件音量会改变样本数值；把音量调到 100% 才是文件原样输出'
  } else {
    text = '位完美 · ' + fmt
    hint = 'WASAPI 独占，按文件原生采样率/位深直出（输出 ' + fmt + '）'
  }

  UI.setHifi({ on: true, text, hint, perfect: state_ === 'perfect', kind: state_ })
}

/** 切换引擎：改设置后重载界面（队列/进度/播放模式会从会话恢复） */
async function toggleExclusiveOutput() {  if (state.settings.exclusiveOutput) {
    state.settings.exclusiveOutput = false
    await window.api.patchSettings({ exclusiveOutput: false }).catch(() => {})
    saveSession()
    await window.api.mpvQuit().catch(() => {})
    location.reload()
    return
  }
  const ok = await window.api.mpvConfirmEnable().catch(() => false)
  if (!ok) return
  state.settings.exclusiveOutput = true
  await window.api.patchSettings({ exclusiveOutput: true }).catch(() => {})
  saveSession()
  location.reload()
}

/* ================= 独占输出设备面板（v2.3：从隐藏的右键菜单升级为正式面板） ================= */

let audioDevicesCache = []
let audioDevicesLoading = false

/** 打开面板并重新枚举设备（枚举需要引擎在跑，主进程会自动管理临时进程） */
async function openAudioPanel() {
  toggleAudioPanel(true)
  paintExclusiveVolume()
  await refreshAudioDevices()
}

/* ---- 高精度音量（v2.5）：独占下直达 mpv 浮点音量，0.1 步进，附 dB 换算 ---- */

function paintExclusiveVolume() {
  const slider = document.getElementById('apVol')
  if (!slider) return
  const v = Math.round((player.volume || 0) * 1000) / 10
  slider.value = v.toFixed(1)
  const db = v > 0 ? (20 * Math.log10(v / 100)).toFixed(1) + ' dB' : '-∞ dB'
  document.getElementById('apVolVal').textContent = v.toFixed(1) + '% · ' + db
  document.querySelectorAll('#apVolPresets .sp-chip').forEach((chip) => {
    chip.classList.toggle('on', Math.abs(Number(chip.dataset.v) - v) < 0.05)
  })
}

function setExclusiveVolume(v) {
  v = Math.max(0, Math.min(100, Number(v) || 0))
  // player.setVolume → MpvAudio.volume → mpv set_property volume（浮点）→ vol-change 落盘
  player.setVolume(v / 100)
  paintExclusiveVolume()
}

function toggleAudioPanel(show) {
  const panel = document.getElementById('audioPanel')
  const target = show === undefined ? panel.hidden : !!show
  panel.hidden = !target
}

/* ================= 在线缓存面板（v3.1） ================= */

function toggleCachePanel(show) {
  const panel = document.getElementById('cachePanel')
  const target = show === undefined ? panel.hidden : !!show
  panel.hidden = !target
  if (target) {
    const dl = document.getElementById('dlPanel')
    if (dl) dl.hidden = true
    refreshCachePanel()
  }
}

function fmtSize(bytes) {
  const b = Number(bytes) || 0
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB'
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  return Math.max(0, Math.round(b / 1024)) + ' KB'
}

/** 面板上的「共几首 / 占多少」+ 目录 + 开关状态 */
async function refreshCachePanel() {
  const info = await window.api.onlineCacheInfo().catch(() => null)
  if (!info) return
  const usage = document.getElementById('cacheUsage')
  usage.textContent = info.count ? `${info.count} 首 · ${fmtSize(info.size)}` : '还没有缓存'
  usage.classList.toggle('off', !info.count)
  const p = document.getElementById('cachePath')
  p.textContent = info.dir
  p.title = info.dir
  document.getElementById('cacheOn').checked = info.enabled
  const sel = document.getElementById('cacheLimit')
  const lim = String(info.limitMB || 0)
  if (!Array.from(sel.options).some((o) => o.value === lim)) {
    const opt = document.createElement('option')
    opt.value = lim
    opt.textContent = lim === '0' ? '不限' : Math.round(Number(lim) / 1024) + ' GB'
    sel.appendChild(opt)
  }
  sel.value = lim
  return info
}

function bindCachePanel() {
  document.getElementById('btnCacheClose').addEventListener('click', () => toggleCachePanel(false))
  document.getElementById('cacheOn').addEventListener('change', async (e) => {
    const on = e.target.checked
    state.settings.onlineCacheOn = on
    await window.api.patchSettings({ onlineCacheOn: on }).catch(() => {})
    toast(on ? '已开启在线缓存' : '已关闭在线缓存')
  })
  document.getElementById('cacheLimit').addEventListener('change', async (e) => {
    const mb = Number(e.target.value) || 0
    state.settings.onlineCacheLimitMB = mb
    await window.api.patchSettings({ onlineCacheLimitMB: mb }).catch(() => {})
    toast(mb ? '缓存上限：' + (mb >= 1024 ? mb / 1024 + ' GB' : mb + ' MB') : '缓存不设上限')
    refreshCachePanel()
  })
  document.getElementById('cachePickDir').addEventListener('click', async () => {
    const info = await window.api.onlinePickCacheDir().catch(() => null)
    if (!info) return
    state.settings.onlineCacheDir = info.dir
    toast('缓存目录：' + info.dir, 3000)
    refreshCachePanel()
  })
  document.getElementById('cacheOpenDir').addEventListener('click', () => window.api.onlineOpenCacheDir())
  document.getElementById('cacheClear').addEventListener('click', async () => {
    const info = await refreshCachePanel()
    if (info && !info.count) { toast('缓存已经是空的'); return }
    const r = await window.api.onlineCacheClear().catch(() => null)
    toast(r ? `已清理 ${r.removed} 首缓存` : '清理失败')
    refreshCachePanel()
  })

  // 高级音源（ChKSz apikey）：用户自己的账号，存本地 settings.json
  const paintKeyState = async () => {
    const st = await window.api.onlineExtraKeyGet().catch(() => null)
    const el = document.getElementById('keyState')
    if (!st || !el) return
    el.textContent = st.set ? '已设置 ' + st.masked : '未设置（QQ/酷狗 只能 320k）'
    el.style.color = st.set ? 'var(--accent)' : ''
  }
  document.getElementById('keySave').addEventListener('click', async () => {
    const input = document.getElementById('chkszKey')
    const k = input.value.trim()
    if (!k) { toast('先粘贴 apikey'); return }
    document.getElementById('keySave').textContent = '验证中…'
    const r = await window.api.onlineExtraKeySet(k).catch((err) => ({ ok: false, error: err.message }))
    document.getElementById('keySave').textContent = '保存并验证'
    if (r && r.ok) {
      input.value = ''
      toast(r.gotUrl ? 'key 有效，已启用' : 'key 有效（这首取不到，可能额度或版权），已启用')
      paintKeyState()
    } else {
      toast('没通过：' + ((r && r.error) || '未知错误'), 3500)
    }
  })
  document.getElementById('keyReg').addEventListener('click', () => window.api.onlineOpenChksz())
  document.getElementById('keyClear').addEventListener('click', async () => {
    await window.api.onlineExtraKeySet('').catch(() => {})
    document.getElementById('chkszKey').value = ''
    toast('已清除高级音源')
    paintKeyState()
  })
  paintKeyState()

  // 青听网关（v3.2）：默认开，关掉就只剩 GDStudio（网易）
  const paintQing = async () => {
    const st = await window.api.onlineQingGet().catch(() => null)
    const el = document.getElementById('qingOn')
    if (!st || !el) return
    el.checked = st.on !== false
    document.getElementById('qingState').textContent = st.on !== false ? '已启用' : '已关闭'
  }
  document.getElementById('qingOn').addEventListener('change', async (e) => {
    const on = e.target.checked
    await window.api.onlineQingSet(on).catch(() => {})
    document.getElementById('qingState').textContent = on ? '已启用' : '已关闭'
    toast(on ? '青听网关已启用（QQ/酷我/酷狗 也能无损）' : '已关闭青听网关，只走网易线路')
  })
  document.getElementById('qingTest').addEventListener('click', async () => {
    const btn = document.getElementById('qingTest')
    const el = document.getElementById('qingState')
    btn.textContent = '测试中…'
    el.textContent = ''
    const r = await window.api.onlineQingTest().catch((err) => ({ ok: false, error: err.message }))
    btn.textContent = '测试线路'
    if (r && r.ok) {
      el.textContent = '线路正常 · ' + r.ms + 'ms'
      el.style.color = 'var(--accent)'
    } else {
      el.textContent = '不通：' + ((r && r.error) || '未知错误')
      el.style.color = '#e06666'
    }
  })
  paintQing()
}

async function refreshAudioDevices() {
  if (audioDevicesLoading) return
  audioDevicesLoading = true
  const body = document.getElementById('audioDevices')
  body.innerHTML = '<span class="ap-loading">正在检测输出设备…</span>'
  const res = await window.api.mpvDevices().catch((err) => ({ ok: false, error: err.message }))
  audioDevicesLoading = false
  if (!res || !res.ok) {
    body.innerHTML = '<span class="ap-loading">检测失败：' + esc((res && res.error) || '未知错误') + '</span>'
    return
  }
  audioDevicesCache = res.devices || []
  paintAudioPanel()
}

function paintAudioPanel() {
  const cur = state.settings.audioDevice || ''
  const body = document.getElementById('audioDevices')
  const chip = (label, name) =>
    '<button class="sp-chip' + (name === cur ? ' on' : '') + '" data-dev="' + esc(name) + '">' +
    esc(label) + (name === cur ? '（当前）' : '') + '</button>'
  let html = chip('跟随系统默认设备', '')
  for (const d of audioDevicesCache) {
    html += chip(d.description || d.name, d.name)
  }
  if (!audioDevicesCache.length) {
    html += '<span class="ap-loading">没有检测到可用设备</span>'
  }
  body.innerHTML = html
}

/** 选中设备（'' = 跟随系统默认）。保存并即时切（独占没开时只保存，开启后生效）。 */
async function setAudioDevice(name) {
  name = name || ''
  state.settings.audioDevice = name
  const r = await window.api.mpvSetDevice(name).catch((err) => ({ ok: false, error: err.message }))
  if (!r || !r.ok) toast('切换输出设备失败：' + ((r && r.error) || '未知错误'), 3000)
  else toast(r.applied ? '输出设备已切换' : '输出设备已保存（开启独占后生效）')
  paintAudioPanel()
}

/* ================= 迷你模式 ================= */

/**
 * 迷你模式只切界面，窗口缩放由主进程做（同一窗口，播放状态天然连续）。
 * on 省略＝切换；返回后以主进程的实际状态为准。
 */
async function toggleMini(on) {
  const next = on == null ? !state.mini : !!on
  if (next === state.mini) return
  // 进迷你/回完整之前把浮层都收掉，免得面板卡在窄窗口里
  UI.toggleQueue(false)
  UI.toggleEq(false)
  UI.hideContextMenu()
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
  }
  toast(next ? '迷你模式' : '完整模式')
}

async function toggleFavoriteCurrent() {
  if (!state.currentId) return
  const favs = await window.api.toggleFavorite(state.currentId)
  state.favorites = new Set(favs)
  UI.setFavorite(state.favorites.has(state.currentId))
  updateNavCounts()
  if (state.view === 'fav') renderView()
  toast(state.favorites.has(state.currentId) ? '已加入收藏' : '已取消收藏')
}

/* ================= 歌词 ================= */

async function loadLyric(track) {
  state.lyricOffset = state.settings.lyricOffset || 0
  UI.setLyricOffset(state.lyricOffset)
  const isOnline = !!track.online
  if (!isOnline && !track.hasLyric) {
    if (track.id === state.currentId) UI.renderLyric(null, track.title)
    return
  }
  let parsed = state.lyricCache.get(track.id)
  if (parsed === undefined) {
    // 在线曲目走主进程取词（本源没词会自动换源找同一首）
    const text = isOnline
      ? await window.api.onlineLyric(track.online).catch(() => null)
      : await window.api.readLyric(track.id)
    // 读文件/取词是异步的：等待期间用户可能已经切歌，慢返回的旧歌词不能覆盖新歌
    if (track.id !== state.currentId) return
    parsed = text ? parseLrc(text) : null
    state.lyricCache.set(track.id, parsed)
  }
  if (track.id !== state.currentId) return
  UI.renderLyric(parsed, track.title)
  UI.updateLyricIndex(audio.currentTime + state.lyricOffset)
  pushDesktopLyric(true)
}

/* ================= UI 接线 ================= */

function bindUI() {
  // 搜索
  const doSearch = debounce((q) => {
    state.query = q.trim()
    document.getElementById('searchClear').hidden = !state.query
    renderView()
  }, 160)
  document.getElementById('searchInput').addEventListener('input', (e) => doSearch(e.target.value))
  document.getElementById('searchClear').addEventListener('click', () => {
    const inp = document.getElementById('searchInput')
    inp.value = ''
    inp.focus()
    doSearch('')
  })

  // 侧边栏导航
  document.getElementById('sidebar').addEventListener('click', (e) => {
    const del = e.target.closest('.pl-del')
    if (del) {
      e.stopPropagation()
      const id = del.closest('[data-playlist]').dataset.playlist
      deletePlaylist(id)
      return
    }
    const item = e.target.closest('.nav-item[data-view]')
    if (!item) return
    switchView(item.dataset.view)
  })

  // 新建歌单
  document.getElementById('btnNewPlaylist').addEventListener('click', async () => {
    const name = '新歌单 ' + (state.playlists.length + 1)
    const pl = await window.api.createPlaylist(name)
    state.playlists.push(pl)
    renderPlaylists()
    switchView(pl.id)
    toast('已创建「' + pl.name + '」')
  })
  document.getElementById('btnImportPlaylist').addEventListener('click', importM3uPlaylist)

  // 歌单右键：重命名 / 导出 m3u / 删除；双击歌单名也可重命名（v2.7）
  document.getElementById('playlistList').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.nav-item[data-playlist]')
    if (!item) return
    e.preventDefault()
    const plId = item.dataset.playlist
    UI.showContextMenu(e.clientX, e.clientY, [
      { label: '重命名', icon: 'edit', act: 'rename-playlist', arg: plId },
      { label: '导出为 m3u…', icon: 'folder', act: 'export-m3u', arg: plId },
      { sep: true },
      { label: '删除歌单', icon: 'trash', danger: true, act: 'delete-playlist', arg: plId }
    ])
  })
  document.getElementById('playlistList').addEventListener('dblclick', (e) => {
    const item = e.target.closest('.nav-item[data-playlist]')
    if (item) openRenameModal(item.dataset.playlist)
  })

  // 改名弹窗（v2.7）
  document.getElementById('btnRenameClose').addEventListener('click', closeRenameModal)
  document.getElementById('btnRenameCancel').addEventListener('click', closeRenameModal)
  document.getElementById('btnRenameOk').addEventListener('click', confirmRename)
  document.getElementById('renameModal').addEventListener('click', (e) => {
    if (e.target.id === 'renameModal') closeRenameModal()
  })
  document.getElementById('renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename() }
    if (e.key === 'Escape') { e.preventDefault(); closeRenameModal() }
  })

  // 列表点击
  document.getElementById('tableBody').addEventListener('click', (e) => {
    const row = e.target.closest('.tr')
    if (!row) { clearSelection(); return }
    const id = row.dataset.id
    const track = state.byId.get(id)
    if (!track) return
    const index = Number(row.dataset.index)
    // Ctrl 点选 / Shift 范围选：只改变选中，不触发播放（v1.7）
    if (e.ctrlKey || e.metaKey) { toggleSelection(id, index); return }
    if (e.shiftKey) { selectRange(index); return }
    clearSelection()
    if (state.currentId === id && player) player.toggle()
    else playFromVisible(track)
  })

  // 列表右键
  document.getElementById('tableBody').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tr')
    if (!row) return
    e.preventDefault()
    const track = state.byId.get(row.dataset.id)
    if (track) showTrackMenu(e.clientX, e.clientY, track)
  })

  // 多选工具条（v2.6）：播放 / 收藏 / 加入歌单 / 清除
  document.getElementById('selBar').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-sel]')
    if (!btn) return
    // 阻止冒泡到 document 的「点外部收起菜单/面板」监听，否则刚弹出的歌单菜单立即被关掉
    e.stopPropagation()
    const tracks = selectedTracks()
    if (!tracks.length) return
    const kind = btn.dataset.sel
    if (kind === 'clear') { clearSelection(); return }
    if (kind === 'play') {
      player.setQueue(tracks, 0, true)
      return
    }
    // fav / addpl 复用右键菜单的动作管道
    currentMenuTrack = tracks[0]
    currentMenuTracks = tracks
    if (kind === 'fav') { handleCtxAction('fav'); return }
    if (kind === 'addpl') {
      const r = btn.getBoundingClientRect()
      UI.showContextMenu(r.left, r.bottom + 6, state.playlists.length
        ? state.playlists.map((p) => ({ label: p.name, act: 'add-pl', arg: p.id }))
        : [{ label: '（暂无歌单）', act: 'noop' }])
    }
  })

  // 表头排序
  document.getElementById('tableHead').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-sort]')
    if (!cell) return
    const key = cell.dataset.sort
    if (state.sortKey === key) {
      // 三态循环（v1.9）：默认方向 → 反向 → 恢复默认（旧代码第三个分支是空的，
      // 只能靠双击表头回默认，等于"点两下就没路可走"）。
      // 方向顺序按列而定：音质/入库时间首点是降序，其余列首点是升序
      const descFirst = SORT_DESC_FIRST.has(key)
      if (state.sortDir === (descFirst ? 'desc' : 'asc')) state.sortDir = descFirst ? 'asc' : 'desc'
      else { state.sortKey = 'default'; state.sortDir = 'asc' }
    } else {
      state.sortKey = key
      // 音质和入库时间默认降序：想看的是"最好的/最新的"，不是最差的
      state.sortDir = SORT_DESC_FIRST.has(key) ? 'desc' : 'asc'
    }
    renderView()
  })
  document.getElementById('tableHead').addEventListener('dblclick', () => {
    state.sortKey = 'default'
    state.sortDir = 'asc'
    renderView()
  })

  // 播放全部 / 随机 / 从歌单移除
  document.getElementById('btnPlayAll').addEventListener('click', () => {
    if (!state.visible.length) return
    player.setQueue(state.visible, 0, true)
  })
  document.getElementById('btnShuffleAll').addEventListener('click', shuffleAll)
  document.getElementById('btnPlaylistRemove').addEventListener('click', () => {
    const pl = state.playlists.find((p) => p.id === state.view)
    if (!pl) return
    toast('请在右键菜单里选择要移除的歌曲')
  })

  // 空状态扫描
  document.getElementById('btnEmptyScan').addEventListener('click', doScan)
  document.getElementById('btnScan').addEventListener('click', openDirModal)

  // 歌词面板开关
  document.getElementById('btnLyricToggle').addEventListener('click', () => {
    const visible = document.getElementById('lyricPanel').classList.contains('hidden')
    UI.setLyricPanelVisible(visible)
    saveSettings({ showLyricPanel: visible })
    state.settings.showLyricPanel = visible
  })

  // 歌词字号 / 偏移
  const setFs = (delta) => {
    const cur = parseInt(state.settings.lyricFontSize || 20, 10)
    const next = Math.max(12, Math.min(40, cur + delta))
    state.settings.lyricFontSize = next
    UI.setLyricFontSize(next)
    saveSettings({ lyricFontSize: next })
  }
  document.getElementById('btnLyricSmaller').addEventListener('click', () => setFs(-2))
  document.getElementById('btnLyricBigger').addEventListener('click', () => setFs(2))
  const setOffset = (delta) => {
    // 偏移按曲目存（v1.7）：不同来源的 LRC 偏差各不相同，共用一个值会互相踩
    const id = state.currentId
    const next = Math.round((offsetFor(id) + delta) * 10) / 10
    if (id) {
      const map = Object.assign({}, state.settings.lyricOffsetById || {})
      map[id] = next
      state.settings.lyricOffsetById = map
      saveSettings({ lyricOffsetById: map })
    } else {
      state.settings.lyricOffset = next
      saveSettings({ lyricOffset: next })
    }
    state.lyricOffset = next
    UI.setLyricOffset(next)
    UI.updateLyricIndex(audio.currentTime + next)
    toast((id ? '本曲歌词偏移 ' : '全局歌词偏移 ') + (next >= 0 ? '+' : '') + next.toFixed(1) + 's')
  }
  document.getElementById('btnLyricEarlier').addEventListener('click', () => setOffset(-0.5))
  document.getElementById('btnLyricLater').addEventListener('click', () => setOffset(0.5))

  // 歌词行点击跳转
  document.getElementById('lpLyrics').addEventListener('click', (e) => {
    const line = e.target.closest('.lyric-line')
    if (!line) return
    const i = parseInt(line.dataset.i, 10)
    const st = UI.lyricState
    const item = st.lines[i]
    if (item && item.t != null) player.seek(item.t - state.lyricOffset)
  })

  // 播放控制
  document.getElementById('btnPlay').addEventListener('click', () => {
    if (!player.current && state.visible.length) {
      player.setQueue(state.visible, 0, true)
      return
    }
    player.toggle()
  })
  document.getElementById('btnPrev').addEventListener('click', () => player.prev())
  document.getElementById('btnNext').addEventListener('click', () => player.next())
  document.getElementById('btnMode').addEventListener('click', () => player.cycleMode())

  // 收藏（完整播放条与迷你卡片共用）
  document.getElementById('btnFav').addEventListener('click', toggleFavoriteCurrent)
  document.getElementById('mvFav').addEventListener('click', toggleFavoriteCurrent)

  // 进度条拖动
  bindBar(document.getElementById('progressBar'), (ratio) => {
    player.seekRatio(ratio)
  }, (ratio) => {
    UI.setProgress(ratio * (audio.duration || 0), audio.duration || 0)
  }, () => {
    UI.setProgress(audio.currentTime, audio.duration || 0)
  })

  // 音量
  bindBar(document.getElementById('volBar'), (ratio) => {
    player.setMuted(false)
    player.setVolume(ratio)
  }, (ratio) => {
    UI.setVolume(ratio, false)
  }, () => {
    UI.setVolume(player.volume, player.muted)
  })
  document.getElementById('btnMute').addEventListener('click', () => player.setMuted(!player.muted))

  // 音量均衡开关 + 右键菜单（分析 / 目标响度 / 清除）
  document.getElementById('btnNorm').addEventListener('click', () => {
    if (state.exclusive) { toast('独占输出下音量均衡不可用（会破坏位完美）'); return }
    const on = !(state.settings.normalizeVolume === true)
    state.settings.normalizeVolume = on
    saveSettings({ normalizeVolume: on })
    UI.setNorm(on)
    applyTrackGain(state.currentId)
    if (on && !hasAnalyzedGains()) toast('已开启音量均衡：右键此按钮可分析曲库响度')
    else toast(on ? '音量均衡已开启' : '音量均衡已关闭')
  })
  document.getElementById('btnNorm').addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (state.exclusive) { toast('独占输出下响度分析不可用（会破坏位完美）'); return }
    const target = state.settings.targetLufs || LUFS_DEFAULT_TARGET
    const lufsItems = [-14, -16, -18, -20].map((v) => ({
      label: `${v} LUFS${v === target ? ' ✓' : ''}`,
      act: 'set-lufs', arg: String(v)
    }))
    UI.showContextMenu(e.clientX, e.clientY, [
      { label: '分析曲库响度', icon: 'refresh', act: 'analyze-loudness' },
      { label: `目标响度（当前 ${target}）`, icon: 'eq', act: 'noop', sub: lufsItems },
      { sep: true },
      { label: '清除分析数据', act: 'clear-gains' }
    ])
  })

  // 桌面歌词
  document.getElementById('btnDLyric').addEventListener('click', toggleDesktopLyric)

  // 独占输出（位完美）：左键开关；选输出设备走正式面板（v2.3，原来藏在右键菜单里）
  document.getElementById('btnHifi').addEventListener('click', toggleExclusiveOutput)
  document.getElementById('btnHifi').addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openAudioPanel()
  })
  // 独占生效时播放条左侧的 HiFi 角标：左键/右键都能打开设备面板
  document.getElementById('hifiBadge').addEventListener('click', (e) => {
    e.stopPropagation()
    openAudioPanel()
  })
  document.getElementById('hifiBadge').addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openAudioPanel()
  })
  document.getElementById('btnAudioRefresh').addEventListener('click', refreshAudioDevices)
  document.getElementById('btnAudioClose').addEventListener('click', () => toggleAudioPanel(false))
  document.getElementById('audioDevices').addEventListener('click', (e) => {
    const chip = e.target.closest('.sp-chip')
    if (chip) setAudioDevice(chip.dataset.dev || '')
  })
  // 高精度音量（v2.5）：拖动实时生效；预设一键到位
  document.getElementById('apVol').addEventListener('input', (e) => setExclusiveVolume(e.target.value))
  document.getElementById('apVolPresets').addEventListener('click', (e) => {
    const chip = e.target.closest('.sp-chip')
    if (chip) setExclusiveVolume(chip.dataset.v)
  })

  // 均衡器面板（独占输出下禁用：任何软件处理都会破坏位完美）
  document.getElementById('btnEq').addEventListener('click', (e) => {
    e.stopPropagation()
    if (state.exclusive) { toast('独占输出下均衡器不可用（会破坏位完美）'); return }
    UI.toggleEq()
  })

  // 睡眠定时面板（v2.2：入口从托盘移到 app 内播放条）
  document.getElementById('btnSleep').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleSleepPanel()
  })
  document.getElementById('btnSleepClose').addEventListener('click', () => toggleSleepPanel(false))
  bindCachePanel()
  document.getElementById('sleepOpts').addEventListener('click', (e) => {
    const chip = e.target.closest('.sp-chip')
    if (!chip) return
    const min = Number(chip.dataset.min) || 0
    window.api.setSleepTimer(min).then((st) => renderSleepState(st))
    toast(min > 0 ? '睡眠定时：' + min + ' 分钟后暂停播放' : '睡眠定时已关闭')
  })
  document.getElementById('btnEqClose').addEventListener('click', () => UI.toggleEq(false))
  document.getElementById('btnEqPower').addEventListener('click', () => {
    const cfg = eqSettings()
    cfg.enabled = !cfg.enabled
    applyEq(cfg)
    toast(cfg.enabled ? '均衡器已开启' : '均衡器已关闭')
  })
  document.getElementById('btnEqFlat').addEventListener('click', () => {
    applyEq({ enabled: eqSettings().enabled, preset: 'flat', bands: EQ_PRESETS.flat.bands.slice() })
  })
  document.getElementById('eqPresets').addEventListener('click', (e) => {
    const chip = e.target.closest('.eq-chip')
    if (chip) applyEqPreset(chip.dataset.preset)
  })
  // 滑块：input 拖动实时生效（applyEq 内部 300ms 去抖落盘）
  const onEqSlider = (e) => {
    const el = e.target
    if (!el.matches || !el.matches('#eqBands input[type="range"]')) return
    setEqBand(Number(el.dataset.i), el.value)
  }
  document.getElementById('eqBands').addEventListener('input', debounce(onEqSlider, 30))
  // 双击滑块归零
  document.getElementById('eqBands').addEventListener('dblclick', (e) => {
    const el = e.target
    if (!el.matches || !el.matches('#eqBands input[type="range"]')) return
    el.value = '0'
    setEqBand(Number(el.dataset.i), 0)
  })

  // 队列
  document.getElementById('btnQueue').addEventListener('click', (e) => {
    e.stopPropagation()
    UI.toggleQueue()
  })
  document.getElementById('btnQueueClose').addEventListener('click', () => UI.toggleQueue(false))
  // A-B 循环（v2.1）：单击循环 设A → 设B → 取消
  document.getElementById('btnAb').addEventListener('click', (e) => {
    e.stopPropagation()
    onAbClick()
  })
  document.getElementById('queueBody').addEventListener('click', (e) => {
    const item = e.target.closest('.qp-item')
    if (!item || !item.dataset.qi) return
    const i = parseInt(item.dataset.qi, 10)
    const track = player.tracks[i]
    if (track) {
      player.index = i
      player._loadCurrent(true)
    }
  })
  // 拖拽交互（队列排序 / 拖歌进歌单）见 js/dragdrop.js
  bindDragAndDrop()

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#queuePanel') && !e.target.closest('#btnQueue')) UI.toggleQueue(false)
    if (!e.target.closest('#ctxMenu')) UI.hideContextMenu()
    if (!e.target.closest('#eqPanel') && !e.target.closest('#btnEq')) UI.toggleEq(false)
    if (!e.target.closest('#sleepPanel') && !e.target.closest('#btnSleep')) toggleSleepPanel(false)
    if (!e.target.closest('#audioPanel') && !e.target.closest('#btnHifi') && !e.target.closest('#hifiBadge')) toggleAudioPanel(false)
  })

  // 右键菜单动作
  document.getElementById('ctxMenu').addEventListener('ctx-act', (e) => {
    handleCtxAction(e.detail.act, e.detail.arg)
  })

  // 窗口控制
  document.getElementById('btnMin').addEventListener('click', () => window.api.minimize())
  document.getElementById('btnMax').addEventListener('click', async () => {
    const max = await window.api.toggleMaximize()
    document.getElementById('btnMax').innerHTML = icon(max ? 'restore' : 'max')
  })
  document.getElementById('btnClose').addEventListener('click', () => {
    saveSession()
    window.api.closeWindow()
  })

  // 双击标题栏最大化
  document.getElementById('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.no-drag')) return
    document.getElementById('btnMax').click()
  })

  // 迷你模式
  document.getElementById('btnMini').addEventListener('click', () => toggleMini(true))
  document.getElementById('miniRestore').addEventListener('click', () => toggleMini(false))
  document.getElementById('miniMin').addEventListener('click', () => window.api.minimize())
  document.getElementById('miniClose').addEventListener('click', () => {
    saveSession()
    window.api.closeWindow()
  })
  // 双击封面/信息区也能回完整模式（键盘外最顺手的一个手势）
  document.querySelector('.mv-body').addEventListener('dblclick', () => toggleMini(false))

  document.getElementById('mvPlay').addEventListener('click', () => {
    if (!player.current && state.visible.length) {
      player.setQueue(state.visible, 0, true)
      return
    }
    player.toggle()
  })
  document.getElementById('mvPrev').addEventListener('click', () => player.prev())
  document.getElementById('mvNext').addEventListener('click', () => player.next())
  document.getElementById('mvMode').addEventListener('click', () => player.cycleMode())

  // 迷你卡片进度条拖动（与完整播放条同一套逻辑）
  bindBar(document.getElementById('mvBar'), (ratio) => {
    player.seekRatio(ratio)
  }, (ratio) => {
    UI.setProgress(ratio * (audio.duration || 0), audio.duration || 0)
  }, () => {
    UI.setProgress(audio.currentTime, audio.duration || 0)
  })
}

/** 进度/音量条通用拖拽 */
function bindBar(el, onCommit, onPreview, onReset) {
  let dragging = false
  const ratioOf = (e) => {
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  el.addEventListener('pointerdown', (e) => {
    dragging = true
    el.setPointerCapture(e.pointerId)
    onPreview(ratioOf(e))
  })
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return
    onPreview(ratioOf(e))
  })
  const end = (e) => {
    if (!dragging) return
    dragging = false
    try { el.releasePointerCapture(e.pointerId) } catch {}
    onCommit(ratioOf(e))
    onReset()
  }
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
}

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
      if (state.view === 'fav') renderView()
      toast(allFav
        ? '已取消收藏' + (targets.length > 1 ? ' ' + targets.length + ' 首' : '')
        : '已加入收藏' + (targets.length > 1 ? ' ' + targets.length + ' 首' : ''))
      break
    }
    case 'add-pl': {
      const ids = (currentMenuTracks.length ? currentMenuTracks : [track]).map((t) => t.id)
      const pl = await window.api.addToPlaylist(arg, ids)
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
      const pl = await window.api.removeFromPlaylist(state.view, ids)
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
    case 'reveal':
      window.api.showInFolder(track.path)
      break
    case 'copy':
      navigator.clipboard.writeText(`${track.title} - ${track.artist}`).then(() => toast('已复制'))
      break
    case 'set-gain': {
      if (state.exclusive) { toast('独占输出下手动增益不可用（会破坏位完美）'); return }
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
  const updated = await window.api.updatePlaylist(plId, { name })
  if (updated) {
    const i = state.playlists.findIndex((p) => p.id === plId)
    if (i >= 0) state.playlists[i] = updated
    renderPlaylists()
    if (state.view === plId) renderView()
    toast('已重命名为「' + name + '」')
  }
}

async function deletePlaylist(id) {
  const pl = state.playlists.find((p) => p.id === id)
  if (!pl) return
  await window.api.removePlaylist(id)
  state.playlists = state.playlists.filter((p) => p.id !== id)
  renderPlaylists()
  if (state.view === id) switchView('all')
  updateNavCounts()
  toast('已删除「' + pl.name + '」')
}

/* ================= 扫描 ================= */

let scanning = false
let draftDirs = []

function openDirModal() {
  if (scanning) { toast('正在扫描，请稍候'); return }
  draftDirs = (state.settings.musicDirs || []).slice()
  const chk = document.getElementById('chkWatchFolders')
  if (chk) chk.checked = state.settings.watchFolders !== false
  UI.showDirModal(draftDirs)
}

function bindDirModal() {
  document.getElementById('btnDirClose').addEventListener('click', () => UI.hideDirModal())
  document.getElementById('dirModal').addEventListener('click', (e) => {
    if (e.target.id === 'dirModal') UI.hideDirModal()
  })
  document.getElementById('btnDirAdd').addEventListener('click', async () => {
    const picked = await window.api.pickDirs()
    if (!picked || !picked.length) return
    for (const d of picked) {
      if (!draftDirs.some((x) => x.toLowerCase() === d.toLowerCase())) draftDirs.push(d)
    }
    UI.renderDirList(draftDirs)
  })
  UI.els.dirList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rm]')
    if (!btn) return
    draftDirs.splice(Number(btn.dataset.rm), 1)
    UI.renderDirList(draftDirs)
  })
  document.getElementById('btnDirSave').addEventListener('click', async () => {
    if (!draftDirs.length) { toast('请至少添加一个文件夹'); return }
    UI.hideDirModal()
    state.settings.musicDirs = draftDirs.slice()
    const chk = document.getElementById('chkWatchFolders')
    const watchFolders = chk ? chk.checked : true
    state.settings.watchFolders = watchFolders
    await window.api.patchSettings({ musicDirs: draftDirs.slice(), watchFolders })
    await doScan()
  })
}

async function doScan() {
  if (scanning) return
  scanning = true
  UI.showScan('正在扫描音乐文件夹…')
  try {
    const dirs = state.settings.musicDirs && state.settings.musicDirs.length
      ? state.settings.musicDirs
      : await window.api.pickDirs()
    if (!dirs.length) { UI.hideScan(); scanning = false; return }
    if (dirs !== state.settings.musicDirs) {
      state.settings.musicDirs = dirs
      await window.api.patchSettings({ musicDirs: dirs })
    }
    const res = await window.api.scan(dirs)
    const tracks = await window.api.listTracks()
    setTracks(tracks)
    updateNavCounts()
    renderView()
    UI.hideScan()
    const bits = []
    if (res.added) bits.push('新增 ' + res.added)
    if (res.updated) bits.push('更新 ' + res.updated)
    if (res.removed) bits.push('移除 ' + res.removed)
    if (res.failed) bits.push(res.failed + ' 个解析失败（标题栏诊断按钮可看明细）')
    // 目录不可访问时主进程会跳过清理，必须告诉用户「不是曲库没了，是盘没连上」
    if (res.missingRoots && res.missingRoots.length) {
      bits.push(res.missingRoots.length + ' 个目录不可访问，已跳过清理')
    }
    toast(`扫描完成：${res.total} 首` + (bits.length ? `（${bits.join('，')}）` : ''), bits.length > 1 ? 4000 : 1800)
  } catch (err) {
    console.error('[scan]', err)
    UI.hideScan()
    toast('扫描失败：' + err.message)
  } finally {
    scanning = false
    UI.hideScan()
    // 诊断面板开着时同步刷新失败清单（扫描往往就是用户打开面板的原因）
    if (typeof Diag !== 'undefined' && Diag.isOpen()) Diag.loadFailures()
  }
}

function onScanProgress(p) {
  if (p.phase === 'collect') { UI.updateScan({ phase: 'collect', done: 0, total: 0 }); return }
  UI.updateScan({
    phase: 'parse',
    done: p.done,
    total: p.total,
    name: p.track ? p.track.title : ''
  })
}

/**
 * 主进程侧的扫描结束通知（首次启动自动建库、解析器升级重建曲库都会走这里）。
 * 自己发起的 doScan 有 await 兜着，这条只处理"后台扫描完成"的情况。
 */
async function onScanDone() {
  if (scanning) return
  try {
    const tracks = await window.api.listTracks()
    setTracks(tracks)
    // 队列里已失效的曲目要剔除，否则点播放会指向不存在的文件
    if (player && player.tracks.length) {
      const kept = player.tracks.filter((t) => state.byId.has(t.id))
      if (kept.length !== player.tracks.length) {
        const curId = player.current ? player.current.id : null
        const idx = Math.max(0, kept.findIndex((t) => t.id === curId))
        if (kept.length) player.setQueue(kept, idx, false)
        else player.stop()
      }
    }
    updateNavCounts()
    renderView()
    if (typeof Diag !== 'undefined' && Diag.isOpen()) Diag.loadFailures()
  } catch (err) {
    console.error('[scan-done]', err)
  }
}

/* ================= A-B 循环（v2.1） ================= */

const AB_MIN_GAP = 1      // A/B 至少差 1 秒，否则就是原地打转
state.ab = { a: null, b: null }

/** 独占模式把循环交给 mpv（精确到采样）；普通输出由 enforceAbLoop 每帧比较后回跳 */
function applyAbLoop() {
  if (typeof audio.setAbLoop === 'function') audio.setAbLoop(state.ab.a, state.ab.b)
}

function updateAbUi() {
  const btn = UI.els.btnAb
  if (!btn) return
  const { a, b } = state.ab
  btn.classList.toggle('arm', a != null && b == null)
  btn.classList.toggle('on', a != null && b != null)
  btn.textContent = a != null && b == null ? 'A-' : 'A-B'
  btn.title = a == null ? 'A-B 循环：点一下设起点，再点一下设终点'
    : b == null ? 'A 点已设 ' + fmtTime(a) + '，播放到终点位置再点一下'
      : 'A-B 循环中 ' + fmtTime(a) + ' → ' + fmtTime(b) + '，再点一下取消'
  const dur = (audio && audio.duration) || 0
  const put = (el, t) => {
    if (!el) return
    if (t == null || !(dur > 0)) { el.hidden = true; return }
    el.hidden = false
    el.style.left = Math.max(0, Math.min(100, (t / dur) * 100)) + '%'
  }
  put(UI.els.abMarkA, a)
  put(UI.els.abMarkB, b)
}

function syncAb() {
  applyAbLoop()
  updateAbUi()
}

function resetAb(silent = true) {
  if (state.ab.a == null && state.ab.b == null) return
  state.ab = { a: null, b: null }
  syncAb()
  if (!silent) toast('已取消 A-B 循环')
}

function onAbClick() {
  if (!player || !player.current) { toast('先播放一首歌再设 A-B'); return }
  const t = Math.max(0, audio.currentTime || 0)
  const { a, b } = state.ab
  if (a == null) {
    state.ab = { a: t, b: null }
    toast('A 点：' + fmtTime(t) + '（播放到终点再点一下）', 2200)
  } else if (b == null) {
    if (t - a < AB_MIN_GAP) { toast('B 点至少要在 A 点之后 1 秒'); return }
    state.ab = { a, b: t }
    toast('A-B 循环：' + fmtTime(a) + ' → ' + fmtTime(t), 2200)
  } else {
    resetAb(false)
    return
  }
  syncAb()
}

/** 普通输出下的循环判定；独占模式 mpv 自己循环，这里直接跳过 */
function enforceAbLoop(cur) {
  const { a, b } = state.ab
  if (a == null || b == null) return
  if (typeof audio.setAbLoop === 'function') return
  if (cur >= b - 0.06) player.seek(a)
}

/* ================= Windows 媒体控制（Media Session / SMTC，v2.1） ================= */

/**
 * Chromium 会把 navigator.mediaSession 接到 Windows 的 SMTC 上（音量浮层、锁屏、硬件媒体键）。
 * 这条链路不需要原生模块，但有个前提：必须有一个**正在播放的 <audio>**。
 * 独占模式下声音走 mpv，页面里没有播放中的 <audio>，所以额外挂一条静音流
 * （体积 0 的 8bit WAV，音量 0.001 —— 不能设 0，Chromium 认为"静音"就不算 audible）。
 */
let mediaKeepAlive = null
let mediaPosAt = 0

function silentWavUrl(seconds = 0.2, rate = 8000) {
  const n = Math.floor(seconds * rate)
  const buf = new ArrayBuffer(44 + n)
  const dv = new DataView(buf)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true)
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true)
  w(36, 'data'); dv.setUint32(40, n, true)
  for (let i = 0; i < n; i++) dv.setUint8(44 + i, 128)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

function initMediaSession() {
  if (!('mediaSession' in navigator)) return
  const ms = navigator.mediaSession
  const set = (name, fn) => { try { ms.setActionHandler(name, fn) } catch {} }
  set('play', () => player.play())
  set('pause', () => player.pause())
  set('previoustrack', () => player.prev())
  set('nexttrack', () => player.next())
  set('stop', () => { player.pause(); player.seek(0) })
  set('seekto', (d) => { if (d && d.seekTime != null) player.seek(d.seekTime) })
  set('seekbackward', (d) => player.seek(Math.max(0, (audio.currentTime || 0) - ((d && d.seekOffset) || 10))))
  set('seekforward', (d) => player.seek((audio.currentTime || 0) + ((d && d.seekOffset) || 10)))
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || track.fileName || '未知曲目',
      artist: track.artist || '',
      album: track.album || '',
      artwork: track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/jpeg' }] : []
    })
  } catch {}
}

function syncMediaSessionState(playing) {
  if (!('mediaSession' in navigator)) return
  try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused' } catch {}
}

/** 进度位置：Windows 浮层的进度条靠它；1 秒一次足够，别每帧都调 */
function updateMediaPosition(cur, dur) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
  const now = Date.now()
  if (now - mediaPosAt < 1000) return
  mediaPosAt = now
  if (!(dur > 0) || !isFinite(dur)) return
  try {
    navigator.mediaSession.setPositionState({
      duration: dur,
      position: Math.min(Math.max(0, cur || 0), dur),
      playbackRate: 1
    })
  } catch {}
}

function keepAliveMediaSession(playing) {
  if (!('mediaSession' in navigator)) return
  // 普通输出下 <audio> 本身就是一场活跃会话，不需要这条假流
  if (!state.exclusive) {
    if (mediaKeepAlive && !mediaKeepAlive.paused) mediaKeepAlive.pause()
    return
  }
  try {
    if (!mediaKeepAlive) {
      mediaKeepAlive = new Audio(silentWavUrl())
      mediaKeepAlive.loop = true
      mediaKeepAlive.volume = 0.001
      mediaKeepAlive.addEventListener('error', () => { mediaKeepAlive = null })
    }
    if (playing) {
      if (mediaKeepAlive.paused) mediaKeepAlive.play().catch(() => {})
    } else if (!mediaKeepAlive.paused) {
      mediaKeepAlive.pause()
    }
  } catch {}
}

/* ================= 播放结束后关机 / 设备热插拔（v2.1） ================= */

let powerCountdownTimer = null
const POWER_TEXT = { shutdown: '关机', hibernate: '休眠', quit: '关闭播放器' }

function showPowerCountdown(kind, seconds) {
  clearInterval(powerCountdownTimer)
  let left = seconds
  const tick = () => {
    if (left <= 0) { clearInterval(powerCountdownTimer); powerCountdownTimer = null; return }
    toast(`队列已播完：${left} 秒后${POWER_TEXT[kind] || '执行动作'}（Esc 或托盘菜单可取消）`, 1200)
    left--
  }
  tick()
  powerCountdownTimer = setInterval(tick, 1000)
}

async function cancelPowerCountdown() {
  clearInterval(powerCountdownTimer)
  powerCountdownTimer = null
  const ok = await window.api.powerCancel().catch(() => false)
  toast(ok ? '已取消' : '没有待执行的关机任务')
}

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
    const inInput = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)
    if (e.key === 'Escape') {
      // 关机倒计时进行中：Esc 优先取消它（这一刻误触的代价最大）
      if (powerCountdownTimer) { cancelPowerCountdown(); e.preventDefault(); return }
      if (state.analyzing) {
        state.abortAnalysis = true
        e.preventDefault()
        return
      }
      UI.hideContextMenu()
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

/* ================= 持久化 ================= */

const saveSettings = debounce((patch) => {
  window.api.patchSettings(patch).then((s) => { state.settings = s }).catch(() => {})
}, 300)

/* ================= 长音轨断点续播见 js/resume.js ================= */

function saveSession() {
  if (!player) return
  const ids = player.tracks.map((t) => t.id)
  if (!ids.length) return
  // 长音轨顺便记一下断点位置
  const cur = player.current
  if (cur && audio.duration > RESUME_MIN_DURATION) rememberResume(cur.id, audio.currentTime)  
  window.api.setSession({
    queueIds: ids,
    index: player.index,
    currentTime: audio.currentTime || 0,
    mode: player.mode
  }).catch(() => {})
}

/* ================= 启动 ================= */

window.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    console.error('[boot]', err)
    document.body.innerHTML = '<pre style="padding:24px;color:#e5484d;font-size:13px">启动失败：\n' + esc(err.stack || err.message) + '</pre>'
  })
})
