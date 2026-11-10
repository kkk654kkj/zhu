'use strict'
/**
 * 在线音源适配层（联网版新增）。
 *
 * 统一四个平台：酷我(kw) / 网易(wy) / QQ(qq) / 酷狗(kg)。
 * 每个源实现三个能力：search() 搜索、getUrl() 取播放直链、getLyric() 取歌词。
 * 平台接口随时可能失效，所以所有请求都容错返回 null，绝不让主进程崩。
 *
 * 直链有有效期（URL 内嵌签名和时间戳），这里按 20 分钟缓存，过期自动重取。
 */

const crypto = require('crypto')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT = 15000

/* 主进程把 logLine 注进来，方便平台接口哪天挂了能在日志里看出来 */
let logger = () => {}
function setLogger(fn) { if (typeof fn === 'function') logger = fn }

/* v3.3.18：整链取消用的三个小工具。Node 18+ 有 AbortSignal.any，老版本退回手工桥接 */
function abortError() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}
function anySignal(a, b) {
  if (!a) return b
  if (!b) return a
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const c = new AbortController()
  const onAbort = () => { try { c.abort() } catch (e) { /* 已 abort */ } }
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return c.signal
}
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    if (!signal) { setTimeout(resolve, ms); return }
    if (signal.aborted) { resolve(); return }
    const t = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * 各平台 CDN 认的 Referer。
 *
 * 无损链路（青听网关通吃四家、ChKSz 主打 QQ/酷狗）会把**别的平台**的直链交给我们，
 * 以前统一塞网易的 Referer —— CDN 做白名单校验时直接 403/无 content-range，
 * probeStream 判 broken 后整档无损被跳过，用户只看到「明明有 flac 却一直 320k」。
 */
const SOURCE_REFERER = {
  wy: 'https://music.163.com/',
  qq: 'https://y.qq.com/',
  kg: 'https://www.kugou.com/',
  kw: 'https://www.kuwo.cn/'
}
function refererFor(source) {
  return SOURCE_REFERER[source] || SOURCE_REFERER.wy
}

/* ---------------- 通用请求 ---------------- */

/**
 * 发一次请求并返回原始 Response（带超时与主动释放能力）。
 * 不做重试 —— 重试策略在 req() 里统一处理。
 */
async function reqOnce(url, opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT)
  // v3.3.18：外部 signal（无损窗口超时 / 客户端断开 / 切歌）必须能收掉这次请求。
  // 以前 opts.signal 到这里完全没被读取，上层传了也白传 —— 输家仍跑满 timeout
  // 并继续扣 ChKSz 的每日额度。
  const ext = opts.signal
  const onAbort = () => { clearTimeout(timer); try { ctrl.abort() } catch (e) { /* 已 abort */ } }
  if (ext) {
    if (ext.aborted) { clearTimeout(timer); throw abortError() }
    ext.addEventListener('abort', onAbort, { once: true })
  }
  let detached = false
  const detach = () => {
    if (detached) return
    detached = true
    if (ext) ext.removeEventListener('abort', onAbort)
  }
  try {
    const headers = { 'User-Agent': UA, ...(opts.headers || {}) }
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      redirect: 'follow',
      signal: ctrl.signal
    })
    // v3.3.7：超时必须覆盖到**正文**。以前拿到响应头就 clearTimeout，
    // 之后 res.text()/json() 挂起时毫无约束（undici 默认 bodyTimeout 300 秒），
    // 一个慢源能把整次搜索拖死。把清计时器挂到正文消费完成之后。
    const done = () => { clearTimeout(timer); detach() }
    // v3.3.13：不消费正文的调用（探测/失败响应）必须能主动释放，
    // 否则 timer 与连接会一直留到超时（每个探测 8~15 秒）
    res.release = () => {
      clearTimeout(timer)
      detach()
      try { if (res.body) res.body.cancel() } catch (e) { /* 已释放 */ }
    }
    const origText = res.text.bind(res)
    res.text = () => origText().finally(done)
    const origJson = res.json.bind(res)
    res.json = () => origJson().finally(done)
    if (res.arrayBuffer) {
      const origAb = res.arrayBuffer.bind(res)
      res.arrayBuffer = () => origAb().finally(done)
    }
    // 注意：不消费正文的调用（只看响应头的探测）会让计时器活着，
    // 超时后 abort 掉连接反而是对的（顺带防了 socket 泄漏）
    return res
  } catch (err) {
    clearTimeout(timer)
    detach()
    throw err
  }
}

/**
 * 发请求。429 / 5xx 做一次短退避重试。
 *
 * 各家状态码的脾气：网易连搜两次会回 405、ChKSz 有配额限流、聚合网关偶发 5xx，
 * 这些都是一次抖动就恢复的。以前一律直接失败并降级到下一个源，
 * 用户看到的是「这个源又没结果」。
 * 404/403/416 属于确定性失败，不重试。
 */
async function req(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    if (opts.signal && opts.signal.aborted) throw abortError()
    const res = await reqOnce(url, opts)
    const retriable = res.status === 429 || res.status >= 500
    if (attempt >= 1 || !retriable) return res
    try { res.release && res.release() } catch (e) { /* 已释放 */ }
    // v3.3.18：abort 后别再睡满 400~700ms，更别再发一次（对 ChKSz 就是再扣一次额度）
    await sleepAbortable(400 + Math.random() * 300, opts.signal)
  }
}

async function reqText(url, opts = {}) {
  try {
    const res = await req(url, opts)
    if (!res.ok) {
      try { res.release && res.release() } catch (e) { /* 忽略 */ }
      logger('[req] HTTP ' + res.status + ' ' + String(url).slice(0, 80))
      return null
    }
    return await res.text()
  } catch (err) {
    if (!err || err.name !== 'AbortError') {
      logger('[req] ' + ((err && err.message) || err) + ' ' + String(url).slice(0, 80))
    }
    return null
  }
}

async function reqJson(url, opts) {
  const txt = await reqText(url, opts)
  if (!txt) return null
  try {
    return JSON.parse(txt)
  } catch (err) {
    return null
  }
}

function encode(s) {
  return encodeURIComponent(s)
}

/** 秒 → mm:ss */
function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/** 把 HTML 实体和多余空白清掉（酷我的歌名带 &nbsp;） */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 音源接口返回的 ext 只认白名单：它会被拼进缓存文件名，
 * 万一接口给出 '../../evil' 这类值就是目录穿越。非法一律回退 mp3。
 */
/**
 * 码率统一成 kbps。
 * 各家字段单位不一致：酷狗明确给 bps（除以 1000），网易要自己算，
 * 酷我原样透传（可能是 bps 也可能是 kbps）。单位一旦猜错，
 * probeStream 的 `>=32` 与 maybeUpgrade 的 `>=96` 就会全部走偏 ——
 * 前者丢掉实测值，后者误以为音质够好而放弃补救。
 */
function normBitrate(v) {
  const n = Number(v) || 0
  if (n <= 0) return 0
  // 大于 10000 只可能是 bps（320000 / 1411200），kbps 不会有这个量级
  return Math.round(n > 10000 ? n / 1000 : n)
}

function safeExt(x) {
  const e = String(x == null ? '' : x).toLowerCase()
  return /^(mp3|m4a|flac|ogg|aac|wav|ape)$/.test(e) ? e : 'mp3'
}

/* ---------------- 酷我 ---------------- */

/**
 * 酷我搜索接口有两种返回：带 mobi=1&vipver=1 时是标准 JSON，
 * 不带时是 JS 字面量（单引号、键不加引号）。
 * 两种都要能解析——接口行为会变，不能只押一种。
 */
function parseKuwoList(text) {
  if (!text) return []
  try {
    const j = JSON.parse(text)
    const list = j && j.abslist
    if (Array.isArray(list)) return list
  } catch (err) { /* 落到宽松解析 */ }

  const out = []
  // 逐个对象扫描：{'KEY':'val', ...}
  const objRe = /\{[^{}]*\}/g
  let m
  while ((m = objRe.exec(text))) {
    const body = m[0]
    if (!/DC_TARGETID|MUSICRID|"DC_TARGETID"/.test(body)) continue
    const obj = {}
    // v3.3.17：值分支以前只认带引号的字符串，无引号的数字（DURATION:245）会整体丢失，
    // duration 变 0 → probeStream 的 expectDuration 与 relevance 的时长加权全部失效
    const kvRe = /['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:\s*(?:'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d+)?))/g
    let kv
    while ((kv = kvRe.exec(body))) {
      obj[kv[1]] = kv[2] !== undefined ? kv[2].replace(/\\'/g, "'") : kv[3]
    }
    if (obj.DC_TARGETID) out.push(obj)
  }
  return out
}

