'use strict'
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
/**
 * v3.3.24 模块拆分：从 main.js 原样搬出（只做 G. 前缀注入，不改逻辑）。
 * init(G) 注入 main 的共享状态访问器（getter，见 main.js 的 G 定义）。
 */
const PROTO = require('./protocols')

let G = null
function init(g) { G = g }

/* ---------------- 联网版：在线音乐缓存 ---------------- */

/**
 * 缓存「放过的在线音频」，下次再放同一首直接从磁盘出，不再走网络。
 * 对无损尤其关键：一首 flac 几十上百 MB，重放不该再等一遍。
 *
 * 索引单独存一份 json：界面要显示「几首 / 占多大」，
 * 每次遍历目录累加太慢（用久了这里会有几百个文件）。
 */
const CACHE_INDEX = 'index.json'

let cacheIdx = null // { <key>: { file, title, artist, ext, size, at } }

/** 原子写 JSON：先写唯一临时文件并 fsync，再 rename，崩溃时不会截断索引 */
function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  let fd = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fd = fs.openSync(tmp, 'w')
    fs.writeFileSync(fd, JSON.stringify(obj, null, 1), 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
  } catch (err) {
    if (fd) { try { fs.closeSync(fd) } catch (e) { /* 忽略 */ } }
    try { fs.unlinkSync(tmp) } catch (e) { /* 忽略 */ }
    throw err
  }
}

function cacheDirPath() {
  const custom = String(G.store.get().settings.onlineCacheDir || '').trim()
  return custom || path.join(G.DATA_DIR, 'music-cache')
}

