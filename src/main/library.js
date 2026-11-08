'use strict'
/**
 * 音乐库：目录扫描 → 元数据解析 → 封面/歌词定位 → 增量缓存。
 * 扫描结果以 fileId(路径哈希) 为键，写进 library.json；二次启动只解析变更文件。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { pinyin } = require('pinyin-pro')

const AUDIO_EXT = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.ape', '.wma', '.aiff', '.aif', '.dsf', '.dff', '.mka'
])
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']

/** 解析规则版本：标题/歌手兜底逻辑变化时递增，旧 library.json 会被视为过期重新解析 */
// v4：新增拼音检索字段 py/pyf
// v5：内嵌封面改内存（cover='@embedded'）、内嵌歌词、ReplayGain、DSD 标记
const PARSE_VERSION = 5

/**
 * 为搜索预先算好拼音：全拼（zhoujielun）与首字母（zjl）。
 * 中文曲库输首字母找歌是刚需，运行时逐首算会卡，所以在解析阶段一次性算好存进 library.json。
 * pinyin-pro 对非中文原样返回，英文歌名不受影响。
 */
function buildPinyinSearch(texts) {
  const parts = []
  const firsts = []
  for (const t of texts) {
    const s = String(t || '').trim()
    if (!s) continue
    try {
      const arr = pinyin(s, { toneType: 'none', type: 'array' })
      parts.push(arr.join('').toLowerCase())
      firsts.push(arr.map((x) => (x ? x[0] : '')).join('').toLowerCase())
    } catch {
      parts.push(s.toLowerCase())
      firsts.push(s.toLowerCase())
    }
  }
  return { py: parts.join(' '), pyf: firsts.join(' ') }
}

function fileId(filePath) {
  return crypto.createHash('md5').update(filePath.toLowerCase()).digest('hex')
}

function extOf(p) {
  return path.extname(p).toLowerCase()
}

const round1 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null)
const round3 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : null)

/** ReplayGain 的 {dB, ratio} → 分贝值。只有 ratio 时按 20*log10 换算 */
function rgDb(obj) {
  if (!obj) return null
  if (typeof obj.dB === 'number' && isFinite(obj.dB)) return round1(obj.dB)
  if (typeof obj.ratio === 'number' && obj.ratio > 0) return round1(20 * Math.log10(obj.ratio))
  return null
}

/** 递归收集音频文件（跳过隐藏目录与常见垃圾目录） */
async function collectFiles(dir, out = [], depth = 0) {
  if (depth > 12) return out
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    return out
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isSymbolicLink()) continue
    if (ent.isDirectory()) {
      if (/^\$RECYCLE|^System Volume Information|^\./i.test(ent.name)) continue
      await collectFiles(full, out, depth + 1)
    } else if (ent.isFile() && AUDIO_EXT.has(extOf(ent.name))) {
      out.push(full)
    }
  }
  return out
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.bmp': 'image/bmp'
}

/**
 * 找封面：同名图片 > 目录内 <歌手>__ARTIST.jpg > <专辑>__ALBUM.jpg > cover/folder
 */
async function findCover(audioPath, meta) {
  const dir = path.dirname(audioPath)
  const base = path.basename(audioPath, path.extname(audioPath))
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return null
  }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]))
  const pick = (candidate) => {
    const hit = lower.get(candidate.toLowerCase())
    return hit ? path.join(dir, hit) : null
  }

  for (const ext of IMAGE_EXT) {
    const hit = pick(base + ext)
    if (hit) return hit
  }
  if (meta) {
    const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_')
    const artist = meta.artist || ''
    const album = meta.album || ''
    if (album) {
      for (const ext of IMAGE_EXT) {
        const hit = pick(`${safe(album)}__ALBUM${ext}`) || pick(`${safe(album)}${ext}`)
        if (hit) return hit
      }
    }
    if (artist) {
      for (const ext of IMAGE_EXT) {
        const hit = pick(`${safe(artist)}__ARTIST${ext}`)
        if (hit) return hit
      }
    }
  }
  for (const n of ['cover', 'folder', 'front', 'album']) {
    for (const ext of IMAGE_EXT) {
      const hit = pick(n + ext)
      if (hit) return hit
    }
  }
  return null
}