const kw = {
  id: 'kw',
  name: '酷我',
  short: 'KW',
  maxQuality: '320k mp3',

  async search(keyword, page = 1, limit = 30, opts = {}) {
    const pn = Math.max(0, page - 1)
    const url = `http://search.kuwo.cn/r.s?all=${encode(keyword)}&ft=music&itemset=web_2013`
      + `&client=kt&pn=${pn}&rn=${limit}&rformat=json&encoding=utf8&mobi=1&vipver=1`
    const txt = await reqText(url, opts)
    const rows = parseKuwoList(txt)
    return rows.map((r) => ({
      source: 'kw',
      id: String(r.DC_TARGETID || r.MUSICRID || '').replace(/^MUSIC_/, ''),
      title: clean(r.NAME || r.SONGNAME),
      artist: clean(r.ARTIST || '未知歌手'),
      album: clean(r.ALBUM || ''),
      duration: Number(r.DURATION) || 0,
      // 酷我搜索结果自带格式清单，界面据此标注有没有 320k / 无损
      quality: /MP3H|MP3HIGH|ALFLAC/.test(String(r.FORMATS || '')) ? '320k' : '128k',
      hasLossless: /ALFLAC|FLAC/.test(String(r.FORMATS || '')),
      cover: r.web_albumpic_short
        ? `https://img2.kuwo.cn/star/albumcover/${String(r.web_albumpic_short).replace(/^\//, '')}`
        : '',
      raw: undefined
    })).filter((s) => s.id && s.title)
  },

  async getUrl(song, prefer = 'best', opts = {}) {
    const br = prefer === 'lossless' ? 'flac' : prefer === '128k' ? '128kmp3' : '320kmp3'
    const url = `http://nmobi.kuwo.cn/mobi.s?f=web&source=kwplayer_ar_9.3.0.0_B_jiakong_vh.apk`
      + `&type=convert_url_with_sign&br=${br}&rid=${encode(song.id)}`
    const j = await reqJson(url, opts)
    const d = j && j.data
    if (!d || !d.url || d.url === 'None') return null
    return {
      url: d.url,
      ext: safeExt(d.format),
      bitrate: normBitrate(d.bitrate),
      duration: Number(d.duration) || song.duration || 0,
      referer: 'https://www.kuwo.cn/'
    }
  },

  async getLyric(song, opts = {}) {
    const j = await reqJson(`http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encode(song.id)}&httpsStatus=1`, opts)
    const list = j && j.data && j.data.lrclist
    if (!Array.isArray(list) || !list.length) return null
    const meta = j.data.songinfo || {}
    const head = []
    if (meta.songName) head.push(`[ti:${meta.songName}]`)
    if (meta.artist) head.push(`[ar:${meta.artist}]`)
    if (meta.album) head.push(`[al:${meta.album}]`)
    const lines = list.map((l) => {
      const t = Number(l.time) || 0
      const mm = String(Math.floor(t / 60)).padStart(2, '0')
      const ss = String(Math.floor(t % 60)).padStart(2, '0')
      // v3.3.16：截到 99 —— Math.round((t%1)*100) 在尾数 ≥0.995 时会给出 100，
      // 而 padStart(2) 不截断，会拼出 [00:12.100]，LRC 解析器按三位百分秒解析出错
      const cs = String(Math.min(99, Math.round((t % 1) * 100))).padStart(2, '0')
      return `[${mm}:${ss}.${cs}]${l.lineLyric || ''}`
    })
    return head.concat(lines).join('\n')
  }
}

/* ---------------- 网易云 ---------------- */