function cacheLoad() {
  if (cacheIdx) return cacheIdx
  cacheIdx = {}
  const idxFile = path.join(cacheDirPath(), CACHE_INDEX)
  try {
    const j = JSON.parse(fs.readFileSync(idxFile, 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) cacheIdx = j
    else throw new Error('索引结构损坏')
  } catch (err) {
    // v3.3.13：损坏的索引先备份，别让一次崩溃把全部缓存记录弄丢
    try {
      if (fs.existsSync(idxFile)) {
        fs.renameSync(idxFile, idxFile + '.corrupt-' + Date.now())
        G.logLine('[cache] 索引损坏已备份', err.message)
      }
    } catch (e) { /* 忽略 */ }
    cacheIdx = {}
  }
  return cacheIdx
}

function cacheSave() {
  try {
    atomicWriteJson(path.join(cacheDirPath(), CACHE_INDEX), cacheIdx || {})
  } catch (err) {
    G.logLine('[cache] 索引写入失败', err.message)
  }
}

/** LRU 刷新/失效清理用去抖落盘：命中本身很频繁，不能每次都同步写盘 */
let cacheSaveTimer = null

function cacheSaveSoon() {
  if (cacheSaveTimer) return
  cacheSaveTimer = setTimeout(() => { cacheSaveTimer = null; cacheSave() }, 1000)
  if (cacheSaveTimer.unref) cacheSaveTimer.unref()
}

/**
 * 缓存按「实际拿到的音质」分类，不能按「请求的音质」。
 * 否则无损没取到时降级下来的 128k mp3 会被存成 flac，
 * 用户下次以为在听无损，其实是一首糊的。
 */
function cacheClassOf(info) {
  const ext = String((info && info.ext) || '').toLowerCase()
  const level = String((info && info.level) || '').toLowerCase()
  // v3.3.18：母带与普通无损共用一个 'flac' 键会让母带缓存永远写不进
  //（finishCache 见同名文件已存在就直接丢），选母带也会命中普通 flac
  if ((info && info.lossless) && /master|hires/.test(level)) return 'master'
  if ((info && info.lossless) || ext === 'flac') return 'flac'
  return (Number(info && info.bitrate) || 0) > 128 ? 'best' : '128'
}

function cacheKeyOf(song, cls) {
  // v3.3.13：URL 里的 src/id 可能含 ../ 等，直接拼进文件名会路径穿越；
  // 用 sha256 摘要做纯十六进制文件名
  const rawKey = `${song.source}_${song.id}_${cls}`
  return crypto.createHash('sha256').update(rawKey).digest('hex')
}

/** 请求的音质 → 可以接受的缓存档位（从优到次） */
function cacheKeysFor(prefer) {
  if (prefer === 'master') return ['master', 'flac']
  if (prefer === 'lossless') return ['flac', 'master']
  if (prefer === '128k') return ['128', 'best']   // 省流量不吃 flac（动辄上百 MB）
  return ['best', 'flac']                          // 音质优先时 flac 当然更好
}

/** 索引可能被篡改：只放行纯文件名且解析后仍在缓存目录内的路径 */
function safeCacheFilePath(rf) {
  const dirResolved = path.resolve(cacheDirPath())
  const name = String(rf || '')
  // 第四轮 §4.5.3 #12：只堵了 \ / 与 .. —— NTFS 的 `file:stream`（ADS）与 %00 仍能穿过，
  // 落到 cachePut 登记的表项会指向一个「文件流」而不是文件
  if (!name || /[\\/]/.test(name) || name.includes('..')) return null
  if (name.includes(':') || name.includes('\u0000') || name.includes('%00')) return null
  const fp = path.resolve(dirResolved, name)
  if (fp !== dirResolved && !fp.startsWith(dirResolved + path.sep)) return null
  return fp
}

/** 命中返回 { path, rec, cls }；文件被手动删掉或大小对不上就当作没缓存 */
function cacheTry(song, cls) {
  const idx = cacheLoad()
  const key = cacheKeyOf(song, cls)
  const rec = idx[key]
  if (!rec) return null
  // v3.3.13：索引可能被篡改，rec.file 必须是纯文件名且解析后仍在缓存目录内
  const rf = String(rec.file || '')
  const fp = safeCacheFilePath(rf)
  if (!fp) {
    delete idx[key]
    cacheSaveSoon()
    return null
  }
  try {
    const st = fs.statSync(fp)
    if (!st.isFile() || st.size !== rec.size) {
      delete idx[key]
      cacheSaveSoon()
      return null
    }
    // 命中即续期做 LRU，但不必每次都写盘：连点试听会让 index.json
    // 在几秒内被重写十几次。5 分钟的续期精度对缓存淘汰完全够用。
    if (!rec.at || Date.now() - rec.at > 5 * 60 * 1000) {
      rec.at = Date.now()
      cacheSaveSoon()
    }
    return { path: fp, rec, cls }
  } catch (err) {
    delete idx[key]
    cacheSaveSoon()   // v3.3.13：脏索引清理也要落盘，否则重启后重现
    return null
  }
}

function cacheHit(song, prefer) {
  for (const cls of cacheKeysFor(prefer)) {
    const hit = cacheTry(song, cls)
    if (hit) return hit
  }
  return null
}

function cacheTotalBytes() {
  const idx = cacheLoad()
  return Object.values(idx).reduce((s, x) => s + (Number(x.size) || 0), 0)
}

function cachePut(key, file, meta, size) {
  const idx = cacheLoad()
  idx[key] = {
    file,
    title: meta.title || '',
    artist: meta.artist || '',
    ext: meta.ext || '',
    size,
    at: Date.now()
  }
  cacheSave()
  cacheEvict()
}

/** 超过上限就按最久没放过的删，删到上限的 80%，别每次都贴着边删 */
function cacheEvict() {
  const limitMB = Number(G.store.get().settings.onlineCacheLimitMB) || 0
  if (limitMB <= 0) return
  const idx = cacheLoad()
  const items = Object.keys(idx).map((k) => ({ k, v: idx[k] }))
  let total = items.reduce((s, x) => s + (Number(x.v.size) || 0), 0)
  const limit = limitMB * 1048576
  if (total <= limit) return
  items.sort((a, b) => (Number(a.v.at) || 0) - (Number(b.v.at) || 0))
  const target = limit * 0.8
  let removed = 0
  for (const it of items) {
    if (total <= target) break
    try {
      const fp = safeCacheFilePath(it.v.file)
      if (!fp) { delete idx[it.k]; cacheSaveSoon(); continue }
      fs.unlinkSync(fp)
    } catch (err) {
      // v3.3.7：删不掉（文件正被播放占用）就留给下次 ——
      // 以前无条件删索引条目，文件留在磁盘上成了永远没人回收的孤儿
      continue
    }
    delete idx[it.k]
    total -= Number(it.v.size) || 0
    removed++
  }
  if (removed) {
    cacheSave()
    G.logLine('[cache] 超出上限，清理了', removed, '首，现', (total / 1048576).toFixed(0) + 'MB')
  }
}

/**
 * 启动时清掉上次异常退出留下的 .part（进程被杀时来不及自己收）。
 *
 * v3.3.20：只删**我们自己命名的**残片（`<sha256>.<uniq>.part`）。
 * 缓存目录是用户可改的（「选缓存目录」允许普通文件夹），以前无差别删掉目录里
 * 所有 `*.part` —— 用户把缓存目录指到 D:\音乐 时，其他下载器的未完成文件会被一起删掉。
 */
const CACHE_PART_RE = /^[0-9a-f]{64}\.[0-9a-z]+\.part$/i

function cacheCleanupParts() {
  try {
    const dir = cacheDirPath()
    for (const f of fs.readdirSync(dir)) {
      if (!CACHE_PART_RE.test(f)) continue
      try { fs.unlinkSync(path.join(dir, f)) } catch (err) { /* 忽略 */ }
    }
  } catch (err) { /* 目录还不存在 */ }
}

/** 只删索引里登记过的文件和 .part 残留，绝不碰目录里别的东西 */
function cacheClear() {
  const idx = cacheLoad()
  const dir = cacheDirPath()
  let n = 0
  for (const k of Object.keys(idx)) {
    const fp = safeCacheFilePath(idx[k].file)
    if (!fp) continue
    try { fs.unlinkSync(fp); n++ } catch (err) { /* 忽略 */ }
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      // v3.3.20：同样只清我们自己的残片命名（见 CACHE_PART_RE）
      if (CACHE_PART_RE.test(f)) { try { fs.unlinkSync(path.join(dir, f)) } catch (err) { /* 忽略 */ } }
    }
  } catch (err) { /* 目录不存在 */ }
  cacheIdx = {}
  cacheSave()
  return { removed: n }
}

