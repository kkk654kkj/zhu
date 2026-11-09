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

/* ---------------- 通用请求 ---------------- */

async function req(url, opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT)
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
    const done = () => clearTimeout(timer)
    // v3.3.13：不消费正文的调用（探测/失败响应）必须能主动释放，
    // 否则 timer 与连接会一直留到超时（每个探测 8~15 秒）
    res.release = () => {
      clearTimeout(timer)
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
    throw err
  }
}

async function reqText(url, opts) {
  try {
    const res = await req(url, opts)
    if (!res.ok) { try { res.release && res.release() } catch (e) {} ; return null }
    return await res.text()
  } catch (err) {
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
    const kvRe = /['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:\s*'((?:[^'\\]|\\.)*)'/g
    let kv
    while ((kv = kvRe.exec(body))) obj[kv[1]] = kv[2].replace(/\\'/g, "'")
    if (obj.DC_TARGETID) out.push(obj)
  }
  return out
}

const kw = {
  id: 'kw',
  name: '酷我',
  short: 'KW',
  maxQuality: '320k mp3',

  async search(keyword, page = 1, limit = 30) {
    const pn = Math.max(0, page - 1)
    const url = `http://search.kuwo.cn/r.s?all=${encode(keyword)}&ft=music&itemset=web_2013`
      + `&client=kt&pn=${pn}&rn=${limit}&rformat=json&encoding=utf8&mobi=1&vipver=1`
    const txt = await reqText(url)
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

  async getUrl(song, prefer = 'best') {
    const br = prefer === 'lossless' ? 'flac' : prefer === '128k' ? '128kmp3' : '320kmp3'
    const url = `http://nmobi.kuwo.cn/mobi.s?f=web&source=kwplayer_ar_9.3.0.0_B_jiakong_vh.apk`
      + `&type=convert_url_with_sign&br=${br}&rid=${encode(song.id)}`
    const j = await reqJson(url)
    const d = j && j.data
    if (!d || !d.url || d.url === 'None') return null
    return {
      url: d.url,
      ext: safeExt(d.format),
      bitrate: Number(d.bitrate) || 0,
      duration: Number(d.duration) || song.duration || 0,
      referer: 'https://www.kuwo.cn/'
    }
  },

  async getLyric(song) {
    const j = await reqJson(`http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encode(song.id)}&httpsStatus=1`)
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

  async search(keyword, page = 1, limit = 30) {
    const offset = (page - 1) * limit
    // 主用 cloudsearch/pc：不限频，返回也全（带封面、时长）。
    // 老的 /api/search/get/web 现在对同一 IP 限得很死，连搜两次就 405，只作兜底。
    let j = await reqJson(
      `https://music.163.com/api/cloudsearch/pc?s=${encode(keyword)}&type=1&limit=${limit}&offset=${offset}`,
      { headers: { Referer: 'https://music.163.com' } }
    )
    if (!(j && j.code === 200 && j.result && Array.isArray(j.result.songs))) {
      j = await reqJson(
        'https://music.163.com/api/search/get?s=' + encode(keyword) + `&type=1&limit=${limit}&offset=${offset}`,
        { headers: { Referer: 'https://music.163.com', Cookie: 'appver=2.0.2' } }
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
  async getUrl(song) {
    const u = `https://music.163.com/song/media/outer/url?id=${encode(song.id)}.mp3`
    try {
      // 用 Range 取 2 字节验证：既确认是音频，也确认支持断点（mpv 拖动进度需要）
      const res = await req(u, {
        headers: { Referer: 'https://music.163.com', Range: 'bytes=0-1' }
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

  async getLyric(song) {
    const j = await reqJson(`https://music.163.com/api/song/lyric?id=${encode(song.id)}&lv=1&kv=1&tv=-1`, {
      headers: { Referer: 'https://music.163.com' }
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

  async search(keyword, page = 1, limit = 30) {
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&w=${encode(keyword)}`
      + `&n=${limit}&p=${page}&cr=1&new_json=1&aggr=1&lossless=0`
    const txt = await reqText(url, { headers: { Referer: 'https://y.qq.com/' } })
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

  async getUrl(song) {
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
      body: JSON.stringify(payload)
    })
    const d = j && j.req_0 && j.req_0.data
    const info = d && d.midurlinfo && d.midurlinfo[0]
    const purl = info && info.purl
    if (!purl) return null
    const sip = (d.sip && d.sip[0]) || 'https://ws.stream.qqmusic.qq.com/'
    return {
      url: sip.replace(/^http:/, 'https:') + purl,
      ext: /\.m4a/i.test(purl) ? 'm4a' : 'mp3',
      bitrate: 128,
      duration: song.duration || 0,
      referer: 'https://y.qq.com/'
    }
  },

  async getLyric(song) {
    const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encode(song.id)}`
      + `&format=json&nobase64=1&g_tk=5381`
    const txt = await reqText(url, { headers: { Referer: 'https://y.qq.com/portal/player.html' } })
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

  async search(keyword, page = 1, limit = 30) {
    const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encode(keyword)}&page=${page}`
      + `&pagesize=${limit}&platform=WebFilter&userid=0&clientver=2000&iscorrection=1`
      + `&privilege_filter=0&filter=10&area_code=1&tag_aggr=1`
    const j = await reqJson(url)
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
  async getUrl(song) {
    const tries = []
    if (song.idHq) tries.push({ hash: song.idHq.toLowerCase(), br: 'hq' })
    tries.push({ hash: String(song.id).toLowerCase(), br: 'hq' })
    tries.push({ hash: String(song.id).toLowerCase(), br: '' })
    for (const t of tries) {
      const key = crypto.createHash('md5').update(t.hash + 'kgcloudv2').digest('hex')
      const url = `https://trackercdn.kugou.com/i/v2/?key=${key}&hash=${t.hash}&br=${t.br}`
        + `&appid=1005&pid=2&cmd=25&behavior=play`
      const j = await reqJson(url, { headers: { Referer: 'https://www.kugou.com/' } })
      if (j && j.status === 1 && j.url) {
        const u = Array.isArray(j.url) ? j.url[0] : j.url
        if (u) {
          return {
            url: u,
            ext: safeExt(j.extName),
            bitrate: Math.round((Number(j.bitRate) || 0) / 1000),
            duration: song.duration || 0,
            referer: 'https://www.kugou.com/'
          }
        }
      }
    }
    return null
  },

  async getLyric(song) {
    const search = await reqJson(`https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=`
      + `&duration=&hash=${encode(song.id)}`)
    const cand = search && search.candidates && search.candidates[0]
    if (!cand) return null
    const dl = await reqJson(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${encode(cand.id)}`
      + `&accesskey=${encode(cand.accesskey)}&fmt=lrc&charset=utf8`)
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
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.list
  try {
    const list = await SOURCES[id].search(keyword, page, limit)
    if (Array.isArray(list) && list.length) {
      if (searchCache.size > 120) searchCache.delete(searchCache.keys().next().value)
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
async function probeStream(info, realDuration, expectDuration = 0) {
  // v3.3.7：探测失败重试一次 —— 网络抖动一次就不给结果，
  // 会让试听片段被当成完整版进缓存
  for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const headers = { Range: 'bytes=0-1' }
    if (info.referer) headers.Referer = info.referer
    if (info.headers && typeof info.headers === 'object') Object.assign(headers, info.headers)
    const res = await req(info.url, { headers, timeout: 8000 })
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
      bitrate: info.bitrate >= 32 ? info.bitrate : kbps,
      partial: kbps < 40 || tooShort
    }
  } catch (err) {
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
async function qingEnsureTicket() {
  if (qingTicket && Date.now() < qingTicketExp) return qingTicket
  if (qingTicketPending) return qingTicketPending
  qingTicketPending = (async () => {
    for (const base of QING_BASES) {
      try {
        const url = base + '/gateway/ticket'
        const body = JSON.stringify({ deviceId: qingDevice, appVersion: QING_VER, platform: 'win32' })
        const r = await req(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...qingHeaders('POST', url, body) },
          body,
          timeout: 8000
        })
        const j = await r.json().catch(() => null)
        if (j && j.ticket) {
          qingTicket = j.ticket
          // v3.3.8：expiresAt 单位防御 —— 若服务端返回秒（<1e12），按毫秒比会
          // 让票据永远「已过期」，每次解析都白跑一趟领票接口
          let exp = Number(j.expiresAt)
          if (exp > 0 && exp < 1e12) exp *= 1000
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
async function qingResolveOnce(source, rid, level) {
  let ticket = await qingEnsureTicket()
  if (!ticket) return null
  const body = JSON.stringify({ source, rid, level })
  for (const base of QING_BASES) {
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
        timeout: 8000
      })
      const j = await r.json().catch(() => null)
      if (!j) continue
      if (j.code === 0 || j.code === '0') {
        const d = j.data || {}
        // need_decrypt：酷我偶发会回加密流，本地没有它的 AES 密钥，直接放弃换别的档
        if (d.need_decrypt) return null
        if (d.url) return { url: d.url, headers: d.playbackHeaders || d.headers || null }
        return null
      }
      // 票过期就作废并**当场重领**：继续用捕获的旧票跑剩下的线路必然全挂
      const qcode = String(j.code ?? '')
      // v3.3.13：网关可能用数字码（401/403/419/10001）表示票据过期，
      // 只匹配字符串关键字会让过期票一直用到超时
      if (/TICKET|AUTH|TOKEN/i.test(qcode) || /^(401|403|419|10001|10002)$/.test(qcode)) {
        qingTicket = ''
        ticket = await qingEnsureTicket()
      }
    } catch (err) { /* 换下一条线路 */ }
  }
  return null
}

/** 按音质档从青听网关取 flac */
async function qingLossless(song, prefer) {
  if (!qingOn) return null
  const source = QING_SRC[song.source]
  if (!source || !song.id) return null
  const levels = (QING_LEVELS[prefer] || QING_LEVELS.lossless)[song.source] || []
  const duration = song.duration || 0
  for (const level of levels) {
    const got = await qingResolveOnce(source, String(song.id), level)
    if (!got || !got.url) continue
    if (!/\.flac(\?|$)/i.test(got.url)) continue
    const probed = await probeStream(
      { url: got.url, ext: 'flac', bitrate: 0, duration, referer: 'https://music.163.com/', headers: got.headers },
      duration,
      duration
    )
    if (probed.broken || probed.partial || probed.unverified) continue
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
async function chkszLossless(song, key) {
  const url = chkszEndpoint(song, key)
  if (!url) return null
  const j = await reqJson(url, { timeout: 8000 })
  if (!j || j.code !== 200 || !j.url) {
    if (j && j.code === 401) logger('[chksz] apikey 无效')
    else if (j && (j.code === 402 || j.code === 429)) logger('[chksz] 额度不足或被限流 ' + j.code)
    return null
  }
  const fmt = String(j.format || j.bitrate || '').toLowerCase()
  const isFlac = /\.flac(\?|$)/i.test(j.url) || fmt === 'flac' || Number(j.br) >= 700
  if (!isFlac) return null
  const duration = song.duration || 0
  const probed = await probeStream(
    { url: j.url, ext: 'flac', bitrate: Number(j.br) || 900, duration, referer: 'https://music.163.com/' },
    duration,
    duration
  )
  if (probed.broken || probed.partial || probed.unverified) return null
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
async function neteaseTwin(song) {
  if (song.source === 'wy' && song.id) return song
  try {
    const list = await SOURCES.wy.search(`${song.title} ${song.artist}`.trim(), 1, 20)
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
async function resolveLossless(song, prefer) {
  const key = extraKey

  // ⓪ 青听网关：四家都支持、还快，先问它。失败就往下走，别处照旧
  try {
    const qing = await qingLossless(song, prefer === 'master' ? 'master' : 'lossless')
    if (qing) return qing
  } catch (err) {
    logger('[qing] 解析异常 ' + err.message)
  }

  // ① QQ / 酷狗：只有 ChKSz 能拿（GDStudio 只支持网易）
  if (key && (song.source === 'qq' || song.source === 'kg')) {
    const got = await chkszLossless(song, key)
    if (got) return got
  }

  // ② 网易：免费的 GDStudio
  const twin = await neteaseTwin(song)
  if (twin) {
    const askUrl = () => reqJson(`${GD_API}?types=url&source=netease&id=${encode(twin.id)}&br=999`, { timeout: 7000 })
    // 这个聚合 API 抖动挺厉害，同一首歌两次跑结果可能不同。
    // 拿不到响应（超时/502）就再问一次；但它明确回了一个非 flac 地址，说明这首确实没有，别浪费第二次。
    let j = await askUrl()
    if (!j || !j.url) j = await askUrl()
    if (j && j.url) {
      const br = Number(j.br) || 0
      // 有些歌只给 320k mp3，也走这个接口——那种情况不算无损，交给降级处理
      if (/\.flac(\?|$)/i.test(j.url) || br >= 700) {
        // 真取一下头几个字节，确认不是错误页
        const probed = await probeStream(
          { url: j.url, ext: 'flac', bitrate: br, duration: twin.duration || song.duration || 0, size: Number(j.size) || 0, referer: 'https://music.163.com/' },
          twin.duration || song.duration || 0,
          song.duration || 0
        )
        if (!probed.broken && !probed.partial && !probed.unverified) {
          return {
            ...probed,
            // 播放时长以下载得到的这份为准，界面上的时长别被蹭偏
            duration: twin.duration || song.duration || 0,
            actual: twin,
            lossless: true,
            ext: 'flac'
          }
        }
      }
    }
  }

  // ③ 兜底：有 key 的话，ChKSz 再试一次（腾讯/酷狗的号池有时比免费接口更硬）
  if (key) {
    const got = await chkszLossless(twin || song, key)
    if (got) return { ...got, actual: twin || song }
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
    let fbPromise = null
    const startFallback = () => {
      if (fbPromise) return fbPromise
      fbPromise = (async () => {
        const res = await resolvePlayable(song, 'best', opts)
        if (!res) return null
        const up = await maybeUpgrade(res, song, 'best')
        urlCachePut(cacheKey(song, 'best'), { ...up, at: Date.now() })
        return up
      })().catch(() => null)   // race 赢家直接 return 时它无人 await，吞掉悬空 rejection
      return fbPromise
    }
    const fbTimer = setTimeout(startFallback, 1500)

    let got = null
    let losslessTimer = null
    const losslessTimeout = new Promise((r) => { losslessTimer = setTimeout(() => r(null), 9000) })
    try {
      got = await Promise.race([
        // 9 秒超时后输家仍在后台跑；吞掉它的 rejection，避免 unhandledRejection
        resolveLossless(song, prefer).catch(() => null),
        // QQ 那边偶尔要 5 秒才给链，窗口给足；超过就先用降级结果出声
        losslessTimeout
      ])
    } catch (err) {
      logger('[flac] 解析异常 ' + err.message)
    } finally {
      clearTimeout(fbTimer)
      clearTimeout(losslessTimer)   // v3.3.13：成功也要清，别留 9 秒空定时器
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
  const up = await maybeUpgrade(res, song, prefer)
  urlCachePut(cacheKey(song, prefer), { ...up, at: Date.now() })
  return up
}

/**
 * 音质补救：主源只给 48k / 64k 这种糊音质时，去别的源碰碰运气。
 *
 * 只在「已经拿到完整版、但码率低于 96k」时才跑，所以绝大多数歌没有额外耗时；
 * 上限 6 秒，超时就用手上这个——宁可音质差一点，也不能让用户干等。
 */
async function maybeUpgrade(res, song, prefer) {
  if (res.partial) return res
  if ((res.bitrate || 0) >= 96) return res
  const t0 = Date.now()
  for (const id of SOURCE_ORDER) {
    if (id === res.song.source || !SOURCES[id]) continue
    if (Date.now() - t0 > 6000) break
    try {
      const list = await SOURCES[id].search(`${song.title} ${song.artist}`.trim(), 1, 10)
      const cands = rankMatches(list, song).slice(0, 2)
      for (const cand of cands) {
        const got = await SOURCES[id].getUrl(cand, prefer)
        if (!got || !got.url) continue
        const probed = await probeStream(got, cand.duration || got.duration, song.duration || 0)
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
async function resolvePlayable(song, prefer = 'best', { allowFallback = true } = {}) {
  const key = cacheKey(song, prefer)
  const hit = urlCache.get(key)
  if (hit && Date.now() - hit.at < URL_TTL_MS) {
    // hit.song 是「实际发声的那首」（可能换过源），别用用户点的这首覆盖掉
    const real = hit.song || song
    return { ...hit, song: real, fallback: real.source !== song.source || real.id !== song.id, fromCache: true }
  }

  let partial = null

  const src = SOURCES[song.source]
  if (src) {
    try {
      const got = await src.getUrl(song, prefer)
      if (got && got.url) {
        // 三个参数缺一不可：realDuration 是「接口自报的这段音频有多长」，
        // expectDuration 是「这首歌本该多长」。只传前两个会让「片段时长明显偏短」
        // 这条判据永远为假 —— 45 秒剪辑版按 240 秒算出来的码率反而很健康。
        const probed = await probeStream(got, got.duration || song.duration || 0, song.duration || 0)
        if (probed.unverified) {
          // v3.3.8：探测两次都失败的结果不进 20 分钟直链缓存
          return { ...probed, song, fallback: false }
        }
        if (!probed.partial && !probed.broken) {
          const rec = { ...probed, at: Date.now() }
          urlCachePut(key, rec)
          return { ...rec, song, fallback: false }
        }
        if (probed.partial) partial = { ...probed, at: Date.now(), song }
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
      const got = await SOURCES[id].getUrl(cand, prefer)
      if (!got || !got.url) continue
      const probed = await probeStream(got, cand.duration || got.duration, song.duration || 0)
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
  if (src) {
    try {
      const list = await src.search(`${song.title} ${song.artist}`.trim(), 1, 10)
      const got = await tryList(song.source, list)
      if (got) return got
    } catch (err) { /* 继续跨源 */ }
  }

  // ② 跨源兜底：按「歌名 + 歌手」到其他源找同名曲，时长差 5 秒以内优先。
  //    每个源要试多个候选——同一个源里同名歌常有好几条（原版/重制/翻唱）。
  const others = SOURCE_ORDER.filter((id) => id !== song.source && SOURCES[id])
  for (const id of others) {
    try {
      const list = await SOURCES[id].search(`${song.title} ${song.artist}`.trim(), 1, 10)
      const got = await tryList(id, list)
      if (got) return got
    } catch (err) { /* 下一个源 */ }
  }

  if (partial) return { ...partial, fallback: true, partial: true }
  return null
}

/** 判断别的源里的搜索结果是不是同一首歌，返回按可信度排序的候选 */
function normText(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_()（）\[\]【】]/g, '')
}

function matchScore(s, song) {
  const t = normText(song.title)
  if (!t) return 0   // v3.3.13：空标题下 st.includes('') 恒真，会把所有候选判成同曲
  const a = normText(String(song.artist || '').split('/')[0])
  const st = normText(s.title)
  const sa = normText(String(s.artist || ''))
  // 歌手完全对不上时直接判定不是同一首。
  // 否则「晴天」会被换成网易上某个用户上传的同名翻唱——名字一样、人不对，
  // 用户点周杰伦却听到陌生人唱，比放不出来还糟。
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
  return list
    .map((s) => ({ s, score: matchScore(s, song) }))
    .filter((x) => x.score >= 8)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.s)
}

function pickBestMatch(list, song) {
  return rankMatches(list, song)[0] || null
}

/* ---------------- 歌词 ---------------- */

const lyricCache = new Map()   // key → { lrc, at }

async function getLyric(song) {
  const key = `${song.source}:${song.id}`
  const hit = lyricCache.get(key)
  if (hit) {
    // v3.3.7：空结果只缓存 1 分钟 —— 网络抖动不该让一首歌整场都没词
    if (hit.lrc || Date.now() - hit.at < 60000) return hit.lrc
  }
  const src = SOURCES[song.source]
  let lrc = null
  if (src) {
    try {
      lrc = await src.getLyric(song)
    } catch (err) { lrc = null }
  }
  // 本源没词就换源找同一首（换了源的曲目也能出词）
  // v3.3.9：换源兜底整体限时 —— 以前最坏 4 源 × (搜索15s + 取词15s) ≈ 90s，
  // 歌词 IPC 全程挂着，界面像死了一样
  const lyricDeadline = Date.now() + 15000
  // v3.3.10：每个 await 都受 deadline 约束 —— 以前只在循环开头查一次，
  // 临界点进入的最后一轮 search+getLyric 各 15s 不可中断，最坏仍拖 ~45s
  const leftMs = () => Math.max(0, lyricDeadline - Date.now())
  const withDeadline = (p) => new Promise((resolve) => {
    if (leftMs() <= 0) return resolve(null)
    const t = setTimeout(() => resolve(null), leftMs())
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v) },
      () => { clearTimeout(t); resolve(null) }
    )
  })
  if (!lrc) {
    for (const id of SOURCE_ORDER) {
      if (leftMs() <= 0) break
      if (id === song.source || !SOURCES[id]) continue
      try {
        const list = await withDeadline(SOURCES[id].search(`${song.title} ${song.artist}`.trim(), 1, 5))
        const cand = list && pickBestMatch(list, song)
        if (!cand || leftMs() <= 0) continue
        lrc = await withDeadline(SOURCES[id].getLyric(cand))
        if (lrc) break
      } catch (err) { /* 下一个 */ }
    }
  }
  if (lyricCache.size > 200) lyricCache.delete(lyricCache.keys().next().value)
  lyricCache.set(key, { lrc, at: Date.now() })
  return lrc
}

/* ---------------- 直链解析给协议/mpv 用 ---------------- */

/** 从 lxstream://play/<source>/<id>?... 解析出可播放信息 */
async function resolveStreamUrl(rawUrl) {
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
  return getPlayable(song, prefer)
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
  getLyric,
  resolveStreamUrl,
  fmtDur
}
