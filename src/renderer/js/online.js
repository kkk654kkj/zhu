'use strict'
/**
 * 在线搜索视图（联网版 v3.0）。
 *
 * 与本地曲库解耦：结果不进 state.tracks，播放时构造 ClientTrack 交给 player，
 * 队列只放「同一个源」的条目——跨源歌曲的版权状态差别太大，混在一个队列里
 * 会出现「切下一首就放不出来」。
 */

/** 音质设置的统一出口：主进程只认 lossless / best / 128k 三个值 */
function qualityKey() {
  const q = state.settings && state.settings.onlineQuality
  if (q === 'master') return 'master'
  if (q === 'lossless') return 'lossless'
  if (q === '128k') return '128k'
  return 'best'
}

/**
 * 安全的事件绑定：元素不存在就跳过。
 * 在线面板有 12 处直接 getElementById(...).addEventListener，任一处缺失
 * （裁剪版 / 热替换 / DOM 改动）都会抛 TypeError 让整条 bind() 中断，
 * 结果是面板完全没有交互且没有任何提示。
 */
function onEl(id, ev, fn) {
  const node = document.getElementById(id)
  if (node) node.addEventListener(ev, fn)
}

const Online = {
  list: [],            // 当前搜索结果（OnlineSong）
  keyword: '',
  page: 1,
  hasMore: false,
  loading: false,
  playingId: null,     // 当前正在播的在线曲目 id（on:<src>:<id>）
  probeToken: 0,       // 音质探测轮次（换关键词就作废上一轮）
  _searchRound: 0,     // 新搜索轮次（play 解析期间发起新搜索就作废旧收尾）
  _searchReq: 0,       // v3.3.63：搜索请求代次（换关键词可抢占在途请求，旧结果回来后整包丢弃）
  sources: [],         // 全部可用源（主进程返回）
  proxyBase: '',       // 本地代理基地址 http://127.0.0.1:<port>
  enabled: new Set(),  // 本次参与搜索的源
  dl: [],             // 下载任务（主进程推过来的快照）
  _ready: false,

  async init() {
    // _ready 只在**全部初始化成功后**才置位：以前一进来就置 true，
    // 中途抛错（元素缺失 / 接口异常）会留下「已就绪但不可用」的死状态，
    // 重新进入面板也不会再试一次。
    if (this._ready || this._initing) return
    this._initing = true
    try {
      await this._initOnce()
      this._ready = true
    } finally {
      this._initing = false
    }
  },

  /** 真正的初始化（由 init 包裹，失败会向上抛给调用方提示） */
  async _initOnce() {
    try {
      this.sources = await window.api.onlineSources()
    } catch (err) {
      this.sources = []
    }
    // 本地代理的基地址（端口是主进程启动时随机分配的，必须问一次）
    try {
      this.proxyBase = await window.api.onlineProxyBase()
    } catch (err) {
      this.proxyBase = ''
    }
    const cfg = (state.settings && state.settings.onlineSources) || ['kw', 'qq', 'kg', 'wy']
    this.enabled = new Set(cfg.filter((id) => this.sources.some((s) => s.id === id)))
    if (!this.enabled.size && this.sources.length) this.enabled.add(this.sources[0].id)

    const sel = document.getElementById('opQuality')
    if (sel) sel.value = qualityKey()

    this.renderSources()
    this.bind()
    window.api.onDlUpdate((list) => this.applyDl(list))
    window.api.onNowPlaying((p) => this.onNowPlaying(p))
    this.applyDl(await window.api.onlineDlList().catch(() => []))
  },

  /**
   * 主进程取流时才真正知道拿到的是什么音质，可能和点播那一刻的结论不一样：
   * 点播时解析失败（网络抖动 / 网易限流）会先报 320k，紧接着取流重试成功就是 flac。
   * 与其让界面撒谎，不如等这条事件把它纠正过来。
   */
  onNowPlaying(p) {
    const cur = player.current
    if (!cur || !cur.online || !p) return
    if ((cur.onlineKey || '') !== p.id) return
    let spec = null
    if (p.lossless && !cur.lossless) {
      cur.lossless = true
      cur.ext = 'FLAC'
      spec = {
        text: '无损',
        cls: 'lossless',
        tip: '取流后确认无损 FLAC' + (p.bitrate ? ' · ' + p.bitrate + 'k' : '') + (p.cached ? '（来自缓存）' : '')
      }
      toast('这首其实拿到了无损 FLAC' + (p.bitrate ? ' · ' + p.bitrate + 'k' : '') + (p.cached ? '（来自缓存）' : ''))
    } else if (!p.lossless && cur.lossless) {
      cur.lossless = false
      spec = { text: (p.bitrate || 320) + 'k', cls: 'dim', tip: '这次只拿到 ' + (p.bitrate || 320) + 'k' }
      toast('无损这次没取到，已按 ' + (p.bitrate || 320) + 'k 播放')
    }
    // v3.3.66：以前只改 lossless 标志 —— 规格列还显示点播那一刻的结论，和 toast 打架
    if (spec) this.applyPlayingSpec(cur, spec)
  },

  /**
   * 把「取流后才知道的真实档位」写回当前曲 + 在线列表行 + 已落盘元数据。
   * 落盘那步很关键：收藏页/队列的规格列读的就是它，不更新的话重启后又变回旧结论。
   */
  applyPlayingSpec(cur, spec) {
    cur.specText = spec.text
    cur.specCls = spec.cls
    cur.specTip = spec.tip || ''
    const id = cur.id
    const song = (this.list || []).find((s) => this.keyOf(s) === id)
    if (song) song._q = spec
    const row = Array.from(document.querySelectorAll('#opBody .op-tr')).find((r) => r.dataset.id === id)
    if (row) {
      const cell = row.querySelector('.op-c-q')
      if (cell) {
        cell.textContent = spec.text
        cell.className = 'op-c-q ' + spec.cls
        if (spec.tip) cell.title = spec.tip
      }
    }
    if (cur.onlineMeta) {
      const meta = Object.assign({}, cur.onlineMeta, { spec })
      cur.onlineMeta = meta
      window.api.onlineTracksRemember([meta])
        .then((map) => this.syncOnlineMeta(map))
        .catch(() => {})
    }
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
    const go = () => this.search(true)
    onEl('opGo', 'click', go)
    onEl('opInput', 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go() }
    })

    onEl('opSources', 'click', async (e) => {
      const chip = e.target.closest('.op-chip')
      if (!chip) return
      const id = chip.dataset.src
      const prev = new Set(this.enabled)
      if (this.enabled.has(id)) {
        if (this.enabled.size === 1) { toast('至少保留一个音源'); return }
        this.enabled.delete(id)
      } else {
        this.enabled.add(id)
      }
      this.renderSources()
      // v3.3.32：写盘失败别乐观生效（重启回退、界面还提示成功），照 cache-panel 口径回滚
      const ok = await window.api.patchSettings({ onlineSources: Array.from(this.enabled) }).then(() => true, () => false)
      if (!ok) {
        this.enabled.clear()
        for (const s of prev) this.enabled.add(s)
        this.renderSources()
        toast('设置保存失败，音源开关未生效', 2500)
        return
      }
      if (this.keyword) this.search(true)
    })

    onEl('opQuality', 'change', async (e) => {
      const prev = state.settings.onlineQuality
      const val = e.target.value
      const ok = await window.api.patchSettings({ onlineQuality: val }).then(() => true, () => false)
      if (!ok) { e.target.value = String(prev || 'best'); toast('设置保存失败，音质偏好未生效', 2500); return }
      state.settings.onlineQuality = val
      const label = { master: '母带（体积很大，拿不到自动降级）', lossless: '无损优先（拿不到自动降级）', best: '音质优先（320k）', '128k': '省流量（128k）' }
      toast('已切换：' + (label[val] || val))
    })

    onEl('opCacheBtn', 'click', () => toggleCachePanel())

    onEl('opDirBtn', 'click', async () => {
      const dir = await window.api.onlinePickDownloadDir().catch((err) => { toast('选择目录失败：' + (err.message || err), 2500); return null })
      if (dir) toast('下载目录：' + dir, 3000)
    })
    onEl('opOpenDir', 'click', () => window.api.onlineOpenDownloadDir().catch(() => {}))
    onEl('opDlBtn', 'click', () => this.toggleDlPanel())
    onEl('btnDlClose', 'click', () => this.toggleDlPanel(false))
    onEl('dlOpenDir', 'click', () => window.api.onlineOpenDownloadDir().catch(() => {}))
    onEl('dlClearDone', 'click', async () => {
      const r = await window.api.onlineDlClearDone().catch(() => null)
      toast(r && r.removed ? '已移除 ' + r.removed + ' 条记录' : '没有已完成的任务')
    })
    onEl('dlList', 'click', async (e) => {
      const btn = e.target.closest('button[data-act]')
      const item = e.target.closest('.dl-item')
      if (!btn || !item) return
      const id = item.dataset.id
      const act = btn.dataset.act
      // v3.3.7：补 catch —— 面板按钮失败不再静默刷 unhandled rejection
      if (act === 'pause') await window.api.onlineDlPause(id).catch(() => {})
      else if (act === 'resume') await window.api.onlineDlResume(id).catch(() => {})
      else if (act === 'delete') await window.api.onlineDlDelete(id).catch(() => {})
      else if (act === 'reveal') await window.api.onlineDlReveal(id).catch(() => {})
    })

    onEl('opMore', 'click', () => this.search(false))

    // 行交互：单击选中、双击播放、按钮各管各的
    onEl('opBody', 'dblclick', (e) => {
      const row = e.target.closest('.op-tr')
      if (row && !e.target.closest('.op-act-btn')) this.playAt(Number(row.dataset.index))
    })
    onEl('opBody', 'click', (e) => {
      const row = e.target.closest('.op-tr')
      if (!row) return
      const act = e.target.closest('.op-act-btn')
      if (act) {
        e.stopPropagation()
        const i = Number(row.dataset.index)
        if (act.dataset.act === 'play') this.playAt(i)
        else if (act.dataset.act === 'download') this.downloadAt(i)
        else if (act.dataset.act === 'queue') this.addQueueAt(i)
        else if (act.dataset.act === 'fav') this.toggleFavAt(i)
        else if (act.dataset.act === 'addpl') this.addPlaylistAt(i, act)
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

  render(appendFrom = 0) {
    const body = document.getElementById('opBody')
    if (!body) return
    if (!this.list.length) {
      body.innerHTML = ''
      return
    }
    const srcName = new Map(this.sources.map((s) => [s.id, s.short || s.name]))
    // 加载更多只追加新行：整页重建会销毁已探测的音质节点并让滚动位置归零
    const from = appendFrom > 0 && body.children.length ? appendFrom : 0
    let html = ''
    for (let i = from; i < this.list.length; i++) {
      const s = this.list[i]
      const id = `on:${s.source}:${s.id}`
      const cur = this.playingId === id
      // v3.3.64：收藏状态与本地列表同一口径（state.favorites 里存的就是这个 id）
      const favOn = state.favorites && state.favorites.has(id) ? ' on' : ''
      html += `<div class="op-tr${cur ? ' playing' : ''}" data-index="${i}" data-id="${esc(id)}">
        <div class="c-idx">
          <span class="num">${i + 1}</span>
          <span class="btn-play-row">${icon('play')}</span>
        </div>
        <div class="op-c-title">
          <span class="tt" title="${esc(s.title)}">${esc(s.title)}</span>
        </div>
        <div class="op-c-artist" title="${esc(s.artist)}">${esc(s.artist)}</div>
        <div class="op-c-src"><span class="op-badge ${esc(s.source)}">${esc(srcName.get(s.source) || s.source)}</span></div>
        <div class="op-c-q ${s._q ? esc(s._q.cls) : (s.quality === '320k' ? 'high dim' : 'dim')}" title="${esc(s._q && s._q.tip ? s._q.tip : '还没探测；播放时按实际文件大小算')}">${esc(s._q ? s._q.text : (s.quality || '—'))}</div>
        <div class="op-c-dur">${fmtDuration(s.duration)}</div>
        <div class="op-c-act">
          <button class="op-act-btn" data-act="play" title="播放">${icon('play')}</button>
          <button class="op-act-btn" data-act="queue" title="加入播放队列">${icon('queue')}</button>
          <button class="op-act-btn${favOn}" data-act="fav" aria-pressed="${favOn ? 'true' : 'false'}" title="${favOn ? '取消收藏' : '加入收藏'}">${icon('heart')}</button>
          <button class="op-act-btn" data-act="addpl" title="加入歌单" aria-label="加入歌单">${icon('plus')}</button>
          <button class="op-act-btn" data-act="download" title="下载到本地">${icon('download')}</button>
        </div>
      </div>`
    }
    if (from > 0) body.insertAdjacentHTML('beforeend', html)
    else body.innerHTML = html
    this.probeQuality(from)
  },

  markPlaying(id) {
    this.playingId = id
    document.querySelectorAll('#opBody .op-tr').forEach((el) => {
      el.classList.toggle('playing', el.dataset.id === id)
    })
  },

  /**
   * 逐行探测「实际能拿到什么音质」。
   *
   * 搜索接口给的码率是平台标称（酷我/QQ 一律 128k），看不出无损，容易让人以为放不了 flac。
   * 这里对前 24 行各问一次解析服务——只取 2 字节拿 content-range，顺带把直链塞进缓存，
   * 真点播放时就不用再解析。3 路并发，换关键词就作废上一轮。
   * @param {number} from 「加载更多」追加的起始行（v3.3.66：以前追加的行永不探测，
   *        同一页里前 24 行是实测档位、第 25 行起是平台标称，口径不一致）
   */
  async probeQuality(from = 0) {
    // 只有新一轮搜索才作废上一轮；追加时沿用当前 token，否则会打断上一批的探测
    const token = from === 0 ? ++this.probeToken : this.probeToken
    if (qualityKey() === '128k') return
    const rows = Array.from(document.querySelectorAll('#opBody .op-tr'))
    const todo = []
    for (const row of rows.slice(from, from + 24)) {
      const song = this.list[Number(row.dataset.index)]
      if (song && !song._q) todo.push({ row, song })
    }
    if (!todo.length) return
    let idx = 0
    const worker = async () => {
      while (idx < todo.length) {
        if (this.probeToken !== token) return
        const { row, song } = todo[idx++]
        const r = await window.api.onlineProbe(song, token).catch(() => null)
        if (this.probeToken !== token) return
        if (!r || !r.ok) {
          song._q = { text: song.quality || '—', cls: 'dim' }
        } else if (r.lossless) {
          const hi = r.level === 'jymaster' || r.level === 'master' || (r.bitrate || 0) >= 1411
          song._q = {
            text: hi ? '高解析' : '无损',
            cls: 'lossless',
            tip: (hi ? '高解析 FLAC' : '无损 FLAC') + (r.bitrate ? ' · ' + r.bitrate + 'k' : '') + (r.size ? ' · ' + (r.size / 1048576).toFixed(1) + 'MB' : '')
          }
        } else {
          song._q = { text: (r.bitrate || 0) + 'k', cls: 'dim', tip: '只能拿到 ' + (r.bitrate || 0) + 'k ' + String(r.ext || '').toUpperCase() }
        }
        const cell = row.querySelector('.op-c-q')
        if (cell) {
          cell.textContent = song._q.text
          cell.className = 'op-c-q ' + song._q.cls
          if (song._q.tip) cell.title = song._q.tip
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
  },

  /* ---------------- 搜索 ---------------- */

  async search(reset) {
    const input = document.getElementById('opInput')
    const kw = (input.value || '').trim()
    if (!kw) { input.focus(); return }
    // v3.3.63：以前是一把 loading 布尔锁 —— 搜索最长要十几秒（四家并发，单源超时 15s），
    // 期间「加载更多」和「换关键词回车」都被静默吞掉，界面上没有任何反馈，看着像卡死。
    // 现在：换关键词（reset）可以抢占旧的，旧结果回来时代次对不上就丢弃；
    // 只有「加载更多」在搜索中才拒绝，并且明确提示，不再无声无息。
    if (this.loading && !reset) { toast('正在搜索，请稍候', 1500); return }
    const reqId = ++this._searchReq
    this.loading = true
    if (reset) this._searchRound++
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
      // 已被更新的一轮搜索取代：结果整体丢弃，别把旧词的结果写进新词的列表
      if (reqId !== this._searchReq) return
      const list = (r && r.list) || []
      const appendFrom = reset ? 0 : this.list.length
      if (reset) {
        this.list = list
      } else {
        // 翻页边界抖动 / 换关键词后继续加载时各源可能返回重叠条目：
        // 重复行会让 data-id 同时高亮多条、playAt(i) 索引歧义
        const seen = new Set(this.list.map((s) => `${s.source}:${s.id}`))
        this.list = this.list.concat(list.filter((s) => {
          const k = `${s.source}:${s.id}`
          if (seen.has(k)) return false
          seen.add(k)
          return true
        }))
      }
      // v3.3.7：hasMore 跟请求的 limit（30）对齐。以前用 20 判断，
      // 某页返回 20~29 条且后面其实还有结果时，「加载更多」会被错误隐藏
      this.hasMore = list.length >= 30
      this.render(appendFrom)
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
      if (reqId !== this._searchReq) return
      // v3.3.7：失败要回滚 page —— 以前 page 已经 +1，下次「加载更多」
      // 直接请求下下页，中间一页结果永久丢失
      if (!reset) this.page = Math.max(1, this.page - 1)
      // 第四轮 §4.5.3 #15：界面留着旧结果却写「搜索失败」，用户会以为那是这次的结果。
      // 明确标出「下面是上一次的结果」。
      const keep = reset ? '' : '（下面仍是上一次的结果）'
      this.setStatus('搜索失败：' + esc(err.message || '网络异常') + keep, this.hasMore)
    } finally {
      if (reqId === this._searchReq) {
        this.loading = false
        if (btn) btn.disabled = false
      }
    }
  },

  /* ---------------- 播放 ---------------- */

  /**
   * 播放第 i 首。队列 = 整页搜索结果（**跨源**）。
   *
   * v3.3.40：以前只把「同一个源」的结果放进队列，切上一首/下一首只能在
   * 酷我或 QQ 内部循环，用户看到的是「播哪个源就只能选哪个源」。
   * 现在整页入队：每首的地址自带 src（proxyBase/stream?src=&id=&q=），
   * 解析都发生在播到那一首的时候，所以跨源不会互相踩；某首无版权/付费
   * 放不出来时由播放器的 error 链自动跳下一首（连续 3 首失败才停）。
   */
  async playAt(i) {
    const song = this.list[i]
    if (!song) return
    await this.play(song)
  },

  async play(song) {
    // v3.3.7：加并发 token + 记下发起时的列表 ——
    // 解析要 1~7 秒，期间连点别的歌或执行新搜索都会让 this.list 变成别人的结果，
    // 以前「后解析完成的赢」，队列还可能新旧混着拼
    const token = (this._playToken || 0) + 1
    this._playToken = token
    const round = this._searchRound
    const listAtStart = this.list
    const key = `${song.source}:${song.id}`
    this.setStatus('正在解析「' + esc(song.title) + '」…', this.hasMore)
    const r = await window.api.onlinePlayable(song).catch((err) => ({ ok: false, error: err.message }))
    if (token !== this._playToken) return   // 已被新的播放请求取代，这次作废
    // 解析期间若发起了新搜索，状态栏与 state.visible 已属于新结果，
    // 别用旧歌快照覆盖；但歌本身照播（点播意图不能丢）。this.list 本就不写。
    const stale = round !== this._searchRound
    if (!r || !r.ok) {
      if (!stale) this.setStatus('❌ ' + esc((r && r.error) || '解析失败'), this.hasMore)
      toast((r && r.error) || '解析失败', 3000)
      return
    }
    // 第四轮 §4.5.3 #15：本地代理没起来时以前会拼出相对 /stream，
    // <audio> 只会报 code 4，用户完全看不出是代理端口绑定失败
    if (!this.proxyBase) {
      if (!stale) this.setStatus('❌ 本地代理未就绪（端口绑定失败），请稍后重试', this.hasMore)
      toast('本地代理未就绪，在线播放暂不可用。稍后重试或重启应用', 4000)
      return
    }
    const actual = r.song || song
    const track = this.toTrack(song, r)
    // 队列取整页结果（跨源），与界面上看到的列表一致
    const queue = listAtStart.map((s) => this.toTrack(s, null))
    const idx = queue.findIndex((t) => t.id === track.id)
    if (idx >= 0) queue[idx] = track
    else queue.unshift(track)

    if (!stale) state.visible = queue   // 让「播放全部 / 上一首下一首」在这批结果里生效
    player.setMode('list')
    player.setQueue(queue, idx >= 0 ? idx : 0, true)
    this.markPlaying(track.id)
    const notes = []
    if (r.fallback) notes.push('已自动换源：' + (this.sources.find((s) => s.id === actual.source)?.name || actual.source))
    if (r.partial) notes.push('仅试听片段')
    if (r.lossless) {
      // 档位名不可全信：有的「母带」实际只给 800k 出头的文件，按码率说话更诚实
      const hi = r.level === 'jymaster' || r.level === 'master' || (r.bitrate || 0) >= 1411
      notes.push((hi ? '高解析 FLAC' : '无损 FLAC') + (r.bitrate ? ' ' + r.bitrate + 'k' : ''))
    }
    else if (r.bitrate) notes.push(r.bitrate + 'k')
    if (!stale) {
      this.setStatus(
        `▶ ${esc(actual.title)} — ${esc(actual.artist)}` + (notes.length ? '（' + notes.join(' · ') + '）' : ''),
        this.hasMore
      )
    }
    if (r.partial) toast('这首只有试听片段（版权限制），要完整版请换源或另找', 3500)
  },

  /** 这首歌在本机代理上的地址（解析交给主进程，播到才做） */
  streamUrlFor(song) {
    const q = new URLSearchParams({
      q: qualityKey(),
      t: song.title || '',
      a: song.artist || '',
      d: String(song.duration || 0)
    })
    return `${this.proxyBase}/stream?src=${encodeURIComponent(song.source)}&id=${encodeURIComponent(song.id)}&${q}`
  },

  /** OnlineSong → player 能吃的 ClientTrack */
  toTrack(song, resolved) {
    // 取流地址一律用「用户点的那首」拼，不用换源后的结果：
    // 主进程的缓存键挂在地址上，如果跟着换源结果走，
    // 同一行点两次（一次直连、一次换源）就会变成两份互不相认的缓存。
    const actual = (resolved && resolved.song) || song
    return {
      id: `on:${song.source}:${song.id}`,
      online: actual,                     // 歌词/下载用实际发声的那首
      onlineKey: `${song.source}:${song.id}`,
      audio: this.streamUrlFor(song),
      title: song.title,
      artist: song.artist,
      album: song.album || '',
      duration: song.duration || 0,
      cover: song.cover || null,
      hasLyric: true,
      ext: (resolved && resolved.ext ? resolved.ext : 'mp3').toUpperCase(),
      lossless: !!(resolved && resolved.lossless),
      isDsd: false,
      onlineBitrate: resolved ? resolved.bitrate : 0,
      specText: (song._q && song._q.text) || '',
      specCls: (song._q && song._q.cls) || 'dim',
      specTip: (song._q && song._q.tip) || '',
      path: null
    }
  },

  /* ---------------- 收藏 / 歌单（v3.3.64） ---------------- */

  /** 曲目在 state.favorites / playlists 里的 id 口径（与 toTrack 一致） */
  keyOf(song) {
    return `on:${song.source}:${song.id}`
  },

  /**
   * OnlineSong → 可落盘的元数据。
   * 只留「重播必须的最小集」：标题/歌手/时长/原音源/封面/标称音质。
   * 直链绝对不能存：签名分钟级过期，存下来只会让下次重播必然失败。
   */
  metaOf(song, spec) {
    return {
      id: this.keyOf(song),
      source: song.source,
      songId: String(song.id),
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      duration: Number(song.duration) || 0,
      cover: song.cover || '',
      quality: song.quality || '',
      spec: spec || song._q || null,
      at: Date.now()
    }
  },

  /** 落盘元数据 → OnlineSong（喂给 toTrack / onlinePlayable 的形状） */
  songFromMeta(meta) {
    if (!meta || !meta.source) return null
    return {
      source: meta.source,
      id: String(meta.songId || ''),
      title: meta.title || '',
      artist: meta.artist || '',
      album: meta.album || '',
      duration: Number(meta.duration) || 0,
      cover: meta.cover || null,
      quality: meta.quality || '',
      _q: meta.spec || null
    }
  },

  /**
   * 落盘元数据 → player 能吃的 ClientTrack。
   * 这就是「我的收藏 / 歌单里的在线曲」能被点开播放的全部秘密：
   * 代理地址按记录里的 src + 平台 id 现拼，播到才解析；已缓存的曲子
   * 连解析都省了（/stream 先查缓存），所以重播常常是秒开的。
   */
  trackFromMeta(meta) {
    const song = this.songFromMeta(meta)
    if (!song || !song.id) return null
    const t = this.toTrack(song, null)
    t.onlineMeta = meta          // 换源失败时 error 链要靠它重搜
    return t
  },

  /**
   * 把主进程返回的元数据整表同步到渲染层。
   * 不同步的后果是实测出来的：「我的收藏」要重启一次才看得见刚收藏的在线曲
   * —— 渲染层的 state.onlineMeta 只在启动时读了一次。
   */
  syncOnlineMeta(map) {
    if (!map || typeof map !== 'object') return
    state.onlineMeta = new Map(Object.entries(map))
  },

  /**
   * 在线曲在「写收藏 / 入歌单 / 记历史」之前，先把元数据落盘（v3.3.66）。
   *
   * 底栏 ♥、迷你卡、播放历史这些入口以前只传 id：收藏里于是留下一个没有元数据的
   * `on:` id —— resolveTrack 解析不出来，行被 filter 掉，计数却 +1，重启也在，
   * 而且没法在收藏视图里删掉。返回 true 表示调用方可以继续写引用。
   * 本地曲 / 已有元数据 / 不需要元数据的 id 都直接放行。
   */
  async rememberTrack(track, spec) {
    if (!track) return false
    const id = track.id || (track.source ? this.keyOf(track) : '')
    if (!id) return false
    if (id.indexOf('on:') !== 0) return true
    // v3.3.67：已存档位优先；但「先收藏、后探测」时旧条目没有 spec —— 那时要把
    // 新探测结果补进去。以前 has(id) 就直接 return true，收藏页永远显示「在线」。
    const have = state.onlineMeta && state.onlineMeta.get ? state.onlineMeta.get(id) : null
    if (have) {
      const want = spec || (track && track._q) || null
      const hasSpec = !!(have.spec && (have.spec.text || have.spec.cls))
      if (!want || hasSpec) return true
      try {
        const map = await window.api.onlineTracksRemember([Object.assign({}, have, { spec: want })])
        this.syncOnlineMeta(map)
      } catch (err) {
        console.error('[online] rememberTrack 补档位失败', err)
      }
      return true
    }
    let meta = null
    if (track.onlineMeta && track.onlineMeta.id === id) {
      // 已有落盘条目（重复收藏 / 换源后重播）：只补 spec，不覆盖旧档位
      meta = Object.assign({}, track.onlineMeta, { spec: spec || track._q || track.onlineMeta.spec || null })
    } else {
      // toTrack 出来的 ClientTrack 不带 source/songId，只有 id（on:<src>:<songId>）
      const m = /^on:([^:]+):(.+)$/.exec(id)
      if (!m) return false
      meta = this.metaOf({
        source: m[1],
        id: m[2],
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        cover: track.cover,
        quality: ''
      }, spec || track._q)
    }
    if (!meta) return false
    try {
      const map = await window.api.onlineTracksRemember([meta])
      this.syncOnlineMeta(map)
      return !!(state.onlineMeta && state.onlineMeta.has(id))
    } catch (err) {
      console.error('[online] rememberTrack', err)
      return false
    }
  },

  /** 只补代理基地址（不渲染界面、不绑事件）：启动时给收藏/歌单里的在线曲铺路 */
  async ensureBase() {
    if (this.proxyBase) return this.proxyBase
    try { this.proxyBase = await window.api.onlineProxyBase() } catch (err) { this.proxyBase = '' }
    return this.proxyBase
  },

  /** 行内 ♥：收藏 / 取消收藏，走与本地列表同一条动作管道 */
  async toggleFavAt(i) {
    const song = this.list[i]
    if (!song) return
    const id = this.keyOf(song)
    const on = state.favorites.has(id)
    // 先把元数据落盘再写收藏：prune 只删「无人引用」的条目，先后本身不影响结果；
    // 这样收藏写入失败时也能明确回滚，不会留下半条记录。
    if (!on) {
      const map = await window.api.onlineTracksRemember([this.metaOf(song, song._q)]).catch(() => null)
      if (!map) { toast('收藏失败：在线曲目信息保存失败', 2500); return }
      this.syncOnlineMeta(map)
    }
    currentMenuTrack = this.pseudoTrack(song)
    currentMenuTracks = [currentMenuTrack]
    try { await handleCtxAction('fav') }
    catch (err) { toast('操作失败：' + ((err && err.message) || err), 2500) }
    // 取消收藏后主进程会顺手清理元数据表，这里同步一次，免得渲染层留着已失效的条目
    if (on) await window.api.onlineTracksGet().then((m) => this.syncOnlineMeta(m)).catch(() => {})
    this.paintFavRows()
  },

  /** 行内 ＋：加入歌单（菜单与本地列表同款，选中后走 add-pl 管道） */
  async addPlaylistAt(i, btn) {
    const song = this.list[i]
    if (!song) return
    if (!state.playlists.length) { toast('还没有歌单：先在左侧「新建歌单」', 2500); return }
    const map = await window.api.onlineTracksRemember([this.metaOf(song, song._q)]).catch(() => null)
    if (!map) { toast('加入歌单失败：在线曲目信息保存失败', 2500); return }
    this.syncOnlineMeta(map)
    currentMenuTrack = this.pseudoTrack(song)
    currentMenuTracks = [currentMenuTrack]
    const box = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : null
    UI.showContextMenu(
      box ? box.left : 0,
      box ? box.bottom + 6 : 0,
      state.playlists.map((p) => ({ label: p.name, act: 'add-pl', arg: p.id }))
    )
  },

  /** 在线行冒充本地 track，只为复用 handleCtxAction（它只用到 id / title / artist） */
  pseudoTrack(song) {
    return {
      id: this.keyOf(song),
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      duration: Number(song.duration) || 0,
      online: { source: song.source, id: String(song.id) }
    }
  },

  /** 收藏动作后把行内 ♥ 就地翻过来（opBody 不走 UI.syncFavMarks 的 .tr 选择器） */
  paintFavRows() {
    document.querySelectorAll('#opBody .op-tr').forEach((row) => {
      const btn = row.querySelector('.op-act-btn[data-act="fav"]')
      if (!btn) return
      const on = state.favorites.has(row.dataset.id)
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
      btn.title = on ? '取消收藏' : '加入收藏'
    })
  },

  /**
   * 原音源失效时的换源兜底（error 链调用）。
   * 用「标题 + 歌手」在全部音源里重搜，按标题/歌手/时长打分挑一条；
   * 分数不够就返回 null（宁可说找不到，也不拿一首别的歌糊弄用户）。
   */
  async recoverFromSources(meta) {
    if (!meta) return null
    const kw = ((meta.title || '') + ' ' + (meta.artist || '')).trim()
    if (!kw) return null
    try { await this.init() } catch (err) { /* 下面按 proxyBase 判断 */ }
    if (!this.proxyBase) return null
    const sources = this.sources.map((s) => s.id)
    if (!sources.length) return null
    const r = await window.api.onlineSearch({ keyword: kw, page: 1, limit: 15, sources }).catch(() => null)
    const list = (r && r.list) || []
    let best = null
    let bestScore = 0
    for (const s of list) {
      const score = this.matchScore(s, meta)
      if (score > bestScore) { bestScore = score; best = s }
    }
    return bestScore >= 60 ? best : null
  },

  /**
   * 换源候选打分（阈值 60）。
   *
   * 标题全等 45 / 标题包含 30（Live、伴奏这类后缀靠它进来）；歌手全等 +25、包含 +12；
   * 时长差 ≤3 秒 +15、≤8 秒 +8、超过 40 秒 -20。
   *
   * 标题对不上直接 0 分 —— 不参与竞争。这样 60 分的门槛实际含义是
   * 「标题命中 + 至少一条佐证（歌手或时长）」，同名的翻唱、同名不同曲进不来。
   */
  matchScore(song, meta) {
    const norm = (x) => String(x || '').toLowerCase().replace(/[\s\-_()（）\[\]【】·,，.。'"!！?？&+]/g, '')
    const t1 = norm(song.title)
    const t2 = norm(meta.title)
    if (!t1 || !t2) return 0
    let score
    if (t1 === t2) score = 45
    else if (t1.includes(t2) || t2.includes(t1)) score = 30
    else return 0
    const a1 = norm(song.artist)
    const a2 = norm(meta.artist)
    if (a1 && a2) {
      if (a1 === a2) score += 25
      else if (a1.includes(a2) || a2.includes(a1)) score += 12
    }
    const d1 = Number(meta.duration) || 0
    const d2 = Number(song.duration) || 0
    if (d1 && d2) {
      const d = Math.abs(d1 - d2)
      if (d <= 3) score += 15
      else if (d <= 8) score += 8
      else if (d > 40) score -= 20
    }
    return score
  },

  /** 加入队列（不打断当前播放） */
  addQueueAt(i) {
    const song = this.list[i]
    if (!song) return
    // 与 play() 同口径：代理未就绪时 toTrack 会拼出相对 /stream，播到该曲必然 404
    if (!this.proxyBase) {
      toast('本地代理未就绪，在线播放暂不可用。稍后重试或重启应用', 4000)
      return
    }
    player.addToQueue(this.toTrack(song, null))
    toast('已加入队列：' + song.title)
  },

  /* ---------------- 下载 ---------------- */

  async downloadAt(i) {
    const song = this.list[i]
    if (!song) return
    let r
    try { r = await window.api.onlineDownload(song) }
    catch (err) { toast('下载启动失败：' + (err.message || err), 3000); return }
    if (!r || !r.ok) {
      toast((r && r.error) || '下载启动失败', 3000)
      if (r && r.id) this.toggleDlPanel(true)
      return
    }
    // 有任务就把下载面板打开，让用户看得见进度 / 能暂停
    this.toggleDlPanel(true)
    toast('开始下载：' + song.title)
  },

  /* ---------------- 下载面板 ---------------- */

  toggleDlPanel(show) {
    const panel = document.getElementById('dlPanel')
    if (!panel) return
    panel.hidden = show === undefined ? !panel.hidden : !show
    if (!panel.hidden) {
      // 两个面板都在右下角，别叠在一起
      const cache = document.getElementById('cachePanel')
      if (cache) cache.hidden = true
      this.renderDlPanel()
    }
  },

  applyDl(payload) {
    // 第四轮 §4.5.3 #13：主进程改成增量推送，载荷是 { full, items }。
    // 旧格式（纯数组）仍兼容，按全量处理。
    const full = !payload || Array.isArray(payload) || payload.full !== false
    const items = Array.isArray(payload) ? payload : ((payload && payload.items) || [])
    const prev = new Map(this.dl.map((t) => [t.id, t]))
    if (full) {
      this.dl = items.slice()
    } else {
      const idx = new Map(this.dl.map((t, i) => [t.id, i]))
      for (const t of items) {
        const i = idx.get(t.id)
        if (i === undefined) { this.dl.push(t); idx.set(t.id, this.dl.length - 1) }
        else this.dl[i] = t
      }
    }
    for (const t of this.dl) {
      const old = prev.get(t.id)
      if (old && old.status !== t.status) {
        if (t.status === 'done') toast('下载完成：' + (t.path || '').split(/[\\/]/).pop(), 3500)
        else if (t.status === 'error') toast('下载失败：' + (t.error || '未知错误'), 3500)
      }
    }
    this.renderDlPanel()
    this.paintDlRows()
  },

  /** 列表每行的下载按钮：显示百分比 / 已有任务的状态 */
  paintDlRows() {
    // 在线面板没显示时不必每 250ms 把搜索列表全量扫一遍
    const pane = document.getElementById('onlinePane')
    if (!pane || pane.hidden) return
    const byKey = new Map()
    for (const t of this.dl) {
      if (t.status === 'done' || t.status === 'error') continue
      byKey.set(t.key, t)
    }
    document.querySelectorAll('#opBody .op-tr').forEach((row) => {
      const btn = row.querySelector('.op-act-btn[data-act="download"]')
      if (!btn) return
      const key = (row.dataset.id || '').replace(/^on:/, '')
      const t = byKey.get(key)
      const pct = t && t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : null
      // 主进程 250ms 推一次进度：只在显示状态变化时重建按钮节点，
      // 否则每次都销毁 SVG / 百分比节点并抹掉 hover 态
      const state = !t ? 'idle' : t.status === 'paused' ? 'paused' : (pct == null ? '…' : pct + '%')
      btn.title = !t ? '下载到本地'
        : t.status === 'paused' ? '已暂停：' + this.dlHuman(t)
        : '下载中 ' + (pct == null ? '' : pct + '%') + ' · ' + this.dlHuman(t)
      if (btn.dataset.dlSig === state) return
      btn.dataset.dlSig = state
      if (!t) {
        btn.innerHTML = icon('download')
        btn.classList.remove('busy')
        return
      }
      btn.classList.add('busy')
      btn.innerHTML = t.status === 'paused'
        ? '<span style="font-size:10px;color:var(--txt-3)">暂停</span>'
        : `<span style="font-size:10px;color:var(--accent)">${state}</span>`
    })
  },

  dlHuman(t) {
    const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB')
    if (t.status === 'done') return mb(t.received)
    if (!t.total) return mb(t.received)
    return mb(t.received) + ' / ' + mb(t.total)
  },

  renderDlPanel() {
    const panel = document.getElementById('dlPanel')
    if (!panel || panel.hidden) return
    const list = document.getElementById('dlList')
    const sum = document.getElementById('dlSummary')
    const active = this.dl.filter((t) => t.status === 'downloading' || t.status === 'pausing' || t.status === 'queued').length
    const paused = this.dl.filter((t) => t.status === 'paused').length
    const done = this.dl.filter((t) => t.status === 'done').length
    const bad = this.dl.filter((t) => t.status === 'error').length
    if (sum) {
      const parts = []
      if (active) parts.push(active + ' 个下载中')
      if (paused) parts.push(paused + ' 个已暂停')
      if (done) parts.push(done + ' 个已完成')
      if (bad) parts.push(bad + ' 个失败')
      sum.textContent = parts.length ? parts.join(' · ') : '还没有下载任务'
    }
    if (!this.dl.length) {
      this._dlSig = ''
      list.innerHTML = '<div class="dl-empty">点歌曲行尾的 ↓ 就能下载，任务会出现在这里</div>'
      return
    }
    // v3.3.16：主进程每 250ms 推一次整表快照。以前每次都整段 innerHTML 重建，
    // 5 个并发任务就是每秒 20 次全量重排 —— 滚动位置归零、按钮 hover/按下态被抹掉。
    // 现在按「任务集合 + 各自状态」做签名：状态没变就只改进度条与文字，不重建 DOM。
    const sig = this.dl.map((t) => t.id + ':' + t.status).join('|')
    if (sig === this._dlSig && list.firstElementChild) {
      this.paintDlProgress()
      return
    }
    this._dlSig = sig
    const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB')
    const speed = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB/s' : Math.round(n / 1024) + 'KB/s')
    list.innerHTML = this.dl.slice().sort((a, b) => b.at - a.at).map((t) => {
      const pct = t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0
      let line = ''
      let warn = ''
      let barCls = ''
      let acts = ''
      if (t.status === 'done') {
        // v3.3.63：上游没给 Content-Length 的（chunked）无法校验完整性，
        // 主进程已置 unverified —— 界面上必须能看见，否则用户以为是完整文件。
        // v3.3.66：警告改成独立节点 —— 以前把 <span> 拼进 line 再整体 esc()，
        // 面板上显示的是这串源码
        line = '已完成 · ' + mb(t.received) + ' · ' + String(t.ext || '').toUpperCase()
        if (t.unverified) warn = '⚠ 长度未知，可能不完整'
        barCls = ' done'
        acts = `<button data-act="reveal">打开位置</button><button data-act="delete">移除</button>`
      } else if (t.status === 'paused') {
        line = '已暂停 · ' + mb(t.received) + (t.total ? ' / ' + mb(t.total) : '')
        barCls = ' paused'
        acts = `<button data-act="resume">继续</button><button data-act="delete">删除</button>`
      } else if (t.status === 'error') {
        line = '失败：' + (t.error || '未知原因')
        barCls = ' error'
        acts = `<button data-act="resume">重试</button><button data-act="delete">删除</button>`
      } else if (t.status === 'pausing') {
        line = '正在暂停…'
        barCls = ' paused'
        acts = `<button data-act="delete">删除</button>`
      } else {
        line = (t.total ? pct + '% · ' + mb(t.received) + ' / ' + mb(t.total) : mb(t.received)) +
          (t.speed ? ' · ' + speed(t.speed) : '')
        acts = `<button data-act="pause">暂停</button><button data-act="delete">删除</button>`
      }
      return `<div class="dl-item" data-id="${esc(t.id)}">
        <div class="dl-top">
          <span class="dl-name" title="${esc((t.artist ? t.artist + ' - ' : '') + (t.title || '未知歌曲'))}">${esc(t.title || '未知歌曲')}</span>
          <span class="dl-pct">${t.status === 'done' ? '100%' : (t.total ? pct + '%' : '')}</span>
        </div>
        <div class="dl-sub">${esc(t.artist || '')} · <span class="dl-line">${esc(line)}${warn ? ' · <span class="dl-warn" style="color:var(--warn,#d9a300)">' + esc(warn) + '</span>' : ''}</span></div>
        <div class="dl-bar"><i class="${barCls}" style="width:${t.status === 'done' ? 100 : pct}%"></i></div>
        <div class="dl-acts">${acts}</div>
      </div>`
    }).join('')
  },

  /** 只刷新进度（签名不变时走这条，避免整表重建） */
  paintDlProgress() {
    const list = document.getElementById('dlList')
    if (!list) return
    const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB')
    const speed = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB/s' : Math.round(n / 1024) + 'KB/s')
    const byId = new Map(this.dl.map((t) => [String(t.id), t]))
    for (const item of list.children) {
      const t = byId.get(item.dataset.id)
      if (!t || t.status !== 'downloading') continue
      const pct = t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0
      const pctEl = item.querySelector('.dl-pct')
      if (pctEl) pctEl.textContent = t.total ? pct + '%' : ''
      const lineEl = item.querySelector('.dl-line')
      if (lineEl) {
        lineEl.textContent = (t.total ? pct + '% · ' + mb(t.received) + ' / ' + mb(t.total) : mb(t.received)) +
          (t.speed ? ' · ' + speed(t.speed) : '')
      }
      const bar = item.querySelector('.dl-bar > i')
      if (bar) bar.style.width = pct + '%'
    }
  }

}
