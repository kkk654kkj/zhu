'use strict'
/**
 * 每日推荐（联网版 v3.3.38）
 *
 * 口径（用户确认，2026-11-13）：
 *  - **全在线**：列表里不再出现本地曲库的歌。只有「断网 / 网关超时 / 一首都没搜到」
 *    才回退本地兜底，并在状态栏写明原因。
 *  - **取数**：口味前 6 歌手各搜一轮（并行，各自 9s 兜底）→ 与本地曲库、同批结果去重
 *    → 按歌手轮转取满 30 首，避免一整页都是同一个人；本地曲库空 / 没有播放记录时
 *    用内置热门歌手池当种子（冷启动）。
 *  - **音质**：跟随全局「音质偏好」（v3.3.38 起默认母带）。进页后后台逐行探测真实档位
 *    （并发 3，复用主进程 10 分钟探测缓存），行内点亮无损/母带；**整批探完只重排一次**，
 *    避免逐行到达时列表来回跳。
 *  - **播放全部**：30 首全入队，每首自带 src + q，切歌时由主进程按需解析；
 *    某首放不出来由播放器自动跳下一首（连续 3 首失败才停）。
 *
 * 为什么不再按源分队列：曲目地址本身就是 proxyBase/stream?src=<源>&id=<歌>&q=<音质>，
 * 解析发生在「播到那一首」的时候，所以跨源入队不会互相踩；点播时把当前这首的已解析
 * 结果替换进队列即可，其余条目仍是「未解析」的占位。
 */

const DAILY_TOTAL = 30
const DAILY_ARTIST_MAX = 6
const DAILY_SEARCH_TIMEOUT = 9000
const DAILY_PROBE_WORKERS = 3
/** 冷启动歌手池：本地曲库为空 / 没有播放记录时当推荐种子 */
const DAILY_COLD_SEEDS = [
  '周杰伦', '林俊杰', '陈奕迅', '孙燕姿', '邓紫棋', '李荣浩', '薛之谦', '王菲',
  '毛不易', '周深', '五月天', '张学友', '刘若英', '田馥甄', '陶喆', '张杰'
]

