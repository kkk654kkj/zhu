'use strict'
/* 视图渲染层：只负责把状态画到 DOM，不做业务决策 */

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
      'btnHifi', 'hifiBadge'
    ]
    for (const id of ids) this.els[id] = document.getElementById(id)
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
      this.els.vhCover.innerHTML = `<img src="${esc(cover)}" alt="" onerror="this.remove()" />`
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
   * @param {object} ctx {currentId, playing, favorites:Set, playCounts, sortKey, sortDir}
   */
  renderTable(tracks, ctx) {
    const body = this.els.tableBody
    if (!tracks.length) {
      body.innerHTML = ''
      return
    }
    // 一次性拼好整段 HTML 再赋 innerHTML。
    // 旧实现复用同一个 div 逐行 innerHTML（每行解析一次 HTML），n 行 = n+1 次解析；
    // 曲库上千首时切视图/搜索有明显掉帧。现在是 1 次解析 + 1 次布局。
    const rows = new Array(tracks.length)
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      const isCur = t.id === ctx.currentId
      rows[i] = `<div class="tr${isCur ? ' playing' : ''}" data-id="${t.id}" data-index="${i}">
          <div class="c-idx">
            <span class="num" draggable="true" title="拖到左侧歌单可加入歌单">${i + 1}</span>
            <span class="btn-play-row">${icon('play')}</span>
          </div>
          <div class="c-title">
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

    body.innerHTML = rows.join('')
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

  showScan(title = '正在扫描…') {
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

  hideScan() {
    this.els.scanOverlay.hidden = true
  },

  /* ---------------- 播放条基本信息 ---------------- */

  renderNowPlaying(track, playing) {
    if (!track) {
      this.els.pbTitle.textContent = '未在播放'
      this.els.pbArtist.textContent = '—'
      this.els.pbCover.innerHTML = icon('music')
      this.els.lpTitle.textContent = '未在播放'
      this.els.lpArtist.textContent = ''
      this.els.lpCover.innerHTML = icon('music')
      this.els.tCur.textContent = '0:00'
      this.els.tDur.textContent = '0:00'
      this.els.mvTitle.textContent = '未在播放'
      this.els.mvArtist.textContent = '—'
      this.els.mvTitle.title = ''
      this.els.mvCover.innerHTML = icon('music')
      this.els.mvLyric.textContent = ''
      this.setPlayIcon(false)
      return
    }
    this.els.pbTitle.textContent = track.title
    this.els.pbTitle.title = track.title
    this.els.pbArtist.textContent = track.artist || '未知歌手'
    this.els.lpTitle.textContent = track.title
    this.els.lpArtist.textContent = (track.artist || '未知歌手') + (track.album ? ' · ' + track.album : '')
    this.els.mvTitle.textContent = track.title
    this.els.mvTitle.title = track.title + (track.artist ? ' — ' + track.artist : '')
    this.els.mvArtist.textContent = track.artist || '未知歌手'
    if (track.cover) {
      const img = `<img src="${esc(track.cover)}" alt="" onerror="this.remove()" />`
      this.els.pbCover.innerHTML = img
      this.els.lpCover.innerHTML = img
      this.els.mvCover.innerHTML = img
    } else {
      this.els.pbCover.innerHTML = icon('music')
      this.els.lpCover.innerHTML = icon('music')
      this.els.mvCover.innerHTML = icon('music')
    }
    this.els.tDur.textContent = fmtDuration(track.duration)
    this.setPlayIcon(playing)
  },

  setPlayIcon(playing) {
    const svg = this.els.btnPlay.querySelector('svg use')
    if (svg) svg.setAttribute('href', playing ? '#i-pause' : '#i-play')
    this.els.btnPlay.title = playing ? '暂停' : '播放'
    const ms = this.els.mvPlay.querySelector('svg use')
    if (ms) ms.setAttribute('href', playing ? '#i-pause' : '#i-play')
    this.els.mvPlay.title = playing ? '暂停' : '播放'
  },

  setFavorite(isFav) {
    this.els.btnFav.classList.toggle('on', isFav)
    this.els.btnFav.title = isFav ? '取消收藏' : '收藏'
    this.els.mvFav.classList.toggle('on', isFav)
    this.els.mvFav.title = isFav ? '取消收藏' : '收藏'
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
  },

  setVolume(v, muted) {
    const pct = (muted ? 0 : v * 100).toFixed(1) + '%'
    this.els.volFill.style.width = pct
    this.els.volDot.style.left = pct
    this.els.volVal.textContent = muted ? '静音' : Math.round(v * 100)
    const use = this.els.btnMute.querySelector('svg use')
    if (use) use.setAttribute('href', muted || v === 0 ? '#i-volume-off' : '#i-volume')
  },

  setMode(mode) {
    const use = this.els.btnMode.querySelector('svg use')
    if (use) use.setAttribute('href', '#' + MODE_ICON[mode])
    this.els.btnMode.title = MODE_LABEL[mode]
    this.els.btnMode.classList.toggle('on', mode !== 'list')
    const mu = this.els.mvMode.querySelector('svg use')
    if (mu) mu.setAttribute('href', '#' + MODE_ICON[mode])
    this.els.mvMode.title = MODE_LABEL[mode]
    this.els.mvMode.classList.toggle('on', mode !== 'list')
  },

  /** 切换迷你布局（窗口缩放由主进程负责，这里只管界面） */
  setMini(on) {
    const mini = !!on
    document.body.classList.toggle('mini', mini)
    this.els.miniView.hidden = !mini
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

  /** 独占输出下禁用 EQ / 音量均衡按钮 */
  setEqDisabled(disabled) {
    this.eqDisabled = !!disabled
    for (const id of ['btnEq', 'btnNorm']) {
      const el = this.els[id]
      if (!el) continue
      el.classList.toggle('disabled', this.eqDisabled)
    }
    if (this.eqDisabled) {
      this.els.btnEq.title = '独占输出下不可用（会破坏位完美）'
      this.els.btnNorm.title = '独占输出下不可用（会破坏位完美）'
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
      box.innerHTML = '<div class="lyric-empty">' +
        (trackTitle ? '暂无歌词' : '暂无歌词') + '</div>'
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
    st.index = idx
    const box = this.els.lpLyrics
    const nodes = box.children
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle('active', i === idx)
    }
    // 迷你卡片只显示当前一句（没到第一句时留空，CSS 会隐藏这一行）
    const cur = idx >= 0 && st.lines[idx] ? st.lines[idx].text : ''
    if (this.els.mvLyric.textContent !== cur) this.els.mvLyric.textContent = cur
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
      return
    }
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

  renderFolderGrid(groups, onClick) {
    const body = this.els.tableBody
    body.innerHTML = ''
    const grid = document.createElement('div')
    grid.className = 'album-grid'
    grid.innerHTML = groups.map((g) => `
      <div class="album-card" data-dir="${esc(g.dir)}" title="${esc(g.dir)}">
        <div class="ac-cover">${g.cover ? `<img src="${esc(g.cover)}" alt="" onerror="this.remove()" />` : icon('folder')}</div>
        <div class="ac-name">${esc(g.name)}</div>
        <div class="ac-sub">${g.count} 首${g.sub ? ' · ' + esc(g.sub) : ''}</div>
      </div>`).join('')
    body.appendChild(grid)
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.album-card')
      if (card) onClick(card.dataset.dir)
    })
  },

  /* ---------------- 专辑网格 ---------------- */

  renderAlbumGrid(albums, onClick) {
    const body = this.els.tableBody
    body.innerHTML = ''
    const grid = document.createElement('div')
    grid.className = 'album-grid'
    grid.innerHTML = albums.map((a) => `
      <div class="album-card" data-album="${esc(a.name)}">
        <div class="ac-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" onerror="this.remove()" />` : icon('album')}</div>
        <div class="ac-name">${esc(a.name || '未知专辑')}</div>
        <div class="ac-sub">${esc(a.artist || '')} · ${a.count} 首</div>
      </div>`).join('')
    body.appendChild(grid)
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.album-card')
      if (card) onClick(card.dataset.album)
    })
  },

  /* ---------------- 右键菜单 ---------------- */

  showContextMenu(x, y, items) {
    const menu = this.els.ctxMenu
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
    }
    setTimeout(() => {
      document.addEventListener('click', handler, true)
      document.addEventListener('contextmenu', cleanup, true)
      window.addEventListener('blur', cleanup)
    }, 0)
  },

  hideContextMenu() {
    this.els.ctxMenu.hidden = true
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