const wy = {
  id: 'wy',
  name: '网易云',
  short: 'WY',
  maxQuality: '320k mp3',

  async search(keyword, page = 1, limit = 30, opts = {}) {
    const offset = (page - 1) * limit
    // 主用 cloudsearch/pc：不限频，返回也全（带封面、时长）。
    // 老的 /api/search/get/web 现在对同一 IP 限得很死，连搜两次就 405，只作兜底。
    let j = await reqJson(
      `https://music.163.com/api/cloudsearch/pc?s=${encode(keyword)}&type=1&limit=${limit}&offset=${offset}`,
      { headers: { Referer: 'https://music.163.com' }, ...opts }
    )
    if (!(j && j.code === 200 && j.result && Array.isArray(j.result.songs))) {
      j = await reqJson(
        'https://music.163.com/api/search/get?s=' + encode(keyword) + `&type=1&limit=${limit}&offset=${offset}`,
        { headers: { Referer: 'https://music.163.com', Cookie: 'appver=2.0.2' }, ...opts }
      )
    }
    const songs = j && j.result && j.result.songs
    if (!Array.isArray(songs)) {
      if (j && j.code && j.code !== 200) logger('[wy] 搜索失败 code=' + j.code + ' ' + (j.msg || ''))
      return []
    }
    // 两套接口字段名不一样：cloudsearch 用 ar/al/dt，老接口用 artists/album/duration
    return songs.map((s) => {
      const artists = s.ar && s.ar.length ? s.ar : (s.artists || [])
      const album = s.al || s.album || {}
      const ms = s.dt || s.duration || 0
      return {
        source: 'wy',
        id: String(s.id),
        title: clean(s.name),
        artist: clean(artists.map((a) => a && a.name).filter(Boolean).join(' / ') || (album.artist && album.artist.name) || '未知歌手'),
        album: clean(album.name || ''),
        duration: Math.round((Number(ms) || 0) / 1000),
        quality: '128k',
        hasLossless: false,
        cover: clean(album.picUrl || ''),
        raw: undefined
      }
    }).filter((s) => s.id && s.title)
  },

  /** 网易没有公开的取链接口，走「外链播放」：无版权的歌会 302 到 404 页面 */
  async getUrl(song, prefer = 'best', opts = {}) {
    const u = `https://music.163.com/song/media/outer/url?id=${encode(song.id)}.mp3`
    try {
      // 用 Range 取 2 字节验证：既确认是音频，也确认支持断点（mpv 拖动进度需要）
      const res = await req(u, {
        headers: { Referer: 'https://music.163.com', Range: 'bytes=0-1' },
        ...opts
      })
      // 只读响应头，正文必须显式释放：否则每次取链留一个 15 秒 timer + 未归还连接
      try { res.release && res.release() } catch (e) { /* 忽略 */ }
      if (!res.ok && res.status !== 206) return null
      const type = res.headers.get('content-type') || ''
      if (/text\/html/i.test(type)) return null      // 落到 404 页
      if (!/audio|octet-stream|mpeg/i.test(type)) return null
      // 外链会 302 到 m801.music.126.net，统一升到 https，避免混合内容被拦
      const finalUrl = res.url.replace(/^http:\/\//i, 'https://')
      const total = Number(res.headers.get('content-range')?.split('/')[1]) || 0
      const bitrate = total && song.duration ? Math.round((total * 8) / song.duration / 1000) : 0
      return {
        url: finalUrl,
        ext: 'mp3',
        bitrate: bitrate > 400 ? 0 : bitrate,
        duration: song.duration || 0,
        referer: 'https://music.163.com/'
      }
    } catch (err) {
      return null
    }
  },

  async getLyric(song, opts = {}) {
    const j = await reqJson(`https://music.163.com/api/song/lyric?id=${encode(song.id)}&lv=1&kv=1&tv=-1`, {
      headers: { Referer: 'https://music.163.com' }, ...opts
    })
    const lrc = j && j.lrc && j.lrc.lyric
    return lrc && /\[\d{1,3}:/.test(lrc) ? lrc : null
  }
}

/* ---------------- QQ 音乐 ---------------- */

const qq = {
  id: 'qq',
  name: 'QQ音乐',
  short: 'QQ',
  maxQuality: '128k m4a（非会员）',

  async search(keyword, page = 1, limit = 30, opts = {}) {
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&w=${encode(keyword)}`
      + `&n=${limit}&p=${page}&cr=1&new_json=1&aggr=1&lossless=0`
    const txt = await reqText(url, { headers: { Referer: 'https://y.qq.com/' }, ...opts })
    if (!txt) return []
    let j = null
    try {
      // 接口偶尔返回 jsonp 包裹
      j = JSON.parse(txt.replace(/^callback\(|\)$/g, ''))
    } catch (err) {
      return []
    }
    const list = j && j.data && j.data.song && j.data.song.list
    if (!Array.isArray(list)) return []
    return list.map((s) => {
      const albumMid = (s.album && s.album.mid) || s.albummid || ''
      return {
        source: 'qq',
        id: String(s.mid || s.songmid || ''),
        title: clean(s.name || s.songname),
        artist: clean((s.singer || []).map((a) => a.name).join(' / ') || '未知歌手'),
        album: clean((s.album && s.album.name) || s.albumname || ''),
        duration: Number(s.interval) || 0,
        quality: '128k',
        hasLossless: false,
        cover: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : '',
        raw: undefined
      }
    }).filter((s) => s.id && s.title)
  },

  async getUrl(song, prefer = 'best', opts = {}) {
    // 未登录只能拿到非 VIP 歌曲的试听链（m4a）
    const payload = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: String(Math.floor(1e9 + Math.random() * 9e9)),
          songmid: [song.id],
          songtype: [0],
          uin: '0',
          loginflag: 1,
          platform: '20'
        }
      },
      comm: { uin: 0, format: 'json', ct: 24, cv: 0 }
    }
    const j = await reqJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
      body: JSON.stringify(payload),
      ...opts
    })
    const d = j && j.req_0 && j.req_0.data
    const info = d && d.midurlinfo && d.midurlinfo[0]
    const purl = info && info.purl
    if (!purl) return null
    const sip = (d.sip && d.sip[0]) || 'https://ws.stream.qqmusic.qq.com/'
    return {
      url: sip.replace(/^http:/, 'https:') + purl,
      ext: /\.m4a/i.test(purl) ? 'm4a' : 'mp3',
      // v3.3.17：以前硬编码 128 —— probeStream 因 `info.bitrate >= 32` 直接采信它、
      // 丢掉 Content-Range 实测值，于是 maybeUpgrade 的「>=96k 就不补救」对 QQ 恒成立、
      // 「候选 <128k 就跳过」恒不成立。给 0 表示「不知道」，让探测结果说话。
      bitrate: 0,
      duration: song.duration || 0,
      referer: 'https://y.qq.com/'
    }
  },

  async getLyric(song, opts = {}) {
    const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encode(song.id)}`
      + `&format=json&nobase64=1&g_tk=5381`
    const txt = await reqText(url, { headers: { Referer: 'https://y.qq.com/portal/player.html' }, ...opts })
    if (!txt) return null
    try {
      const j = JSON.parse(txt.replace(/^MusicJsonCallback\(|\)$/g, ''))
      const lrc = j && j.lyric
      return lrc && /\[\d{1,3}:/.test(lrc) ? lrc : null
    } catch (err) {
      return null
    }
  }
}

/* ---------------- 酷狗 ---------------- */

const kg = {
  id: 'kg',
  name: '酷狗',
  short: 'KG',
  maxQuality: '128k mp3（部分）',

  async search(keyword, page = 1, limit = 30, opts = {}) {
    const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encode(keyword)}&page=${page}`
      + `&pagesize=${limit}&platform=WebFilter&userid=0&clientver=2000&iscorrection=1`
      + `&privilege_filter=0&filter=10&area_code=1&tag_aggr=1`
    const j = await reqJson(url, opts)
    const list = j && j.data && j.data.lists
    if (!Array.isArray(list)) return []
    return list.map((s) => ({
      source: 'kg',
      id: String(s.FileHash || ''),
      // 320k 用另一条 hash，存起来省一次搜索
      idHq: s.HQFileHash ? String(s.HQFileHash) : '',
      title: clean(s.SongName),
      artist: clean(s.SingerName || '未知歌手'),
      album: clean(s.AlbumName || ''),
      duration: Number(s.Duration) || 0,
      quality: s.HQFileHash ? '320k' : '128k',
      hasLossless: false,
      cover: s.Image ? String(s.Image).replace('{size}', '400') : '',
      albumId: String(s.AlbumID || ''),
      raw: undefined
    })).filter((s) => s.id && s.title)
  },

  /** 走 tracker 接口；热门版权歌会返回 status=2（无授权），此时按失败处理交给别的源 */
  async getUrl(song, prefer = 'best', opts = {}) {
    // v3.3.17：idHq 与 id 相同时前两条请求完全一样，白跑一次 15 秒超时的请求。
    // 用 seen 去重（hash + br 相同即视为同一次尝试）。
    const tries = []
    const seen = new Set()
    const push = (hash, br) => {
      const h = String(hash || '').toLowerCase()
      if (!h) return
      const k = h + '|' + br
      if (seen.has(k)) return
      seen.add(k)
      tries.push({ hash: h, br })
    }
    if (song.idHq) push(song.idHq, 'hq')
    push(song.id, 'hq')
    push(song.id, '')
    for (const t of tries) {
      const key = crypto.createHash('md5').update(t.hash + 'kgcloudv2').digest('hex')
      const url = `https://trackercdn.kugou.com/i/v2/?key=${key}&hash=${t.hash}&br=${t.br}`
        + `&appid=1005&pid=2&cmd=25&behavior=play`
      if (opts.signal && opts.signal.aborted) return null
      const j = await reqJson(url, { headers: { Referer: 'https://www.kugou.com/' }, ...opts })
      if (j && j.status === 1 && j.url) {
        const u = Array.isArray(j.url) ? j.url[0] : j.url
        if (u) {
          return {
            url: u,
            ext: safeExt(j.extName),
            bitrate: normBitrate(j.bitRate),
            duration: song.duration || 0,
            referer: 'https://www.kugou.com/'
          }
        }
      }
    }
    return null
  },

  async getLyric(song, opts = {}) {
    const search = await reqJson(`https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=`
      + `&duration=&hash=${encode(song.id)}`, opts)
    const cand = search && search.candidates && search.candidates[0]
    if (!cand) return null
    const dl = await reqJson(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${encode(cand.id)}`
      + `&accesskey=${encode(cand.accesskey)}&fmt=lrc&charset=utf8`, opts)
    if (!dl || !dl.content) return null
    const txt = Buffer.from(dl.content, 'base64').toString('utf8')
    return /\[\d{1,3}:/.test(txt) ? txt : null
  }
}

/* ---------------- 源注册表 ---------------- */

const SOURCES = { kw, wy, qq, kg }
/**
 * 顺序即优先级：搜索时按这个顺序交错合并，跨源兜底也按这个顺序试。
 *
 * 网易排最后是有实测依据的：它的公开搜索索引里，热门版权歌的原唱已经拿不到，
 * 搜「晴天 周杰伦」出来的前几条全是翻唱和自我上传（“晴天(深情版) - Lucky小爱”）。
 * 拿它兜底既慢又容易换错人，所以放末位，只在其他源都没有时再试。
 */
const SOURCE_ORDER = ['kw', 'qq', 'kg', 'wy']

function listSources() {
  return SOURCE_ORDER.map((id) => ({
    id,
    name: SOURCES[id].name,
    short: SOURCES[id].short,
    quality: SOURCES[id].maxQuality
  }))
}

/**
 * 搜索相关度打分：各平台自己排出来的顺序经常把翻唱/伴奏/片段排在正版前面，
 * 用户搜「起风了」第一首是抖音翻唱版会很难受。这里简单按「歌名/歌手是否命中」
 * 重排一次，命中越多越靠前，伴奏类和 DJ 版降权。
 */
function relevance(song, keyword) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_()（）\[\]【】·.。]/g, '')
  const k = norm(keyword)
  const t = norm(song.title)
  const a = norm(song.artist)
  let score = 0
  if (t && t === k) score += 12
  else if (t && k.includes(t)) score += 7
  else if (t && t.includes(k)) score += 5
  if (a && k.includes(a)) score += 5
  if (song.duration >= 90 && song.duration <= 600) score += 2
  if (/伴奏|纯音乐|ktv|karaoke|dj版|翻自|remix|cover/i.test(song.title)) score -= 5
  return score
}

/* ---------------- 搜索缓存 ---------------- */

/**
 * 各平台对同一 IP 的搜索都有频次限制（网易最狠，几次就 405）。
 * 缓存三分钟：既省一次往返，也让「改个字再改回来」这类操作不白吃配额。
 * 只缓存有结果的查询，空结果不缓存——免得某次网络抖动把关键词钉死三分钟。
 */
const SEARCH_TTL_MS = 3 * 60 * 1000
const searchCache = new Map()

async function searchOne(id, keyword, page, limit) {
  const key = `${id}|${keyword}|${page}|${limit}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    // v3.3.17：命中即前移（delete + set 走 Map 插入序）→ 真 LRU。
    // 以前不刷新序，热词反而先被淘汰，本质是 FIFO。
    searchCache.delete(key)
    searchCache.set(key, hit)
    return hit.list
  }
  try {
    const list = await SOURCES[id].search(keyword, page, limit)
    if (Array.isArray(list) && list.length) {
      if (searchCache.size > 120) {
        // 先按 TTL 清过期项，再按插入序淘汰，避免长期会话里驻留一堆过期列表
        const now = Date.now()
        for (const [k, v] of searchCache) { if (now - v.at > SEARCH_TTL_MS) searchCache.delete(k) }
        while (searchCache.size > 120) searchCache.delete(searchCache.keys().next().value)
      }
      searchCache.set(key, { list, at: Date.now() })
    }
    return list
  } catch (err) {
    logger('[online] ' + id + ' 搜索异常：' + err.message)
    return []
  }
}

async function search(keyword, page = 1, limit = 30, sourceIds = null) {
  const ids = (sourceIds && sourceIds.length ? sourceIds : SOURCE_ORDER).filter((id) => SOURCES[id])
  const results = await Promise.all(ids.map((id) => searchOne(id, keyword, page, limit)))
  // 交错合并：各家第一首、各家第二首……避免某一源把整页占满
  const merged = []
  const maxLen = Math.max(0, ...results.map((r) => r.length))
  for (let i = 0; i < maxLen; i++) {
    for (const list of results) {
      if (list[i]) merged.push(list[i])
    }
  }
  // 第一页才按相关度重排：翻页时用户是想"看后面的"，顺序应该稳定
  if (page === 1) {
    merged.sort((x, y) => relevance(y, keyword) - relevance(x, keyword))
  }
  return merged
}

/* ---------------- 直链缓存 ---------------- */

const URL_TTL_MS = 20 * 60 * 1000
const urlCache = new Map()   // key: src:id:prefer → { url, ext, bitrate, duration, at }

/** v3.3.7：直链缓存加上限淘汰 —— 以前只进不出，长会话缓慢膨胀 */
function urlCachePut(key, rec) {
  // v3.3.16：探测不可信（unverified）或只是试听片段（partial）的结果一律不入缓存。
  // 以前只在 resolvePlayable 的某一处做了判断，getPlayable 的普通分支与降级链
  // 仍会无条件写入 —— 于是 30 秒片段/死链会被当成「完整版」缓存 20 分钟，
  // 期间同一首歌再怎么点都直接命中它，连换源都不试。
  if (!rec || rec.unverified || rec.partial) return
  if (urlCache.size > 300) {
    const now = Date.now()
    for (const [k, v] of urlCache) { if (now - v.at > URL_TTL_MS) urlCache.delete(k) }
    while (urlCache.size > 300) urlCache.delete(urlCache.keys().next().value)
  }
  urlCache.set(key, rec)
}

/**
 * v3.3.17：作废某首歌的直链缓存。
 *
 * 平台签名直链可能提前失效（换签名 / 风控 / 同一 IP 多端），而缓存 TTL 是 20 分钟、
 * 期间没有任何回写路径 —— 用户在这段时间里每次点这首歌都命中同一条死链，
 * 换源逻辑压根不会触发，只能重启。播放器收到 file-error 时调这个即可。
 */
function invalidateUrl(song, prefer) {
  if (!song) return false
  const base = cacheKey(song, prefer || 'best')
  // v3.3.18：无损结果写的是 'flac:' + cacheKey(...)，以前两个分支都匹配不到：
  // 精确键只删不带前缀的，全清分支又用 startsWith('src:id:') 漏掉 'flac:src:id:'。
  // 结果 file-error 后 20 分钟内仍反复命中同一条死链，换源永远不触发。
  const prefix = song.source + ':' + song.id + ':'
  const keys = prefer ? [base, 'flac:' + base] : Array.from(urlCache.keys())
  let hit = false
  for (const k of keys) {
    if (prefer) {
      if (urlCache.delete(k)) hit = true
    } else if (k.startsWith(prefix) || k.startsWith('flac:' + prefix)) {
      urlCache.delete(k)
      hit = true
    }
  }
  return hit
}

function cacheKey(song, prefer) {
  return `${song.source}:${song.id}:${prefer}`
}

/**
 * 探测直链是否完整。
 *
 * 平台对热门歌经常只给 30 秒试听，而接口会老老实实说"这段音频 11 秒"——
 * 拿这个时长去算码率反而算出来很正常（185KB/11s = 135k），完全看不出问题。
 * 所以必须用**搜索结果里的歌曲时长**做基准：
 * ① 文件大小 ÷ 歌曲时长 < 40kbps → 试听；
 * ② 接口给的片段时长明显短于歌曲时长（<70%）→ 试听。
 */
async function probeStream(info, realDuration, expectDuration = 0, opts = {}) {
  const signal = opts.signal
  // v3.3.7：探测失败重试一次 —— 网络抖动一次就不给结果，
  // 会让试听片段被当成完整版进缓存
  for (let attempt = 0; attempt < 2; attempt++) {
  if (signal && signal.aborted) return { ...info, unverified: true }
  try {
    const headers = { Range: 'bytes=0-1' }
    if (info.referer) headers.Referer = info.referer
    if (info.headers && typeof info.headers === 'object') Object.assign(headers, info.headers)
    const res = await req(info.url, { headers, timeout: 8000, signal })
    // v3.3.13：本函数只看响应头，正文必须显式取消，否则每个探测留 8 秒 timer + 连接
    try { res.release && res.release() } catch (e) { /* 忽略 */ }
    // v3.3.8：先看状态码 —— 404/503 的直链以前只要 content-type 不是 html
    // 就被当有效结果放行（content-range 为空 → total=0 → 原样返回），进 20 分钟缓存
    if (!res.ok && res.status !== 206) return { ...info, broken: true }
    const cr = res.headers.get('content-range') || ''
    const total = Number(cr.split('/')[1]) || 0
    const type = res.headers.get('content-type') || ''
    if (/text\/html/i.test(type)) return { ...info, broken: true }
    if (!total || !realDuration) return { ...info, unverified: true }
    const kbps = Math.round((total * 8) / realDuration / 1000)
    // 兜底换源时，候选的时长不能自己跟自己对——必须跟**用户点的那首歌**比。
    // 否则「45 秒剪辑版」永远判不出来：0.7MB/45s = 130k，看着比谁都健康。
    const expect = expectDuration || realDuration
    const tooShort = realDuration > 0 && expect > 0 && realDuration < expect * 0.7
    return {
      ...info,
      size: total,
      // v3.3.18：实测码率优先。接口标称值单位混乱（bps/kbps 混用）还会谎报，
      // 采信它会让 partial 与 maybeUpgrade 的判据全部走偏；标称值只在实测缺失时兜底。
      bitrate: kbps > 0 ? kbps : (Number(info.bitrate) || 0),
      partial: kbps < 40 || tooShort
    }
  } catch (err) {
    if (signal && signal.aborted) return { ...info, unverified: true }
    if (attempt === 1) {
      // 再失败只能原样放行，但必须标记 unverified ——
      // 否则 30 秒试听片段会被当成完整版写进 20 分钟直链缓存
      return { ...info, unverified: true }
    }
  }
  }
}

/* ---------------- 无损：借聚合 API 取网易的 flac ---------------- */

/**
 * 折腾了一圈才定下这条路，记录一下各家现状（2026-10 实测）：
 *
 *  · 酷我：mobi.s 换直链带 br=flac 也只回 11 秒 / bitrate=1，VIP 歌一律试听；
 *  · 咪咕：listenSong.do?toneFlag=SQ 要么「暂不提供试听地址」，要么给 mp3，不是 flac；
 *  · 酷狗：trackercdn br=flac 全返回 status=2（无授权）；
 *  · 网易：自己的 eapi 要登录态，但公开的聚合 API 能用「网易 id + br=999」直接换到 flac。
 *
 * 洛雪那些音源脚本看着什么平台都能无损，实际都是走各家的自建中转服务器
 * （脚本里能看到 97.64.x.x 之类地址），依赖别人的账号和带宽，说不准哪天就没了，
 * 不适合塞进这个离线可用的播放器。所以只接「查得到 id 就能换」的这一条。
 *
 * 代价是覆盖面受网易曲库限制：周杰伦这类网易没版权的，原唱在网易索引里根本搜不到，
 * 出来全是翻唱。所以这里的校验必须狠——宁可退回 320k 原唱，也不能给用户一个翻唱 flac。
 */
const GD_API = 'https://music-api.gdstudio.xyz/api.php'
const FLAC_PREFER = 'lossless'

/* ---------------- 无损来源②：青听网关（四家通吃，含母带） ---------------- */

/**
 * 青听音乐（Windows 客户端 v1.0.3）用的解析网关，协议是从它的 app.asar 里读出来的：
 *
 *   POST {base}/gateway/ticket      → 领一张 12 小时的匿名票（ttl 43200s）
 *   POST {base}/music/resolve-url   → { source, rid, level } 换直链
 *
 * 头里带 6 个字段，签名是
 *   HMAC-SHA256(secret, [appId, ts, nonce, METHOD, pathname, sha256hex(body)].join('\n'))
 * 匿名票 uid 为空也能用，不需要登录、不需要 key。
 *
 * 相比 GDStudio：支持 QQ/酷我/酷狗（周杰伦那批终于有 flac）、单次 150~600ms、
 * 还能要 master / jymaster 母带档。代价是老样子——别人的中转服务，随时可能停，
 * 所以拿不到就当没有，直接走后面的降级链路，绝不影响能出声这件事。
 */
const QING_BASES = ['https://musicserver.haitangw.cc/v1', 'https://qt.haitangw.net/v1']
const QING_APP_ID = 'qingmusic-desktop'
const QING_SECRET = 'qm-gw-7c1f4e9a2b8d5360e1a7c4f9b2d8036c'
const QING_VER = '1.0.3'
/** 我们的源 id → 它的源 id（它是 tx，我们沿用 tx 之外的叫法 qq） */
const QING_SRC = { wy: 'wy', qq: 'tx', kg: 'kg', kw: 'kw' }
/** 每档偏好的尝试顺序；拿不到就往下掉一级 */
const QING_LEVELS = {
  master: { wy: ['jymaster', 'hires', 'lossless'], qq: ['jymaster', 'hires', 'lossless'], kw: ['master', 'hires', 'lossless'], kg: ['hires', 'lossless'] },
  lossless: { wy: ['lossless'], qq: ['lossless'], kw: ['lossless'], kg: ['lossless'] }
}

let qingOn = true
let qingTicket = ''
let qingTicketExp = 0
let qingTicketPending = null
// 设备号只在内存里随机生成：服务端只拿它绑票，不校验硬件，重启换一个没关系
const qingDevice = crypto.randomBytes(8).toString('hex')

function setQingEnabled(on) { qingOn = on !== false }

function qingHeaders(method, url, body, ticket) {
  const ts = String(Date.now())
  const nonce = crypto.randomBytes(16).toString('hex')
  let path = '/'
  try { path = new URL(url).pathname || '/' } catch (err) { /* 保持 / */ }
  const raw = [QING_APP_ID, ts, nonce, method.toUpperCase(), path,
    crypto.createHash('sha256').update(body, 'utf8').digest('hex')].join('\n')
  const h = {
    'X-Qing-App-Id': QING_APP_ID,
    'X-Qing-App-Version': QING_VER,
    'X-Qing-Device-Id': qingDevice,
    'X-Qing-Ts': ts,
    'X-Qing-Nonce': nonce,
    'X-Qing-Sign': crypto.createHmac('sha256', QING_SECRET).update(raw, 'utf8').digest('hex')
  }
  if (ticket) h.Authorization = 'Bearer ' + ticket
  return h
}

/** 领票；12 小时有效，提前 10 分钟换新的 */
async function qingEnsureTicket(opts = {}) {
  if (qingTicket && Date.now() < qingTicketExp) return qingTicket
  if (qingTicketPending) return qingTicketPending
  const signal = opts.signal
  qingTicketPending = (async () => {
    for (const base of QING_BASES) {
      if (signal && signal.aborted) return ''
      try {
        const url = base + '/gateway/ticket'
        const body = JSON.stringify({ deviceId: qingDevice, appVersion: QING_VER, platform: 'win32' })
        const r = await req(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...qingHeaders('POST', url, body) },
          body,
          timeout: 8000,
          signal
        })
        const j = await r.json().catch(() => null)
        if (j && j.ticket) {
          qingTicket = j.ticket
          // v3.3.8：expiresAt 单位防御 —— 若服务端返回秒（<1e12），按毫秒比会
          // 让票据永远「已过期」，每次解析都白跑一趟领票接口
          let exp = Number(j.expiresAt)
          // v3.3.18：expiresAt 可能是「绝对秒 / 绝对毫秒 / 相对 TTL 秒」三种。
          // 相对 TTL（如 43200）乘 1000 后落在 1970 年，票据永远判已过期，
          // 每首歌都白跑一次 8 秒领票接口，还会成为无损窗口的后台输家。
          if (exp > 0 && exp < 1e9) exp = Date.now() + exp * 1000
          else if (exp >= 1e9 && exp < 1e12) exp *= 1000
          qingTicketExp = exp > 0 ? exp - 600000 : Date.now() + 3600000
          return qingTicket
        }
      } catch (err) { /* 换下一条线路 */ }
    }
    return ''
  })().finally(() => { qingTicketPending = null })
  return qingTicketPending
}

