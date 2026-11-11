'use strict'
/* 应用主控：状态、视图切换、交互接线 */

function lyricCachePut(id, entry) {
  state.lyricCache.set(id, entry)
  // v2.8.7：加上限，长会话不再无限增长
  if (state.lyricCache.size > 50) state.lyricCache.delete(state.lyricCache.keys().next().value)
}

let maxIntent = 0
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
  historyId: null,       // 最近一条已写入历史的曲目 id（去重，见 state-change 处理）
  gainsCleared: false,   // 分析途中点了「清除分析数据」→ 收尾时不要再写回
  consecutiveFails: 0, // 连续播放失败次数（>=3 停止自动跳过）
  autoSkipping: false,
  skipTimer: null,
  mini: false,           // 迷你模式（窗口尺寸由主进程管，这里管布局）
  exclusive: false,      // 独占输出（mpv 后端）是否生效
  exclusiveFellBack: false, // mpv 已自行回退到 WASAPI 共享（后端仍是 mpv，不再是位完美）
  audioGraphReady: false,   // WebAudio 链是否真的建起来了（EQ / 音量均衡 / 频谱的唯一生效前提）
  resumePos: {},         // 长音轨断点位置 {trackId: 秒}（v1.6）
  restoringSession: false,// 正在恢复上次会话（此时不要叠加断点续播）
  selected: new Set(),   // 列表多选（v1.7）
  selAnchor: null,       // Shift 范围选的起点下标
  sessionTimer: null
}

let player = null
let audio = null

/* ================= 启动 ================= */

/**
 * 拉取首屏所需数据并落到 state。
 * 主进程若正在建库，lib:list 会等它结束；超过 400ms 先给个遮罩，避免空等白屏。
 * @returns {Promise<{tracks: Array, session: object|null}>}
 */
async function loadInitialData() {
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

  state.settings = settings || {}
  state.resumePos = Object.assign({}, (settings && settings.resumePos) || {})
  state.favorites = new Set(favs || [])
  state.history = hist || []
  state.playlists = playlists || []
  state.playCounts = counts || {}
  state.lyricOffset = (settings && settings.lyricOffset) || 0
  applySettings()
  return { tracks: tracks || [], session: session || null }
}

/**
 * 选音频引擎并建 Player（v1.5）。
 * 独占输出走 mpv + WASAPI exclusive，其余情况仍是原来的 HTML5 + WebAudio。
 * 独占起不来就退回共享输出，并把设置里的 exclusiveOutput 落成 false（下次启动不再白试）。
 */
