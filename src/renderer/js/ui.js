'use strict'
/* 视图渲染层：只负责把状态画到 DOM，不做业务决策 */

/* 虚拟滚动参数：行高必须与 css .tr 的 height 严格一致（40px + 水平 margin 不影响垂直） */
const TABLE_ROW_H = 40
const TABLE_VBUF = 8   // 可视区上下各多渲染 8 行缓冲，滚动时不露白

const UI = {
  els: {},

  init() {
    const ids = [
      'searchInput', 'searchClear', 'btnScan', 'btnLyricToggle', 'btnMin', 'btnMax', 'btnClose',
      'cntAll', 'cntFav', 'cntRecent', 'cntMost', 'cntFolders', 'cntAlbums', 'cntAdded', 'playlistList', 'btnNewPlaylist', 'libStat',
      'viewHeader', 'vhCover', 'vhTitle', 'vhSub', 'btnPlayAll', 'btnShuffleAll', 'btnPlaylistRemove',
      'tableHead', 'tableBody', 'emptyState', 'emptyText', 'btnEmptyScan',
      'scanOverlay', 'scanTitle', 'scanBar', 'scanSub',
      'lyricPanel', 'lpCover', 'lpTitle', 'lpArtist', 'lpLyrics', 'lpOffset',
      'btnLyricSmaller', 'btnLyricBigger', 'btnLyricEarlier', 'btnLyricLater',
      'pbCover', 'pbTitle', 'pbArtist', 'btnFav', 'btnMode', 'btnPrev', 'btnPlay', 'btnNext', 'btnQueue',
      'tCur', 'tDur', 'progressBar', 'progressFill', 'progressDot',
      'btnMute', 'volBar', 'volFill', 'volDot', 'volVal',
      'queuePanel', 'queueBody', 'btnQueueClose', 'ctxMenu', 'toast',
      'dirModal', 'dirList', 'btnDirAdd', 'btnDirSave', 'btnDirClose',
      'btnNorm', 'btnDLyric',
      'btnEq', 'eqPanel', 'eqPresets', 'eqBands', 'btnEqPower', 'btnEqClose', 'btnEqFlat', 'spectrum',
      'btnAb', 'abMarkA', 'abMarkB',
      'btnMini', 'miniView', 'mvCover', 'mvTitle', 'mvArtist', 'mvLyric',
      'mvCur', 'mvDur', 'mvBar', 'mvFill', 'mvDot',
      'mvMode', 'mvPrev', 'mvPlay', 'mvNext', 'mvFav',
      'miniRestore', 'miniMin', 'miniClose',
      'btnHifi', 'hifiBadge',
      'logo',
      'fsView', 'fsClose', 'fsCover', 'fsTitle', 'fsArtist', 'fsQ', 'fsLyric',
      'fsCur', 'fsDur', 'fsBar', 'fsFill', 'fsDot',
      'fsMode', 'fsPrev', 'fsPlay', 'fsNext', 'fsFav'
    ]
    for (const id of ids) this.els[id] = document.getElementById(id)
    // v3.3.20：CSP 是 script-src 'self'，内联 onerror 全被拦掉，封面读不出来时
    // 只能靠这里收掉裂图。img 的 error 事件不冒泡，必须用捕获阶段的委托。
    document.addEventListener('error', (e) => {
      const t = e.target
      if (!t || t.tagName !== 'IMG') return
      t.remove()
    }, true)
    return this.els
  },

  /* ---------------- 侧边栏 ---------------- */

  setActiveNav(view) {
    $$('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view)
    })
    $$('#playlistList .nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.playlist === view)
    })
  },

  renderNavCounts({ all, fav, recent, most, folders, albums, added }) {
    this.els.cntAll.textContent = all
    this.els.cntFav.textContent = fav
    this.els.cntRecent.textContent = recent
    this.els.cntMost.textContent = most
    this.els.cntFolders.textContent = folders
    this.els.cntAlbums.textContent = albums
    if (this.els.cntAdded) this.els.cntAdded.textContent = added == null ? 0 : added
  },

  renderPlaylists(playlists) {
    const box = this.els.playlistList
    if (!playlists.length) {
      box.innerHTML = '<div class="nav-item" style="color:var(--txt-3);cursor:default;font-size:12px;padding-left:10px">还没有歌单</div>'
      return
    }
    box.innerHTML = playlists.map((p) => `
      <div class="pl-item" data-playlist="${esc(p.id)}">
        <a class="nav-item" data-view="${esc(p.id)}" data-playlist="${esc(p.id)}" title="${esc(p.name)}">
          ${icon('album')}<span>${esc(p.name)}</span><b>${p.trackIds ? p.trackIds.length : 0}</b>
        </a>
      </div>`).join('')
  },

  setLibStat(text) {
    this.els.libStat.textContent = text
  },

  /* ---------------- 头部 ---------------- */

  renderHeader({ title, sub, cover, showPlayAll, showRemove, isAlbum }) {
    this.els.vhTitle.textContent = title
    this.els.vhSub.textContent = sub
    if (cover) {
      this.els.vhCover.innerHTML = `<img src="${esc(cover)}" alt="" />`
    } else {
      this.els.vhCover.innerHTML = icon(isAlbum ? 'album' : 'music')
    }
    this.els.btnPlayAll.hidden = !showPlayAll
    this.els.btnShuffleAll.hidden = !showPlayAll
    this.els.btnPlaylistRemove.hidden = !showRemove
  },

  /* ---------------- 列表 ---------------- */

  /**
   * @param {Array} tracks 已排序过滤后的列表
   * @param {object} ctx {currentId, playing, favorites, playCounts, showCounts, sortKey, sortDir, selected}
   */
  renderTable(tracks, ctx) {
    const body = this.els.tableBody
    this._tTracks = tracks
    this._tCtx = ctx || {}
    this._tCurrentId = this._tCtx.currentId || null
    if (!tracks.length) {
      body.innerHTML = ''
      this._tStart = -1
      this._tEnd = -1
      return
    }
    // v3.3.22：虚拟滚动。曲库上千首时一次性拼 n 行 HTML 仍会让 DOM 节点数破万、
    // 切视图/搜索掉帧。改为只渲染可视区 ± 缓冲行，上下用占位 div 撑住总高度；
    // 滚动时 rAF 节流重画窗口。行高固定 40px（css .tr），事件委托（click/contextmenu/
    // dragstart 都挂在 tableBody 上）与 data-index 语义不变。
    if (!this._tScrollBound) {
      this._tScrollBound = true
      let raf = 0
      body.addEventListener('scroll', () => {
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          this._renderTableWindow(false)
        })
      })
    }
    // 与旧实现（innerHTML 重建后浏览器自动回顶）行为一致：切视图/排序/搜索回顶部
    if (body.scrollTop) body.scrollTop = 0
    this._tStart = -1
    this._tEnd = -1
    this._renderTableWindow(true)
  },

  /** 只重画可视窗口；内容总高不变，scrollTop 由占位 div 维持 */
  _renderTableWindow(force) {
    const body = this.els.tableBody
    const tracks = this._tTracks
    if (!tracks || !tracks.length) return
    const n = tracks.length
    const viewH = body.clientHeight || 600
    const start = Math.max(0, Math.floor(body.scrollTop / TABLE_ROW_H) - TABLE_VBUF)
    const end = Math.min(n, Math.ceil((body.scrollTop + viewH) / TABLE_ROW_H) + TABLE_VBUF)
    if (!force && start === this._tStart && end === this._tEnd) return
    this._tStart = start
    this._tEnd = end
    const ctx = this._tCtx
    const curId = this._tCurrentId != null ? this._tCurrentId : ctx.currentId
    const selected = ctx.selected
    const rows = new Array(end - start)
    for (let i = start; i < end; i++) {
      const t = tracks[i]
      const isCur = t.id === curId
      const isSel = selected && selected.has(t.id)
      // v2.8.25 UI 美化：行内小封面（无封面只留渐变占位块）+ 正在播放行的均衡器动画。
      // 两者都不改变行高（40px 虚拟滚动不变量）；封面 img 失败由 init 里的
      // error 捕获委托统一摘除，占位块天然兜底。
      const cv = `<span class="cv-mini">${t.cover ? `<img src="${esc(t.cover)}" loading="lazy" alt="" />` : ''}</span>`
      const eq = isCur ? '<span class="eq-bars"><i></i><i></i><i></i></span>' : ''
      rows[i - start] = `<div class="tr${isCur ? ' playing' : ''}${isSel ? ' selected' : ''}" data-id="${esc(t.id)}" data-index="${i}">
          <div class="c-idx">
            <span class="num" draggable="true" title="拖到左侧歌单可加入歌单">${i + 1}</span>
            <span class="btn-play-row">${icon('play')}</span>
          </div>
          <div class="c-title">${cv}${eq}
            <span class="tt">${esc(t.title)}</span>
            ${t.hasLyric ? '<span class="tag-lyric">词</span>' : ''}
            ${ctx.showCounts && ctx.playCounts && ctx.playCounts[t.id]
              ? `<span class="pc" title="播放 ${ctx.playCounts[t.id]} 次">${ctx.playCounts[t.id]}</span>` : ''}
          </div>
          <div class="c-artist">${esc(t.artist || '未知歌手')}</div>
          <div class="c-album">${esc(t.album || '—')}</div>
          <div class="c-fmt"><span class="badge${t.lossless ? ' lossless' : ''}">${esc(t.ext || '')}</span></div>
          <div class="c-q${isHires(t) ? ' hires' : ''}" title="${esc(qualityTitle(t))}">${esc(fmtQuality(t))}</div>
          <div class="c-dur">${fmtDuration(t.duration)}</div>
        </div>`
    }
    // 占位 div 不带 class，closest('.tr') 查不到，点空白走原有 clearSelection 分支
    body.innerHTML =
      `<div style="height:${start * TABLE_ROW_H}px"></div>` +
      rows.join('') +
      `<div style="height:${(n - end) * TABLE_ROW_H}px"></div>`
    this._markSortHeader(ctx.sortKey, ctx.sortDir)
  },

  _markSortHeader(key, dir) {
    $$('#tableHead [data-sort]').forEach((el) => {
      el.textContent = {
        artist: '歌手', album: '专辑', ext: '格式', duration: '时长', quality: '音质'
      }[el.dataset.sort] || el.dataset.sort
      if (el.dataset.sort === key) {
        el.textContent += dir === 'asc' ? ' ↑' : ' ↓'
        el.style.color = 'var(--accent)'
      } else {
        el.style.color = ''
      }
    })
  },

  setRowPlaying(id, playing) {
    // v3.3.22：虚拟滚动后可视窗口重画需要最新的当前曲 id（ctx 里的会过时）
    if (playing) this._tCurrentId = id
    else if (this._tCurrentId === id) this._tCurrentId = null
    $$('#tableBody .tr').forEach((el) => {
      el.classList.toggle('playing', el.dataset.id === id)
    })
  },

  renderTableHeadVisible(visible) {
    this.els.tableHead.hidden = !visible
  },

  /* ---------------- 空状态 / 扫描 ---------------- */

  showEmpty(text) {
    this.els.emptyState.hidden = false
    this.els.emptyText.textContent = text
    this.els.tableBody.hidden = true
  },

  hideEmpty() {
    this.els.emptyState.hidden = true
    this.els.tableBody.hidden = false
  },

  showScan(title = '正在扫描…', owner = '') {
    // 第四轮 §4.4：遮罩要带 owner 标记 —— 扫描与分析共用一块遮罩，
    // 谁先收尾谁就把它关掉，另一边的进度就看不见了（分析中途扫描 → 进度被盖掉）
    this.scanOwner = owner
    this.els.scanOverlay.hidden = false
    this.els.scanTitle.textContent = title
    this.els.scanBar.style.width = '0%'
    this.els.scanSub.textContent = ''
  },

  updateScan({ done, total, phase, name, label }) {
    if (phase === 'collect') {
      this.els.scanTitle.textContent = '正在收集文件…'
      this.els.scanSub.textContent = ''
      return
    }
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0
    this.els.scanTitle.textContent = `${label || '正在解析元数据'} ${done}/${total}`
    this.els.scanBar.style.width = pct + '%'
    this.els.scanSub.textContent = name || ''
  },

  hideScan(owner = '') {
    // 传了 owner 就只在「自己还持有遮罩」时才关，避免互踩
    if (owner && this.scanOwner && this.scanOwner !== owner) return
    this.scanOwner = ''
    this.els.scanOverlay.hidden = true
  },

  /* ---------------- 播放条基本信息 ---------------- */

  /**
   * 三处界面（完整播放条 / 歌词面板 / 迷你卡片）同时设置封面。
   * 无封面时退回音符图标；<img> 带 onerror 自清，避免裂图占位。
   */
  _setCovers(cover) {
    const html = cover ? `<img src="${esc(cover)}" alt="" />` : icon('music')
    this.els.pbCover.innerHTML = html
    this.els.lpCover.innerHTML = html
    this.els.mvCover.innerHTML = html
    // v2.8.25：全屏播放页第四处镜像
    if (this.els.fsCover) this.els.fsCover.innerHTML = html
  },

  /** 换按钮内的 svg 图标（主播放条与迷你卡片共用，名字需含 i- 前缀） */
  _setIcon(el, name) {
    if (!el) return
    const use = el.querySelector('svg use')
    if (use) use.setAttribute('href', '#' + name)
  },

  renderNowPlaying(track, playing) {
    if (!track) { this._clearNowPlaying(); return }
    // v3.3.7：同一首歌重复调用（播放/暂停都会触发）不再重建封面 <img> ——
    // 以前每次暂停/恢复都新建三处 <img>，浏览器重新解码加载，肉眼可见闪烁
    // v3.3.9：键带 cover —— 播放中后台扫描补到封面（同 id、cover 变了）也要刷新
    const npKey = track.id + '|' + (track.cover || '')
    const npChanged = npKey !== this._npKey
    this._npKey = npKey
    this._renderNowPlayingText(track)
    if (npChanged) {
      this._setCovers(track.cover)
      this.els.tDur.textContent = fmtDuration(track.duration)
      // v2.8.25：主题色「跟随封面」钩子（theme.js 提供，未加载时静默跳过）
      if (typeof Theme !== 'undefined') Theme.onTrack(track)
    }
    this.setPlayIcon(playing)
  },

  /** 有曲目时更新三处文案（封面与时长另算，见 renderNowPlaying） */
  _renderNowPlayingText(track) {
    const artist = track.artist || '未知歌手'
    this.els.pbTitle.textContent = track.title
    this.els.pbTitle.title = track.title
    this.els.pbArtist.textContent = artist
    this.els.lpTitle.textContent = track.title
    this.els.lpArtist.textContent = artist + (track.album ? ' · ' + track.album : '')
    this.els.mvTitle.textContent = track.title
    this.els.mvTitle.title = track.title + (track.artist ? ' — ' + track.artist : '')
    this.els.mvArtist.textContent = artist
    // v2.8.25：全屏播放页镜像文案 + 音质标签
    if (this.els.fsTitle) {
      this.els.fsTitle.textContent = track.title
      this.els.fsArtist.textContent = artist + (track.album ? ' · ' + track.album : '')
      const bits = []
      if (track.lossless) bits.push('无损')
      const q = fmtQuality(track)
      if (q) bits.push(q)
      this.els.fsQ.textContent = bits.join(' · ')
    }
  },

  /** 无曲目时的空态：三处一起清干净，避免残留上一首的封面/标题/提示 */
  _clearNowPlaying() {
    this._setCovers(null)
    this.els.pbTitle.textContent = '未在播放'
    this.els.pbTitle.title = ''
    this.els.pbArtist.textContent = '—'
    this.els.lpTitle.textContent = '未在播放'
    this.els.lpArtist.textContent = ''
    this.els.mvTitle.textContent = '未在播放'
    this.els.mvArtist.textContent = '—'
    this.els.mvTitle.title = ''
    this.els.mvLyric.textContent = ''
    if (this.els.fsTitle) {
      this.els.fsTitle.textContent = '未在播放'
      this.els.fsArtist.textContent = '—'
      this.els.fsQ.textContent = ''
      this.els.fsLyric.textContent = ''
    }
    this.els.tCur.textContent = '0:00'
    this.els.tDur.textContent = '0:00'
    this._npKey = null
    this.setPlayIcon(false)
  },

  setPlayIcon(playing) {
    const name = playing ? 'i-pause' : 'i-play'
    const title = playing ? '暂停' : '播放'
    this._setIcon(this.els.btnPlay, name)
    this.els.btnPlay.title = title
    this._setIcon(this.els.mvPlay, name)
    this.els.mvPlay.title = title
    // v2.8.25：全屏播放页镜像 + 行内均衡器动画暂停态
    if (this.els.fsPlay) {
      this._setIcon(this.els.fsPlay, name)
      this.els.fsPlay.title = title
    }
    document.querySelectorAll('#tableBody .tr.playing')
      .forEach((el) => el.classList.toggle('paused', !playing))
  },

  setFavorite(isFav) {
    const title = isFav ? '取消收藏' : '收藏'
    this.els.btnFav.classList.toggle('on', isFav)
    this.els.btnFav.title = title
    this.els.mvFav.classList.toggle('on', isFav)
    this.els.mvFav.title = title
    if (this.els.fsFav) {
      this.els.fsFav.classList.toggle('on', isFav)
      this.els.fsFav.title = title
    }
  },

  setProgress(cur, dur) {
    const ratio = dur > 0 ? Math.max(0, Math.min(1, cur / dur)) : 0
    const pct = (ratio * 100).toFixed(2) + '%'
    this.els.progressFill.style.width = pct
    this.els.progressDot.style.left = pct
    this.els.tCur.textContent = fmtTime(cur)
    this.els.tDur.textContent = fmtDuration(dur || 0)
    this.els.mvFill.style.width = pct
    this.els.mvDot.style.left = pct
    this.els.mvCur.textContent = fmtTime(cur)
    this.els.mvDur.textContent = fmtDuration(dur || 0)
    // v2.8.25：全屏播放页镜像进度
    if (this.els.fsFill) {
      this.els.fsFill.style.width = pct
      this.els.fsDot.style.left = pct
      this.els.fsCur.textContent = fmtTime(cur)
      this.els.fsDur.textContent = fmtDuration(dur || 0)
    }
  },

  setVolume(v, muted) {
    const pct = (muted ? 0 : v * 100).toFixed(1) + '%'
    this.els.volFill.style.width = pct
    this.els.volDot.style.left = pct
    this.els.volVal.textContent = muted ? '静音' : Math.round(v * 100)
    this._setIcon(this.els.btnMute, muted || v === 0 ? 'i-volume-off' : 'i-volume')
  },

  setMode(mode) {
    // 未知模式名直接忽略：拼出 '#undefined' 会把图标清空
    if (!MODE_ICON[mode]) return
    for (const el of [this.els.btnMode, this.els.mvMode, this.els.fsMode]) {
      if (!el) continue
      this._setIcon(el, MODE_ICON[mode])
      el.title = MODE_LABEL[mode]
      el.classList.toggle('on', mode !== 'list')
    }
  },

  /** 切换迷你布局（窗口缩放由主进程负责，这里只管界面） */
  setMini(on) {
    const mini = !!on
    document.body.classList.toggle('mini', mini)
    this.els.miniView.hidden = !mini
  },

  /* ---------------- 全屏播放页（v2.8.25） ---------------- */

  /** show=true 显示 / false 隐藏 / 省略=切换。返回操作后的可见状态 */
  setFullscreen(show) {
    const el = this.els.fsView
    if (!el) return false
    const willShow = show == null ? !el.classList.contains('open') : !!show
    el.classList.toggle('open', willShow)
    return willShow
  },

  isFullscreen() {
    const el = this.els.fsView
    return !!(el && el.classList.contains('open'))
  },

  /* ---------------- 均衡器 ---------------- */

  /** 建立预设按钮 + 10 个竖滑块（只建一次） */
  initEq() {
    const presetBox = this.els.eqPresets
    presetBox.innerHTML = Object.entries(EQ_PRESETS)
      .map(([key, p]) => `<button class="eq-chip" data-preset="${key}">${esc(p.label)}</button>`)
      .join('')

    const bandBox = this.els.eqBands
    bandBox.innerHTML = EQ_FREQ_LABEL.map((label, i) => `
      <div class="eq-band" data-i="${i}">
        <span class="eq-db" id="eqDb${i}">0</span>
        <div class="eq-slot">
          <input type="range" min="-${EQ_MAX_DB}" max="${EQ_MAX_DB}" step="0.5" value="0" data-i="${i}" aria-label="${label}Hz" />
        </div>
        <span class="eq-freq">${label}</span>
      </div>`).join('')
  },

  /** 把设置同步到界面：开关状态、预设高亮、滑块位置与数值 */
  renderEq(cfg) {
    const enabled = !!(cfg && cfg.enabled)
    const bands = cfg && Array.isArray(cfg.bands) ? cfg.bands : []
    const preset = (cfg && cfg.preset) || 'flat'

    this.els.btnEq.classList.toggle('on', enabled)
    if (!this.eqDisabled) this.els.btnEq.title = enabled ? '均衡器：开' : '均衡器'
    const pw = this.els.btnEqPower
    pw.classList.toggle('on', enabled)
    pw.textContent = enabled ? '已开启' : '已关闭'

    $$('#eqPresets .eq-chip').forEach((el) => {
      el.classList.toggle('on', el.dataset.preset === preset)
    })

    $$('#eqBands input[type="range"]').forEach((el) => {
      const i = Number(el.dataset.i)
      const v = Number(bands[i]) || 0
      if (Number(el.value) !== v) el.value = String(v)
      el.disabled = this.eqDisabled
      const db = this.els['eqDb' + i] || document.getElementById('eqDb' + i)
      if (db) {
        db.textContent = (v > 0 ? '+' : '') + (Number.isInteger(v) ? v : v.toFixed(1))
        db.classList.toggle('pos', v > 0)
      }
    })
  },

  /** show=true 显示 / false 隐藏 / 省略=切换。返回操作后的可见状态 */
  toggleEq(show) {
    const el = this.els.eqPanel
    const willShow = show == null ? el.hidden : !!show
    el.hidden = !willShow
    return willShow
  },

  /** 音量均衡按钮状态 */
  setNorm(on) {
    this.els.btnNorm.classList.toggle('on', !!on)
    if (this.eqDisabled) {
      this.els.btnNorm.title = '独占输出下不可用（会破坏位完美）'
      return
    }
    this.els.btnNorm.title = on ? '音量均衡：开（右键分析曲库响度）' : '音量均衡：关'
  },

  /* ---------------- 独占输出（位完美） ---------------- */

  eqDisabled: false,

  /** 独占输出下禁用 EQ / 音量均衡按钮
   *  v3.3.18（第四轮 P1 #8）：除了加 .disabled class，还要真的把 10 个滑块设成
   *  el.disabled = true —— css/app.css 的「禁用态」仍然可点，以前拖滑块会走到
   *  applyEq（因 !ctx 早退）但 renderEq + saveSettings 照常执行，白污染 settings.json。
   */
  setEqDisabled(disabled) {
    this.eqDisabled = !!disabled
    for (const id of ['btnEq', 'btnNorm']) {
      const el = this.els[id]
      if (!el) continue
      el.classList.toggle('disabled', this.eqDisabled)
    }
    // 滑块与预设 chip 一并真正禁用
    $$('#eqBands input[type="range"]').forEach((el) => { el.disabled = this.eqDisabled })
    $$('#eqPresets .eq-chip').forEach((el) => { el.disabled = this.eqDisabled })
    if (this.els.btnEqPower) this.els.btnEqPower.disabled = this.eqDisabled
    if (this.eqDisabled) {
      this.els.btnEq.title = '独占输出下不可用（会破坏位完美）'
      this.els.btnNorm.title = '独占输出下不可用（会破坏位完美）'
    } else {
      // 独占失败回退共享后要恢复可用提示，别残留「独占下不可用」
      this.els.btnEq.title = this.els.btnEq.classList.contains('on') ? '均衡器：开' : '均衡器'
      this.els.btnNorm.title = this.els.btnNorm.classList.contains('on')
        ? '音量均衡：开（右键分析曲库响度）' : '音量均衡：关'
    }
  },

  setSpectrumVisible(visible) {
    const c = this.els.spectrum
    if (c) c.style.display = visible ? '' : 'none'
  },

  /** 标题栏的「位完美」按钮 + 播放条状态标签
   *  kind: perfect（绿）| warn（琥珀）| idle/probing（灰） */
  setHifi({ on, text, hint, perfect, kind }) {
    const btn = this.els.btnHifi
    if (btn) {
      btn.classList.toggle('on', !!on)
      btn.classList.toggle('warn', !!on && kind === 'warn')
      btn.title = on
        ? (hint || '独占输出已开启')
        : '独占输出（位完美）：改用 WASAPI 独占直出，其他程序将没有声音'
    }
    const badge = this.els.hifiBadge
    if (!badge) return
    if (!on) { badge.hidden = true; return }
    badge.hidden = false
    badge.textContent = text || ''
    badge.title = hint || ''
    badge.classList.toggle('perfect', kind === 'perfect')
    badge.classList.toggle('warn', kind === 'warn')
    badge.classList.toggle('muted', kind === 'idle' || kind === 'probing')
  },

  /** 桌面歌词按钮状态：open=窗口开着，locked=锁定中 */
  setDLyric(open, locked) {
    const btn = this.els.btnDLyric
    btn.classList.toggle('on', !!open)
    const use = btn.querySelector('svg use')
    if (use) use.setAttribute('href', locked ? '#i-lock' : '#i-dlyric')
    btn.title = !open
      ? '打开桌面歌词（Ctrl+Alt+D）'
      : locked ? '桌面歌词已锁定，点击解锁' : '关闭桌面歌词'
  },

  setLyricPanelVisible(visible) {
    this.els.lyricPanel.classList.toggle('hidden', !visible)
    this.els.btnLyricToggle.classList.toggle('on', visible)
    // v3.3.9：面板隐藏时停掉频谱 rAF 循环（画布缩到 0，循环每帧空转）；
    // 显示且有分析器时重启
    if (typeof AudioFx !== 'undefined') {
      if (visible && AudioFx.analyser) AudioFx.startSpectrum(this.els.spectrum)
      else AudioFx.stopSpectrum()
    }
  },

  /* ---------------- 歌词 ---------------- */

  lyricState: { lines: [], plain: false, index: -2 },

  renderLyric(parsed, trackTitle) {
    const box = this.els.lpLyrics
    this.lyricState.lines = parsed ? parsed.lines : []
    this.lyricState.plain = !!(parsed && parsed.plain)
    this.lyricState.index = -2
    this.els.mvLyric.textContent = ''
    if (!parsed || !parsed.lines.length) {
      box.innerHTML = '<div class="lyric-empty">暂无歌词</div>'
      return
    }
    box.innerHTML = parsed.lines.map((l, i) =>
      `<div class="lyric-line${this.lyricState.plain ? ' plain' : ''}" data-i="${i}">${esc(l.text || '♪')}</div>`
    ).join('')
    box.scrollTop = 0
  },

  updateLyricIndex(curSec) {
    const st = this.lyricState
    if (st.plain || !st.lines.length) return
    const idx = findLineIndex(st.lines, curSec)
    if (idx === st.index) return
    const prevIdx = st.index
    st.index = idx
    const box = this.els.lpLyrics
    const nodes = box.children
    // 第四轮 §4.4：以前每次高亮切换都全量遍历歌词行做 classList.toggle（长歌词 5Hz × N 次），
    // 这里只改「上一行 + 当前行」两处
    if (prevIdx >= 0 && nodes[prevIdx]) nodes[prevIdx].classList.remove('active')
    if (idx >= 0 && nodes[idx]) nodes[idx].classList.add('active')
    // 迷你卡片只显示当前一句（没到第一句时留空，CSS 会隐藏这一行）
    const cur = idx >= 0 && st.lines[idx] ? st.lines[idx].text : ''
    if (this.els.mvLyric.textContent !== cur) this.els.mvLyric.textContent = cur
    // v2.8.25：全屏播放页同步当前句
    if (this.els.fsLyric && this.els.fsLyric.textContent !== cur) this.els.fsLyric.textContent = cur
    if (idx >= 0 && nodes[idx]) {
      const node = nodes[idx]
      // 用 rect 差值算，不要用 offsetTop：它相对最近定位祖先，一旦祖先在上方就会大幅偏移
      const boxRect = box.getBoundingClientRect()
      const nodeRect = node.getBoundingClientRect()
      const delta = (nodeRect.top - boxRect.top) - (box.clientHeight - nodeRect.height) / 2
      // 必须瞬时定位：高亮约每 0.2s 切一次，smooth 动画会被下一次调用打断，滚动几乎不动
      const max = box.scrollHeight - box.clientHeight
      box.scrollTop = Math.min(Math.max(0, box.scrollTop + delta), Math.max(0, max))
    }
  },

  setLyricOffset(sec) {
    this.els.lpOffset.textContent = (sec >= 0 ? '+' : '') + sec.toFixed(1) + 's'
  },

  setLyricFontSize(px) {
    document.documentElement.style.setProperty('--lyric-fs', String(px))
  },

  /* ---------------- 播放队列 ---------------- */

  renderQueue(tracks, index, playingId) {
    const box = this.els.queueBody
    if (!tracks.length) {
      box.innerHTML = '<div class="qp-item" style="cursor:default;color:var(--txt-3)">队列为空</div>'
      this._queueSig = ''
      this._queueStructSig = null
      return
    }
    // 一次 setQueue 会连发 queue-change + track-change，以前整段 innerHTML 被重建
    // 两次、队列面板滚动位置丢失。用「结构签名」判断列表是否真变了：
    //  - 结构相同（只是 index / currentId 变化）→ 只 toggle active 与 ♪，不重建 DOM
    //  - 结构不同（增删/重排/换队列）→ 才重建 innerHTML
    // 第四轮 §4.4：签名只含 id 时，扫描补齐元数据（标题/歌手）后签名不变，
    // 队列面板就再也不刷新，显示的还是旧标题
    const structSig = tracks.length + ':'
      + tracks.map((t) => t.id + '~' + (t.title || '') + '~' + (t.artist || '')).join(',')
    const fullSig = structSig + '|' + index + '|' + (playingId || '')
    if (fullSig === this._queueSig) return
    if (structSig === this._queueStructSig) {
      const items = box.children
      for (let i = 0; i < items.length; i++) {
        const el = items[i]
        const active = i === index
        el.classList.toggle('active', active)
        const tspan = el.querySelector('.qi-t')
        if (tspan) {
          const want = (active && playingId ? '♪ ' : '') + (tracks[i] ? tracks[i].title : '')
          if (tspan.textContent !== want) tspan.textContent = want
        }
      }
      this._queueSig = fullSig
      return
    }
    this._queueStructSig = structSig
    this._queueSig = fullSig
    box.innerHTML = tracks.map((t, i) => `
      <div class="qp-item${i === index ? ' active' : ''}" data-qi="${i}" title="${esc(t.title)}" draggable="true">
        <span class="qi-t">${i === index && playingId ? '♪ ' : ''}${esc(t.title)}</span>
        <span class="qi-a">${esc(t.artist || '')}</span>
      </div>`).join('')
  },

  toggleQueue(show) {
    const el = this.els.queuePanel
    const next = show == null ? el.hidden : show
    el.hidden = !next
  },

  /* ---------------- 文件夹网格（v1.7） ---------------- */

  /**
   * 卡片网格通用渲染：文件夹视图与专辑视图结构完全一致，
   * 差异只有 data-* 属性名、图标和副标题文案，所以合并到一处。
   * @param {Array} cards [{value, cover, icon, name, sub}]，sub 由调用方转义好
   * @param {string} dataKey 'dir' | 'album'
   * @param {(value:string)=>void} onClick
   */
  _renderCardGrid(cards, dataKey, onClick) {
    const body = this.els.tableBody
    const grid = document.createElement('div')
    grid.className = 'album-grid'
    grid.innerHTML = cards.map((c) => `
      <div class="album-card" data-${dataKey}="${esc(c.value)}"${dataKey === 'dir' ? ` title="${esc(c.value)}"` : ''}>
        <div class="ac-cover">${c.cover ? `<img src="${esc(c.cover)}" alt="" />` : icon(c.icon)}</div>
        <div class="ac-name">${esc(c.name)}</div>
        <div class="ac-sub">${c.sub}</div>
      </div>`).join('')
    body.innerHTML = ''
    body.appendChild(grid)
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.album-card')
      if (card) onClick(card.dataset[dataKey])
    })
  },

  renderFolderGrid(groups, onClick) {
    this._renderCardGrid(groups.map((g) => ({
      value: g.dir,
      cover: g.cover,
      icon: 'folder',
      name: g.name,
      sub: `${g.count} 首${g.sub ? ' · ' + esc(g.sub) : ''}`
    })), 'dir', onClick)
  },

  renderAlbumGrid(albums, onClick) {
    this._renderCardGrid(albums.map((a) => ({
      value: a.name,
      cover: a.cover,
      icon: 'album',
      name: a.name || '未知专辑',
      sub: `${esc(a.artist || '')} · ${a.count} 首`
    })), 'album', onClick)
  },

  /* ---------------- 右键菜单 ---------------- */

  showContextMenu(x, y, items) {
    const menu = this.els.ctxMenu
    // v3.3.20：覆盖 _ctxCleanup 之前必须先摘掉上一轮挂在 document/window 上的监听。
    // 有些路径不会走 hideContextMenu（比如多选工具条的按钮带 stopPropagation），
    // 旧 handler 留在 document 上，同一次点击会把动作跑两遍 —— 加入歌单重复添加、
    // 收藏被切两次等于没收藏。这里在 menu.hidden=false 之前调用，不影响本次显示。
    if (this._ctxCleanup) { const prev = this._ctxCleanup; this._ctxCleanup = null; prev() }
    const build = (list) => list.map((it) => {
      if (it.sep) return '<div class="ctx-sep"></div>'
      if (it.sub && it.sub.length) {
        return `<div class="ctx-item ctx-sub">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span>` +
          `<span class="arrow">▸</span><div class="ctx-submenu">${build(it.sub)}</div></div>`
      }
      return `<div class="ctx-item${it.danger ? ' danger' : ''}" data-act="${esc(it.act)}" data-arg="${esc(it.arg == null ? '' : it.arg)}">` +
        `${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></div>`
    }).join('')

    menu.innerHTML = build(items)
    menu.hidden = false
    // 防溢出
    const rect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    menu.style.left = Math.min(x, vw - rect.width - 8) + 'px'
    menu.style.top = Math.min(y, vh - rect.height - 8) + 'px'

    // v2.6：子菜单防溢出——右侧放不下时向左弹
    menu.querySelectorAll('.ctx-sub').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const sub = el.querySelector('.ctx-submenu')
        if (!sub) return
        sub.classList.remove('flip')
        if (sub.getBoundingClientRect().right > vw - 8) sub.classList.add('flip')
      })
    })

    // v2.6：含子菜单的父项点击不关菜单、不触发动作，改为展开/收起子菜单；
    // 只有叶子项（data-act）才执行并关闭。
    // 每次弹/关菜单都递增 token：setTimeout(...,0) 里注册监听时比对 token，
    // 避免 hideContextMenu 落在 0ms 窗口内、remove 对未添加的监听无效、
    // 随后又把 capture 监听挂回来的竞态残留
    const token = (this._ctxToken = (this._ctxToken || 0) + 1)
    const handler = (e) => {
      const subParent = e.target.closest('.ctx-sub')
      if (subParent && subParent.contains(e.target) && !e.target.closest('.ctx-submenu')) {
        // 点在父项本体上 → 切换子菜单（悬停也能开，点击是给不知道悬停的人用的）
        subParent.classList.toggle('open')
        return
      }
      const item = e.target.closest('.ctx-item[data-act]')
      if (!item) return
      const act = item.dataset.act
      const arg = item.dataset.arg
      menu.hidden = true
      cleanup()
      this.els.ctxMenu.dispatchEvent(new CustomEvent('ctx-act', { detail: { act, arg } }))
    }
    const cleanup = () => {
      document.removeEventListener('click', handler, true)
      document.removeEventListener('contextmenu', cleanup, true)
      window.removeEventListener('blur', cleanup)
      this.els.ctxMenu.hidden = true   // 非菜单区右键时也要把菜单真正藏掉
      this._ctxCleanup = null
    }
    this._ctxCleanup = cleanup
    setTimeout(() => {
      if (token !== this._ctxToken) return   // 菜单已被隐藏，别再把监听挂回来
      document.addEventListener('click', handler, true)
      document.addEventListener('contextmenu', cleanup, true)
      window.addEventListener('blur', cleanup)
    }, 0)
  },

  hideContextMenu() {
    this._ctxToken = (this._ctxToken || 0) + 1
    this.els.ctxMenu.hidden = true
    // v3.3.7：外部点击关菜单的路径也要清掉 document 级监听 ——
    // 否则残留的 handler 会让下一次菜单的动作触发两次（重复添加歌单/双 toast）
    if (this._ctxCleanup) { const c = this._ctxCleanup; this._ctxCleanup = null; c() }
  },

  /* ---------------- 音乐文件夹弹窗 ---------------- */

  renderDirList(dirs) {
    const box = this.els.dirList
    if (!dirs.length) {
      box.innerHTML = '<div class="dir-empty">还没有添加文件夹</div>'
      return
    }
    box.innerHTML = dirs.map((d, i) => `
      <div class="dir-item" data-i="${i}">
        ${icon('folder')}
        <span class="dp" title="${esc(d)}">${esc(d)}</span>
        <button class="dx" data-rm="${i}" title="移除">${icon('close')}</button>
      </div>`).join('')
  },

  showDirModal(dirs) {
    this.renderDirList(dirs)
    this.els.dirModal.hidden = false
  },

  hideDirModal() {
    this.els.dirModal.hidden = true
  }
}