/** 换一次直链；返回 { url } 或 null */
async function qingResolveOnce(source, rid, level, opts = {}) {
  const signal = opts.signal
  let ticket = await qingEnsureTicket(opts)
  if (!ticket || (signal && signal.aborted)) return null
  const body = JSON.stringify({ source, rid, level })
  let ticketRetry = 0
  for (let i = 0; i < QING_BASES.length; i++) {
    if (signal && signal.aborted) return null
    const base = QING_BASES[i]
    const url = base + '/music/resolve-url'
    try {
      const r = await req(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Request-Id': 'qmpc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          ...qingHeaders('POST', url, body, ticket)
        },
        body,
        timeout: 8000,
        signal
      })
      const j = await r.json().catch(() => null)
      if (!j) continue
      if (j.code === 0 || j.code === '0') {
        const d = j.data || {}
        // need_decrypt：酷我偶发会回加密流，本地没有它的 AES 密钥。
        // v3.3.17：这里只放弃**这一档**（continue 到下一个 level / 下一条线路），
        // 以前 return null 把整条青听链路直接掐死，备用 base 也不会试
        if (d.need_decrypt) continue
        if (d.url) return { url: d.url, headers: d.playbackHeaders || d.headers || null }
        // v3.3.18：主线路回了 code=0 但没 url，不能掐断备用线路
        continue
      }
      // 票过期就作废并**当场重领**：继续用捕获的旧票跑剩下的线路必然全挂
      const qcode = String(j.code ?? '')
      // v3.3.13：网关可能用数字码（401/403/419/10001）表示票据过期，
      // 只匹配字符串关键字会让过期票一直用到超时
      if (/TICKET|AUTH|TOKEN/i.test(qcode) || /^(401|403|419|10001|10002)$/.test(qcode)) {
        qingTicket = ''
        ticket = await qingEnsureTicket(opts)
        // 重领的票要拿去重试**当前**线路一次，而不是白等到下一个 base
        if (ticket && ticketRetry++ < 1 && !(signal && signal.aborted)) i--
      }
    } catch (err) { /* 换下一条线路 */ }
  }
  return null
}