async function createAudioEngine(settings) {
  let exclusiveOK = false
  if (settings.exclusiveOutput === true) {
    const r = await window.api.mpvStart(true).catch((err) => ({ ok: false, error: err && err.message }))
    if (r && r.ok) {
      exclusiveOK = true
      audio = new MpvAudio({ volume: settings.volume ?? 0.8 })
      audio.addEventListener('formatchange', updateHifiBadge)
      audio.addEventListener('fallback', () => {
        // 不依赖主进程载荷：MpvAudio 自身回退时也把运行时状态同步掉
        applyExclusiveFallback()
        toast('独占输出失败，已回退共享输出（不再是位完美）')
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
}

/**
 * 恢复上次会话的队列（不自动播放）。
 * restoringSession 期间不要叠加断点续播，否则会和会话位置打架。
 */
function restoreSession(session) {
  if (!session || !Array.isArray(session.queueIds) || !session.queueIds.length) return
  const queue = session.queueIds.map((id) => state.byId.get(id)).filter(Boolean)
  if (!queue.length) return
  // v3.3.17：优先按 currentId 定位。队列里有被过滤掉的在线曲时，index 已经错位，
  // 按 index 取会让「当前曲」变成别的歌，currentTime 也被 seek 进错误的文件。
  let startIndex = session.index || 0
  let seekTo = session.currentTime
  if (session.currentId) {
    const byId = queue.findIndex((t) => t.id === session.currentId)
    if (byId >= 0) startIndex = byId
    else { startIndex = 0; seekTo = 0 }   // 上次那首已经不在队列里，别把进度用到别的歌上
  }
  // 第四轮 §4.3 #2：queue 已被 filter(Boolean) 压缩过，原始 index 可能越界 ——
  // 以前只判 currentId，没有 currentId 的旧会话会直接用未压缩的 index 索引压缩后的队列，
  // 恢复出来的「当前曲」是别的歌，概率性地每次启动都错。
  if (!(startIndex >= 0) || startIndex >= queue.length) { startIndex = 0; seekTo = 0 }
  state.restoringSession = true
  player.setQueue(queue, startIndex, false)
  state.restoringSession = false
  player.mode = session.mode || 'list'
  UI.setMode(player.mode)
  if (seekTo) {
    // 第四轮 §4.3 #3：once 监听挂在 audio 上没有取消路径 —— 用户在这个事件到达前切歌，
    // once 会被新曲消费，把上一首的进度 seek 进新歌（独占下 MpvAudio 的 setter 直接 mpvSeek）。
    // 记下目标曲目，回调里比对，代次不符就丢弃。
    const expectId = queue[startIndex] ? queue[startIndex].id : ''
    const onMeta = () => {
      const curId = player.current ? player.current.id : ''
      if (expectId && curId !== expectId) return
      try { audio.currentTime = seekTo } catch (e) { /* 时长未知时忽略 */ }
    }
    audio.addEventListener('loadedmetadata', onMeta, { once: true })
  }
}

/**
 * 退出钩子与定时落盘。
 * 本地版没有联网下载任务，退出前用 flushSaveSettingsForExit() 把挂起的设置同步刷掉。
 */
function setupExitHooks() {
  window.addEventListener('beforeunload', () => {
    // 第四轮 §4.3（退出链）：浏览器不等 Promise，这里只能「发起」；
    // 真正保证写盘的是 btnClose 的串行 await 与主进程关窗时的兜底 flush
    try { saveSession() } catch (e) { /* 忽略 */ }
    flushSaveSettingsForExit().catch(() => {})
  })
  setInterval(saveSession, 10000)
}

async function boot() {
  UI.init()

  // 上次退出时是迷你模式 → 先在界面侧切好布局，别让 320px 宽的窗口里闪一下完整界面
  state.mini = await window.api.isMini().catch(() => false)
  UI.setMini(state.mini)

  const { tracks, session } = await loadInitialData()
  await createAudioEngine(state.settings)
  setTracks(tracks)

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
    else {
      clearInterval(powerCountdownTimer)
      powerCountdownTimer = null
      // 主进程执行关机/休眠失败时会把错误带回来（组策略禁用、权限不足）
      if (p && p.error) toast(p.error, 6000)
    }
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
  UI.setLyricPanelVisible(state.settings.showLyricPanel !== false)
  UI.setNorm(state.settings.normalizeVolume === true)
  updateHifiBadge()
  showReleaseNotice()
  window.api.dlyricIsOpen().then((open) => {
    UI.setDLyric(open, open && state.settings.desktopLyric && state.settings.desktopLyric.locked)
  }).catch(() => {})
  // 歌词窗口那边改了锁定/自行关闭，主进程会推最新状态过来
  window.api.onDlyricOpenState((st) => {
    const open = st && typeof st === 'object' ? !!st.open : !!st
    const locked = st && typeof st === 'object' ? !!st.locked : false
    if (typeof st === 'object' && st.locked !== undefined) {
      state.settings.desktopLyric = { ...(state.settings.desktopLyric || {}), locked: !!st.locked }
    }
    // 第四轮 §4.3 #1：浮窗自己关掉时也要把内存开关同步掉，否则当前会话就继续空推 IPC
    if (!open && state.settings.desktopLyric && state.settings.desktopLyric.enabled) {
      state.settings.desktopLyric = { ...state.settings.desktopLyric, enabled: false }
    }
    UI.setDLyric(open, open && locked)
  })
  updateNavCounts()
  renderPlaylists()

  restoreSession(session)
  switchView('all')

  if (!state.tracks.length) {
    UI.showEmpty('曲库为空，先扫描音乐文件夹')
    setTimeout(() => doScan(), 300)
  }

  window.api.onScanProgress(onScanProgress)
  window.api.onScanDone(onScanDone)
  window.api.onShortcut((action) => handleShortcut(action))
  // v2.8.10：独占输出被系统踢掉/自动夺回的用户提示
  // v2.8.12：同类 30 秒内只提示一次
  const aoToastAt = {}
  const aoToast = (type, msg, ms) => {
    const now = Date.now()
    if (aoToastAt[type] && now - aoToastAt[type] < 30000) return
    aoToastAt[type] = now
    toast(msg, ms)
  }
  window.api.onMpvEvent((e) => {
    if (!e) return
    if (e.type === 'fallback') {
      // 主进程独占失败自动回退共享（载荷带 exclusive:false）：同步运行时状态
      // 并刷新所有派生 UI，否则 state.exclusive 残留 true 会误命中独占分支
      applyExclusiveFallback()
    } else if (e.type === 'ao-lost') aoToast('ao-lost', '独占输出被系统中断（可能是游戏启动改了音频设备），正在自动恢复…', 5000)
    else if (e.type === 'ao-recovered') {
      // v3.3.20：看门狗夺回独占说明 AO 已经正常工作，回退标记必须复位 ——
      // 否则一次 ao-lost 之后，后续所有 error 都按「单曲坏了」处理并自动跳曲，
      // 而真正掉设备时应该停下来提示（error 分支靠这个标记分流）
      if (state.exclusiveFellBack) { state.exclusiveFellBack = false; updateHifiBadge() }
      aoToast('ao-recovered', '独占输出已恢复', 2500)
    }
    else if (e.type === 'exclusive-lost') aoToast('exclusive-lost', e.message || '自动夺回独占失败：设备被其他程序占用', 6000)
  })
  // v2.8.9：第二实例带来的关联文件 —— 单文件导入尚未实现，先给出可见反馈
  window.api.onOpenFiles((p) => {
    const paths = (p && p.paths) || []
    if (!paths.length) return
    toast('收到 ' + paths.length + ' 个文件：单文件导入开发中，请先把文件所在文件夹加进曲库', 6000)
  })
  // 外面改了当前这首的 .lrc（main 的 fs.watch 推过来）→ 立刻重读重画
  if (window.api.onLyricChanged) {
    window.api.onLyricChanged((id) => {
      if (id !== state.currentId) return
      state.lyricCache.delete(id)
      const cur = player && player.current
      if (cur && cur.id === id) loadLyric(cur)
    })
  }
  // 睡眠定时到点：player.pause() 会走正常的淡出，不会突然静音（v1.7）
  window.api.onSleepTimer(() => {
    if (player && player.isPlaying) player.pause()
    toast('睡眠定时已到，播放已暂停', 4000)
  })
  // 睡眠定时状态（v2.2：入口从托盘移到 app 内播放条）
  window.api.getSleepState().then((st) => renderSleepState(st)).catch(() => {})
  window.api.onSleepState((st) => renderSleepState(st))
  // 托盘/快捷键改迷你状态时，主进程会推过来，界面跟着切
  window.api.onMiniState((st) => {
    state.mini = !!(st && st.mini !== undefined ? st.mini : st)
    UI.setMini(state.mini)
  })

  setupExitHooks()

  // v2.8.7：isMaximized 是 IPC 函数，直接放条件里恒为真 —— 必须真的调一次
  // 异步回调可能晚于用户点击落地，用意图 token 比对，token 变了就别用启动时的旧状态覆盖图标
  const maxToken = maxIntent
  window.api.isMaximized().then((max) => {
    if (maxToken !== maxIntent) return
    document.getElementById('btnMax').innerHTML = icon(max ? 'restore' : 'max')
  }).catch(() => {})
}

/** 当前曲目的歌词偏移（v1.7）：优先本曲设置，没有则用全局默认 */
function offsetFor(id) {
  const map = (state.settings && state.settings.lyricOffsetById) || {}
  if (id && map[id] != null) return Number(map[id]) || 0
  return Number(state.settings && state.settings.lyricOffset) || 0
}

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
    sortDir: state.sortDir,
    selected: state.selected             // v3.3.22 虚拟滚动：重画可视窗口时带上选中态
  })
}

/* ================= 播放接线 ================= */

/** 取消「失败自动跳曲」的挂起定时器（切歌/手动操作时调用，防连跳叠加） */
function cancelSkipTimer() {
  if (state.skipTimer) { clearTimeout(state.skipTimer); state.skipTimer = null }
}

function bindPlayer() {
  player.on('track-change', (track) => {
    state.currentId = track.id
    state.counted = false
    // 只有「用户手动切歌 / 重新选曲」才清零连续失败计数；失败自动跳曲的
    // track-change 保留计数，否则「连跳 3 首就停」的保底永远凑不满。
    // 真正播过 3 秒也会清（见下面 time 处理器）。
    if (!state.autoSkipping && state.consecutiveFails) state.consecutiveFails = 0
    cancelSkipTimer()
    state.lastErrKey = null        // 换曲后允许重新记错误
    resetAb()                       // A-B 是"这一首之内"的事，换歌就作废
    updateMediaSession(track)
    applyTrackGain(track.id)
    UI.renderNowPlaying(track, player.isPlaying)
    UI.setPlayIcon(player.isPlaying)
    UI.setFavorite(state.favorites.has(track.id))
    UI.setRowPlaying(track.id, true)
    loadLyric(track)
    // v3.3.17：历史挪到「真的开播」时写（见 state-change 处理）。
    // track-change 在 autoplay=false 时也会触发（启动恢复会话、扫描后重建队列），
    // 以前那些没播过的歌也会进「最近播放」。
    state.currentId = track.id
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
    // 真正开始播放时才记一条历史（track-change 也会在仅加载时触发）
    if (playing && player.current && state.historyId !== player.current.id) {
      const id = player.current.id
      state.historyId = id
      window.api.addHistory(id).catch(() => {})
      state.history = [{ id, at: Date.now() }]
        .concat(state.history.filter((h) => h.id !== id)).slice(0, 300)
      updateNavCounts()
      if (state.view === 'recent') renderView()
    }
    UI.setPlayIcon(playing)
    // v3.3.7：renderQueue 的输出只跟 tracks/index/currentId 有关，播放/暂停
    // 不改变它 —— 以前每次暂停/恢复都全量重建队列 innerHTML（滚动位置丢失）
    if (player.current) UI.renderNowPlaying(player.current, playing)
    pushDesktopLyric()
    if (!playing) {
      // 失败自动跳曲窗口内暂停/拖进度/睡眠定时到点：立刻撤掉待跳定时器，
      // 否则 400/500ms 后仍会强切下一首、打断用户暂停
      cancelSkipTimer()
      saveSession()
    }
    // 任务栏缩略图的播放/暂停按钮要跟着变
    window.api.setPlayState(playing)
    syncMediaSessionState(playing)
    // 独占模式下 mpv 不是 <audio>，得另外挂一条静音流让 Windows 上出现媒体会话
    keepAliveMediaSession(playing)
  })

  player.on('time', (cur, dur) => {
    // 播过 3 秒 = 真的在出声，连续失败计数清零（计数只认「没播出来」）
    if (cur > 3 && state.consecutiveFails) state.consecutiveFails = 0
    UI.setProgress(cur, dur)
    UI.updateLyricIndex(cur + state.lyricOffset)
    pushDesktopLyric()
    enforceAbLoop(cur)
    if (state.ab.a != null) updateAbUi()
    updateMediaPosition(cur, dur)
    // 播放到 30s 或一半计入播放次数
    // v3.3.17：dur 为 0 时不能计数 —— Math.min(30, 0*0.9) === 0 会让
    // `cur >= 0` 恒真，独占后端把 _duration 清零后第一帧就记一次播放，
    // 「最常播放」与播放次数全量失真，且 counted 立刻置真、后面真听完也不再计。
    if (!state.counted && player.current && dur > 0) {
      const half = dur > 60 ? dur * 0.5 : 30
      if (cur >= Math.min(half, dur * 0.9)) {
        state.counted = true
        const id = player.current.id
        window.api.incPlayCount(id).then((n) => {
          state.playCounts[id] = n
          // 正在看「最常播放」时顺序会变，立即重排
          if (state.view === 'most') renderView()
        }).catch(() => {})
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
    // 同一首歌的重复报错只处理一次（mpvaudio 对同一文件可能连发
    // error / file-error 两类事件，不去重会一次失败跳两首）
    if (cur && state.lastErrKey === cur.id && Date.now() - state.lastErrAt < 2000) return
    if (cur) { state.lastErrKey = cur.id; state.lastErrAt = Date.now() }

    // 独占模式下多半是声卡/引擎问题，不是文件坏了：绝不自动跳曲。
    // （v3.3.18 起回退共享只置 state.exclusiveFellBack，后端仍是 mpv，判据不变）
    // v3.3.20：已经回退共享时，mpv 后端本身能正常出声，这时的 error 就是「这一首坏了」，
    // 再按独占处理会把队列永久卡在这一首（audit-main 第 7 条）。
    if (state.exclusive && !state.exclusiveFellBack) {
      toast('音频输出失败：' + ((audio && audio.lastError) || '设备不可用，已暂停'))
      player.pause()
      return
    }

    // 在线 / 本地统一计数：连续 3 首放不出来就停，防止移动硬盘掉线、
    // 格式不支持时每 400ms 一首无限连跳。跳曲一律走 skipToNext()：
    // 它强制 index+1、忽略 single 模式、且不会 emit queue-end 误触发「播完关机」。
    state.consecutiveFails = (state.consecutiveFails || 0) + 1
    if (state.consecutiveFails >= 3) {
      cancelSkipTimer()
      // force 绕过全局 toast 的 30s 同类去重：手动切歌清零后再次连败也要提示
      if (state.consecutiveFails === 3) toast('连续多首无法播放，已停止自动跳过', 4000, true)
      player.pause()
      return
    }

    toast(cur && cur.online
      ? '这首在线歌曲放不出来（版权或音源失效），已跳过'
      : (cur && cur.isDsd
        ? 'DSD 文件需要独占输出才能播放：点标题栏波形按钮开启（已跳过）'
        : '该歌曲无法播放，已跳过'),
      cur && cur.isDsd ? 4000 : (cur && cur.online ? 2500 : 1800))

    // 排定时器前先清掉旧的，避免多次失败叠加多个定时器
    cancelSkipTimer()
    state.skipTimer = setTimeout(() => {
      state.skipTimer = null
      if (!player.isPlaying) return    // 用户在等待窗口里暂停了就别再强跳
      state.autoSkipping = true
      try { player.skipToNext() } finally { state.autoSkipping = false }
    }, cur && cur.online ? 500 : 400)
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

/* ================= 歌词 ================= */

async function loadLyric(track) {
  // v2.8.7：用这首歌自己的偏移（没有才落回全局）。以前写死全局值，
  // 「外部改 .lrc → lyric:changed → loadLyric」会把单独设过的偏移覆盖掉
  state.lyricOffset = offsetFor(track ? track.id : null)
  UI.setLyricOffset(state.lyricOffset)
  // v2.8.3：不再用扫描时的 hasLyric 决定「有没有词」——扫描之后才放进去的 .lrc
  // 会让这个标记一直是 false，歌词永远出不来。直接读文件，没有就是没有。
  // 每次播放都读一次（几 KB 小文件）+ mtime 校验，外面改完歌词不用重启。
  const res = await window.api.readLyric(track.id).catch(() => null)
  if (track.id !== state.currentId) return
  const hit = state.lyricCache.get(track.id)
  let parsed
  if (res && hit && hit.mtime === res.mtimeMs) {
    parsed = hit.parsed
  } else {
    parsed = res && res.text ? parseLrc(res.text) : null
    lyricCachePut(track.id, { parsed, mtime: res ? res.mtimeMs : 0 })
  }
  if (track.id !== state.currentId) return
  UI.renderLyric(parsed, track.title)
  UI.updateLyricIndex(audio.currentTime + state.lyricOffset)
  pushDesktopLyric(true)
}

/* ================= UI 接线 ================= */

/**
 * 交互接线总入口。
 * 以前是一个 400+ 行的巨型函数，改一个按钮都要在整段里找；
 * 现在按界面区域拆成若干 bindXxx()，调用顺序与原注册顺序完全一致。
 */
function bindUI() {
  bindSearch()
  bindPlaylistUi()
  bindTrackListUi()
  bindLyricUi()
  bindTransportUi()
  bindDeviceUi()
  bindEqUi()
  bindPopupUi()
  bindWindowUi()
}

/** 搜索框（输入去抖 + 清除按钮） */
function bindSearch() {
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
}

/** 侧边栏：导航、新建/导入歌单、歌单右键与改名弹窗 */
function bindPlaylistUi() {
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
    let pl
    try { pl = await window.api.createPlaylist(name) }
    catch (err) { toast('新建歌单失败：' + (err.message || err), 2500); return }
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

}

/** 曲目列表：点选播放 / Ctrl·Shift 多选 / 右键菜单 / 表头排序 / 扫描入口 */
function bindTrackListUi() {
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

}

/** 歌词面板：显隐、字号、每曲偏移、点行跳转 */
function bindLyricUi() {
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

}

/** 播放控制条：播放/上下曲/模式/收藏/进度/音量/音量均衡开关 */
function bindTransportUi() {
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
  // 进度条拖动
  bindProgressBar(document.getElementById('progressBar'))

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
    if (eqBlocked()) { toast(EQ_BLOCKED_MSG); return }
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
    if (eqBlocked()) { toast('响度分析需要 WebAudio 链：当前输出下不可用'); return }
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

}

/** 独占输出相关入口：桌面歌词按钮、位完美开关、设备面板、高精度音量 */
function bindDeviceUi() {
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

}

/** 均衡器面板：开关 / 预设 / 滑块（拖动实时生效，双击归零） */
function bindEqUi() {
  // 均衡器面板（独占输出下禁用：任何软件处理都会破坏位完美）
  document.getElementById('btnEq').addEventListener('click', (e) => {
    e.stopPropagation()
    if (eqBlocked()) { toast(EQ_BLOCKED_MSG); return }
    UI.toggleEq()
  })

  // 睡眠定时面板（v2.2：入口从托盘移到 app 内播放条）
  document.getElementById('btnSleep').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleSleepPanel()
  })
  document.getElementById('btnSleepClose').addEventListener('click', () => toggleSleepPanel(false))
  document.getElementById('sleepOpts').addEventListener('click', (e) => {
    const chip = e.target.closest('.sp-chip')
    if (!chip) return
    const min = Number(chip.dataset.min) || 0
    window.api.setSleepTimer(min).then((st) => renderSleepState(st)).catch(() => {})
    toast(min > 0 ? '睡眠定时：' + min + ' 分钟后暂停播放' : '睡眠定时已关闭')
  })
  document.getElementById('btnEqClose').addEventListener('click', () => UI.toggleEq(false))
  document.getElementById('btnEqPower').addEventListener('click', () => {
    // v3.3.18（P1 #8）：滑块虽已 el.disabled，按钮仍是可点的，这里补齐早退
    if (eqBlocked()) { toast(EQ_BLOCKED_MSG); return }
    const cfg = eqSettings()
    cfg.enabled = !cfg.enabled
    applyEq(cfg)
    toast(cfg.enabled ? '均衡器已开启' : '均衡器已关闭')
  })
  document.getElementById('btnEqFlat').addEventListener('click', () => {
    if (eqBlocked()) { toast(EQ_BLOCKED_MSG); return }
    applyEq({ enabled: eqSettings().enabled, preset: 'flat', bands: EQ_PRESETS.flat.bands.slice() })
  })
  document.getElementById('eqPresets').addEventListener('click', (e) => {
    const chip = e.target.closest('.eq-chip')
    if (!chip) return
    if (eqBlocked()) { toast(EQ_BLOCKED_MSG); return }
    applyEqPreset(chip.dataset.preset)
  })
  // 滑块：input 拖动实时生效（applyEq 内部 300ms 去抖落盘）
  const onEqSlider = (e) => {
    const el = e.target
    if (!el.matches || !el.matches('#eqBands input[type="range"]')) return
    if (eqBlocked()) return
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

}

/** 浮层与全局点击：队列面板、A-B 循环、拖拽、"点外部收起"、右键菜单动作分发 */
function bindPopupUi() {
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
    // v3.3.17：分发处没有 catch，任何一个动作失败都会变成 unhandledRejection，
    // 用户看到的是「点了菜单没反应」且没有任何提示
    handleCtxAction(e.detail.act, e.detail.arg).catch((err) => {
      console.error('[ctx]', err)
      toast('操作失败：' + ((err && err.message) || err))
    })
  })

}

/** 窗口控制：最小化/最大化/关闭、标题栏双击、迷你模式切换 */
function bindWindowUi() {
  // 窗口控制
  document.getElementById('btnMin').addEventListener('click', () => window.api.minimize().catch(() => {}))
  document.getElementById('btnMax').addEventListener('click', async () => {
    maxIntent++                       // 作废启动时 isMaximized 的异步回调
    const max = await window.api.toggleMaximize().catch(() => null)
    if (max == null) return
    document.getElementById('btnMax').innerHTML = icon(max ? 'restore' : 'max')
  })
  // v2.8.26：主进程事件推送最大化状态（含外部贴边最大化/快速连点兜底）
  if (window.api.onMaxState) {
    window.api.onMaxState((max) => {
      document.getElementById('btnMax').innerHTML = icon(max ? 'restore' : 'max')
    })
  }
  document.getElementById('btnClose').addEventListener('click', async () => {
    // 第四轮 §4.3（退出链）：必须串行等待 —— 以前发完 flush 立刻关窗，
    // 最后 300ms 内的设置改动（去抖未落盘的那批）直接丢掉
    try { saveSession() } catch (e) { /* 忽略 */ }
    await flushSaveSettingsForExit()
    await window.api.closeWindow().catch(() => {})
  })

  // 双击标题栏最大化
  document.getElementById('titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('.no-drag')) return
    document.getElementById('btnMax').click()
  })

  // 迷你模式
  document.getElementById('btnMini').addEventListener('click', () => toggleMini(true))
  document.getElementById('miniRestore').addEventListener('click', () => toggleMini(false))
  document.getElementById('miniMin').addEventListener('click', () => window.api.minimize().catch(() => {}))
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
  bindProgressBar(document.getElementById('mvBar'))
}

/**
 * 进度条拖拽：完整播放条与迷你卡片共用同一套提交/预览/回弹逻辑。
 * duration 每次实时读（切歌瞬间还没更新过）。
 */
function bindProgressBar(el) {
  bindBar(el,
    (ratio) => player.seekRatio(ratio),
    (ratio) => UI.setProgress(ratio * (audio.duration || 0), audio.duration || 0),
    () => UI.setProgress(audio.currentTime, audio.duration || 0)
  )
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
  // 第四轮 §4.4 #4：pointercancel（滚动/手势打断）以前与 pointerup 共用 end()，
  // 会把「取消」当成一次真实提交 → 非预期 seek / 音量突变
  const end = (e, commit) => {
    if (!dragging) return
    dragging = false
    try { el.releasePointerCapture(e.pointerId) } catch {}
    if (commit) onCommit(ratioOf(e))
    onReset()
  }
  el.addEventListener('pointerup', (e) => end(e, true))
  el.addEventListener('pointercancel', (e) => end(e, false))
}

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
    // v3.3.17：同时记当前曲 id。恢复时队列里有已下架的在线曲（或曲库被扫描删曲），
    // 只按 index 取会落到错误的歌上，进度还会被 seek 进那个错的文件。
    currentId: cur ? cur.id : null,
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