function cacheStats() {
  const idx = cacheLoad()
  const items = Object.values(idx)
  return {
    dir: cacheDirPath(),
    count: items.length,
    size: items.reduce((s, x) => s + (Number(x.size) || 0), 0),
    limitMB: Number(G.store.get().settings.onlineCacheLimitMB) || 0,
    enabled: G.store.get().settings.onlineCacheOn !== false
  }
}

/**
 * v3.3.13：这是白名单外的第二条本地读通道，必须断言文件仍落在
 * 缓存目录 / 数据目录之内（realpath 后比较，防被篡改索引 + junction 绕过）。
 * @returns {boolean} 可读
 */
function isReadableFromCacheOrData(filePath) {
  let realFile = null
  try { realFile = fs.realpathSync.native(filePath) } catch (e) { realFile = null }
  if (!realFile) return false
  return [cacheDirPath(), G.DATA_DIR].some((d) => {
    let rd = PROTO.realpathCached(d)
    if (!rd) return false
    rd = rd.toLowerCase()
    const rf = realFile.toLowerCase()
    const prefix = (rd.endsWith(path.sep) ? rd.slice(0, -path.sep.length) : rd) + path.sep
    return rf === rd || rf.startsWith(prefix)
  })
}

module.exports = {
  init,
  CACHE_INDEX,
  get cacheIdx() { return cacheIdx },
  set cacheIdx(v) { cacheIdx = v },
  atomicWriteJson,
  cacheDirPath,
  cacheLoad,
  cacheSave,
  get cacheSaveTimer() { return cacheSaveTimer },
  cacheSaveSoon,
  cacheClassOf,
  cacheKeyOf,
  cacheKeysFor,
  safeCacheFilePath,
  cacheTry,
  cacheHit,
  cacheTotalBytes,
  cachePut,
  cacheEvict,
  CACHE_PART_RE,
  cacheCleanupParts,
  cacheClear,
  cacheStats,
  isReadableFromCacheOrData,
}