function findLyric(audioPath) {
  const base = audioPath.slice(0, audioPath.length - path.extname(audioPath).length)
  for (const ext of ['.lrc', '.LRC', '.Lrc']) {
    const p = base + ext
    if (fs.existsSync(p)) return p
  }
  return null
}

/** 内嵌封面的标记值（v2.0）。曲目里 cover 为它时，封面走 lxcover:// 协议按需从音频文件里取，
 *  不再往 data\covers 写文件——上千首就是上千个小文件，扫描 I/O 和目录遍历都被拖慢。 */
const COVER_EMBEDDED = '@embedded'

/**
 * 内嵌封面内存缓存（id → {buf, mime, at}），带字节上限的 LRU。
 * 扫描时就把封面塞进来（那时数据本来就在手上），播放/列表翻页都直接命中；
 * 被淘汰或重启后由 getCover() 重新解析文件。
 */
const COVER_CACHE = new Map()
const COVER_CACHE_MAX_BYTES = 160 * 1024 * 1024
let coverCacheBytes = 0

function coverCacheSet(id, buf, mime) {
  if (!id || !buf || !buf.length) return
  const prev = COVER_CACHE.get(id)
  if (prev) coverCacheBytes -= prev.buf.length
  const entry = { buf, mime: mime || 'image/jpeg', at: Date.now() }
  COVER_CACHE.delete(id)          // 重新插入以体现"最近使用"
  COVER_CACHE.set(id, entry)
  coverCacheBytes += buf.length
  // 超限就从头淘汰（Map 保持插入顺序，最旧的在前）
  while (coverCacheBytes > COVER_CACHE_MAX_BYTES && COVER_CACHE.size > 1) {
    const [oldId, old] = COVER_CACHE.entries().next().value
    COVER_CACHE.delete(oldId)
    coverCacheBytes -= old.buf.length
  }
}

function coverCacheGet(id) {
  const e = COVER_CACHE.get(id)
  if (!e) return null
  COVER_CACHE.delete(id)
  COVER_CACHE.set(id, e)          // 命中即刷新 LRU 顺序
  return e
}

/** 内嵌图片 → {buf, mime}；music-metadata 的 picture.format 是 image/jpeg 这类 MIME */
function pictureToBuf(picture) {
  if (!picture || !picture.data) return null
  const buf = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data)
  if (!buf.length) return null
  let mime = String(picture.format || 'image/jpeg')
  if (!/^image\//.test(mime)) mime = 'image/' + mime.replace('jpg', 'jpeg')
  return { buf, mime }
}

/**
 * 内嵌歌词（v2.0）：music-metadata 的 common.lyrics，可能是纯文本数组，也可能是
 * 「{ text }」或「{ syncText:[{text,timestamp}] }」对象数组（ID3 USLT / FLAC LYRICS）。
 * 统一还原成 LRC 文本；同步歌词优先（它自带时间轴）。
 */
function lyricsToLrc(common) {
  const raw = common && common.lyrics
  if (!raw || !raw.length) return null
  const cands = Array.isArray(raw) ? raw : [raw]
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n').trim()
  // ① 带时间轴的
  for (const c of cands) {
    if (!c) continue
    const sync = c.syncText || c.syncedLyrics || c.sync
    if (Array.isArray(sync) && sync.length) {
      const lines = sync
        .map((s) => {
          const t = s.timestamp != null ? s.timestamp : s.time
          const text = s.text != null ? s.text : ''
          if (t == null) return text
          const ms = Number(t)
          if (!isFinite(ms)) return text
          const mm = String(Math.floor(ms / 60000)).padStart(2, '0')
          const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
          const cs = String(Math.floor((ms % 1000) / 10)).padStart(2, '0')
          return `[${mm}:${ss}.${cs}]${text}`
        })
        .filter((l) => l && l.trim())
      if (lines.length) return lines.join('\n')
    }
  }
  // ② 纯文本（可能本身就是 LRC）
  for (const c of cands) {
    const text = norm(typeof c === 'string' ? c : (c && (c.text || c.lyrics)))
    if (text) return text
  }
  return null
}