/** 按音质档从青听网关取 flac */
async function qingLossless(song, prefer, opts = {}) {
  if (!qingOn) return null
  const signal = opts.signal
  const source = QING_SRC[song.source]
  if (!source || !song.id) return null
  const levels = (QING_LEVELS[prefer] || QING_LEVELS.lossless)[song.source] || []
  const duration = song.duration || 0
  for (const level of levels) {
    if (signal && signal.aborted) return null
    const got = await qingResolveOnce(source, String(song.id), level, opts)
    if (!got || !got.url) continue
    // v3.3.17：签名直链常常没有扩展名（/resolve/xxx?sign=...），以前一律 continue，
    // 真无损被当成「不是 flac」丢掉，整条青听链路白跑。现在只排除明确的有损后缀，
    // 其余交给 probeStream 按码率确认（下面 hasFlacExt 的判定）。
    if (/\.(mp3|m4a|aac|ogg|wav)(\?|$)/i.test(got.url)) continue
    const probed = await probeStream(
      { url: got.url, ext: 'flac', bitrate: 0, duration, referer: refererFor(song.source), headers: got.headers },
      duration,
      duration,
      opts
    )
    if (probed.broken || probed.partial || probed.unverified) continue
    // 没有 .flac 后缀的地址必须用码率兜底确认：无损一般 >700k，
    // 达不到就说明网关给的是有损档，不能标成 lossless 骗界面
    const hasFlacExt = /\.flac(\?|$)/i.test(got.url)
    if (!hasFlacExt && (probed.bitrate || 0) < 700) continue
    return {
      ...probed,
      duration,
      actual: song,
      lossless: true,
      ext: 'flac',
      level,
      from: 'qing'
    }
  }
  return null
}

/**
 * 可选的第二个无损来源：ChKSz API（需要用户自己注册拿 apikey）。
 *
 * 为什么需要它：GDStudio 只能查网易，而网易没有周杰伦这类歌的版权，
 * 所以那些歌永远拿不到无损。ChKSz 背后是别人的 SVIP 号池，
 * 网易/QQ/酷狗都能给 flac——正好补上 QQ 和酷狗这一半。
 *
 * 代价是额度（据其文档：每日 50 次/账户），所以只在「源是 QQ/酷狗」时才用它，
 * 网易的歌优先走免费的 GDStudio，省着点花。
 */
let extraKey = ''
function setExtraKey(k) {
  extraKey = String(k || '').trim()
}

const CHKSZ = 'https://api.chksz.com/api'

/** 按源把我们的 id 换成 ChKSz 的请求（它只认 wy / qq / kg 三种） */
function chkszEndpoint(song, key) {
  const id = encode(song.id)
  const k = encode(key)
  if (song.source === 'wy') return `${CHKSZ}/163_music?id=${id}&level=lossless&apikey=${k}`
  if (song.source === 'qq') return `${CHKSZ}/qq_music?mid=${id}&size=flac&apikey=${k}`
  if (song.source === 'kg') return `${CHKSZ}/kugou_music?id=${id}&size=flac&apikey=${k}`
  return null // 酷我它不支持
}

