'use strict'
/**
 * 每日推荐（联网版 v3.3.37）
 *
 * 口径（用户确认）：
 *  - 侧栏独立导航项 + 独立视图：封面 / 描述 / 「换一批」。
 *  - 混合来源：本地曲库为主（收藏 / 播放次数 / 最近播放加权），在线补新歌
 *    （按高频歌手搜索，并与本地曲库去重）。
 *  - 每次进入页面重新抽一批，不按日期缓存；在线失败 / 断网自动降级为全本地。
 *
 * 为什么本地与在线不进同一条播放队列：在线搜索视图的既有结论是「跨源队列
 * 会出现切下一首就放不出来」。这里点本地行走本地队列、点在线行走在线队列，
 * 「播放全部」只播本地部分，避免把两种可播性完全不同的条目混排。
 */

const DAILY_LOCAL_TARGET = 24
const DAILY_TOTAL = 30
const DAILY_ONLINE_TIMEOUT = 9000

const Daily = {
  list: [],                 // [{ kind:'local', track, reason } | { kind:'online', song, reason }]
  token: 0,                 // 重算轮次：换一批 / 切页会作废旧请求
  lastLocal: new Set(),     // 上一批本地 id，下一批降权，避免每次都是同一堆歌
  reason: '',
  status: '',
  onlineCount: 0,
  _bound: false,

  localTracks() {
    return this.list.filter((x) => x.kind === 'local').map((x) => x.track)
  },

  setStatus(text) {
    this.status = text
    const el = document.getElementById('dailyStatus')
    if (el) el.textContent = text
  },

  bind() {
    if (this._bound) return
    const on = (id, ev, fn) => {
      const el = document.getElementById(id)
      if (el) el.addEventListener(ev, fn)
    }
    on('dailyRefresh', 'click', () => { this.recompute().catch(() => {}) })
    on('dailyPlayAll', 'click', () => this.playAll())
    on('dailyBody', 'dblclick', (e) => {
      const row = e.target.closest('.op-tr[data-index]')
      if (row && !e.target.closest('.op-act-btn')) this.playAt(Number(row.dataset.index))
    })
    on('dailyBody', 'click', (e) => {
      const row = e.target.closest('.op-tr[data-index]')
      if (!row) return
      const i = Number(row.dataset.index)
      const act = e.target.closest('.op-act-btn')
      if (act) {
        e.stopPropagation()
        if (act.dataset.act === 'play') this.playAt(i)
        else if (act.dataset.act === 'download') this.downloadAt(i)
        return
      }
      if (e.target.closest('.btn-play-row')) this.playAt(i)
    })
    this._bound = true
  },

  /** 每次进页 / 点「换一批」都重算：先立即出本地部分，再异步补在线部分 */
  async recompute() {
    const token = ++this.token
    try {
      this.bind()
      const picked = this.pickLocal()
      this.list = picked
      this.lastLocal = new Set(picked.map((x) => x.track.id))
      this.reason = this.tasteText()
      this.onlineCount = 0
      this.setStatus('正在补充在线新发现…')
      if (state.view === 'daily') {
        this.render()
        state.visible = this.localTracks()
      }

      let songs = []
      try { songs = await this.fetchOnline(token) } catch { songs = [] }
      if (token !== this.token || state.view !== 'daily') return

      const need = DAILY_TOTAL - this.list.length
      const fresh = songs.slice(0, Math.max(0, need))
      for (const s of fresh) this.list.push({ kind: 'online', song: s, reason: '在线新发现' })
      this.onlineCount = fresh.length
      // 在线没拿到（断网 / 网关超时 / 无结果）→ 本地余量补满 30 首
      const missing = DAILY_TOTAL - this.list.length
      if (missing > 0) this.fillLocal(missing)
      this.setStatus(this.onlineCount
        ? `双击播放 · 在线 ${this.onlineCount} 首点播时按实际音源解析 · 每次打开重新挑选`
        : '在线补新这次没成功（网络或音源不可用），已用本地曲库补满 · 可点「换一批」重试')
      this.render()
      state.visible = this.localTracks()
    } catch (err) {
      if (token !== this.token) return
      this.setStatus('推荐生成失败：' + ((err && err.message) || '未知错误'))
      this.render()
    }
  },

  /** 口味加权：播放次数 > 收藏 > 最近播放，再叠随机扰动保证「换一批」真的会变 */
  pickLocal() {
    const favs = state.favorites || new Set()
    const counts = state.playCounts || {}
    const histRank = new Map((state.history || []).map((h, i) => [h.id, i]))
    const scored = (state.tracks || []).map((t) => {
      const pc = Math.min(Number(counts[t.id]) || 0, 10)
      const fav = favs.has(t.id) ? 1 : 0
      const ri = histRank.has(t.id) ? histRank.get(t.id) : -1
      const recent = ri >= 0 ? Math.max(0, 1 - ri / 50) : 0
      let reason = '值得一听'
      if (fav) reason = '你的收藏'
      else if (pc >= 3) reason = '常听'
      else if (ri >= 0) reason = '最近播放'
      const score = pc * 0.6 + fav * 3 + recent * 2.5 +
        (this.lastLocal.has(t.id) ? -1.2 : 0) + Math.random() * 2.4
      return { item: { kind: 'local', track: t, reason }, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, DAILY_LOCAL_TARGET).map((x) => x.item)
  },

  /** 高频歌手：播放次数 + 收藏 + 最近播放加权，供在线补新当搜索词 */
  topArtists() {
    const w = new Map()
    const add = (a, n) => {
      const name = String(a || '').trim()
      if (!name || name === '未知歌手' || name === '未知') return
      w.set(name, (w.get(name) || 0) + n)
    }
    const favs = state.favorites || new Set()
    const counts = state.playCounts || {}
    for (const t of state.tracks || []) {
      const pc = Math.min(Number(counts[t.id]) || 0, 10)
      if (pc) add(t.artist, pc)
      if (favs.has(t.id)) add(t.artist, 3)
    }
    const byId = state.byId || new Map()
    for (const h of (state.history || []).slice(0, 30)) {
      const t = byId.get(h.id)
      if (t) add(t.artist, 1.5)
    }
    return Array.from(w.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0])
  },

  tasteText() {
    const artists = this.topArtists().slice(0, 2)
    return artists.length ? '因为你常听 ' + artists.join('、') : '根据你的收藏与最近播放'
  },

  key(title, artist) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s·、,，\-_()（）\[\]【】]/g, '')
    return norm(title) + '|' + norm(artist)
  },

  /** 在线补新：搜高频歌手 → 与本地库去重 → 随机抽。失败 / 超时一律返回空数组走降级 */
  async fetchOnline(token) {
    const artists = this.topArtists()
    if (!artists.length) return []
    try { await Online.init() } catch { /* proxyBase 为空时点播会给出明确提示 */ }
    if (token !== this.token) return []
    const sources = Online.enabled && Online.enabled.size
      ? Array.from(Online.enabled)
      : ((state.settings && state.settings.onlineSources) || ['kw', 'qq', 'kg', 'wy'])
    const kw = artists[Math.floor(Math.random() * Math.min(artists.length, 3))]
    const p = window.api.onlineSearch({ keyword: kw, page: 1, limit: 30, sources }).catch(() => null)
    const r = await this.withTimeout(p, DAILY_ONLINE_TIMEOUT)
    const raw = (r && r.list) || []
    const local = new Set((state.tracks || []).map((t) => this.key(t.title, t.artist)))
    const seen = new Set()
    const out = []
    for (const s of raw) {
      if (!s || !s.title || !s.id || !s.source) continue
      const k = this.key(s.title, s.artist)
      if (local.has(k) || seen.has(k)) continue
      seen.add(k)
      out.push(s)
    }
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp
    }
    return out
  },

  /** IPC 可能一直挂着（第三方网关不响应），必须自己兜超时，否则「换一批」永远转圈 */
  withTimeout(p, ms) {
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        resolve(null)
      }, ms)
      Promise.resolve(p).then(
        (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } },
        () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } }
      )
    })
  },

  fillLocal(n) {
    const used = new Set(this.list.filter((x) => x.kind === 'local').map((x) => x.track.id))
    const pool = (state.tracks || []).filter((t) => !used.has(t.id))
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp
    }
    for (const t of pool.slice(0, n)) this.list.push({ kind: 'local', track: t, reason: '本地曲库' })
  },

  srcName(id) {
    const s = (Online.sources || []).find((x) => x.id === id)
    return s ? (s.short || s.name) : (id || '在线')
  },

  row(x, i) {
    const isLocal = x.kind === 'local'
    const t = isLocal ? x.track : x.song
    const title = t.title || '未知歌曲'
    const artist = t.artist || '未知歌手'
    const q = isLocal ? (t.ext || '—') : (t.quality || '—')
    const badge = isLocal
      ? `<span class="op-badge daily-badge" title="${esc(x.reason)}">${esc(x.reason)}</span>`
      : `<span class="op-badge ${esc(t.source)}" title="在线新发现 · ${esc(this.srcName(t.source))}">新发现</span>`
    const acts = `<button class="op-act-btn" data-act="play" title="播放">${icon('play')}</button>` +
      (isLocal ? '' : `<button class="op-act-btn" data-act="download" title="下载到本地">${icon('download')}</button>`)
    return `<div class="op-tr" data-index="${i}">
      <div class="c-idx"><span class="num">${i + 1}</span><span class="btn-play-row">${icon('play')}</span></div>
      <div class="op-c-title"><span class="tt" title="${esc(title)}">${esc(title)}</span></div>
      <div class="op-c-artist" title="${esc(artist)}">${esc(artist)}</div>
      <div class="op-c-src">${badge}</div>
      <div class="op-c-q">${esc(String(q).toUpperCase())}</div>
      <div class="op-c-dur">${fmtDuration(t.duration || 0)}</div>
      <div class="op-c-act">${acts}</div>
    </div>`
  },

  render() {
    const body = document.getElementById('dailyBody')
    const sub = document.getElementById('dailySub')
    const cover = document.getElementById('dailyCover')
    const local = this.list.filter((x) => x.kind === 'local').length
    if (sub) sub.textContent = `${this.reason || '为你精选'} · 本地 ${local} 首 + 在线新发现 ${this.onlineCount} 首 · 每次打开重新挑选`
    const first = this.list.find((x) => x.kind === 'local' && x.track.cover)
    if (cover) cover.innerHTML = first ? `<img src="${esc(first.track.cover)}" alt="" />` : icon('spark')
    const st = document.getElementById('dailyStatus')
    if (st) st.textContent = this.status || '双击播放 · 在线歌曲点播时按实际音源解析'
    if (!body) return
    if (!this.list.length) {
      body.innerHTML = '<div class="dl-empty" style="padding:24px;text-align:center">曲库还是空的，先扫描本地音乐；联网时会自动补新歌</div>'
      return
    }
    body.innerHTML = this.list.map((x, i) => this.row(x, i)).join('')
  },

  async playAt(i) {
    const x = this.list[i]
    if (!x) return
    try {
      if (x.kind === 'local') {
        const queue = this.localTracks()
        const idx = queue.findIndex((t) => t.id === x.track.id)
        state.visible = queue
        player.setMode('list')
        player.setQueue(queue, Math.max(0, idx), true)
        return
      }
      await this.playOnline(x.song)
    } catch (err) {
      toast('播放失败：' + ((err && err.message) || err), 3000)
    }
  },

  /** 在线行：复用在线搜索视图的解析 / 代理 / ClientTrack 构造，但不碰 Online.list */
  async playOnline(song) {
    try { await Online.init() } catch { /* 下面按 proxyBase 判断 */ }
    if (!Online.proxyBase) {
      toast('本地代理未就绪，在线播放暂不可用。稍后重试或重启应用', 4000)
      return
    }
    const r = await window.api.onlinePlayable(song).catch((err) => ({ ok: false, error: err.message }))
    if (!r || !r.ok) { toast((r && r.error) || '解析失败', 3000); return }
    const track = Online.toTrack(song, r)
    const queue = this.list
      .filter((x) => x.kind === 'online' && x.song.source === song.source)
      .map((x) => Online.toTrack(x.song, null))
    const idx = queue.findIndex((t) => t.id === track.id)
    if (idx >= 0) queue[idx] = track
    else queue.unshift(track)
    state.visible = queue
    player.setMode('list')
    player.setQueue(queue, idx >= 0 ? idx : 0, true)
    toast('正在播放：' + song.title + (r.lossless ? ' · 无损 FLAC' : ''))
  },

  playAll() {
    const queue = this.localTracks()
    if (!queue.length) { toast('本地曲库还没有歌曲，先扫描音乐文件夹'); return }
    state.visible = queue
    player.setMode('list')
    player.setQueue(queue, 0, true)
    toast('已播放本地推荐 ' + queue.length + ' 首（在线新发现请单独点播）')
  },

  async downloadAt(i) {
    const x = this.list[i]
    if (!x || x.kind !== 'online') return
    try {
      const r = await window.api.onlineDownload(x.song)
      if (!r || !r.ok) { toast((r && r.error) || '下载启动失败', 3000); return }
      toast('开始下载：' + x.song.title)
    } catch (err) {
      toast('下载启动失败：' + ((err && err.message) || err), 3000)
    }
  }
}