/** 懒加载 music-metadata（只有需要读内嵌歌词时才用） */
let MM_PROMISE = null
function getMM () {
  if (!MM_PROMISE) MM_PROMISE = import('music-metadata')
  return MM_PROMISE
}

/**
 * v2.8.4：运行时读内嵌歌词。
 *
 * 以前只有扫描时才解析标签，于是「用 Mp3tag 之类改完 FLAC 内嵌 LYRICS 后」
 * 播放器永远读不到新词——它只认外置 .lrc。这里给主进程一个按需读取的入口，
 * 配合 mtime 比较就能做到「改哪边都生效」。
 */
async function readEmbeddedLyric (filePath) {
  if (!filePath) return null
  try {
    const mm = await getMM()
    const parsed = await mm.parseFile(filePath, { duration: false, skipCovers: true })
    return lyricsToLrc(parsed.common || {})
  } catch (err) {
    return null
  }
}

/** 把内嵌歌词落到 data\lyrics\<id>.lrc，让下游（lyric:read / LRC 解析）完全不用改。
 *  只在「没有同名 .lrc」且「标签里确实有歌词」时才写，数量受真实数据限制。 */
async function writeEmbeddedLyric(text, lyricDir, id) {
  try {
    await fsp.mkdir(lyricDir, { recursive: true })
    const out = path.join(lyricDir, id + '.lrc')
    const old = await fsp.readFile(out, 'utf8').catch(() => null)
    if (old === text) return out
    await fsp.writeFile(out, text, 'utf8')
    return out
  } catch (err) {
    console.error('[lyric] 内嵌歌词写入失败:', err.message)
    return null
  }
}

/** 把曲目里的封面字段解析成可读的绝对路径。
 *  兼容三种形态：①相对 coverDir 的文件名（旧格式）②旧的绝对路径 ③旧绝对路径但文件已不在
 *  （程序文件夹搬过家）——此时按文件名到当前 coverDir 里找，找到就用新的。 */
function resolveCoverPath(cover, coverDir) {
  if (!cover) return null
  if (!path.isAbsolute(cover)) return path.join(coverDir, cover)
  if (fs.existsSync(cover)) return cover
  const inCurrent = path.join(coverDir, path.basename(cover))
  return fs.existsSync(inCurrent) ? inCurrent : cover
}

/** 读 LRC 头部标签（ti/ar/al），只读前 8KB；失败返回 null */
function readLrcMeta(lyricPath) {
  if (!lyricPath) return null
  try {
    const fd = fs.openSync(lyricPath, 'r')
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const head = decodeLrcBuffer(buf.subarray(0, n))
    const pick = (tag) => {
      const m = new RegExp('\\[' + tag + ':([^\\]]*)\\]', 'i').exec(head)
      return m && m[1] ? m[1].trim() : null
    }
    const meta = { ti: pick('ti'), ar: pick('ar'), al: pick('al') }
    return meta.ti || meta.ar ? meta : null
  } catch {
    return null
  }
}