/** 用 ChKSz 拿 flac；拿不到（没 key / 无权限 / 额度用完）返回 null */
async function chkszLossless(song, key, opts = {}) {
  const url = chkszEndpoint(song, key)
  if (!url || (opts.signal && opts.signal.aborted)) return null
  const j = await reqJson(url, { timeout: 8000, signal: opts.signal })
  if (!j || j.code !== 200 || !j.url) {
    if (j && j.code === 401) logger('[chksz] apikey 无效')
    else if (j && (j.code === 402 || j.code === 429)) logger('[chksz] 额度不足或被限流 ' + j.code)
    return null
  }
  const fmt = String(j.format || j.bitrate || '').toLowerCase()
  const isFlac = /\.flac(\?|$)/i.test(j.url) || fmt === 'flac' || normBitrate(j.br) >= 700
  if (!isFlac) return null
  const duration = song.duration || 0
  const probed = await probeStream(
    // bitrate 给 0：让 probeStream 用 Content-Range 实测值说话，别采信接口标称
    { url: j.url, ext: 'flac', bitrate: 0, duration, referer: refererFor(song.source) },
    duration,
    duration,
    opts
  )
  if (probed.broken || probed.partial || probed.unverified) return null
  // v3.3.18：与青听链对齐，签名直链没有 .flac 后缀时用实测码率确认确实是无损档
  if (!/\.flac(\?|$)/i.test(j.url) && (probed.bitrate || 0) < 700) return null
  return {
    ...probed,
    duration,
    actual: song,
    lossless: true,
    ext: 'flac',
    from: 'chksz'
  }
}

/** 这首歌在网易有没有对得上的条目（歌手必须一致，时长差太多不要） */
async function neteaseTwin(song, opts = {}) {
  if (song.source === 'wy' && song.id) return song
  if (opts.signal && opts.signal.aborted) return null
  try {
    const list = await SOURCES.wy.search(`${song.title} ${song.artist}`.trim(), 1, 20, opts)
    return rankMatches(list, song)[0] || null
  } catch (err) {
    return null
  }
}

/** 验一下 apikey 能不能用（会在对方那边消耗 1 次额度，所以只在保存时调） */
async function testExtraKey(key) {
  const k = String(key || '').trim()
  if (!k) return { ok: false, error: '没有填 key' }
  const j = await reqJson(`${CHKSZ}/163_music?id=1330348068&level=lossless&apikey=${encode(k)}`, { timeout: 9000 })
  if (!j) return { ok: false, error: '接口没有响应（网络不通或被墙）' }
  if (j.code === 401) return { ok: false, error: 'apikey 无效' }
  if (j.code === 402) return { ok: false, error: '额度已用完' }
  if (j.code === 429) return { ok: false, error: '请求太频繁，稍后再试' }
  if (j.code === 200) return { ok: true, gotUrl: !!j.url }
  return { ok: false, error: j.msg || ('接口返回 code ' + j.code) }
}

