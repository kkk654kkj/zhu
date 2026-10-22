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
const PARSE_VERSION = 4

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
  constructor({ cacheFile, coverDir }) {
    this.cacheFile = cacheFile
    this.coverDir = coverDir
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
      // 解析器版本变了就丢弃旧缓存，让所有曲目重新解析（标题/歌手规则更新）
      if (parsed.version !== PARSE_VERSION) {
        this.tracks.clear()
        return
      }
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
    } catch {
      /* 首次运行无缓存 */
    }
    // v1.9：老缓存没有 addedAt。用文件 mtime 兜底——同一个文件夹拷进来的歌
    // mtime 通常就接近入库那一刻，比一律填 now() 更接近事实（否则全库都成"刚刚添加"）
    for (const t of this.tracks.values()) {
      if (!t.addedAt) t.addedAt = Math.round(t.mtime || Date.now())
      else t.addedAt = Math.round(t.addedAt)   // fs 的 mtimeMs 带小数，统一取整
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
          const lyric = findLyric(filePath)
          let cover = cached.cover
          const absCover = resolveCoverPath(cover, this.coverDir)
          if (!absCover || !fs.existsSync(absCover)) cover = await findCover(filePath, cached)
          track = { ...cached, lyric, cover }
          if (!track.addedAt) track.addedAt = cached.mtime || Date.now()
        } else {
          try {
            track = await parseTrack(filePath, this.mm, this.coverDir)
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
  Library, fileId, AUDIO_EXT, MIME_BY_EXT, resolveCoverPath,
  __test: { splitFileNameSegments, resolveNameSegments, normName, readLrcMeta, parseTrack }
}