/** LRC 编码可能是 UTF-8 也可能是 GBK，先按 UTF-8 解，出现替换字符再退 GBK */
function decodeLrcBuffer(buf) {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

/** 归一化用于模糊比对：去空白、去括号内容、小写 */
function normName(s) {
  if (!s) return ''
  return String(s)
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s\-_'’·.,，。]/g, '')
    .toLowerCase()
}

/**
 * 从文件名拆「A - B」。只认 ' - '（两侧带空格），无空格单连字符交给
 * resolveNameSegments 用 LRC 的 [ar:] 佐证后再决定，避免拆坏歌名。
 */
function splitFileNameSegments(nameBase) {
  const idx = nameBase.lastIndexOf(' - ')
  if (idx > 0) {
    return [nameBase.slice(0, idx).trim(), nameBase.slice(idx + 3).trim()]
  }
  return [nameBase.trim(), null]
}

/**
 * 结合 LRC 头部，决定「歌名 / 歌手」，并处理「歌手 - 歌名」的反向命名。
 * 返回 { title, artist }（可能为 null，交给上层兜底）。
 */
function resolveNameSegments(nameBase, lrcMeta) {
  let [a, b] = splitFileNameSegments(nameBase)
  // 无 ' - ' 时，用 LRC 的 [ar:] 佐证「歌手-歌名」这种紧凑写法
  if (!b) {
    const idx = nameBase.lastIndexOf('-')
    if (idx > 0 && idx < nameBase.length - 1) {
      const x = nameBase.slice(0, idx).trim()
      const y = nameBase.slice(idx + 1).trim()
      if (x && y && lrcMeta && lrcMeta.ar) {
        if (normName(x) === normName(lrcMeta.ar) && normName(x) !== normName(y)) {
          a = x
          b = y
        }
      }
    }
  }
  if (!b) return { title: a || null, artist: null }

  let title = a
  let artist = b
  const lrcTitle = (lrcMeta && lrcMeta.ti) || null
  const lrcArtist = (lrcMeta && lrcMeta.ar) || null
  const nA = normName(a)
  const nB = normName(b)
  const aIsArtist = lrcArtist && nA === normName(lrcArtist)
  const bIsArtist = lrcArtist && nB === normName(lrcArtist)
  const t = normName(lrcTitle)
  const aIsTitle = !!(t && nA.includes(t))
  const bIsTitle = !!(t && nB.includes(t))

  // 明确 A 是歌手 → 交换；明确 B 是歌名 → 交换
  if (aIsArtist && !bIsArtist) {
    title = b
    artist = a
  } else if (bIsTitle && !aIsTitle) {
    title = b
    artist = a
  }
  return { title: title || null, artist: artist || null }
}

/** 解析单个文件的全部信息 */
async function parseTrack(filePath, mm, coverDir, lyricDir) {
  const id = fileId(filePath)
  const st = await fsp.stat(filePath)
  let meta = null
  let mmError = null
  let embeddedLyric = null
  let rg = null
  try {
    const parsed = await mm.parseFile(filePath, { duration: true, skipCovers: false })
    const c = parsed.common || {}
    meta = {
      title: (c.title || '').trim() || null,
      artist: (Array.isArray(c.artists) ? c.artists.join(' / ') : c.artist) || null,
      artists: Array.isArray(c.artists) ? c.artists : c.artist ? [c.artist] : [],
      album: (c.album || '').trim() || null,
      albumArtist: c.albumartist || null,
      year: c.year || null,
      trackNo: c.track && c.track.no ? c.track.no : null,
      discNo: c.disk && c.disk.no ? c.disk.no : null,
      genre: Array.isArray(c.genre) ? c.genre : [],
      duration: parsed.format && parsed.format.duration ? parsed.format.duration : 0,
      bitrate: parsed.format && parsed.format.bitrate ? parsed.format.bitrate : 0,
      sampleRate: parsed.format && parsed.format.sampleRate ? parsed.format.sampleRate : 0,
      bitsPerSample: parsed.format && parsed.format.bitsPerSample ? parsed.format.bitsPerSample : 0,
      codec: parsed.format && parsed.format.codec ? parsed.format.codec : null,
      lossless: !!(parsed.format && parsed.format.lossless)
    }
    // 内嵌封面（v2.0）：不再落盘，进内存 LRU，页面按需通过 lxcover:// 取
    const pic = c.picture && c.picture.length ? c.picture[0] : null
    const pb = pictureToBuf(pic)
    if (pb) {
      coverCacheSet(id, pb.buf, pb.mime)
      meta.cover = COVER_EMBEDDED
    } else {
      meta.cover = null
    }
    // 内嵌歌词：没有同名 .lrc 时才用（外置文件优先，方便随时改）
    embeddedLyric = lyricsToLrc(c)
    // ReplayGain 标签（v2.0）：有标签就不用再跑一遍整库响度分析
    const rgT = rgDb(c.replaygain_track_gain)
    if (rgT != null) {
      rg = {
        rgTrackDb: rgT,
        rgAlbumDb: rgDb(c.replaygain_album_gain),
        rgPeak: round3(c.replaygain_track_peak ? c.replaygain_track_peak.ratio : null)
      }
    }
  } catch (err) {
    mmError = err.message
  }

  const nameBase = path.basename(filePath, path.extname(filePath))
  const cover = (meta && meta.cover) || (await findCover(filePath, meta))
  let lyric = findLyric(filePath)
  if (!lyric && embeddedLyric && lyricDir) {
    lyric = await writeEmbeddedLyric(embeddedLyric, lyricDir, id)
  }
  const lrcMeta = readLrcMeta(lyric)

  const named = resolveNameSegments(nameBase, lrcMeta)
  let nameTitle = named.title
  let nameArtist = named.artist
  // 标签缺失时，用 LRC 的 [ti:]/[ar:] 补齐（歌名去掉末尾的影视插曲括号）
  if (lrcMeta) {
    if (!(meta && meta.title) && lrcMeta.ti) {
      nameTitle = lrcMeta.ti.replace(/\s*[（(][^（()）]*[）)]\s*$/, '').trim() || nameTitle
    }
    if (!(meta && meta.artist) && lrcMeta.ar) nameArtist = lrcMeta.ar
  }

  const title = (meta && meta.title) || nameTitle
  const artist = (meta && meta.artist) || nameArtist || '未知歌手'
  const album = (meta && meta.album) || ''
  const pys = buildPinyinSearch([title, artist, album])

  return {
    id,
    path: filePath,
    fileName: path.basename(filePath),
    size: st.size,
    mtime: st.mtimeMs,
    // 入库时间（v1.9）：「最近添加」视图按它倒序。首次解析记当前时间，
    // 之后无论重建缓存还是重新解析都由 scan() 沿用旧值（见 scan 内的 addedAt 处理）
    addedAt: Date.now(),
    title,
    artist,
    artists: (meta && meta.artists) || (nameArtist ? [nameArtist] : []),
    album,
    albumArtist: (meta && meta.albumArtist) || '',
    year: (meta && meta.year) || null,
    trackNo: (meta && meta.trackNo) || null,
    discNo: (meta && meta.discNo) || null,
    genre: (meta && meta.genre) || [],
    duration: (meta && meta.duration) || 0,
    bitrate: (meta && meta.bitrate) || 0,
    sampleRate: (meta && meta.sampleRate) || 0,
    bitsPerSample: (meta && meta.bitsPerSample) || 0,
    codec: (meta && meta.codec) || extOf(filePath).slice(1).toUpperCase(),
    lossless: !!(meta && meta.lossless),
    cover,
    lyric,
    ext: extOf(filePath).slice(1),
    // DSD（v2.0）：dsf/dff 在普通输出（Chromium）里根本解不了，必须走独占；界面据此标注
    isDsd: /^(dsf|dff)$/i.test(extOf(filePath).slice(1)),
    // ReplayGain 标签（v2.0）：有值就优先用，省掉一次整库响度分析
    rgTrackDb: (rg && rg.rgTrackDb) ?? null,
    rgAlbumDb: (rg && rg.rgAlbumDb) ?? null,
    rgPeak: (rg && rg.rgPeak) ?? null,
    py: pys.py,
    pyf: pys.pyf,
    parseError: mmError
  }
}

/** 并发受限的 map */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

class Library {
  constructor({ cacheFile, coverDir, lyricDir }) {
    this.cacheFile = cacheFile
    this.coverDir = coverDir
    // 内嵌歌词落盘目录（v2.0）：只给「标签里有歌词、但没有同名 .lrc」的曲目用
    this.lyricDir = lyricDir || path.join(path.dirname(cacheFile), 'lyrics')
    // 解析失败清单（v1.8）：独立于 library.json 存，因为「连元数据都读不出来」的文件
    // 根本进不了曲库，以前只在扫描返回值里留前 10 个文件名，重启即丢。
    this.failuresFile = path.join(path.dirname(cacheFile), 'parse-failures.json')
    this.failures = new Map()
    this.tracks = new Map()
    this.mm = null
    this.scanning = false
  }

  /** 记一条失败（幂等）：同一文件重复失败只刷新时间与原因，保留首次出现时间 */
  recordFailure(filePath, error, stage = 'parse', size = 0) {
    const id = fileId(filePath)
    const prev = this.failures.get(id)
    this.failures.set(id, {
      id,
      path: filePath,
      fileName: path.basename(filePath),
      ext: extOf(filePath).slice(1),
      size: size || (prev && prev.size) || 0,
      stage,                                   // stat | parse（完全读不出） | metadata（能播但无标签）
      error: String(error || '未知错误').slice(0, 300),
      firstAt: (prev && prev.firstAt) || Date.now(),
      at: Date.now()
    })
    return this.failures.get(id)
  }

  clearFailure(filePathOrId) {
    const id = this.failures.has(filePathOrId) ? filePathOrId : fileId(String(filePathOrId || ''))
    return this.failures.delete(id)
  }

  clearAllFailures() {
    const n = this.failures.size
    this.failures.clear()
    return n
  }

  listFailures() {
    return Array.from(this.failures.values()).sort((a, b) => b.at - a.at)
  }

  async persistFailures() {
    try {
      await fsp.mkdir(path.dirname(this.failuresFile), { recursive: true })
      const tmp = this.failuresFile + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify({ v: 1, failures: this.listFailures() }), 'utf8')
      await fsp.rename(tmp, this.failuresFile)
    } catch (err) {
      console.error('[library] 失败清单写入失败:', err.message)
    }
  }

  async init() {
    // music-metadata v11 是纯 ESM，CJS 里用动态 import
    this.mm = await import('music-metadata')
    try {
      const rawF = await fsp.readFile(this.failuresFile, 'utf8')
      const parsedF = JSON.parse(rawF)
      for (const f of parsedF.failures || []) {
        if (f && f.path) this.failures.set(f.id || fileId(f.path), f)
      }
    } catch {
      /* 首次运行没有失败清单 */
    }
    try {
      const raw = await fsp.readFile(this.cacheFile, 'utf8')
      const parsed = JSON.parse(raw)
      // 解析器版本变了就丢弃旧缓存，让所有曲目重新解析（标题/歌手规则更新）。
      // 注意别在这里 return —— 下面还有「旧封面缓存清理」，早退会把它一起跳过
      if (parsed.version !== PARSE_VERSION) {
        this.tracks.clear()
      } else {
        for (const t of parsed.tracks || []) {
          // 这里不再校验 path 是否存在：移动硬盘/网络盘离线时启动，会把整库过滤成空。
          // 真正的增删以 scan() 为准（它会先确认目录可达）。
          if (!t || !t.id) continue
          // 旧缓存里 cover 是绝对路径，程序文件夹搬过家会全失效；能按文件名在本机 covers 里找到的，就地归一化成相对名。
          // 注意：与音频同目录的封面图也是绝对路径，但它们不在 coverDir 里，必须原样保留。
          if (t.cover && path.isAbsolute(t.cover) && !fs.existsSync(t.cover)) {
            const inCurrent = path.join(this.coverDir, path.basename(t.cover))
            if (fs.existsSync(inCurrent)) t.cover = path.basename(inCurrent)
          }
          this.tracks.set(t.id, t)
        }
      }
    } catch {
      /* 首次运行无缓存 */
    }
    // v1.9：老缓存没有 addedAt。用文件 mtime 兜底——同一个文件夹拷进来的歌
    // mtime 通常就接近入库那一刻，比一律填 now() 更接近事实（否则全库都成"刚刚添加"）
    // v2.0：老缓存的 cover 是 covers 目录里的文件名，统一改成内嵌标记，改走 lxcover:// 协议；
    //       旧封面文件随后由 cleanupLegacyCovers() 清掉（它们只是缓存，能从音频里重新解出来）
    let migratedCovers = 0
    for (const t of this.tracks.values()) {
      if (!t.addedAt) t.addedAt = Math.round(t.mtime || Date.now())
      else t.addedAt = Math.round(t.addedAt)   // fs 的 mtimeMs 带小数，统一取整
      if (t.cover && !path.isAbsolute(t.cover) && t.cover !== COVER_EMBEDDED) {
        t.cover = COVER_EMBEDDED
        migratedCovers++
      }
    }
    // 无条件清扫一次：解析版本升级后可能已经是"全部 @embedded 但磁盘上还留着旧文件"
    // 的状态，靠 migratedCovers 判断会漏掉那一次（cleanupLegacyCovers 内部有守卫）
    this.cleanupLegacyCovers()
  }

  /** 清掉旧版在 data\covers 里留下的封面文件（只删 <32位hash>.<图片扩展名> 这种名字，
   *  绝不碰用户自己的图片）。内嵌封面现在走内存 + lxcover://，磁盘上不该再有这些垃圾。 */
  cleanupLegacyCovers() {
    // 只要还有曲目引用「coverDir 里的文件名」，就说明迁移没完成，一律不删
    for (const t of this.tracks.values()) {
      if (t.cover && !path.isAbsolute(t.cover) && t.cover !== COVER_EMBEDDED) return
    }
    let n = 0
    try {
      for (const f of fs.readdirSync(this.coverDir)) {
        if (!/^[0-9a-f]{32}\.(jpe?g|png|webp|bmp|gif)$/i.test(f)) continue
        try { fs.unlinkSync(path.join(this.coverDir, f)); n++ } catch {}
      }
    } catch { /* 目录不存在就算了 */ }
    if (n) console.warn('[cover] 已清理旧封面缓存 ' + n + ' 个')
  }

  /** 取内嵌封面（v2.0）：命中内存 LRU 直接返回，否则现场解析文件并回填缓存。
   *  返回 {buf, mime} 或 null。 */
  async getCover(id) {
    const hit = coverCacheGet(id)
    if (hit) return hit
    const t = this.tracks.get(id)
    if (!t || t.cover !== COVER_EMBEDDED || !t.path) return null
    try {
      const parsed = await this.mm.parseFile(t.path, { duration: false, skipCovers: false })
      const pic = parsed.common && parsed.common.picture && parsed.common.picture[0]
      const pb = pictureToBuf(pic)
      if (!pb) return null
      coverCacheSet(id, pb.buf, pb.mime)
      return pb
    } catch (err) {
      return null
    }
  }

  list() {
    return Array.from(this.tracks.values())
  }

  get(id) {
    return this.tracks.get(id) || null
  }

  async persist() {
    try {
      await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true })
      const tmp = this.cacheFile + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify({ version: PARSE_VERSION, tracks: this.list() }), 'utf8')
      await fsp.rename(tmp, this.cacheFile)
    } catch (err) {
      console.error('[library] 缓存写入失败:', err.message)
    }
  }

  /**
   * 扫描：dirs 为目录数组。onProgress({phase, done, total, track})
   * 增量：mtime+size 未变则复用缓存记录（但每次仍校验封面/歌词是否存在）
   */
  async scan(dirs, onProgress = () => {}) {
    if (this.scanning) return { added: 0, updated: 0, total: this.tracks.size }
    this.scanning = true
    const started = Date.now()
    try {
      onProgress({ phase: 'collect', done: 0, total: 0 })
      const all = []
      const missingRoots = []      // 本次不可访问的根目录（拔盘 / 网络盘离线 / 权限变动）
      for (const dir of dirs) {
        if (!dir) continue
        let ok = false
        try {
          const st = await fsp.stat(dir)
          ok = st.isDirectory()
        } catch {
          ok = false
        }
        if (!ok) {
          missingRoots.push(dir)
          continue
        }
        const files = await collectFiles(dir, [])
        all.push(...files)
      }
      // 大小写去重：一次建 Map，O(n)。旧写法对每个唯一路径都遍历整个数组（O(n²)），
      // 千首以上会明显拖慢收集阶段。
      const unique = Array.from(
        new Map(all.map((f) => [f.toLowerCase(), f])).values()
      )

      const seen = new Set()
      const failedFiles = []
      let done = 0
      let added = 0
      let updated = 0
      const total = unique.length

      await mapLimit(unique, 4, async (filePath) => {
        const id = fileId(filePath)
        seen.add(id)
        let st
        try {
          st = await fsp.stat(filePath)
        } catch (err) {
          // 收集阶段还在、解析时读不到（被占用 / 权限 / 刚被删）
          if (err.code !== 'ENOENT') this.recordFailure(filePath, '读取文件信息失败：' + err.message, 'stat')
          done++
          return
        }
        const cached = this.tracks.get(id)
        let track
        if (cached && cached.size === st.size && Math.abs(cached.mtime - st.mtimeMs) < 1) {
          // 复用元数据，但修正可能新增/删除的封面与歌词
          // 歌词：外置 .lrc 优先；没有就沿用缓存里的（可能是内嵌歌词生成的那份），
          // 但文件已不存在时要清掉，否则点开歌词会读到空
          const lyric = findLyric(filePath) || (cached.lyric && fs.existsSync(cached.lyric) ? cached.lyric : null)
          let cover = cached.cover
          // 内嵌封面是个标记，没有实体文件可 stat —— 别拿它去 existsSync，
          // 否则每次扫描都会把标记覆盖成 findCover() 的结果（内嵌封面就此丢失）
          if (cover && cover !== COVER_EMBEDDED) {
            const absCover = resolveCoverPath(cover, this.coverDir)
            if (!absCover || !fs.existsSync(absCover)) cover = await findCover(filePath, cached)
          }
          track = { ...cached, lyric, cover }
          if (!track.addedAt) track.addedAt = cached.mtime || Date.now()
        } else {
          try {
            track = await parseTrack(filePath, this.mm, this.coverDir, this.lyricDir)
            // 入库时间只认第一次：重新解析（改了标签、换了封面、PARSE_VERSION 升级）
            // 不等于"新添加"，否则整库都会跳到"最近添加"最前面
            track.addedAt = (cached && cached.addedAt) || track.addedAt
            if (cached) updated++
            else added++
          } catch (err) {
            console.error('[library] 解析失败:', filePath, err.message)
            // 保留旧缓存（若存在），只记名字让上层提示；直接丢弃会让用户
            // 完全不知道「为什么少了几首歌」
            failedFiles.push(path.basename(filePath))
            // v1.8：失败明细单独落盘，诊断面板要能看到完整路径与原因
            this.recordFailure(filePath, err.message, 'parse', st.size)
            done++
            onProgress({ phase: 'parse', done, total, track: null })
            return
          }
        }
        // 元数据能解析但标签读不出来（music-metadata 抛错但有文件名兜底）也算失败，
        // 区别是它仍能播放，所以 stage 记 metadata；解析正常则清掉历史失败记录
        if (track.parseError) this.recordFailure(filePath, track.parseError, 'metadata', st.size)
        // 连时长都读不出来，基本就是这个文件坏了 / 格式不受支持（能"解析成功"但 duration=0）
        else if (!(track.duration > 0)) {
          this.recordFailure(filePath, '无法读取音频时长（文件可能损坏或格式不受支持）', 'duration', st.size)
        } else this.failures.delete(id)
        this.tracks.set(id, track)
        done++
        onProgress({ phase: 'parse', done, total, track })
      })

      // 清理已不存在的文件
      // 有根目录本次不可访问时一律跳过：否则拔掉移动硬盘 / 网络盘离线后扫描一次，
      // 就会把这些目录下的曲目全部删除并写回 library.json（数据丢失）
      let removed = 0
      if (missingRoots.length) {
        console.warn('[library] 有目录不可访问，跳过清理:', missingRoots.join(' | '))
      } else {
        for (const id of Array.from(this.tracks.keys())) {
          if (!seen.has(id)) {
            const old = this.tracks.get(id)
            // 内嵌歌词是程序生成的文件，曲目被移除时一起清掉，别在 data\lyrics 里留孤儿
            if (old && old.lyric && this.lyricDir && path.dirname(old.lyric) === this.lyricDir) {
              try { fs.unlinkSync(old.lyric) } catch {}
            }
            this.tracks.delete(id)
            removed++
          }
        }
        // 失败记录同样要清理：文件已被删掉的条目留着就是脏数据（目录不可达时一并跳过）
        for (const [id, f] of Array.from(this.failures)) {
          if (!seen.has(id) && !fs.existsSync(f.path)) this.failures.delete(id)
        }
      }

      await this.persist()
      await this.persistFailures()
      return {
        added, updated, removed, total: this.tracks.size,
        failed: failedFiles.length,
        failedFiles: failedFiles.slice(0, 10),
        // v1.8：失败清单完整条数（failedFiles 只给前 10 个名字，诊断面板另有完整数据）
        failures: this.failures.size,
        missingRoots,
        elapsed: Date.now() - started
      }
    } finally {
      this.scanning = false
    }
  }
}

module.exports = {
  Library, fileId, AUDIO_EXT, MIME_BY_EXT, resolveCoverPath, COVER_EMBEDDED, readEmbeddedLyric,
  __test: { splitFileNameSegments, resolveNameSegments, normName, readLrcMeta, parseTrack }
}