/** 面板上「测试网关」用：领票 + 拿一首固定歌换直链，判断这条线还活着没 */
async function qingSelfTest() {
  const t0 = Date.now()
  try {
    const ticket = await qingEnsureTicket()
    if (!ticket) return { ok: false, error: '领不到票（线路不通）' }
    const got = await qingResolveOnce('wy', '1330348068', 'lossless') // 起风了
    if (!got || !got.url) return { ok: false, error: '票正常，但换不到直链' }
    return { ok: true, ms: Date.now() - t0 }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/**
 * 拿无损直链，按「免费优先、花钱的兜底」的顺序试：
 *
 *  ① QQ/酷狗 的歌 → 有 key 就直接问 ChKSz（网易根本没这些歌，绕过去是白跑）
 *  ② 网易这条路 → GDStudio（免费，覆盖大部分非版权独占的歌）
 *  ③ 还不行且有 key → ChKSz 兜底（网易源也能用它的 163_music）
 *
 * 返回 null 表示「这首歌拿不到无损」，调用方直接降级即可。
 * 注意 GDStudio 的搜索接口极慢（实测 7~90 秒），所以只用它的 url 接口。
 */
async function resolveLossless(song, prefer, opts = {}) {
  const key = extraKey
  const signal = opts.signal
  const stopped = () => !!(signal && signal.aborted)

  // ⓪ 青听网关：四家都支持、还快，先问它。失败就往下走，别处照旧
  try {
    const qing = await qingLossless(song, prefer === 'master' ? 'master' : 'lossless', opts)
    if (qing) return qing
  } catch (err) {
    logger('[qing] 解析异常 ' + err.message)
  }

  // ① QQ / 酷狗：只有 ChKSz 能拿（GDStudio 只支持网易）
  // v3.3.17：③ 的兜底会对同一首再调一次 ChKSz（twin 为 null 时参数完全一样），
  // 白耗一次每日 50 次的额度，且结果必然与这里相同 —— 记下已试过的 id 供 ③ 跳过。
  let chkszTried = ''
  if (stopped()) return null
  if (key && (song.source === 'qq' || song.source === 'kg')) {
    chkszTried = song.source + ':' + song.id
    const got = await chkszLossless(song, key, opts)
    if (got) return got
  }

  // ② 网易：免费的 GDStudio
  if (stopped()) return null
  const twin = await neteaseTwin(song, opts)
  if (twin) {
    const askUrl = () => reqJson(`${GD_API}?types=url&source=netease&id=${encode(twin.id)}&br=999`,
      { timeout: 7000, signal })
    // 这个聚合 API 抖动挺厉害，同一首歌两次跑结果可能不同。
    // 拿不到响应（超时/502）就再问一次；但它明确回了一个非 flac 地址，说明这首确实没有，别浪费第二次。
    let j = await askUrl()
    if (!j || !j.url) {
      if (stopped()) return null
      j = await askUrl()
    }
    if (stopped()) return null
    if (j && j.url) {
      const br = Number(j.br) || 0
      // 有些歌只给 320k mp3，也走这个接口——那种情况不算无损，交给降级处理
      if (/\.flac(\?|$)/i.test(j.url) || br >= 700) {
        // 真取一下头几个字节，确认不是错误页
        const probed = await probeStream(
          { url: j.url, ext: 'flac', bitrate: 0, duration: twin.duration || song.duration || 0, size: Number(j.size) || 0, referer: 'https://music.163.com/' },
          twin.duration || song.duration || 0,
          song.duration || 0,
          opts
        )
        if (!probed.broken && !probed.partial && !probed.unverified &&
            // v3.3.18：与青听链同一把尺子 —— 无 .flac 后缀时用实测码率确认没被塞有损档
            (/\.flac(\?|$)/i.test(j.url) || (probed.bitrate || 0) >= 700)) {
          return {
            ...probed,
            // 播放时长以下载得到的这份为准，界面上的时长别被蹭偏
            duration: twin.duration || song.duration || 0,
            actual: twin,
            lossless: true,
            ext: 'flac',
            level: '',
            from: 'gd'
          }
        }
      }
    }
  }

  // ③ 兜底：有 key 的话，ChKSz 再试一次（腾讯/酷狗的号池有时比免费接口更硬）
  if (stopped()) return null
  if (key) {
    const target = twin || song
    const tid = target.source + ':' + target.id
    // 同一首已经在上面的 ① 试过一次，这里再试必然同样失败，别白扣额度
    if (tid !== chkszTried) {
      const got = await chkszLossless(target, key, opts)
      if (got) return { ...got, actual: target }
    }
  }
  return null
}

/**
 * 取播放直链（对外入口）。
 *
 * prefer = 'lossless' 时先试无损，拿不到再按普通链路降级——
 * 「至少要有无损」和「不能因为拿不到无损就放不出来」这两件事都得成立。
 */
async function getPlayable(song, prefer = 'best', opts = {}) {
  // lossless / master 都走无损链路，区别只在「要求哪一档」；拿不到都降级
  if (prefer === FLAC_PREFER || prefer === 'master') {
    const key = 'flac:' + cacheKey(song, prefer)
    const hit = urlCache.get(key)
    if (hit && Date.now() - hit.at < URL_TTL_MS) {
      return { ...hit, song: hit.actual || song, fallback: false, lossless: true }
    }
    // 无损解析可能 1~7 秒，而「这首歌根本没有无损」要等它跑完才知道。
    // 所以让降级链路在旁边并行跑：1.5 秒还没拿到 flac 就把它拉起来，
    // 万一 flac 迟迟不来（6 秒），用户至少立刻有声音，不用干等十秒。
    // v3.3.18：两条并行链各绑一个 controller。窗口超时后无损链必须被 abort，
    // 否则它会在后台跑完青听/ChKSz/GDStudio，白扣每日 50 次额度；反过来无损
    // 先赢时降级链的结果没人用，也要收掉。外部 signal（客户端断开/切歌）一并组合。
    const losslessCtrl = new AbortController()
    const fbCtrl = new AbortController()
    const losslessSignal = anySignal(opts.signal, losslessCtrl.signal)
    const fbSignal = anySignal(opts.signal, fbCtrl.signal)
    let fbPromise = null
    const startFallback = () => {
      if (fbPromise) return fbPromise
      fbPromise = (async () => {
        const res = await resolvePlayable(song, 'best', { ...opts, signal: fbSignal })
        if (!res) return null
        const up = await maybeUpgrade(res, song, 'best', { signal: fbSignal })
        // v3.3.17：缓存命中的结果不能重新盖时间戳 —— 否则反复点同一首 lossless 歌，
        // 1.5 秒定时器每次都给**已过期的签名直链**续期，TTL 被无限重置，
        // 正是上面 L1019「命中不重写时间戳」那条修复要防的事。
        if (!res.fromCache) urlCachePut(cacheKey(song, 'best'), { ...up, at: Date.now() })
        return up
      })().catch(() => null)   // race 赢家直接 return 时它无人 await，吞掉悬空 rejection
      return fbPromise
    }
    const fbTimer = setTimeout(startFallback, 1500)

    let got = null
    let losslessTimer = null
    let losslessDone = false
    // v3.3.17：窗口按档位分。母带要多跳几级（jymaster → hires → lossless）且常走两条线路，
    // 9 秒对它太紧；普通无损 7 秒足够。注释里承诺的「6 秒」早就和实现对不上了。
    const losslessWait = prefer === 'master' ? 12000 : 7000
    const losslessTimeout = new Promise((r) => { losslessTimer = setTimeout(() => r(null), losslessWait) })
    try {
      got = await Promise.race([
        // 吞掉输家的 rejection，避免 unhandledRejection；超时后由 finally 主动 abort
        resolveLossless(song, prefer, { signal: losslessSignal })
          .then((v) => { losslessDone = true; return v })
          .catch(() => { losslessDone = true; return null }),
        // QQ 那边偶尔要 5 秒才给链，窗口给足；超过就先用降级结果出声
        losslessTimeout
      ])
    } catch (err) {
      logger('[flac] 解析异常 ' + err.message)
    } finally {
      clearTimeout(fbTimer)
      clearTimeout(losslessTimer)   // v3.3.13：成功也要清，别留空定时器
      // 超时赢（或解析抛错）→ 中止无损链；正常返回后 abort 已无意义
      if (!losslessDone) losslessCtrl.abort()
      // 无损赢 → 降级链结果无人消费，收掉它
      if (got) fbCtrl.abort()
    }
    if (got) {
      const rec = { ...got, at: Date.now() }
      urlCachePut(key, rec)
      return { ...rec, song: got.actual || song, fallback: false, lossless: true }
    }
    // 降级：注意这里必须把 prefer 换回 best，各家 getUrl 只认 best / 128k
    const up = await startFallback()
    if (!up) return null
    return { ...up, lossless: false }
  }
  const res = await resolvePlayable(song, prefer, opts)
  if (!res) return null
  // v3.3.7：缓存命中不重写时间戳 —— 以前每次命中都续期，平台签名直链
  // 过期后反而拿不到新链，死链被无限续命
  if (res.fromCache) return res
  const up = await maybeUpgrade(res, song, prefer, opts)
  urlCachePut(cacheKey(song, prefer), { ...up, at: Date.now() })
  return up
}

/**
 * 音质补救：主源只给 48k / 64k 这种糊音质时，去别的源碰碰运气。
 *
 * 只在「已经拿到完整版、但码率低于 96k」时才跑，所以绝大多数歌没有额外耗时；
 * 上限 6 秒，超时就用手上这个——宁可音质差一点，也不能让用户干等。
 */
async function maybeUpgrade(res, song, prefer, opts = {}) {
  if (res.partial) return res
  if ((res.bitrate || 0) >= 96) return res
  if (opts.signal && opts.signal.aborted) return res
  const t0 = Date.now()
  // v3.3.17：预算改成「剩余时间」，并在每个 await 之间复查。
  // 以前只在 for 头部判一次，循环体内 search(15s) + 2×(getUrl 15s + probe 16s)
  // 单源最坏能跑到 77 秒 —— 注释承诺的「上限 6 秒」完全没兑现。
  const left = () => 6000 - (Date.now() - t0)
  for (const id of SOURCE_ORDER) {
    if (opts.signal && opts.signal.aborted) break
    if (id === res.song.source || !SOURCES[id]) continue
    if (left() <= 0) break
    try {
      const list = await SOURCES[id].search(`${song.title} ${song.artist}`.trim(), 1, 10, opts)
      if (left() <= 0) break
      const cands = rankMatches(list, song).slice(0, 2)
      for (const cand of cands) {
        if (left() <= 0) break
        const got = await SOURCES[id].getUrl(cand, prefer, opts)
        if (!got || !got.url) continue
        if (left() <= 0) break
        const probed = await probeStream(got, cand.duration || got.duration, song.duration || 0, opts)
        if (probed.broken || probed.partial || probed.unverified) continue
        if ((probed.bitrate || 0) < 128) continue
        const rec = { ...probed, at: Date.now() }
        urlCachePut(cacheKey(cand, prefer), rec)
        logger('[online] 音质补救 ' + res.song.source + ' ' + (res.bitrate||0) + 'k → ' + id + ' ' + probed.bitrate + 'k')
        return { ...rec, song: cand, fallback: true, upgraded: true }
      }
    } catch (err) { /* 下一个源 */ }
  }
  return res
}

/**
 * 解析播放直链，带缓存与换源兜底。
 * 顺序：本源完整版 → 本源其他候选 → 其他源完整版 → 退回试听片段（标注 partial）
 */
async function resolvePlayable(song, prefer = 'best', { allowFallback = true, signal } = {}) {
  const opts = { signal }
  const key = cacheKey(song, prefer)
  if (signal && signal.aborted) return null
  const hit = urlCache.get(key)
  if (hit && Date.now() - hit.at < URL_TTL_MS) {
    // hit.song 是「实际发声的那首」（可能换过源），别用用户点的这首覆盖掉
    const real = hit.song || song
    return { ...hit, song: real, fallback: real.source !== song.source || real.id !== song.id, fromCache: true }
  }

  let partial = null
  let unverified = null
  // v3.3.17：整条兜底链必须有总预算。以前一个 deadline 都没有：
  // 主链路 getUrl(15s)+probe(16s)，本源 3 个候选各 31s，再叠三个源各 ~108s，
  // 最坏能跑五分钟 —— mpv 的 load 会一直挂着，界面永久「正在加载」。
  // getLyric 早就有同样的 deadline，这里补齐。
  const deadline = Date.now() + 12000
  const expired = () => (signal && signal.aborted) || Date.now() > deadline

  const src = SOURCES[song.source]
  if (src) {
    try {
      const got = await src.getUrl(song, prefer, opts)
      if (got && got.url) {
        // 三个参数缺一不可：realDuration 是「接口自报的这段音频有多长」，
        // expectDuration 是「这首歌本该多长」。只传前两个会让「片段时长明显偏短」
        // 这条判据永远为假 —— 45 秒剪辑版按 240 秒算出来的码率反而很健康。
        const probed = await probeStream(got, got.duration || song.duration || 0, song.duration || 0, opts)
        // v3.3.17：unverified（探测两次都失败 / CDN 不回 content-range）以前在这里
        // 直接 return，等于「接受一条永不可信、永不缓存、也永不换源的地址」，
        // 而 tryList / maybeUpgrade / 青听对它是跳过 —— 同一个结果两种处置。
        // 现在把它记为兜底备选，继续往下换源；实在没有更好的才用它。
        if (probed.unverified) {
          if (!unverified) unverified = { ...probed, song, fallback: false }
        } else if (!probed.partial && !probed.broken) {
          const rec = { ...probed, at: Date.now() }
          urlCachePut(key, rec)
          return { ...rec, song, fallback: false }
        } else if (probed.partial) {
          partial = { ...probed, at: Date.now(), song }
        }
      }
    } catch (err) { /* 继续兜底 */ }
  }

  if (!allowFallback) return partial ? { ...partial, fallback: false, partial: true } : null

  // 换候选：先用**本源的其他条目**，再跨源。
  //
  // 只看源的顺序是不够的。酷我这类平台上，同一首歌常有好几条并存：
  // 第一条是 VIP 试听（接口老实说"这段 11 秒"），第二条才是完整 320k。
  // 用户点的恰好是第一条时，如果直接跳到别的源，就会把本源的完整版白白错过。
  // 实测《稻香》就是这样：酷我第二条是 320k 完整的，却一路兜底到别处。
  const tryList = async (id, list) => {
    const cands = rankMatches(list, song)
      .filter((c) => !(c.source === song.source && c.id === song.id))
      .slice(0, 3)
    for (const cand of cands) {
      if (expired()) break
      const got = await SOURCES[id].getUrl(cand, prefer, opts)
      if (!got || !got.url) continue
      const probed = await probeStream(got, cand.duration || got.duration, song.duration || 0, opts)
      if (probed.broken || probed.unverified) continue
      if (probed.partial) {
        if (!partial || (probed.size || 0) > (partial.size || 0)) partial = { ...probed, at: Date.now(), song: cand }
        continue
      }
      const rec = { ...probed, at: Date.now() }
      urlCachePut(cacheKey(cand, prefer), rec)
      return { ...rec, song: cand, fallback: cand.source !== song.source }
    }
    return null
  }

  // ① 本源内换候选
  if (src && !expired()) {
    try {
      const list = await src.search(`${song.title} ${song.artist}`.trim(), 1, 10, opts)
      const got = await tryList(song.source, list)
      if (got) return got
    } catch (err) { /* 继续跨源 */ }
  }

  // ② 跨源兜底：按「歌名 + 歌手」到其他源找同名曲，时长差 5 秒以内优先。
  //    每个源要试多个候选——同一个源里同名歌常有好几条（原版/重制/翻唱）。
  const others = SOURCE_ORDER.filter((id) => id !== song.source && SOURCES[id])
  for (const id of others) {
    if (expired()) break
    try {
      const list = await SOURCES[id].search(`${song.title} ${song.artist}`.trim(), 1, 10, opts)
      const got = await tryList(id, list)
      if (got) return got
    } catch (err) { /* 下一个源 */ }
  }

  if (partial) {
    // fallback 只在「真的换过源」时为真：本源的试听片段也走这条分支，
    // 以前一律标 true，界面会显示「已换源」，用户以为听到了别的版本
    const changed = partial.song && (partial.song.id !== song.id || partial.song.source !== song.source)
    return { ...partial, fallback: !!changed, partial: true }
  }
  if (unverified) return unverified
  return null
}

/** 判断别的源里的搜索结果是不是同一首歌，返回按可信度排序的候选 */
function normText(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_()（）\[\]【】]/g, '')
}