const Daily = {
  list: [],                 // [{ kind:'online', song, reason, w, q, qr } | { kind:'local', track, reason }]
  token: 0,                 // 重算轮次：换一批 / 切页会作废旧请求
  lastKeys: new Set(),      // 上一批在线曲目 key（降权，保证换一批真的会换）
  reason: '',               // 视图头描述
  status: '',
  onlineCount: 0,
  probed: 0,
  probing: 0,
  lastErr: '',
  _bound: false,

  localTracks() {
    return this.list.filter((x) => x.kind === 'local').map((x) => x.track)
  },

  onlineSongs() {
    return this.list.filter((x) => x.kind === 'online').map((x) => x.song)
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
    on('dailyPlayAll', 'click', () => { this.playAll() })
    // v3.3.41：与在线搜索同款的小工具（缓存设置 / 下载管理 / 下载目录），复用同一批面板与 IPC
    on('dailyCacheBtn', 'click', () => toggleCachePanel())
    on('dailyDlBtn', 'click', () => Online.toggleDlPanel())
    on('dailyDirBtn', 'click', async () => {
      const dir = await window.api.onlinePickDownloadDir().catch((err) => {
        toast('选择目录失败：' + (err.message || err), 2500)
        return null
      })
      if (dir) toast('下载目录：' + dir, 3000)
    })
    on('dailyOpenDir', 'click', () => window.api.onlineOpenDownloadDir().catch(() => {}))
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

  /** 每次进页 / 点「换一批」都重算：全在线，断了才本地兜底 */
  async recompute() {
    const token = ++this.token
    try {
      this.bind()
      this.list = []
      this.onlineCount = 0
      this.probed = 0
      this.probing = 0
      this.lastErr = ''
      this.reason = this.tasteText()
      this.setStatus('正在挑选在线曲目…')
      if (state.view === 'daily') {
        this.render()
        state.visible = this.localTracks()
      }

      let items = []
      try { items = await this.fetchOnline(token) } catch (err) {
        items = []
        this.lastErr = (err && err.message) || ''
      }
      if (token !== this.token || state.view !== 'daily') return

      if (items.length) {
        this.list = items.filter((x) => x && x.song).slice(0, DAILY_TOTAL).map((x) => ({
          kind: 'online', song: x.song, reason: x.reason, w: x.w, q: null, qr: 0
        }))
        this.onlineCount = this.list.length
        this.lastKeys = new Set(this.list.map((x) => this.key(x.song.title, x.song.artist)))
        this.setStatus(this.onlineCount >= DAILY_TOTAL
          ? '正在核对音质…'
          : `音源只给了 ${this.onlineCount} 首，正在核对音质…`)
      } else {
        // 只有「一首都没拿到」才回退本地：这是断网 / 网关超时 / 全部源都搜不到
        this.fillLocal(DAILY_TOTAL)
        this.setStatus('在线推荐这次没成功' + (this.lastErr ? '（' + this.lastErr + '）' : '') +
          '，临时用本地曲库兜底 · 点「换一批」重试')
      }

      this.render()
      state.visible = this.localTracks()
      if (this.onlineCount) this.probeAll(token).catch(() => {})
    } catch (err) {
      if (token !== this.token) return
      this.setStatus('推荐生成失败：' + ((err && err.message) || '未知错误'))
      this.render()
    }
  },

  /** 口味种子：优先本地高频歌手，曲库空 / 没记录时用冷启动歌手池 */
  seedArtists() {
    const tasted = this.topArtists()
    if (tasted.length) return tasted.slice(0, DAILY_ARTIST_MAX)
    const pool = DAILY_COLD_SEEDS.slice()
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp
    }
    return pool.slice(0, DAILY_ARTIST_MAX)
  },

  /** 高频歌手：播放次数 + 收藏 + 最近播放加权，供在线推荐当搜索词 */
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
    return Array.from(w.entries()).sort((a, b) => b[1] - a[1]).slice(0, DAILY_ARTIST_MAX).map((x) => x[0])
  },

  tasteText() {
    const artists = this.topArtists().slice(0, 2)
    return artists.length ? '因为你常听 ' + artists.join('、') : '根据热门歌手为你挑新歌'
  },

  key(title, artist) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s·、,，\-_()（）\[\]【】]/g, '')
    return norm(title) + '|' + norm(artist)
  },

  sourceList() {
    return (Online.enabled && Online.enabled.size)
      ? Array.from(Online.enabled)
      : ((state.settings && state.settings.onlineSources) || ['kw', 'qq', 'kg', 'wy'])
  },

  /** 单歌手搜一轮：失败 / 超时一律空数组（不抛，交给上层判断「一首都没有」） */
  async searchArtist(name, page, token) {
    const p = window.api.onlineSearch({
      keyword: name, page, limit: 30, sources: this.sourceList()
    }).catch((err) => { this.lastErr = (err && err.message) || '搜索失败'; return null })
    const r = await this.withTimeout(p, DAILY_SEARCH_TIMEOUT)
    if (!r) { if (!this.lastErr) this.lastErr = '搜索超时'; return [] }
    if (token !== this.token) return []
    return (r && r.list) || []
  },

  /** 去重 + 与本地曲库比对，塞进该歌手的桶里 */
  absorb(bucket, seen, localKeys, raw, weight, reason) {
    for (const s of raw) {
      if (!s || !s.title || !s.id || !s.source) continue
      const k = this.key(s.title, s.artist)
      if (localKeys.has(k) || seen.has(k)) continue
      seen.add(k)
      if (this.lastKeys.has(k)) weight -= 0.8   // 上一批出现过的沉到后面
      bucket.push({ song: s, w: weight, reason })
    }
  },

  /**
   * 全在线取数：6 个歌手并行搜 → 去重 → 按歌手轮转取 30 首。
   * 候选不够 30 时补一次 page 2；一首都没有 → 返回空数组，上层走本地兜底。
   */
  async fetchOnline(token) {
    const seeds = this.seedArtists()
    this.reason = seeds.length && this.topArtists().length
      ? this.tasteText()
      : '根据热门歌手为你挑新歌'
    try { await Online.init() } catch { /* proxyBase 为空时点播会给出明确提示 */ }
    if (token !== this.token) return []

    const localKeys = new Set((state.tracks || []).map((t) => this.key(t.title, t.artist)))
    const seen = new Set()
    const buckets = seeds.map(() => [])
    const first = await Promise.all(seeds.map((name) => this.searchArtist(name, 1, token)))
    if (token !== this.token) return []
    first.forEach((raw, i) => {
      const w = (seeds.length - i) / seeds.length      // 越靠前的口味歌手权重越高
      const reason = this.topArtists().length ? '你常听' : '热门新歌'
      this.absorb(buckets[i], seen, localKeys, raw, w, reason)
    })

    const out = this.roundRobin(buckets)
    // 候选不够：拿前 3 个歌手再补一页（这一页通常已经烧不烧额度都无所谓，纯搜索）
    if (out.length < DAILY_TOTAL) {
      const more = await Promise.all(seeds.slice(0, 3).map((name) => this.searchArtist(name, 2, token)))
      if (token !== this.token) return out
      more.forEach((raw, i) => {
        const w = (seeds.length - i) / seeds.length - 0.2
        const reason = this.topArtists().length ? '你常听' : '热门新歌'
        this.absorb(buckets[i], seen, localKeys, raw, w, reason)
      })
      return this.roundRobin(buckets)
    }
    return out
  },

  /** 按歌手轮转取歌：一轮每个歌手各出 1 首，避免一整页全是同一个人 */
  roundRobin(buckets) {
    const out = []
    const depth = Math.max(0, ...buckets.map((b) => b.length))
    for (let round = 0; round < depth && out.length < DAILY_TOTAL; round++) {
      for (const b of buckets) {
        if (out.length >= DAILY_TOTAL) break
        const item = b[round]
        if (item) out.push(item)
      }
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
    for (const t of pool.slice(0, n)) this.list.push({ kind: 'local', track: t, reason: '本地兜底' })
  },

  /* ---------------- 音质探测 ---------------- */

  /** 全局音质偏好的中文名（与 index.html 的 #opQuality 选项一致） */
  qualityLabel() {
    const q = state.settings && state.settings.onlineQuality
    if (q === 'master') return '母带'
    if (q === 'lossless') return '无损'
    if (q === '128k') return '省流量'
    return '高码率'
  },

  /** 探测结果 → 行内文案 + 排序档位（3 母带 / 2 无损 / 1 高码率 / 0 低码率或未知） */
  qualityOf(song, r) {
    if (!r || !r.ok) {
      return { text: String(song.quality || '—').toUpperCase(), cls: 'dim', rank: 0, tip: '没探测到实际档位（点播时按音源能力解析）' }
    }
    if (r.lossless) {
      const hi = r.level === 'jymaster' || r.level === 'master' || (r.bitrate || 0) >= 1411
      return {
        text: hi ? '母带' : '无损',
        cls: 'lossless',
        rank: hi ? 3 : 2,
        tip: (hi ? '高解析 FLAC' : '无损 FLAC') +
          (r.bitrate ? ' · ' + r.bitrate + 'k' : '') +
          (r.size ? ' · ' + (r.size / 1048576).toFixed(1) + 'MB' : '')
      }
    }
    const br = r.bitrate || 0
    return {
      text: br ? br + 'k' : '—',
      cls: br >= 256 ? 'ok' : 'dim',
      rank: br >= 256 ? 1 : 0,
      tip: '实际 ' + (br || '?') + 'k ' + String(r.ext || '').toUpperCase()
    }
  },

  /** 后台逐行探测（3 路并发）；整批探完只重排一次，避免列表逐行跳 */
  async probeAll(token) {
    const rows = this.list.filter((x) => x.kind === 'online')
    if (!rows.length) return
    if (this.qualityLabel() === '省流量') {
      this.setStatus(this.summaryStatus())
      return
    }
    const total = rows.length
    this.probing = total
    this.probed = 0
    let qi = 0
    const worker = async () => {
      while (qi < total) {
        if (token !== this.token) return
        const x = rows[qi++]
        const r = await window.api.onlineProbe(x.song, token).catch(() => null)
        if (token !== this.token) return
        this.probed++
        x.q = this.qualityOf(x.song, r)
        x.qr = x.q.rank
        this.paintCell(x)
        this.setStatus('正在核对音质 ' + this.probed + '/' + total + '…')
      }
    }
    await Promise.all(Array.from({ length: DAILY_PROBE_WORKERS }, () => worker()))
    if (token !== this.token) return
    this.probing = 0
    this.sortByQuality()
    this.render()
    this.setStatus(this.summaryStatus())
  },

  /** 单行就地更新音质格（不重建整张表，滚动位置不跳） */
  paintCell(x) {
    const body = document.getElementById('dailyBody')
    if (!body || typeof body.querySelectorAll !== 'function') return
    const k = x.song.source + ':' + x.song.id
    for (const row of body.querySelectorAll('.op-tr')) {
      if (!row.dataset || row.dataset.k !== k) continue
      const cell = typeof row.querySelector === 'function' ? row.querySelector('.op-c-q') : null
      if (!cell) return
      cell.textContent = x.q.text
      cell.className = 'op-c-q ' + x.q.cls
      if (x.q.tip) cell.title = x.q.tip
      return
    }
  },

  /** 音质优先重排：档位降序 → 口味权重降序 → 原顺序（稳定） */
  sortByQuality() {
    if (!this.list.some((x) => x.kind === 'online')) return
    this.list = this.list
      .map((x, i) => ({ x, i }))
      .sort((a, b) => (b.x.qr || 0) - (a.x.qr || 0) ||
        (b.x.w || 0) - (a.x.w || 0) || a.i - b.i)
      .map((o) => o.x)
  },

  summaryStatus() {
    if (!this.onlineCount) return this.status || '在线推荐暂不可用'
    const hi = this.list.filter((x) => x.qr >= 2).length
    return `全 ${this.onlineCount} 首在线曲目 · ${this.qualityLabel()}优先` +
      (hi ? ' · 已探到 ' + hi + ' 首无损/母带' : '') +
      ' · 每次打开重新挑选'
  },

  srcName(id) {
    const s = (Online.sources || []).find((x) => x.id === id)
    return s ? (s.short || s.name) : (id || '在线')
  },

  row(x, i) {
    const isLocal = x.kind === 'local'
    const t = (isLocal ? x.track : x.song) || {}
    const title = t.title || '未知歌曲'
    const artist = t.artist || '未知歌手'
    const q = isLocal ? (t.ext || '—') : (x.q ? x.q.text : String(t.quality || '—').toUpperCase())
    const qCls = isLocal ? '' : ' ' + ((x.q && x.q.cls) || 'dim')
    const qTip = isLocal ? '' : ((x.q && x.q.tip) || '进页后会自动核对真实档位')
    const badge = isLocal
      ? `<span class="op-badge daily-badge" title="${esc(x.reason)}">${esc(x.reason)}</span>`
      : `<span class="op-badge ${esc(t.source)}" title="${esc(x.reason)} · ${esc(this.srcName(t.source))}">${esc(x.reason)}</span>`
    const acts = `<button class="op-act-btn" data-act="play" title="播放">${icon('play')}</button>` +
      (isLocal ? '' : `<button class="op-act-btn" data-act="download" title="下载到本地">${icon('download')}</button>`)
    return `<div class="op-tr" data-index="${i}"${isLocal ? '' : ` data-k="${esc(t.source + ':' + t.id)}"`}>
      <div class="c-idx"><span class="num">${i + 1}</span><span class="btn-play-row">${icon('play')}</span></div>
      <div class="op-c-title"><span class="tt" title="${esc(title)}">${esc(title)}</span></div>
      <div class="op-c-artist" title="${esc(artist)}">${esc(artist)}</div>
      <div class="op-c-src">${badge}</div>
      <div class="op-c-q${qCls}"${qTip ? ` title="${esc(qTip)}"` : ''}>${esc(String(q).toUpperCase())}</div>
      <div class="op-c-dur">${fmtDuration(t.duration || 0)}</div>
      <div class="op-c-act">${acts}</div>
    </div>`
  },

  render() {
    const body = document.getElementById('dailyBody')
    const sub = document.getElementById('dailySub')
    const cover = document.getElementById('dailyCover')
    const local = this.list.filter((x) => x.kind === 'local').length
    if (sub) {
      sub.textContent = local
        ? `${this.reason || '为你精选'} · 在线推荐暂不可用，本地兜底 ${local} 首 · 可点「换一批」重试`
        : `${this.reason || '为你精选'} · 全是新歌 ${this.onlineCount} 首 · ${this.qualityLabel()}优先 · 每次打开重新挑选`
    }
    // 推荐项可能来自不完整的数据（在线接口缺字段 / 打桩数据）：这里一律按「有 song/track 才算数」取
    const first = this.list.find((x) => x.kind === 'online' && x.song && x.song.cover) ||
      this.list.find((x) => x.kind === 'local' && x.track && x.track.cover)
    const coverSrc = first ? (first.kind === 'online' ? first.song.cover : first.track.cover) : ''
    if (cover) cover.innerHTML = coverSrc ? `<img src="${esc(coverSrc)}" alt="" />` : icon('spark')
    const st = document.getElementById('dailyStatus')
    if (st) st.textContent = this.status || '双击播放 · 全在线推荐 · 每个音源按实际能力解析'
    if (!body) return
    if (!this.list.length) {
      body.innerHTML = '<div class="dl-empty" style="padding:24px;text-align:center">正在向各音源要歌单… 若一直为空，点「换一批」重试（检查网络与在线音源开关）</div>'
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

  /** 在线行：复用在线搜索视图的解析 / 代理 / ClientTrack 构造，队列 = 本页全部在线曲目 */
  async playOnline(song) {
    try { await Online.init() } catch { /* 下面按 proxyBase 判断 */ }
    if (!Online.proxyBase) {
      toast('本地代理未就绪，在线播放暂不可用。稍后重试或重启应用', 4000)
      return
    }
    const r = await window.api.onlinePlayable(song).catch((err) => ({ ok: false, error: err.message }))
    if (!r || !r.ok) { toast((r && r.error) || '解析失败', 3000); return }
    const track = Online.toTrack(song, r)
    const queue = this.onlineSongs().map((s) => Online.toTrack(s, null))
    const idx = queue.findIndex((t) => t.id === track.id)
    if (idx >= 0) queue[idx] = track
    else queue.unshift(track)
    state.visible = queue
    player.setMode('list')
    player.setQueue(queue, idx >= 0 ? idx : 0, true)
    const hi = r.level === 'jymaster' || r.level === 'master' || (r.bitrate || 0) >= 1411
    toast('正在播放：' + song.title +
      (r.lossless ? ' · ' + (hi ? '高解析 FLAC' : '无损 FLAC') : (r.bitrate ? ' · ' + r.bitrate + 'k' : '')))
  },

  /** 播放全部：30 首全入队，切歌时逐首解析（放不出来由播放器自动跳下一首） */
  async playAll() {
    try {
      const songs = this.onlineSongs()
      if (!songs.length) {
        toast(this.list.length
          ? '这批只有本地兜底曲目，点「换一批」重新拿在线推荐'
          : '还没有推荐内容，点「换一批」重试')
        return
      }
      try { await Online.init() } catch { /* 下面按 proxyBase 判断 */ }
      if (!Online.proxyBase) {
        toast('本地代理未就绪，在线播放暂不可用。稍后重试或重启应用', 4000)
        return
      }
      const queue = songs.map((s) => Online.toTrack(s, null))
      state.visible = queue
      player.setMode('list')
      player.setQueue(queue, 0, true)
      toast(`已入队 ${queue.length} 首在线歌曲 · ${this.qualityLabel()}优先 · 放不出来会自动跳下一首`, 3500)
    } catch (err) {
      toast('播放失败：' + ((err && err.message) || err), 3000)
    }
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
