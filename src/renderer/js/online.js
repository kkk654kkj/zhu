'use strict'
/**
 * 在线搜索视图（联网版 v3.0）。
 *
 * 与本地曲库解耦：结果不进 state.tracks，播放时构造 ClientTrack 交给 player，
 * 队列只放「同一个源」的条目——跨源歌曲的版权状态差别太大，混在一个队列里
 * 会出现「切下一首就放不出来」。
 */

const Online = {
  list: [],            // 当前搜索结果（OnlineSong）
  keyword: '',
  page: 1,
  hasMore: false,
  loading: false,
  playingId: null,     // 当前正在播的在线曲目 id（on:<src>:<id>）
  sources: [],         // 全部可用源（主进程返回）
  enabled: new Set(),  // 本次参与搜索的源
  downloads: new Map(),// key → { received, total }
  _ready: false,

  async init() {
    if (this._ready) return
    this._ready = true
    try {
      this.sources = await window.api.onlineSources()
    } catch (err) {
      this.sources = []
    }
    const cfg = (state.settings && state.settings.onlineSources) || ['kw', 'qq', 'kg', 'wy']
    this.enabled = new Set(cfg.filter((id) => this.sources.some((s) => s.id === id)))
    if (!this.enabled.size && this.sources.length) this.enabled.add(this.sources[0].id)

    const sel = document.getElementById('opQuality')
    if (sel) sel.value = (state.settings && state.settings.onlineQuality) || 'best'

    this.renderSources()
    this.bind()
    window.api.onDownloadProgress((p) => this.onProgress(p))
    window.api.onDownloadDone((p) => this.onDone(p))
  },

  /* ---------------- 界面 ---------------- */

  renderSources() {
    const box = document.getElementById('opSources')
    if (!box) return
    box.innerHTML = this.sources.map((s) => `
      <button class="op-chip${this.enabled.has(s.id) ? ' on' : ''}" data-src="${s.id}" title="${esc(s.quality)}">
        <i></i>${esc(s.name)}
      </button>`).join('')
  },

  bind() {
    const input = document.getElementById('opInput')
    const go = () => this.search(true)
    document.getElementById('opGo').addEventListener('click', go)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go() }
    })

    document.getElementById('opSources').addEventListener('click', (e) => {
      const chip = e.target.closest('.op-chip')
      if (!chip) return
      const id = chip.dataset.src
      if (this.enabled.has(id)) {
        if (this.enabled.size === 1) { toast('至少保留一个音源'); return }
        this.enabled.delete(id)
      } else {
        this.enabled.add(id)
      }
      this.renderSources()
      window.api.patchSettings({ onlineSources: Array.from(this.enabled) }).catch(() => {})
      if (this.keyword) this.search(true)
    })

    document.getElementById('opQuality').addEventListener('change', (e) => {
      window.api.patchSettings({ onlineQuality: e.target.value }).catch(() => {})
      state.settings.onlineQuality = e.target.value
      toast(e.target.value === '128k' ? '已切换：省流量（128k 优先）' : '已切换：音质优先')
    })

    document.getElementById('opDirBtn').addEventListener('click', async () => {
      const dir = await window.api.onlinePickDownloadDir()
      if (dir) toast('下载目录：' + dir, 3000)
    })
    document.getElementById('opOpenDir').addEventListener('click', () => window.api.onlineOpenDownloadDir())

    document.getElementById('opMore').addEventListener('click', () => this.search(false))

    // 行交互：单击选中、双击播放、按钮各管各的
    const body = document.getElementById('opBody')
    body.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.op-tr')
      if (row && !e.target.closest('.op-act-btn')) this.playAt(Number(row.dataset.index))
    })
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.op-tr')
      if (!row) return
      const act = e.target.closest('.op-act-btn')
      if (act) {
        e.stopPropagation()
        const i = Number(row.dataset.index)
        if (act.dataset.act === 'play') this.playAt(i)
        else if (act.dataset.act === 'download') this.downloadAt(i)
        else if (act.dataset.act === 'queue') this.addQueueAt(i)
        return
      }
      if (e.target.closest('.btn-play-row')) { this.playAt(Number(row.dataset.index)); return }
    })
  },

  setStatus(text, showMore) {
    const st = document.getElementById('opStatus')
    if (st) st.innerHTML = text
    const more = document.getElementById('opMore')
    if (more) more.hidden = !showMore
  },

  render() {
    const body = document.getElementById('opBody')
    if (!body) return
    if (!this.list.length) {
      body.innerHTML = ''
      return
    }
    const srcName = new Map(this.sources.map((s) => [s.id, s.short || s.name]))
    body.innerHTML = this.list.map((s, i) => {
      const id = `on:${s.source}:${s.id}`
      const cur = this.playingId === id
      return `<div class="op-tr${cur ? ' playing' : ''}" data-index="${i}" data-id="${esc(id)}">
        <div class="c-idx">
          <span class="num">${i + 1}</span>
          <span class="btn-play-row">${icon('play')}</span>
        </div>
        <div class="op-c-title">
          <span class="tt" title="${esc(s.title)}">${esc(s.title)}</span>
        </div>
        <div class="op-c-artist" title="${esc(s.artist)}">${esc(s.artist)}</div>
        <div class="op-c-src"><span class="op-badge ${esc(s.source)}">${esc(srcName.get(s.source) || s.source)}</span></div>
        <div class="op-c-q ${s.quality === '320k' ? 'high' : ''}">${esc(s.quality || '')}</div>
        <div class="op-c-dur">${fmtDuration(s.duration)}</div>
        <div class="op-c-act">
          <button class="op-act-btn" data-act="play" title="播放">${icon('play')}</button>
          <button class="op-act-btn" data-act="queue" title="加入播放队列">${icon('plus')}</button>
          <button class="op-act-btn" data-act="download" title="下载到本地">${icon('download')}</button>
        </div>
      </div>`
    }).join('')
  },

  markPlaying(id) {
    this.playingId = id
    document.querySelectorAll('#opBody .op-tr').forEach((el) => {
      el.classList.toggle('playing', el.dataset.id === id)
    })
  },

  /* ---------------- 搜索 ---------------- */

  async search(reset) {
    const input = document.getElementById('opInput')
    const kw = (input.value || '').trim()
    if (!kw) { input.focus(); return }
    if (this.loading) return
    this.loading = true
    this.keyword = kw
    this.page = reset ? 1 : this.page + 1
    this.setStatus('正在搜索「' + esc(kw) + '」…', false)
    const btn = document.getElementById('opGo')
    if (btn) btn.disabled = true
    const t0 = performance.now()
    try {
      const r = await window.api.onlineSearch({
        keyword: kw,
        page: this.page,
        limit: 30,
        sources: Array.from(this.enabled)
      })
      const list = (r && r.list) || []
      this.list = reset ? list : this.list.concat(list)
      this.hasMore = list.length >= 20
      this.render()
      const ms = Math.round(performance.now() - t0)
      const counts = {}
      for (const s of this.list) counts[s.source] = (counts[s.source] || 0) + 1
      const detail = Object.entries(counts)
        .map(([k, v]) => (this.sources.find((s) => s.id === k)?.name || k) + ' ' + v)
        .join(' · ')
      this.setStatus(
        this.list.length
          ? `找到 <b>${this.list.length}</b> 首（${detail}）· ${ms}ms · 双击播放，↓ 下载`
          : '没搜到结果，换个关键词试试',
        this.hasMore
      )
      if (!this.list.length) this.setStatus('没搜到结果，换个关键词试试', false)
    } catch (err) {
      this.setStatus('搜索失败：' + esc(err.message || '网络异常'), false)
    } finally {
      this.loading = false
      if (btn) btn.disabled = false
    }
  },

  /* ---------------- 播放 ---------------- */

  /**
   * 播放第 i 首。队列 = 同源的其他结果（同一源的可播性最接近），
   * 避免播到别的平台的付费歌时整条队列全是"跳过"。
   */
  async playAt(i) {
    const song = this.list[i]
    if (!song) return
    await this.play(song)
  },

  async play(song) {
    const key = `${song.source}:${song.id}`
    this.setStatus('正在解析「' + esc(song.title) + '」…', this.hasMore)
    const r = await window.api.onlinePlayable(song).catch((err) => ({ ok: false, error: err.message }))
    if (!r || !r.ok) {
      this.setStatus('❌ ' + esc((r && r.error) || '解析失败'), this.hasMore)
      toast((r && r.error) || '解析失败', 3000)
      return
    }
    const actual = r.song || song
    const track = this.toTrack(actual, r)
    const queue = this.list
      .filter((s) => s.source === actual.source)
      .map((s) => this.toTrack(s, null))
    // 队列里的曲目尚未解析，audio 先挂 lxstream 地址（协议层会现取），当前这首用已验证的
    const idx = queue.findIndex((t) => t.id === track.id)
    if (idx >= 0) queue[idx] = track
    else queue.unshift(track)

    state.visible = queue       // 让「播放全部 / 上一首下一首」在这批结果里生效
    player.setMode('list')
    player.setQueue(queue, idx >= 0 ? idx : 0, true)
    this.markPlaying(track.id)
    const notes = []
    if (r.fallback) notes.push('已自动换源：' + (this.sources.find((s) => s.id === actual.source)?.name || actual.source))
    if (r.partial) notes.push('仅试听片段')
    if (r.bitrate) notes.push(r.bitrate + 'k')
    this.setStatus(
      `▶ ${esc(actual.title)} — ${esc(actual.artist)}` + (notes.length ? '（' + notes.join(' · ') + '）' : ''),
      this.hasMore
    )
    if (r.partial) toast('这首只有试听片段（版权限制），要完整版请换源或另找', 3500)
  },

  /** OnlineSong → player 能吃的 ClientTrack */
  toTrack(song, resolved) {
    const q = new URLSearchParams({
      q: (state.settings && state.settings.onlineQuality) === '128k' ? '128k' : 'best',
      t: song.title || '',
      a: song.artist || '',
      d: String(song.duration || 0)
    })
    return {
      id: `on:${song.source}:${song.id}`,
      online: song,                       // 歌词/下载都靠它回到主进程
      audio: resolved ? resolved.streamUrl : `lxstream://play/${song.source}/${encodeURIComponent(song.id)}?${q}`,
      title: song.title,
      artist: song.artist,
      album: song.album || '',
      duration: song.duration || 0,
      cover: song.cover || null,
      hasLyric: true,
      ext: (resolved && resolved.ext ? resolved.ext : 'mp3').toUpperCase(),
      lossless: false,
      isDsd: false,
      onlineBitrate: resolved ? resolved.bitrate : 0,
      path: null
    }
  },

  /** 加入队列（不打断当前播放） */
  addQueueAt(i) {
    const song = this.list[i]
    if (!song) return
    player.addToQueue(this.toTrack(song, null))
    toast('已加入队列：' + song.title)
  },

  /* ---------------- 下载 ---------------- */

  async downloadAt(i) {
    const song = this.list[i]
    if (!song) return
    const key = `${song.source}:${song.id}`
    if (this.downloads.has(key)) { toast('正在下载中…'); return }
    this.downloads.set(key, { received: 0, total: 0 })
    this.paintDownload(key)
    const r = await window.api.onlineDownload(song)
    if (!r || !r.ok) {
      this.downloads.delete(key)
      this.paintDownload(key)
      toast((r && r.error) || '下载启动失败', 3000)
      return
    }
    toast('开始下载：' + song.title)
  },

  onProgress(p) {
    const rec = this.downloads.get(p.key)
    if (!rec) return
    rec.received = p.received
    rec.total = p.total
    this.paintDownload(p.key)
  },

  onDone(p) {
    this.downloads.delete(p.key)
    this.paintDownload(p.key)
    if (p.ok) {
      toast('下载完成：' + (p.path || '').split(/[\\/]/).pop(), 3500)
    } else {
      toast('下载失败：' + (p.error || '未知错误'), 3000)
    }
  },

  /** 只改这一行的下载进度，不重绘整张表 */
  paintDownload(key) {
    const rec = this.downloads.get(key)
    const row = document.querySelector(`#opBody .op-tr[data-id="on:${key}"]`)
    const btn = row && row.querySelector('.op-act-btn[data-act="download"]')
    if (!btn) return
    if (!rec) {
      btn.innerHTML = icon('download')
      btn.classList.remove('busy')
      btn.title = '下载到本地'
      return
    }
    btn.classList.add('busy')
    const pct = rec.total ? Math.min(100, Math.round((rec.received / rec.total) * 100)) : null
    btn.innerHTML = `<span style="font-size:10px;color:var(--accent)">${pct == null ? '…' : pct + '%'}</span>`
    btn.title = pct == null ? '下载中' : `下载中 ${pct}%`
  }
}