/** 各源在歌手缺失时会填这些占位词，比对时必须当成「不知道」而不是「一个叫未知歌手的歌手」 */
const UNKNOWN_ARTISTS = new Set(['未知歌手', '未知', 'unknown', '未知艺术家', 'various'])
function normArtist(v) {
  const s = normText(String(v || '').split('/')[0])
  return UNKNOWN_ARTISTS.has(s) ? '' : s
}

function matchScore(s, song) {
  const t = normText(song.title)
  if (!t) return 0   // v3.3.13：空标题下 st.includes('') 恒真，会把所有候选判成同曲
  const st = normText(s.title)
  if (!st) return 0  // v3.3.17：候选标题为空时 t.includes('') 同样恒真，白送 5 分
  const a = normArtist(song.artist)
  const sa = normArtist(s.artist)
  // 歌手完全对不上时直接判定不是同一首。
  // 否则「晴天」会被换成网易上某个用户上传的同名翻唱——名字一样、人不对，
  // 用户点周杰伦却听到陌生人唱，比放不出来还糟。
  // v3.3.17：占位词（未知歌手）先归一成空串，否则"未知歌手"与真实歌手互不包含，
  // 冷门/纯音乐/原唱缺失的歌会在这里被判 0 分，跨源兜底与无损兜底双双失效。
  if (a && sa && !sa.includes(a) && !a.includes(sa)) return 0
  let score = 0
  if (st === t) score += 6
  else if (st.includes(t) || t.includes(st)) score += 5
  if (a && sa) score += 3
  if (song.duration && s.duration) {
    const diff = Math.abs(s.duration - song.duration)
    if (diff <= 5) score += 2
    // 时长相差三成以上，基本是剪辑版 / 现场版 / 加速版，宁可不要。
    // 光看大小是发现不了的：45 秒的剪辑版算出来码率 130k，比完整版还"健康"。
    else if (diff > song.duration * 0.3) score -= 4
  }
  return score
}

function rankMatches(list, song) {
  if (!list || !list.length) return []
  const scored = list.map((s) => ({ s, score: matchScore(s, song) }))
  const best = scored.reduce((m, x) => Math.max(m, x.score), 0)
  // v3.3.17：固定阈值 8 在「时长未知」时过于苛刻 —— 无时长最多只能拿
  // 6（标题精确）+ 3（歌手）= 9，歌手也未知时就只剩 6 分，同名同曲会被全部滤掉，
  // 兜底链空转、用户看到「放不出来」。
  // 现在：最高分够 8 就仍用 8（保持原来的严格度），否则退到「最高分的 80%，但不低于 6」。
  const floor = best >= 8 ? 8 : Math.max(6, Math.round(best * 0.8))
  return scored
    .filter((x) => x.score >= floor)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.s)
}

function pickBestMatch(list, song) {
  return rankMatches(list, song)[0] || null
}

/* ---------------- 歌词 ---------------- */

const lyricCache = new Map()   // key → { lrc, at }

async function getLyric(song, opts = {}) {
  const key = `${song.source}:${song.id}`
  const lyricCtrl = new AbortController()
  const signal = anySignal(opts.signal, lyricCtrl.signal)
  // v3.3.17：deadline 必须在**第一个请求之前**建立。以前它在换源兜底前才创建，
  // 首个 src.getLyric 仍可跑满 15 秒 —— 加上后面的兜底循环，总耗时最坏 30 秒，
  // 与「整体限时 15 秒」的注释不符。
  const lyricDeadline = Date.now() + 15000
  const leftMs = () => Math.max(0, lyricDeadline - Date.now())
  const withDeadline = (p) => new Promise((resolve) => {
    if (leftMs() <= 0) { lyricCtrl.abort(); return resolve(null) }
    // v3.3.18：超时只让外层拿到 null 是不够的，底层请求仍在后台跑满 15 秒
    const t = setTimeout(() => { lyricCtrl.abort(); resolve(null) }, leftMs())
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v) },
      () => { clearTimeout(t); resolve(null) }
    )
  })
  const hit = lyricCache.get(key)
  if (hit) {
    // v3.3.7：空结果只缓存 1 分钟 —— 网络抖动不该让一首歌整场都没词
    if (hit.lrc || Date.now() - hit.at < 60000) {
      // 命中前移 → 真 LRU（与 searchCache 一致）
      lyricCache.delete(key)
      lyricCache.set(key, hit)
      return hit.lrc
    }
  }
  const src = SOURCES[song.source]
  let lrc = null
  if (src) {
    try {
      lrc = await withDeadline(src.getLyric(song, { signal }))
    } catch (err) { lrc = null }
  }
  // 本源没词就换源找同一首（换了源的曲目也能出词）
  // v3.3.9：换源兜底整体限时 —— 以前最坏 4 源 × (搜索15s + 取词15s) ≈ 90s，
  // 歌词 IPC 全程挂着，界面像死了一样
  // v3.3.10：每个 await 都受 deadline 约束（deadline 与 withDeadline 定义在函数开头）
  if (!lrc) {
    for (const id of SOURCE_ORDER) {
      if (leftMs() <= 0) break
      if (id === song.source || !SOURCES[id]) continue
      try {
        const list = await withDeadline(SOURCES[id].search(`${song.title} ${song.artist}`.trim(), 1, 5, { signal }))
        const cand = list && pickBestMatch(list, song)
        if (!cand || leftMs() <= 0) continue
        lrc = await withDeadline(SOURCES[id].getLyric(cand, { signal }))
        if (lrc) break
      } catch (err) { /* 下一个 */ }
    }
  }
  if (lyricCache.size > 200) {
    const now = Date.now()
    for (const [k, v] of lyricCache) { if (now - v.at > 3600000) lyricCache.delete(k) }
    while (lyricCache.size > 200) lyricCache.delete(lyricCache.keys().next().value)
  }
  lyricCache.set(key, { lrc, at: Date.now() })
  return lrc
}

/* ---------------- 直链解析给协议/mpv 用 ---------------- */

/** 从 lxstream://play/<source>/<id>?... 解析出可播放信息 */
async function resolveStreamUrl(rawUrl, opts = {}) {
  let u
  try {
    u = new URL(rawUrl)
  } catch (err) {
    return null
  }
  if (u.protocol !== 'lxstream:') return null
  // v3.3.13：畸形 % 序列的 decodeURIComponent 会抛 URIError（旧会话脏数据），
  // 以前会让 mpv:load reject、界面永久停在「正在加载」
  let source = ''
  let id = ''
  try {
    const parts = u.pathname.replace(/^\/+/, '').split('/')
    source = decodeURIComponent(parts[0] || '')
    id = decodeURIComponent(parts[1] || '')
  } catch (err) {
    return null
  }
  if (!SOURCES[source] || !id) return null
  const song = {
    source,
    id,
    title: u.searchParams.get('t') || '',
    artist: u.searchParams.get('a') || '',
    album: '',
    duration: Number(u.searchParams.get('d')) || 0
  }
  const prefer = u.searchParams.get('q') || 'best'
  return getPlayable(song, prefer, opts)
}

module.exports = {
  SOURCES,
  SOURCE_ORDER,
  setLogger,
  setExtraKey,
  testExtraKey,
  setQingEnabled,
  qingSelfTest,
  listSources,
  search,
  getPlayable,
  invalidateUrl,
  getLyric,
  resolveStreamUrl,
  fmtDur
}
