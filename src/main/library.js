'use strict'
/**
 * 音乐库：目录扫描 → 元数据解析 → 封面/歌词定位 → 增量缓存。
 * 扫描结果以 fileId(路径哈希) 为键，写进 library.json；二次启动只解析变更文件。
 */
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const AUDIO_EXT = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.ape', '.wma', '.aiff', '.aif', '.dsf', '.dff', '.mka'
])
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']

/** 解析规则版本：标题/歌手兜底逻辑变化时递增，旧 library.json 会被视为过期重新解析 */
const PARSE_VERSION = 3

function fileId(filePath) {
  return crypto.createHash('md5').update(filePath.toLowerCase()).digest('hex')
}

function extOf(p) {
  return path.extname(p).toLowerCase()
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

/** 从内嵌封面写缓存文件。
 *  返回「相对 coverDir 的文件名」（如 `abc.jpg`），不返回绝对路径——
 *  library.json 会被缓存，若存绝对路径，整个程序文件夹搬家后封面会全部失效。 */
async function writeEmbeddedCover(picture, coverDir, id) {
  if (!picture || !picture.data) return null
  try {
    await fsp.mkdir(coverDir, { recursive: true })
    const fmt = String(picture.format || 'image/jpeg').split('/').pop().replace('jpeg', 'jpg')
    const ext = ['.jpg', '.png', '.webp', '.bmp', '.gif'].includes('.' + fmt) ? '.' + fmt : '.jpg'
    const name = id + ext
    const out = path.join(coverDir, name)
    try {
      const st = await fsp.stat(out)
      if (st.size > 0) return name
    } catch {}
    await fsp.writeFile(out, Buffer.from(picture.data))
    return name
  } catch (err) {
    console.error('[cover] 写入失败:', err.message)
    return null
  }
}

/** 把曲目里的封面字段解析成可读的绝对路径。
 *  兼容三种形态：①相对 coverDir 的文件名（新格式）②旧的绝对路径 ③旧绝对路径但文件已不在
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
async function parseTrack(filePath, mm, coverDir) {
  const id = fileId(filePath)
  const st = await fsp.stat(filePath)
  let meta = null
  let mmError = null
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
    const pic = c.picture && c.picture.length ? c.picture[0] : null
    const embedded = await writeEmbeddedCover(pic, coverDir, id)
    meta.cover = embedded
  } catch (err) {
    mmError = err.message
  }

  const nameBase = path.basename(filePath, path.extname(filePath))
  const cover = (meta && meta.cover) || (await findCover(filePath, meta))
  const lyric = findLyric(filePath)
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

  return {
    id,
    path: filePath,
    fileName: path.basename(filePath),
    size: st.size,
    mtime: st.mtimeMs,
    title: (meta && meta.title) || nameTitle,
    artist: (meta && meta.artist) || nameArtist || '未知歌手',
    artists: (meta && meta.artists) || (nameArtist ? [nameArtist] : []),
    album: (meta && meta.album) || '',
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
  constructor({ cacheFile, coverDir }) {
    this.cacheFile = cacheFile
    this.coverDir = coverDir
    this.tracks = new Map()
    this.mm = null
    this.scanning = false
  }

  async init() {
    // music-metadata v11 是纯 ESM，CJS 里用动态 import
    this.mm = await import('music-metadata')
    try {
      const raw = await fsp.readFile(this.cacheFile, 'utf8')
      const parsed = JSON.parse(raw)
      // 解析器版本变了就丢弃旧缓存，让所有曲目重新解析（标题/歌手规则更新）
      if (parsed.version !== PARSE_VERSION) {
        this.tracks.clear()
        return
      }
      for (const t of parsed.tracks || []) {
        if (!t || !t.id || !fs.existsSync(t.path)) continue
        // 旧缓存里 cover 是绝对路径，程序文件夹搬过家会全失效；能按文件名在本机 covers 里找到的，就地归一化成相对名。
        // 注意：与音频同目录的封面图也是绝对路径，但它们不在 coverDir 里，必须原样保留。
        if (t.cover && path.isAbsolute(t.cover) && !fs.existsSync(t.cover)) {
          const inCurrent = path.join(this.coverDir, path.basename(t.cover))
          if (fs.existsSync(inCurrent)) t.cover = path.basename(inCurrent)
        }
        this.tracks.set(t.id, t)
      }
    } catch {
      /* 首次运行无缓存 */
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
      for (const dir of dirs) {
        if (!dir) continue
        try {
          const st = await fsp.stat(dir)
          if (!st.isDirectory()) continue
        } catch {
          continue
        }
        const files = await collectFiles(dir, [])
        all.push(...files)
      }
      const unique = Array.from(new Set(all.map((f) => f.toLowerCase()))).map((lower) => {
        return all.find((f) => f.toLowerCase() === lower)
      })

      const seen = new Set()
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
        } catch {
          done++
          return
        }
        const cached = this.tracks.get(id)
        let track
        if (cached && cached.size === st.size && Math.abs(cached.mtime - st.mtimeMs) < 1) {
          // 复用元数据，但修正可能新增/删除的封面与歌词
          const lyric = findLyric(filePath)
          let cover = cached.cover
          const absCover = resolveCoverPath(cover, this.coverDir)
          if (!absCover || !fs.existsSync(absCover)) cover = await findCover(filePath, cached)
          track = { ...cached, lyric, cover }
        } else {
          try {
            track = await parseTrack(filePath, this.mm, this.coverDir)
            if (cached) updated++
            else added++
          } catch (err) {
            console.error('[library] 解析失败:', filePath, err.message)
            done++
            return
          }
        }
        this.tracks.set(id, track)
        done++
        onProgress({ phase: 'parse', done, total, track })
      })

      // 清理已不存在的文件
      let removed = 0
      for (const id of Array.from(this.tracks.keys())) {
        if (!seen.has(id)) {
          this.tracks.delete(id)
          removed++
        }
      }

      await this.persist()
      return {
        added, updated, removed, total: this.tracks.size,
        elapsed: Date.now() - started
      }
    } finally {
      this.scanning = false
    }
  }
}

module.exports = {
  Library, fileId, AUDIO_EXT, MIME_BY_EXT, resolveCoverPath,
  __test: { splitFileNameSegments, resolveNameSegments, normName, readLrcMeta, parseTrack }
}
