'use strict'
/**
 * 主进程：窗口、自定义文件协议、音乐库、持久化、全局快捷键。
 */
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, globalShortcut, Tray, Menu, nativeImage, screen, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { execFile, execFileSync } = require('child_process')
const { pathToFileURL } = require('url')
const { Readable } = require('stream')

const { Store } = require('./store')
const { Library, fileId, MIME_BY_EXT, resolveCoverPath, COVER_EMBEDDED } = require('./library')
const { MpvEngine } = require('./mpv')
const online = require('./online')

const isDev = process.argv.includes('--dev')
const DEFAULT_MUSIC_DIR = 'D:\\音乐'
// 应用显示名（窗口标题 / 托盘提示）
const APP_NAME = '猪专属播放器·联网版'
// 内部应用名绝不能跟着改。
// 实测：把这里换成带「·」的新名字后，Chromium 会去 %APPDATA%\<新名字> 建它自己的
// 目录（某些 Windows 环境建不了），结果是自定义协议 lxfile/lxcover 全部失效、
// <audio> 只报 "Format error"，而 http 请求却照常——极难排查。
// 所以内部名沿用老名字，界面上的名字用 APP_NAME 单独给。
app.setName('猪专属播放器')

// 数据目录（便携式）：放在应用目录下的 data\
// 不用系统默认 userData —— 部分 Windows 环境下 Chromium 在 %APPDATA% 里建不了
// 锁文件与缓存目录（Error code: 5），表现为双击后进程静默退出、没有窗口。
const DATA_DIR = process.env.LX_DATA
  ? path.resolve(process.env.LX_DATA)
  : app.isPackaged
    // 打包后 __dirname 在 app.asar 内（只读），必须落在 exe 同级目录
    ? path.join(path.dirname(process.execPath), 'data')
    : path.join(__dirname, '..', '..', 'data')
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
app.setPath('userData', DATA_DIR)
app.setPath('sessionData', DATA_DIR)

// 启动日志：无控制台时也能定位崩溃点
const LOG_FILE = process.env.LX_LOG || path.join(DATA_DIR, 'lx-player.log')
function logLine(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
  try { console.log(line) } catch {}
}
process.on('uncaughtException', (err) => {
  logLine('UNCAUGHT', err.stack || String(err))
})
process.on('unhandledRejection', (err) => {
  logLine('UNHANDLED_REJECTION', (err && err.stack) || String(err))
})

/**
 * 清掉 Chromium 在 data\ 下攒的纯缓存目录。
 *
 * 便携程序把 userData 指到了 data\，于是 Cache / Code Cache / GPUCache 全堆在
 * 用户眼皮底下，几个月能涨到几百 MB，而它们对播放没有任何用处。
 * 只删白名单里的纯缓存目录，绝不碰 settings.json / library.json / covers\ / Local Storage。
 */
const CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache',
  'DawnWebGPUCache', 'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache',
  'Shared Dictionary', 'component_crx_cache'
]
function cleanChromiumCache() {
  let removed = 0
  for (const name of CACHE_DIRS) {
    const dir = path.join(DATA_DIR, name)
    try {
      if (!fs.existsSync(dir)) continue
      fs.rmSync(dir, { recursive: true, force: true })
      removed++
    } catch (err) {
      // 文件被占用（例如上一实例还在跑）就跳过，不影响启动
    }
  }
  if (removed) logLine('stage: cache-cleaned=' + removed + ' dirs')
}

/**
 * 结束上次被强杀留下的 mpv 进程。
 *
 * 主进程被任务管理器 / taskkill /F 干掉时，before-quit 不会执行，
 * 残留的 mpv 会一直霸占 WASAPI 独占 → 用户看到的是「播放器明明没开，
 * 别的程序全都没声音」。只杀命令行带我们命名管道前缀（lxmpv-）的 mpv，不误伤用户自己的。
 */
function killOrphanMpv() {
  if (process.platform !== 'win32') return
  // 命名管道是 lxmpv-<主进程PID>-<时间戳>，所以只杀「管道名里不是当前 PID」的那些。
  // 不能无条件扫所有 lxmpv-*：启动后渲染层会在 1~2 秒内拉起自己的 mpv，
  // 而这一步恰好也是异步的，会把刚起的引擎当孤儿杀掉。
  // （v1.6.0 实测踩到：日志里 killed-orphan-mpv 之后紧跟 mpv IPC 连接失败）
  // v3.3.2 关键修复：以前只排除「本进程」的管道名，于是两个实例同时开着时，
  // 后启动的那个会把前一个正在用的 mpv 当孤儿杀掉 —— 前一个立刻失声，
  // 而进度条还在按插值往前走（用户看到「没声音但还在放」）。
  // 现在从管道名 lxmpv-<归属PID>- 里解析出主进程 PID：
  // 归属进程还活着（且是播放器自己）就绝不动它，只有 owner 已经死了才算孤儿。
  const selfPid = process.pid
  const script = [
    'Get-CimInstance Win32_Process -Filter "Name=\'mpv.exe\'" | ForEach-Object {',
    '  $m = [regex]::Match($_.CommandLine, \'lxmpv-(\\d+)-\')',
    '  if (-not $m.Success) { return }',
    '  $owner = [int]$m.Groups[1].Value',
    '  if ($owner -eq ' + selfPid + ') { return }',
    '  $p = Get-Process -Id $owner -ErrorAction SilentlyContinue',
    "  if ($p -and $p.ProcessName -like '猪专属播放器*') { return }",
    '  $_.ProcessId',
    '}'
  ].join("\n")
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 8000 },
    (err, stdout) => {
      if (err || !stdout) return
      const pids = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
      for (const pid of pids) {
        try {
          execFileSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true, timeout: 5000 })
          logLine('stage: killed-orphan-mpv=' + pid)
        } catch {}
      }
    })
}
logLine('=== boot ===', process.argv.join(' '), 'electron', process.versions.electron)
logLine('stage: require-ok app=' + typeof app + ' protocol=' + typeof protocol)

try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'lxfile',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
    },
    {
      // v2.0：内嵌封面按需从音频文件里解出来，不再往 data\covers 写文件
      scheme: 'lxcover',
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true }
    }
  ])
  logLine('stage: schemes-ok')
} catch (err) {
  logLine('FATAL registerSchemesAsPrivileged', err.stack || String(err))
  throw err
}

let win = null
let tray = null
let store = null
let library = null
let userData = null
let quitting = false
/** 正在进行的扫描 Promise；lib:list 要等它结束，避免渲染进程读到半成品曲库 */
let activeScan = null

const AUDIO_MIME = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.ape': 'audio/x-ape',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff',
  '.mka': 'audio/x-matroska'
}

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase()
  return AUDIO_MIME[ext] || MIME_BY_EXT[ext] || 'application/octet-stream'
}

/* ---------------- 自定义协议：支持 Range 的本地文件读取 ---------------- */

function registerFileProtocol() {
  protocol.handle('lxfile', async (request) => {
    try {
      const url = new URL(request.url)
      // lxfile://local/D:/music/a.flac  →  D:/music/a.flac
      let raw = decodeURIComponent(url.pathname)
      // 兜底：兼容旧式 lxfile:///D:/…（此时盘符会被当 host，需要拼回来）
      if (!/^\/?[A-Za-z]:\//.test(raw) && /^[A-Za-z]$/.test(url.hostname)) {
        raw = '/' + url.hostname + ':' + raw
      }
      let filePath = raw
      if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
      if (process.platform !== 'win32' && !filePath.startsWith('/')) filePath = '/' + filePath
      filePath = path.normalize(filePath)

      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) return new Response('not a file', { status: 404 })

      const type = mimeFor(filePath)
      const range = request.headers.get('range')
      const total = stat.size

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = m && m[1] ? parseInt(m[1], 10) : 0
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1
        if (Number.isNaN(start)) start = 0
        if (Number.isNaN(end) || end >= total) end = total - 1
        if (start > end) return new Response('bad range', { status: 416 })
        const stream = fs.createReadStream(filePath, { start, end })
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        })
      }

      const stream = fs.createReadStream(filePath)
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    } catch (err) {
      return new Response('not found: ' + err.message, { status: 404 })
    }
  })
}

/**
 * v2.0：内嵌封面协议。`lxcover://local/<trackId>` → 从音频文件里取封面。
 * 为什么不用 data: URL —— 每张封面几十到几百 KB，塞进 library.json 会让 5k 首的缓存
 * 涨到几十 MB；也不用磁盘文件，那正是"5k 首 = 5k 个小文件"的来源。
 * 内存 LRU 在扫描时就预热好了，正常情况这里不碰磁盘。
 */
function registerCoverProtocol() {
  protocol.handle('lxcover', async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname).replace(/^\/+/, '') || url.hostname
      const cov = library ? await library.getCover(id) : null
      if (!cov) return new Response('no cover', { status: 404 })
      return new Response(cov.buf, {
        status: 200,
        headers: {
          'Content-Type': cov.mime,
          'Content-Length': String(cov.buf.length),
          'Cache-Control': 'no-store'
        }
      })
    } catch (err) {
      return new Response('cover error: ' + err.message, { status: 500 })
    }
  })
}

/**
 * v3.0（联网版）：在线音频本地代理。
 *
 * 一开始试的是自定义协议 lxstream://，但 Electron 里 <audio> 加载自定义 scheme
 * 不可靠（请求根本到不了 protocol.handle，只在 media error 里看到 code 4，
 * 排查成本极高）。改用最朴素的本地 HTTP 服务：
 *  · <audio> / fetch / mpv 全都天然支持 http；
 *  · 自己发 CORS 头，WebAudio（均衡器/频谱）拿得到同源数据；
 *  · 直链过期时这层能透明重取，页面无感；
 *  · 需要 Referer 的 CDN 也在这里补。
 *
 * 地址：http://127.0.0.1:<随机端口>/stream?src=kw&id=xxx&q=best&t=&a=&d=
 * 只监听回环，外部访问不到。
 */
let streamServer = null
let streamBase = ''
let streamReady = null

/* 端口是异步绑定的，播放请求可能比它就绪更早，统一在这里等一等 */
function ensureStreamBase() {
  if (streamBase) return Promise.resolve(streamBase)
  return streamReady || Promise.resolve('')
}

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

function cacheDirPath() {
  const custom = String(store.get().settings.onlineCacheDir || '').trim()
  return custom || path.join(DATA_DIR, 'music-cache')
}

function cacheLoad() {
  if (cacheIdx) return cacheIdx
  cacheIdx = {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cacheDirPath(), CACHE_INDEX), 'utf8'))
    if (j && typeof j === 'object') cacheIdx = j
  } catch (err) { /* 没索引 = 空缓存 */ }
  return cacheIdx
}

function cacheSave() {
  try {
    fs.mkdirSync(cacheDirPath(), { recursive: true })
    fs.writeFileSync(path.join(cacheDirPath(), CACHE_INDEX), JSON.stringify(cacheIdx || {}))
  } catch (err) {
    logLine('[cache] 索引写入失败', err.message)
  }
}

/**
 * 缓存按「实际拿到的音质」分类，不能按「请求的音质」。
 * 否则无损没取到时降级下来的 128k mp3 会被存成 flac，
 * 用户下次以为在听无损，其实是一首糊的。
 */
function cacheClassOf(info) {
  const ext = String((info && info.ext) || '').toLowerCase()
  if ((info && info.lossless) || ext === 'flac') return 'flac'
  return (Number(info && info.bitrate) || 0) > 128 ? 'best' : '128'
}

function cacheKeyOf(song, cls) {
  return `${song.source}_${song.id}_${cls}`
}

/** 请求的音质 → 可以接受的缓存档位（从优到次） */
function cacheKeysFor(prefer) {
  if (prefer === 'lossless' || prefer === 'master') return ['flac']
  if (prefer === '128k') return ['128', 'best']   // 省流量不吃 flac（动辄上百 MB）
  return ['best', 'flac']                          // 音质优先时 flac 当然更好
}

/** 命中返回 { path, rec, cls }；文件被手动删掉或大小对不上就当作没缓存 */
function cacheTry(song, cls) {
  const idx = cacheLoad()
  const key = cacheKeyOf(song, cls)
  const rec = idx[key]
  if (!rec) return null
  const fp = path.join(cacheDirPath(), rec.file)
  try {
    const st = fs.statSync(fp)
    if (!st.isFile() || st.size !== rec.size) {
      delete idx[key]
      return null
    }
    rec.at = Date.now() // 命中即刷新，做 LRU
    return { path: fp, rec, cls }
  } catch (err) {
    delete idx[key]
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
  const limitMB = Number(store.get().settings.onlineCacheLimitMB) || 0
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
    try { fs.unlinkSync(path.join(cacheDirPath(), it.v.file)) } catch (err) { /* 已经没了 */ }
    delete idx[it.k]
    total -= Number(it.v.size) || 0
    removed++
  }
  if (removed) {
    cacheSave()
    logLine('[cache] 超出上限，清理了', removed, '首，现', (total / 1048576).toFixed(0) + 'MB')
  }
}

/** 启动时清掉上次异常退出留下的 .part（进程被杀时来不及自己收） */
function cacheCleanupParts() {
  try {
    const dir = cacheDirPath()
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.part')) continue
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
    try { fs.unlinkSync(path.join(dir, idx[k].file)); n++ } catch (err) { /* 忽略 */ }
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.part')) { try { fs.unlinkSync(path.join(dir, f)) } catch (err) { /* 忽略 */ } }
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
    limitMB: Number(store.get().settings.onlineCacheLimitMB) || 0,
    enabled: store.get().settings.onlineCacheOn !== false
  }
}

/** 从磁盘出流，支持 Range（拖动进度条要靠它） */
function serveLocalFile(filePath, req, res) {
  const stat = fs.statSync(filePath)
  const total = stat.size
  const base = {
    'Content-Type': mimeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  }
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= total) end = total - 1
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` })
      res.end()
      return
    }
    res.writeHead(206, {
      ...base,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...base, 'Content-Length': String(total) })
  fs.createReadStream(filePath).pipe(res)
}

function startStreamServer() {
  const http = require('http')
  let readyResolve = () => {}
  streamReady = new Promise((resolve) => { readyResolve = resolve })
  streamServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      if (u.pathname !== '/stream') {
        res.writeHead(404).end('not found')
        return
      }
      const source = u.searchParams.get('src') || ''
      const id = u.searchParams.get('id') || ''
      const prefer = u.searchParams.get('q') || 'best'
      if (!source || !id) {
        res.writeHead(400).end('bad params')
        return
      }
      const song = {
        source,
        id,
        title: u.searchParams.get('t') || '',
        artist: u.searchParams.get('a') || '',
        album: '',
        duration: Number(u.searchParams.get('d')) || 0
      }
      // 先看缓存：命中就连解析都省了（无损解析要 1~7 秒，重放不该再等）
      const cacheOn = store.get().settings.onlineCacheOn !== false
      if (cacheOn) {
        const hit = cacheHit(song, prefer)
        if (hit) {
          logLine('[cache] 命中', path.basename(hit.path))
          sendToRenderer('online:now-playing', {
            id: `${source}:${id}`,
            song: { title: hit.rec.title || song.title, artist: hit.rec.artist || song.artist },
            lossless: hit.cls === 'flac',
            bitrate: 0,
            ext: hit.rec.ext || path.extname(hit.path).slice(1),
            cached: true
          })
          serveLocalFile(hit.path, req, res)
          return
        }
      }
      const info = await online.getPlayable(song, prefer)
      if (!info || !info.url) {
        logLine('[online] 代理无地址', source, id)
        res.writeHead(404).end('no source')
        return
      }
      // 解析出来的实际音质如果正好有缓存，就别再拉一遍流。
      // （无损请求在「网易没这首/只有 mp3」时会降级，降级档位同样值得复用缓存）
      if (cacheOn) {
        const hit2 = cacheTry(song, cacheClassOf(info))
        if (hit2) {
          logLine('[cache] 命中(降级档)', path.basename(hit2.path))
          sendToRenderer('online:now-playing', {
            id: `${source}:${id}`,
            song: { title: hit2.rec.title || song.title, artist: hit2.rec.artist || song.artist },
            lossless: hit2.cls === 'flac',
            bitrate: info.bitrate || 0,
            ext: hit2.rec.ext || info.ext,
            cached: true
          })
          serveLocalFile(hit2.path, req, res)
          return
        }
      }
      const headers = { 'User-Agent': 'Mozilla/5.0' }
      if (info.referer) headers.Referer = info.referer
      // 有些平台的直链要带它自己指定的头（比如 QQ 的 Cookie/Referer），网关会一起给
      if (info.headers && typeof info.headers === 'object') {
        for (const [k, v] of Object.entries(info.headers)) {
          if (typeof v === 'string' && !/^(host|content-length|connection|range)$/i.test(k)) headers[k] = v
        }
      }
      if (req.headers.range) headers.Range = req.headers.range
      const upstream = await fetch(info.url, { headers, redirect: 'follow' })
      if (!upstream.ok && upstream.status !== 206) {
        logLine('[online] 上游失败', upstream.status, info.url.slice(0, 70))
        res.writeHead(502).end('upstream ' + upstream.status)
        return
      }
      const out = {
        'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'content-length, content-range, accept-ranges',
        'Cache-Control': 'no-store'
      }
      for (const k of ['content-length', 'content-range']) {
        const v = upstream.headers.get(k)
        if (v) out[k.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase())] = v
      }
      // 只有「从头整段请求」才顺手存缓存；用户拖进度条发来的 Range 请求
      // 存下来的是一段残片，反而会把缓存搞脏。
      const rangeHdr = String(req.headers.range || '').trim()
      const canCache = cacheOn && (!rangeHdr || /^bytes=0-$/.test(rangeHdr))
      const cKey = cacheKeyOf(song, cacheClassOf(info))
      let partPath = null
      let partStream = null
      let partBytes = 0
      if (canCache) {
        try {
          fs.mkdirSync(cacheDirPath(), { recursive: true })
          // 每个请求用自己的临时文件名：同一首歌可能被连点两次，
          // 共用一个 .part 的话，先结束的那个会把后一个正在写的文件删掉。
          const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
          partPath = path.join(cacheDirPath(), `${cKey}.${uniq}.part`)
          partStream = fs.createWriteStream(partPath)
          partStream.on('error', () => { partStream = null })
        } catch (err) {
          partPath = null
          partStream = null
        }
      }
      const dropPart = () => {
        const ps = partStream
        const p = partPath
        partStream = null
        partPath = null
        if (!p) return
        // Windows 上不能删一个还开着的文件，得等流真正关了再删
        const del = () => { try { fs.unlinkSync(p) } catch (e) { /* 忽略 */ } }
        if (!ps) { del(); return }
        try {
          ps.once('close', del)
          ps.destroy()
        } catch (e) {
          del()
        }
      }
      // 收尾：字节数和预期一致才算缓存成功，半截的直接丢
      const finishCache = () => {
        if (!partStream || !partPath) return
        const expect = Number(out['Content-Length']) || 0
        const target = partPath
        const key = cKey
        const meta = { title: info.song ? info.song.title : song.title, artist: info.song ? info.song.artist : song.artist, ext: info.ext }
        const stream = partStream
        partStream = null
        partPath = null
        stream.end(() => {
          if (!expect || partBytes !== expect) {
            try { fs.unlinkSync(target) } catch (e) { /* 忽略 */ }
            return
          }
          const file = `${key}.${meta.ext || 'mp3'}`
          try {
            const target2 = path.join(cacheDirPath(), file)
            // 另一个并发请求可能已经先写完了，那就用它的
            if (fs.existsSync(target2)) {
              try { fs.unlinkSync(target) } catch (e) { /* 忽略 */ }
              return
            }
            fs.renameSync(target, target2)
            cachePut(key, file, meta, partBytes)
            logLine('[cache] 缓存完成', file, (partBytes / 1048576).toFixed(1) + 'MB')
          } catch (e) {
            try { fs.unlinkSync(target) } catch (e2) { /* 忽略 */ }
          }
        })
      }
      res.writeHead(upstream.status === 206 ? 206 : 200, out)
      // 告诉界面「这首实际是什么音质」——界面拿到的是解析时那一刻的结论，
      // 而真正取流发生在这里，两边可能不一致（第一次解析失败、重试成功之类）。
      sendToRenderer('online:now-playing', {
        id: `${source}:${id}`,
        song: info.song ? { title: info.song.title, artist: info.song.artist } : null,
        lossless: !!info.lossless,
        bitrate: info.bitrate || 0,
        ext: info.ext || 'mp3',
        cached: false
      })
      const reader = upstream.body.getReader()
      // 客户端一断开（切歌、拖进度条）就把上游和写盘一起收掉。
      // 只等 'drain' 是不够的：连接没了就没有 drain，这个请求会永远悬着。
      let aborted = false
      const onClose = () => {
        if (res.writableFinished) return
        aborted = true
        try { reader.cancel() } catch (e) { /* 已结束 */ }
        dropPart()
      }
      res.on('close', onClose)
      const waitDrain = (emitter) => new Promise((r) => {
        let done = false
        const go = () => {
          if (done) return
          done = true
          emitter.off('drain', go)
          emitter.off('close', go)
          r()
        }
        emitter.once('drain', go)
        emitter.once('close', go)
        setTimeout(go, 3000) // 宁可丢掉缓存，也不能卡住播放
      })
      let complete = false
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (aborted) break
          const buf = Buffer.from(value)
          const ps = partStream
          if (ps) {
            partBytes += buf.length
            // 磁盘跟不上就先等写盘，否则 100MB 的 flac 会在内存里堆起来
            if (!ps.write(buf)) await waitDrain(ps)
          }
          if (!res.write(buf)) await waitDrain(res)
        }
        complete = !aborted
      } catch (err) {
        complete = false
      } finally {
        res.off('close', onClose)
        // 正常读完才落缓存；中途断开就把残片丢掉
        if (complete) finishCache()
        else dropPart()
      }
      try { res.end() } catch (e) { /* 已断开 */ }
    } catch (err) {
      logLine('[online] 代理异常', err.message)
      try { res.writeHead(500).end('proxy error') } catch (e) { /* 已断开 */ }
    }
  })
  streamServer.on('error', (err) => logLine('[online] 代理服务错误', err.message))
  streamServer.listen(0, '127.0.0.1', () => {
    const port = streamServer.address().port
    streamBase = `http://127.0.0.1:${port}`
    logLine('[online] 代理就绪', streamBase)
    readyResolve(streamBase)
  })
  return streamBase
}

function toLxUrl(filePath) {  if (!filePath) return null
  const norm = path.resolve(filePath).replace(/\\/g, '/')
  // 固定用 local 当 host，完整路径（含盘符）放在 path 里：
  // 若把盘符塞进 authority（lxfile:///D:/…），Chromium 会把它规范成 host，盘符就丢了。
  const body = norm.split('/').map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/')
  return 'lxfile://local/' + body.replace(/^\/+/, '')
}

/* ---------------- 默认配置 ---------------- */

const DEFAULT_SETTINGS = {
  musicDirs: [DEFAULT_MUSIC_DIR],
  volume: 0.8,
  muted: false,
  playMode: 'list', // list | single | shuffle | order
  fadeMs: 350,
  lyricFontSize: 20,
  lyricOffset: 0,
  lyricOffsetById: {},         // 每曲歌词偏移（v1.7）：{ trackId: 秒 }，优先于 lyricOffset
  theme: 'dark',
  accent: '#31c27c',
  showLyricPanel: true,
  autoScanOnStart: false,
  watchFolders: true,          // 监视音乐文件夹变化并自动增量扫描（v1.7）
  closeToTray: false,
  closeAsk: true,              // v2.4：点 × 时弹窗询问（最小化到托盘 / 直接退出），勾「不再提示」后关闭
  // 音量均衡
  normalizeVolume: false,
  targetLufs: -16,
  trackGains: {},   // { trackId: dB } 响度分析自动计算
  manualGains: {},  // { trackId: dB } 用户手动指定（优先于自动）
  // 桌面歌词
  desktopLyric: { enabled: false, locked: false, fontSize: 34, color: '#ffffff', colorIdx: 0, bounds: null },
  // 均衡器（10 段：31/62/125/250/500/1k/2k/4k/8k/16k）
  eq: { enabled: false, preset: 'flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  // 迷你模式：enabled=当前是否迷你；bounds=迷你窗口尺寸位置；fullBounds=进迷你前的完整窗口
  mini: { enabled: false, bounds: null, fullBounds: null },
  // 独占输出（v1.5）：真实 bit-perfect 走 mpv + WASAPI 独占；关闭时用原本的 HTML5/WebAudio 链路
  exclusiveOutput: false,      // 独占输出（v1.5）：true 时用 mpv + WASAPI exclusive
  audioDevice: '',             // 独占输出设备（v1.6）：mpv 的 --audio-device，'' = 系统默认
  powerAfterQueue: 'off',      // v2.1：整队播完后 off|shutdown|hibernate|quit
  resumePos: {},               // 长音轨断点位置（v1.6）：{ trackId: 秒 }
  // 联网版（v3.0）：在线音乐
  onlineDownloadDir: '',       // 下载目录，'' = 默认「音乐\猪专属下载」
  onlineSources: ['kw', 'qq', 'kg', 'wy'],  // 参与搜索的音源（顺序即合并优先级）
  onlineQuality: 'lossless',   // master（母带，最大）| lossless | best | 128k
  onlineQualityMigrated: false,// v3.1 一次性迁移标记（老版本默认 best → lossless）
  onlineQingOn: true,          // v3.2：青听网关（四家通吃、含母带）；关掉就只走 GDStudio
  onlineCacheOn: true,         // 播放时顺手把音频缓存到本地
  onlineCacheDir: '',          // 缓存目录，'' = 数据目录\music-cache
  onlineCacheLimitMB: 4096,    // 缓存上限（MB），0 = 不限；超了按最久没放的删
  onlineChkszKey: ''           // 可选：ChKSz API 的 apikey，填了就能给 QQ/酷狗 的歌拿无损
}

// 迷你卡片默认尺寸 / 尺寸下限
const MINI_DEFAULT_W = 320
const MINI_DEFAULT_H = 420
const MINI_MIN_W = 300
const MINI_MIN_H = 360
const FULL_MIN_W = 1000
const FULL_MIN_H = 640

/* ---------------- 窗口 ---------------- */

/** 当前是否处于迷你模式（唯一真理，渲染层靠事件同步） */
let miniActive = false

function miniCfg() {
  const s = store && store.get().settings
  return (s && s.mini) || {}
}

/** 把尺寸/位置夹到屏幕工作区内，避免换分辨率后窗口跑到看不见的地方 */
function clampToWorkArea(b) {
  const width = Math.max(200, Math.round(b.width || MINI_DEFAULT_W))
  const height = Math.max(200, Math.round(b.height || MINI_DEFAULT_H))
  let area = null
  try {
    const x = Number.isFinite(b.x) ? b.x : 0
    const y = Number.isFinite(b.y) ? b.y : 0
    area = screen.getDisplayMatching({ x, y, width, height }).workArea
  } catch { /* screen 不可用时直接返回原值 */ }
  if (!area) return { ...b, width, height }
  const w = Math.min(width, area.width)
  const h = Math.min(height, area.height)
  const x = Math.min(Math.max(Number.isFinite(b.x) ? b.x : area.x + area.width - w - 24, area.x), area.x + area.width - w)
  const y = Math.min(Math.max(Number.isFinite(b.y) ? b.y : area.y + 80, area.y), area.y + area.height - h)
  return { x, y, width: w, height: h }
}

/** 等一次窗口事件（带超时兜底），用于 unmaximize 这类异步状态切换 */
function waitWindowEvent(win, ev, timeout = 500) {
  return new Promise((resolve) => {
    let done = false
    const fin = () => {
      if (done) return
      done = true
      try { win.removeListener(ev, fin) } catch {}
      resolve()
    }
    win.once(ev, fin)
    setTimeout(fin, timeout)
  })
}

/**
 * 切换迷你模式：同一个窗口缩放，不做第二个窗口（播放状态天然连续）。
 * 进迷你前把完整窗口的尺寸位置存进 settings.mini.fullBounds，退出时原样还原。
 */
async function applyMini(on) {
  if (!win || win.isDestroyed()) return miniActive
  on = !!on
  if (on === miniActive) return miniActive
  const cfg = miniCfg()

  if (on) {
    // 记下"进迷你前是不是最大化"，回来时要还原成同样的形态
    const wasMax = win.isMaximized()
    if (wasMax) {
      win.unmaximize()
      // Windows 上 unmaximize 是异步的，不等它落地就 setBounds 会被忽略（实测尺寸纹丝不动）
      await waitWindowEvent(win, 'unmaximize')
    }
    const prev = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    // 只有"像完整窗口"的尺寸才写进 fullBounds：万一 prev 本身是卡片尺寸
    // （例如启动时就在迷你态、或外部调用顺序异常），存进去会让退出迷你时还原成小窗
    const prevUsable = Number.isFinite(prev.width) && Number.isFinite(prev.height) &&
      prev.width >= FULL_MIN_W && prev.height >= FULL_MIN_H
    store.patch({
      settings: {
        mini: {
          enabled: true,
          fullBounds: prevUsable ? { ...prev, maximized: wasMax } : cfg.fullBounds || null,
          bounds: cfg.bounds || { width: MINI_DEFAULT_W, height: MINI_DEFAULT_H, x: prev.x, y: prev.y }
        }
      }
    })
    // 必须先放开最小尺寸，否则 setBounds 会被 1000×640 卡住
    win.setMinimumSize(MINI_MIN_W, MINI_MIN_H)
    win.setMaximizable(false)
    const b = cfg.bounds && Number.isFinite(cfg.bounds.width) ? cfg.bounds : { width: MINI_DEFAULT_W, height: MINI_DEFAULT_H }
    win.setBounds(clampToWorkArea({
      width: Math.max(MINI_MIN_W, b.width),
      height: Math.max(MINI_MIN_H, b.height),
      x: Number.isFinite(b.x) ? b.x : prev.x,
      y: Number.isFinite(b.y) ? b.y : prev.y
    }))
    miniActive = true
  } else {
    const fb = cfg.fullBounds || {}
    // fullBounds 可能是脏数据（早期版本在迷你态里存过卡片尺寸）→ 不可信就回到默认大小
    const usable = Number.isFinite(fb.width) && Number.isFinite(fb.height) &&
      fb.width >= FULL_MIN_W && fb.height >= FULL_MIN_H
    win.setMinimumSize(FULL_MIN_W, FULL_MIN_H)
    win.setMaximizable(true)
    win.setBounds(clampToWorkArea({
      width: usable ? fb.width : 1280,
      height: usable ? fb.height : 800,
      x: usable ? fb.x : undefined,
      y: usable ? fb.y : undefined
    }))
    if (fb.maximized) win.maximize()
    miniActive = false
    store.patch({ settings: { mini: { enabled: false } } })
  }

  refreshTrayMenu()
  sendToRenderer('win:mini-state', { mini: miniActive })
  return miniActive
}

function createWindow() {
  const bounds = store.get().window || {}
  const mc = miniCfg()
  miniActive = !!(mc && mc.enabled)
  const mb = (mc && mc.bounds) || {}

  const width = miniActive ? Math.max(MINI_MIN_W, mb.width || MINI_DEFAULT_W) : (bounds.width || 1280)
  const height = miniActive ? Math.max(MINI_MIN_H, mb.height || MINI_DEFAULT_H) : (bounds.height || 800)
  const x = miniActive ? (Number.isFinite(mb.x) ? mb.x : bounds.x) : bounds.x
  const y = miniActive ? (Number.isFinite(mb.y) ? mb.y : bounds.y) : bounds.y

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: miniActive ? MINI_MIN_W : FULL_MIN_W,
    minHeight: miniActive ? MINI_MIN_H : FULL_MIN_H,
    maximizable: !miniActive,
    show: false,
    frame: false,
    backgroundColor: '#0f1115',
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  win.once('ready-to-show', () => {
    if (bounds.maximized && !miniActive) win.maximize()
    win.show()
  })

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    // 迷你模式只记迷你尺寸，别把 320×420 写进完整窗口的位置里
    if (miniActive) {
      store.patch({ settings: { mini: { bounds: b } } })
    } else {
      store.patch({ window: { ...b, maximized: win.isMaximized() } })
    }
  }
  win.on('resize', debounce(saveBounds, 400))
  win.on('move', debounce(saveBounds, 400))

  win.on('close', (e) => {
    if (!quitting) {
      const st = store.get().settings
      // v2.4：默认每次点 × 都问一次（最小化到托盘 / 直接退出），勾了「不再提示」后按记住的选择执行
      if (st.closeAsk) {
        e.preventDefault()
        handleCloseAsk()
        return
      }
      if (st.closeToTray) {
        e.preventDefault()
        win.hide()
        return
      }
    }
    saveBounds()
    // 主窗口真要关掉 → 桌面歌词一起收（否则只剩一个歌词窗悬空，进程也不会退出）。
    // 这里的 quitting 只用来阻止歌词窗口把 enabled 改成 false，下次启动仍能恢复。
    quitting = true
    closeLyricWindow()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  // 任务栏悬停时的那排媒体按钮（初始为"播放"态）
  updateThumbar(false)
}

function debounce(fn, ms) {
  let t = null
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

/* ---------------- 托盘 ---------------- */

/** 托盘菜单重建（迷你开关的勾选态会变，不能只建一次） */
/* ---------------- 睡眠定时（v1.7 托盘入口，v2.2 移到 app 内播放条） ---------------- */

let sleepTimerId = null
let sleepMinutes = 0
let sleepEndsAt = 0   // 到点时刻的 Date.now()，渲染层用它显示倒计时

/** 广播当前定时状态给渲染层（minutes=0 表示无定时） */
function pushSleepState() {
  sendToRenderer('sleep-state', { minutes: sleepMinutes, endsAt: sleepEndsAt || null })
}

/** minutes=0 表示关闭。到点只做一件事：让渲染层淡出并暂停。 */
function setSleepTimer(minutes) {
  if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null }
  sleepMinutes = Number(minutes) || 0
  sleepEndsAt = 0
  if (sleepMinutes > 0) {
    logLine('[sleep] 定时 ' + sleepMinutes + ' 分钟')
    sleepEndsAt = Date.now() + sleepMinutes * 60 * 1000
    sleepTimerId = setTimeout(() => {
      sleepTimerId = null
      sleepMinutes = 0
      sleepEndsAt = 0
      sendToRenderer('sleep-timer', { fired: true })
      pushSleepState()
    }, sleepMinutes * 60 * 1000)
  } else {
    logLine('[sleep] 已关闭')
  }
  pushSleepState()
}

/* ---------------- 播放结束后动作（v2.1） ---------------- */

const POWER_LABEL = { off: '不处理', shutdown: '关机', hibernate: '休眠', quit: '关闭播放器' }
/** 'off' | 'shutdown' | 'hibernate' | 'quit' */
let powerAfterQueue = 'off'

function setPowerAfterQueue(kind) {
  powerAfterQueue = POWER_LABEL[kind] ? kind : 'off'
  logLine('[power] 播放结束后：' + powerAfterQueue)
  store.patch({ settings: { powerAfterQueue } })
  refreshTrayMenu()
  sendToRenderer('power-after-queue', powerAfterQueue)
}

/**
 * 队列播完（渲染层上报）。只在真的"外面还有歌"时才动手：
 * 循环模式列表回卷也算一次播完，用户要的就是那个时刻关机。
 */
function runPowerAction() {
  if (powerAfterQueue === 'off') return
  const kind = powerAfterQueue
  powerAfterQueue = 'off'
  store.patch({ settings: { powerAfterQueue: 'off' } })
  refreshTrayMenu()
  sendToRenderer('power-after-queue', 'off')
  sendToRenderer('power-action', { kind, delay: 15 })
  logLine('[power] 队列结束，执行 ' + kind + '（15 秒内可在托盘取消）')

  // 给用户 15 秒反悔时间：误触关机比少关一次机难受得多
  powerPending = setTimeout(() => {
    powerPending = null
    if (kind === 'quit') { quitting = true; app.quit(); return }
    try {
      if (kind === 'shutdown') execFile('shutdown', ['/s', '/t', '30'])
      else if (kind === 'hibernate') execFile('shutdown', ['/h'])
    } catch (err) {
      logLine('[power] 执行失败 ' + err.message)
    }
  }, 15000)
}

let powerPending = null
function cancelPowerAction() {
  if (!powerPending) return false
  clearTimeout(powerPending)
  powerPending = null
  try { execFile('shutdown', ['/a']) } catch {}
  logLine('[power] 已取消')
  sendToRenderer('power-action', { kind: null })
  return true
}

/**
 * v2.4：点 × 弹窗问「最小化到托盘还是直接退出」。
 * 勾选「不再提示」后记住这次的选择（可在托盘菜单改回来）；
 * 不勾则只对本次生效，设置不变。弹窗失败时退回旧行为（按 closeToTray 设置执行）。
 */
async function handleCloseAsk() {
  try {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: '关闭播放器',
      message: '点击 × 时想做什么？',
      detail: '勾选「不再提示」后将按这次的选择执行，之后可在托盘菜单里改回来。',
      buttons: ['最小化到托盘', '直接退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '不再提示',
      checkboxChecked: false,
      noLink: true
    })
    if (r.response === 2) return
    const toTray = r.response === 0
    if (r.checkboxChecked) {
      store.patch({ settings: { closeToTray: toTray, closeAsk: false } })
      refreshTrayMenu()
      logLine('[close] 记住选择：' + (toTray ? '最小化到托盘' : '直接退出') + '（不再提示）')
    } else {
      logLine('[close] 本次：' + (toTray ? '最小化到托盘' : '直接退出'))
    }
    if (toTray) { win.hide(); return }
    quitting = true
    win.close()
  } catch (err) {
    logLine('[close] 询问弹窗失败 ' + err.message + '，按托盘设置执行')
    if (store.get().settings.closeToTray) win.hide()
    else { quitting = true; win.close() }
  }
}

function refreshTrayMenu() {
  if (!tray) return
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus() } } },
      {
        label: '迷你模式',
        type: 'checkbox',
        checked: miniActive,
        click: () => applyMini(!miniActive)
      },
      { label: '桌面歌词', click: () => sendToRenderer('shortcut', 'dlyric') },
      {
        // v2.1：整队播完之后做什么。和「睡眠定时」是两件事——那个是到点暂停，这个看进度
        label: '播放结束后' + (POWER_LABEL[powerAfterQueue] ? '（' + POWER_LABEL[powerAfterQueue] + '）' : ''),
        submenu: ['off', 'shutdown', 'hibernate', 'quit'].map((k) => ({
          label: POWER_LABEL[k],
          type: 'radio',
          checked: powerAfterQueue === k,
          click: () => setPowerAfterQueue(k)
        }))
      },
      {
        label: '关闭时询问（点 × 弹窗选择）',
        type: 'checkbox',
        checked: store.get().settings.closeAsk !== false,
        click: (item) => store.patch({ settings: { closeAsk: item.checked } })
      },
      {
        label: '关闭时最小化到托盘',
        type: 'checkbox',
        checked: store.get().settings.closeToTray === true,
        click: (item) => store.patch({ settings: { closeToTray: item.checked } })
      },
      { type: 'separator' },
      ...(powerPending ? [{ label: '⚠ 取消关机 / 休眠', click: () => cancelPowerAction() }] : []),
      { label: '退出', click: () => { quitting = true; app.quit() } }
    ]))
  } catch (err) {
    console.error('[tray] 菜单更新失败:', err.message)
  }
}

/**
 * 任务栏缩略图工具栏（悬停任务栏图标时出现的那排媒体按钮）。
 * Electron 没有暴露 Windows SMTC 接口，这是纯 JS 能做到的最接近的一层。
 * 图标是 make-thumbar-icons.py 生成的 16x16 单色 PNG。
 */
let thumbarPlaying = false
function updateThumbar(playing) {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return
  thumbarPlaying = !!playing
  const dir = path.join(__dirname, '..', 'assets')
  const ic = (name) => nativeImage.createFromPath(path.join(dir, name))
  try {
    win.setThumbarButtons([
      {
        tooltip: '上一首',
        icon: ic('thumb-prev.png'),
        click: () => sendToRenderer('shortcut', 'prev')
      },
      {
        tooltip: thumbarPlaying ? '暂停' : '播放',
        icon: ic(thumbarPlaying ? 'thumb-pause.png' : 'thumb-play.png'),
        click: () => sendToRenderer('shortcut', 'play-pause')
      },
      {
        tooltip: '下一首',
        icon: ic('thumb-next.png'),
        click: () => sendToRenderer('shortcut', 'next')
      }
    ])
  } catch (err) {
    logLine('WARN thumbar 设置失败', err.message)
  }
}

/* ---------------- 音乐文件夹监视（v1.7） ---------------- */

/** 只关心这些扩展名：音源、歌词、同级封面。其他文件变动忽略，避免无意义的重扫。 */
const WATCH_EXTS = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.ape', '.wma',
  '.aiff', '.aif', '.dsf', '.dff', '.mka', '.lrc', '.jpg', '.jpeg', '.png', '.webp', '.bmp'
])
let watchers = []
let watchTimer = null

function stopWatching() {
  for (const w of watchers) { try { w.close() } catch {} }
  watchers = []
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
}

/**
 * 监听音乐目录（递归）。Windows 支持 recursive，大目录也没问题。
 * 变化后等 8 秒再扫：拷一张专辑会触发几十个事件，防抖能合成一次
 * （增量扫描本来只解析变了的文件，所以这一次很便宜）。
 */
function startWatching() {
  stopWatching()
  const s = store.get().settings
  if (s.watchFolders === false) { logLine('[watch] 已关闭'); return }
  const dirs = Array.isArray(s.musicDirs) ? s.musicDirs.filter(Boolean) : []
  for (const dir of dirs) {
    try {
      const w = fs.watch(dir, { recursive: true }, (evt, filename) => {
        if (!filename) return
        if (!WATCH_EXTS.has(path.extname(String(filename)).toLowerCase())) return
        scheduleWatchScan()
      })
      w.on('error', (err) => logLine('WARN watch 错误', dir, err.message))
      watchers.push(w)
    } catch (err) {
      logLine('WARN watch 启动失败（目录不存在或无权限）', dir, err.message)
    }
  }
  logLine('[watch] 监视 ' + watchers.length + ' 个目录')
}

function scheduleWatchScan() {
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = setTimeout(runWatchScan, 8000)
}

async function runWatchScan() {
  watchTimer = null
  if (library.scanning || activeScan) {
    // 正在扫（可能用户手动点了），等它结束再来
    scheduleWatchScan()
    return
  }
  const s = store.get().settings
  if (s.watchFolders === false) return
  logLine('[watch] 检测到文件变化，开始增量扫描')
  try {
    const run = library.scan(s.musicDirs, (p) => {
      sendToRenderer('lib:scan-progress', {
        phase: p.phase, done: p.done, total: p.total,
        track: p.track ? toClientTrack(p.track) : null
      })
    })
    activeScan = run
    const res = await run
    logLine('[watch] 完成 ' + JSON.stringify({
      added: res.added, updated: res.updated, removed: res.removed, total: res.total, failed: res.failed
    }))
    sendToRenderer('lib:scan-done', res)
  } catch (err) {
    logLine('[watch] 扫描失败 ' + err.message)
  } finally {
    activeScan = null
  }
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray.png')
    let img = nativeImage.createFromPath(iconPath)
    if (img.isEmpty()) {
      img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'))
    }
    if (img.isEmpty()) return
    tray = new Tray(img.resize({ width: 16, height: 16 }))
    tray.setToolTip(APP_NAME)
    refreshTrayMenu()
    tray.on('click', () => {
      if (!win) return
      if (win.isVisible()) win.hide()
      else { win.show(); win.focus() }
    })
  } catch (err) {
    console.error('[tray] 创建失败:', err.message)
  }
}

/* ---------------- 全局快捷键 ---------------- */

const SHORTCUTS = {
  'MediaPlayPause': 'play-pause',
  'MediaNextTrack': 'next',
  'MediaPreviousTrack': 'prev',
  'MediaStop': 'stop',
  'CommandOrControl+Alt+Space': 'play-pause',
  'CommandOrControl+Alt+Right': 'next',
  'CommandOrControl+Alt+Left': 'prev',
  'CommandOrControl+Alt+Up': 'volume-up',
  'CommandOrControl+Alt+Down': 'volume-down',
  'CommandOrControl+Alt+D': 'dlyric',
  'CommandOrControl+Alt+M': 'mini-toggle'
}

function registerShortcuts() {
  const failed = []
  for (const [accel, action] of Object.entries(SHORTCUTS)) {
    try {
      const ok = globalShortcut.register(accel, () => sendToRenderer('shortcut', action))
      if (!ok) failed.push(accel)
    } catch {
      failed.push(accel)
    }
  }
  return failed
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/* ---------------- 桌面歌词浮窗 ---------------- */

let dlyricWin = null
/**
 * 最近一次推给歌词窗口的内容。
 * 歌词窗口是异步加载的，刚打开时那次推送必然早于页面就绪（webContents.send 会静默丢弃），
 * 渲染层又按内容去重、不会重发 → 表现为「打开后不显示歌词，暂停一下才出来」。
 * 所以主进程必须缓存一份，在页面就绪时补发。
 */
let lastDlyricData = null

function dlyricCfg() {
  return store.get().settings.desktopLyric || {}
}

function sendToDlyric(channel, payload) {
  if (dlyricWin && !dlyricWin.isDestroyed()) {
    dlyricWin.webContents.send(channel, payload)
  }
}

/** 歌词窗口就绪/重载后补发：配置 + 当前歌词行 */
function replayDlyricState() {
  sendToDlyric('dlyric:cfg', dlyricCfg())
  if (lastDlyricData) sendToDlyric('dlyric:data', lastDlyricData)
}

/** 锁定 = 鼠标穿透；同时把最新配置推给歌词窗口 */
function applyDlyricLock() {
  const cfg = dlyricCfg()
  if (dlyricWin && !dlyricWin.isDestroyed()) {
    dlyricWin.setIgnoreMouseEvents(!!cfg.locked)
    sendToDlyric('dlyric:cfg', cfg)
  }
}

/** 把 开/关 + 锁定 状态同步给主窗口（按钮图标/提示、点击语义都依赖它） */
function notifyDlyricState() {
  const cfg = dlyricCfg()
  sendToRenderer('dlyric:open-state', {
    open: !!(dlyricWin && !dlyricWin.isDestroyed()),
    locked: !!cfg.locked
  })
}

function createLyricWindow() {
  if (dlyricWin && !dlyricWin.isDestroyed()) return dlyricWin
  const cfg = dlyricCfg()
  const b = cfg.bounds || {}
  dlyricWin = new BrowserWindow({
    width: b.width || 900,
    height: b.height || 120,
    x: Number.isFinite(b.x) ? b.x : undefined,
    y: Number.isFinite(b.y) ? b.y : undefined,
    minWidth: 300,
    minHeight: 70,
    transparent: true,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: '桌面歌词',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  // screen-saver 层级：压在普通置顶窗口之上
  dlyricWin.setAlwaysOnTop(true, 'screen-saver')
  dlyricWin.loadFile(path.join(__dirname, '..', 'renderer', 'dlyric.html'))

  dlyricWin.once('ready-to-show', () => {
    dlyricWin.show()
    applyDlyricLock()
  })

  // 页面加载完就补发一次（dlyric:ready 的兜底，重载/刷新时同样能立刻出词）
  dlyricWin.webContents.on('did-finish-load', () => replayDlyricState())

  // 位置/尺寸持久化（去抖）
  const saveBounds = debounce(() => {
    if (!dlyricWin || dlyricWin.isDestroyed()) return
    const nb = dlyricWin.getNormalBounds ? dlyricWin.getNormalBounds() : dlyricWin.getBounds()
    store.patch({ settings: { desktopLyric: { bounds: nb } } })
  }, 400)
  dlyricWin.on('resize', saveBounds)
  dlyricWin.on('move', saveBounds)

  // 歌词窗口自行关闭（控制条 ✕ 或系统方式）→ 通知主窗口同步按钮状态。
  // 注意退出App时也会触发 closed，用 quitting 区分，避免把 enabled 改没。
  dlyricWin.on('closed', () => {
    dlyricWin = null
    if (!quitting) {
      store.patch({ settings: { desktopLyric: { enabled: false } } })
      notifyDlyricState()
    }
  })

  return dlyricWin
}

function closeLyricWindow() {
  if (dlyricWin && !dlyricWin.isDestroyed()) dlyricWin.close()
  else if (dlyricWin) dlyricWin = null
}

/* ---------------- 独占输出（mpv + WASAPI exclusive） ---------------- */

let mpvEngine = null

/**
 * mpv 诊断日志环形缓冲（v1.8）。
 * 渲染层收到 mpv:event 时只关心"要不要更新界面"，排查问题需要的上下文
 * （启动参数、audio-out-params、回退共享、引擎退出码）散在各处，面板统一从这里取。
 * 只收低频、有信息量的事件：time/volume/pause 这类 1~2Hz 的不要，会瞬间冲满。
 */
const MPV_LOG_MAX = 800
const mpvLogs = []
let mpvLogSeq = 0
function pushMpvLog(level, text) {
  const s = String(text == null ? '' : text)
  if (!s) return
  mpvLogs.push({ seq: ++mpvLogSeq, at: Date.now(), level: level || 'info', text: s.slice(0, 2000) })
  if (mpvLogs.length > MPV_LOG_MAX) mpvLogs.splice(0, mpvLogs.length - MPV_LOG_MAX)
}

/**
 * 引擎路径查找顺序：LX_MPV 环境变量（调试） → exe 同级 engine\mpv.exe（成品）
 * → 项目根 engine\mpv.exe（开发）。
 */
function mpvExePath() {
  const candidates = []
  if (process.env.LX_MPV) candidates.push(process.env.LX_MPV)
  candidates.push(
    app.isPackaged
      ? path.join(path.dirname(process.execPath), 'engine', 'mpv.exe')
      : path.join(__dirname, '..', '..', 'engine', 'mpv.exe')
  )
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p } catch {}
  }
  return candidates[candidates.length - 1]
}

function onMpvEvent(evt) {
  // 独占打不开（设备不支持该格式/被别的程序独占）→ 自动回退共享一次并告知界面
  if (evt.type === 'file-error' && mpvEngine && mpvEngine.exclusive && !mpvEngine.fellBack) {
    mpvEngine.fellBack = true
    logLine('[mpv] 独占输出失败，回退共享：' + (evt.message || ''))
    pushMpvLog('warn', '独占输出失败，回退共享：' + (evt.message || ''))
    mpvEngine.restart({ exclusive: false }).then((r) => {
      pushMpvLog(r.ok ? 'warn' : 'error', r.ok ? '已重启引擎为共享输出' : '回退共享也失败：' + (r.error || ''))
      sendToRenderer('mpv:event', r.ok
        ? { type: 'fallback', message: (evt.message || '') }
        : { type: 'error', message: r.error || '独占失败且回退共享也失败' })
    })
    return
  }
  // 输出参数是"是否位完美"的第一手证据，落日志便于事后核对
  if (evt.type === 'format') {
    logLine('[mpv] audio-out-params=' + JSON.stringify(evt.params))
    pushMpvLog('info', 'audio-out-params=' + JSON.stringify(evt.params))
  }
  if (evt.type === 'file-error') {
    logLine('[mpv] file-error: ' + (evt.message || ''))
    pushMpvLog('error', 'file-error: ' + (evt.message || ''))
  }
  if (evt.type === 'log' && (evt.level === 'error' || evt.level === 'fatal')) {
    logLine('[mpv][log] ' + evt.text)
    pushMpvLog(evt.level === 'fatal' ? 'error' : 'warn', '[' + evt.level + '] ' + evt.text)
  }
  if (evt.type === 'engine-exit') {
    pushMpvLog('error', '引擎退出 code=' + evt.code + (evt.stderr ? ' stderr=' + evt.stderr : ''))
  }
  if (evt.type === 'error') pushMpvLog('error', evt.message || '引擎错误')
  if (evt.type === 'loaded') pushMpvLog('info', 'file-loaded')
  sendToRenderer('mpv:event', evt)
}

async function ensureMpv(exclusive) {
  if (!mpvEngine) {
    mpvEngine = new MpvEngine({ exePath: mpvExePath(), onEvent: onMpvEvent })
  }
  if (mpvEngine.running) return { ok: true, exclusive: mpvEngine.exclusive }
  const wantExclusive = exclusive !== false
  // 输出设备来自设置；空字符串 = 跟随系统默认
  const audioDevice = String(store.get().settings.audioDevice || '').trim()
  // v2.5：启动音量跟随设置（以前 mpv 固定 --volume=100，重启引擎音量就被重置）
  const startVolume = Math.max(0, Math.min(1, Number(store.get().settings.volume ?? 1)))
  pushMpvLog('info', '启动引擎：exclusive=' + wantExclusive + ' device=' + (audioDevice || '(系统默认)') + ' volume=' + Math.round(startVolume * 1000) / 10)
  const r = await mpvEngine.start({ exclusive: wantExclusive, audioDevice, volume: startVolume })
  logLine('[mpv] start exclusive=' + wantExclusive + ' ' + JSON.stringify(r) + ' exe=' + mpvExePath())
  pushMpvLog(r.ok ? 'info' : 'error',
    '启动结果：' + (r.ok ? 'ok' : '失败 ' + (r.error || '')) + ' exe=' + mpvExePath())
  // 独占流跑起来之后才开始盯设备（共享模式下 mpv 自己会跟系统默认设备走）
  if (r.ok && wantExclusive) startDeviceWatch()
  return r
}

function stopMpv() {
  if (mpvEngine) {
    pushMpvLog('info', '关闭引擎')
    mpvEngine.kill()
    mpvEngine = null
  }
  stopDeviceWatch()
}

/* ---------------- 输出设备热插拔（v2.1） ---------------- */

/**
 * 独占模式最典型的翻车场景：接 USB DAC 听歌，人走开把线拔了 —— mpv 的独占流会直接失效，
 * 但界面什么都不会说，用户只会觉得"播放器卡住了/没声音"。
 * 这里每 8 秒对一次 WASAPI 设备列表：选定的设备消失就自动退回系统默认并告知界面；
 * 设备插回来后自动切回去（只在同一次运行里记着，重启不猜）。
 */
let deviceWatchId = null
let lostDevice = ''

function startDeviceWatch() {
  if (deviceWatchId || process.platform !== 'win32') return
  deviceWatchId = setInterval(async () => {
    if (!mpvEngine || !mpvEngine.running || !store.get().settings.exclusiveOutput) return
    const cur = String(store.get().settings.audioDevice || '')
    let devs
    try {
      devs = await mpvEngine.listDevices()
    } catch {
      return
    }
    const names = new Set(devs.map((d) => d.name))
    if (cur && !names.has(cur)) {
      lostDevice = cur
      pushMpvLog('error', '输出设备已断开：' + cur + ' → 自动切回系统默认')
      logLine('[device] 设备断开，回退系统默认：' + cur)
      store.patch({ settings: { audioDevice: '' } })
      sendToRenderer('device-lost', { device: cur, restored: false })
      try { await mpvEngine.restart({ exclusive: true, audioDevice: '' }) } catch {}
      return
    }
    if (!cur && lostDevice && names.has(lostDevice)) {
      const back = lostDevice
      lostDevice = ''
      pushMpvLog('info', '输出设备已接回：' + back + ' → 自动切回')
      logLine('[device] 设备接回，自动切回：' + back)
      store.patch({ settings: { audioDevice: back } })
      sendToRenderer('device-lost', { device: back, restored: true })
      try { await mpvEngine.restart({ exclusive: true, audioDevice: back }) } catch {}
    }
  }, 8000)
  if (deviceWatchId.unref) deviceWatchId.unref()
  logLine('[device] 开始监视输出设备（8s 一次）')
}

function stopDeviceWatch() {
  if (deviceWatchId) { clearInterval(deviceWatchId); deviceWatchId = null }
  lostDevice = ''
}

/* ---------------- IPC ---------------- */

/* ---------------- 联网版：下载目录 / 进行中的下载 ---------------- */

/** 下载目录：用户设置优先，否则「我的音乐\猪专属下载」 */
function downloadDir() {
  const custom = String(store.get().settings.onlineDownloadDir || '').trim()
  if (custom) return custom
  try {
    return path.join(app.getPath('music'), '猪专属下载')
  } catch (err) {
    return path.join(DATA_DIR, 'downloads')
  }
}

/* ---------------- 在线音乐下载管理（v3.3） ---------------- */

/**
 * 任务表：id → {
 *   key, song, status: queued|downloading|pausing|paused|done|error,
 *   received, total, speed, path(目标文件), ext, error, at, abort, deleted
 * }
 *
 * 「暂停」不是取消：abort 掉 fetch，但 .part 留着；「继续」用 Range 从断点续，
 * 所以暂停一个 200MB 的母带不会把已下的白扔。只有「删除」才清残片。
 */
const dlTasks = new Map()
let dlSeq = 0
let dlSaveTimer = null

function dlFile() { return path.join(userData, 'downloads.json') }

function dlDto(t) {
  return {
    id: t.id,
    key: t.key,
    title: (t.song && t.song.title) || '',
    artist: (t.song && t.song.artist) || '',
    source: (t.song && t.song.source) || '',
    status: t.status,
    received: t.received || 0,
    total: t.total || 0,
    speed: t.speed || 0,
    path: t.path || '',
    ext: t.ext || '',
    error: t.error || '',
    at: t.at || 0
  }
}

/** 推给界面；save=false 用于高频进度（别每 250ms 写一次盘） */
function dlBroadcast(save) {
  const data = Array.from(dlTasks.values()).map(dlDto)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('online:dl-update', data)
  }
  if (save !== false) dlSaveSoon()
}

/** 只持久化「还没完成」的任务，重启后一律按暂停恢复 */
function dlSaveSoon() {
  if (dlSaveTimer) return
  dlSaveTimer = setTimeout(() => {
    dlSaveTimer = null
    try {
      const keep = Array.from(dlTasks.values())
        .filter((t) => t.status !== 'done' && t.status !== 'error')
        .map((t) => ({
          id: t.id, key: t.key, song: t.song, status: 'paused',
          received: t.received || 0, total: t.total || 0,
          path: t.path || '', ext: t.ext || '', at: t.at || 0
        }))
      fs.writeFileSync(dlFile(), JSON.stringify(keep, null, 1))
    } catch (err) { /* 写不进去就算了，不影响下载 */ }
  }, 700)
}

function dlLoad() {
  try {
    const arr = JSON.parse(fs.readFileSync(dlFile(), 'utf8'))
    if (!Array.isArray(arr)) return
    for (const r of arr) {
      if (!r || !r.id || !r.song) continue
      dlTasks.set(r.id, { ...r, status: 'paused', speed: 0, abort: null, deleted: false })
    }
    if (arr.length) logLine('[dl] 恢复', arr.length, '个未完成任务')
  } catch (err) { /* 没有历史任务 */ }
}

/** 删残片要重试：Windows 上写流还没 close 时 unlink 会失败（EBUSY/EPERM） */
function dlUnlinkRetry(p, tries = 0) {
  if (!p) return
  try {
    fs.unlinkSync(p)
  } catch (err) {
    if (err.code === 'ENOENT') return
    if (tries < 10) setTimeout(() => dlUnlinkRetry(p, tries + 1), 400)
  }
}

function dlSafeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
}

/** 定目标文件名；重名加 (2)(3)，也避开同名的 .part */
function dlPickPath(song, ext) {
  const dir = downloadDir()
  fs.mkdirSync(dir, { recursive: true })
  const base = dlSafeName(`${song.artist} - ${song.title}`).slice(0, 120) || '未知歌曲'
  let target = path.join(dir, `${base}.${ext}`)
  let n = 1
  while (fs.existsSync(target) || fs.existsSync(target + '.part')) {
    n++
    target = path.join(dir, `${base} (${n}).${ext}`)
  }
  return target
}

/** 跑一个任务（首次开始 / 继续都走这里） */
async function dlRun(task) {
  if (task.status === 'downloading') return
  task.status = 'downloading'
  task.error = ''
  task.deleted = false
  const ctrl = new AbortController()
  task.abort = ctrl
  dlBroadcast(true)

  let ws = null
  try {
    let info = null
    try { info = await online.getPlayable(task.song, qualityPref()) } catch (err) { info = null }
    if (!info || !info.url) throw new Error('没有可用地址（可能版权限制）')

    if (!task.path) {
      const ext = info.ext === 'm4a' ? 'm4a' : info.ext === 'flac' ? 'flac' : 'mp3'
      task.ext = ext
      task.path = dlPickPath(task.song, ext)
    }
    const part = task.path + '.part'
    let offset = 0
    try { offset = fs.statSync(part).size } catch (err) { offset = 0 }

    const headers = { 'User-Agent': 'Mozilla/5.0' }
    if (info.referer) headers.Referer = info.referer
    if (info.headers && typeof info.headers === 'object') Object.assign(headers, info.headers)
    if (offset > 0) headers.Range = 'bytes=' + offset + '-'

    const res = await fetch(info.url, { headers, signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status)
    // 服务端不认 Range 就会回 200 全量，这时只能从头写
    if (res.status === 200 && offset > 0) offset = 0
    const cr = res.headers.get('content-range') || ''
    const len = Number(res.headers.get('content-length')) || 0
    task.total = /\/\d+/.test(cr) ? Number(cr.split('/')[1]) : (offset + len)
    task.received = offset

    ws = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
    const reader = res.body.getReader()
    let lastT = Date.now()
    let lastB = task.received
    let lastEmit = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      task.received += buf.length
      if (!ws.write(buf)) await new Promise((r) => ws.once('drain', r))
      const now = Date.now()
      if (now - lastEmit >= 250) {
        lastEmit = now
        const dt = (now - lastT) / 1000
        if (dt > 0.25) {
          task.speed = Math.max(0, Math.round((task.received - lastB) / dt))
          lastB = task.received
          lastT = now
        }
        dlBroadcast(false)
      }
      if (task.deleted) { try { ctrl.abort() } catch (err) { /* 忽略 */ } break }
    }
    await new Promise((r) => ws.end(r))
    ws = null
    if (task.deleted) throw Object.assign(new Error('__deleted'), { name: 'AbortError' })
    if (task.total && task.received + 1024 < task.total) throw new Error('下载不完整（连接中断）')
    fs.renameSync(part, task.path)
    task.status = 'done'
    task.speed = 0
    if (task.total) task.received = task.total
    logLine('[dl] 完成', path.basename(task.path), (task.received / 1048576).toFixed(1) + 'MB')
    // 落盘后丢给曲库做增量扫描，下载完就能在「最近添加」里看到
    if (library) library.scan(store.get().settings.musicDirs || []).catch(() => {})
  } catch (err) {
    if (ws) { try { ws.destroy() } catch (e) { /* 忽略 */ } }
    if (task.deleted) {
      dlTasks.delete(task.id)
      dlUnlinkRetry(task.path ? task.path + '.part' : '')
      dlUnlinkRetry(task.path || '')
    } else if (err && (err.name === 'AbortError' || /abort/i.test(err.message || ''))) {
      task.status = 'paused'
      task.speed = 0
    } else {
      task.status = 'error'
      task.error = (err && err.message) || '下载失败'
      task.speed = 0
      logLine('[dl] 失败', task.error)
    }
  } finally {
    task.abort = null
    dlBroadcast(true)
  }
}

/** 音质设置 → 各音源认的 prefer 值（只有 lossless / best / 128k 三种） */
function qualityPref() {
  const q = store.get().settings.onlineQuality
  if (q === 'master') return 'master'
  if (q === 'lossless') return 'lossless'
  if (q === '128k') return '128k'
  return 'best'
}

/* 音质探测：结果缓存 10 分钟 + 并发闸门（最多 3 个同时跑，别把解析服务打爆） */
const probeCache = new Map()
const PROBE_TTL = 10 * 60 * 1000
let probeRunning = 0
const probeWaiting = []

function probeLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      probeRunning++
      fn().then(resolve, reject).finally(() => {
        probeRunning--
        const next = probeWaiting.shift()
        if (next) next()
      })
    }
    if (probeRunning < 3) run()
    else probeWaiting.push(run)
  })
}

function registerIpc() {
  // —— 音乐库 ——
  // 扫库期间 lib:list 必须等待扫描结束，否则渲染进程会读到半成品列表
  ipcMain.handle('lib:list', async () => {
    if (activeScan) {
      try { await activeScan } catch { /* 扫描失败也用现有数据 */ }
    }
    return library.list().map(toClientTrack)
  })

  ipcMain.handle('lib:scan', async (event, dirs) => {
    const targetDirs = Array.isArray(dirs) && dirs.length ? dirs : store.get().settings.musicDirs
    const sender = event.sender
    const run = library.scan(targetDirs, (p) => {
      if (!sender.isDestroyed()) {
        sender.send('lib:scan-progress', {
          phase: p.phase,
          done: p.done,
          total: p.total,
          track: p.track ? toClientTrack(p.track) : null
        })
      }
    })
    activeScan = run
    try {
      const res = await run
      if (!sender.isDestroyed()) sender.send('lib:scan-done', res)
      return res
    } finally {
      if (activeScan === run) activeScan = null
    }
  })

  // —— 设置 ——
  ipcMain.handle('settings:get', () => store.get().settings)
  ipcMain.handle('settings:patch', (e, patch) => {
    const before = store.get().settings || {}
    const prevDirs = JSON.stringify(before.musicDirs || [])
    const prevWatch = before.watchFolders
    const next = store.patch({ settings: patch }).settings
    // 目录列表或监视开关变了 → 重新挂 watcher（v1.7）
    if (JSON.stringify(next.musicDirs || []) !== prevDirs || next.watchFolders !== prevWatch) {
      startWatching()
    }
    return next
  })

  // —— 歌单 ——
  ipcMain.handle('playlists:get', () => store.get().playlists || [])
  ipcMain.handle('playlists:create', (e, name) => {
    const list = store.get().playlists || []
    const item = {
      id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || '新建歌单',
      trackIds: [],
      createdAt: Date.now()
    }
    list.push(item)
    store.patch({ playlists: list })
    return item
  })
  ipcMain.handle('playlists:update', (e, { id, patch }) => {
    const list = store.get().playlists || []
    const idx = list.findIndex((p) => p.id === id)
    if (idx < 0) return null
    list[idx] = { ...list[idx], ...patch }
    store.patch({ playlists: list })
    return list[idx]
  })
  ipcMain.handle('playlists:remove', (e, id) => {
    store.patch({ playlists: (store.get().playlists || []).filter((p) => p.id !== id) })
    return true
  })
  ipcMain.handle('playlists:addTracks', (e, { id, trackIds }) => {
    const list = store.get().playlists || []
    const pl = list.find((p) => p.id === id)
    if (!pl) return null
    for (const t of trackIds) if (!pl.trackIds.includes(t)) pl.trackIds.push(t)
    store.patch({ playlists: list })
    return pl
  })
  ipcMain.handle('playlists:removeTracks', (e, { id, trackIds }) => {
    const list = store.get().playlists || []
    const pl = list.find((p) => p.id === id)
    if (!pl) return null
    const set = new Set(trackIds)
    pl.trackIds = pl.trackIds.filter((t) => !set.has(t))
    store.patch({ playlists: list })
    return pl
  })

  /**
   * 导出 m3u 歌单。渲染层只有曲目 id，路径由主进程按 library 反查（渲染层拿不到真实路径）。
   * 优先写相对路径（m3u 与音乐在同一棵树里时更耐搬动），跨盘时自动退化为绝对路径。
   */
  ipcMain.handle('playlist:exportM3u', async (e, { name, trackIds } = {}) => {
    if (!win) return { ok: false, error: '窗口未就绪' }
    const tracks = (trackIds || []).map((id) => library.get(id)).filter(Boolean)
    if (!tracks.length) return { ok: false, error: '歌单是空的' }
    const safe = String(name || '播放列表').replace(/[\\/:*?"<>|]/g, '_')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出 m3u 歌单',
      defaultPath: safe + '.m3u8',
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u8', 'm3u'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const base = path.dirname(filePath)
    const lines = ['#EXTM3U']
    for (const t of tracks) {
      const rel = path.relative(base, t.path)
      const useRel = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
      lines.push(useRel ? rel : t.path)
    }
    try {
      fs.writeFileSync(filePath, lines.join('\r\n') + '\r\n', 'utf8')
      return { ok: true, filePath, count: tracks.length }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /** 导入 m3u：路径就地映射成 trackId，未在曲库里的条目单独计数（不报错） */
  ipcMain.handle('playlist:importM3u', async () => {
    if (!win) return { ok: false, error: '窗口未就绪' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入 m3u 歌单',
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u8', 'm3u'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths.length) return { ok: false, canceled: true }
    const file = filePaths[0]
    let entries = []
    try {
      entries = decodeText(fs.readFileSync(file)).split(/\r?\n/)
    } catch (err) {
      return { ok: false, error: err.message }
    }
    const base = path.dirname(file)
    const trackIds = []
    const seen = new Set()
    let unmatched = 0
    for (const raw of entries) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const abs = path.isAbsolute(line) ? line : path.resolve(base, line)
      const id = fileId(abs)
      if (!library.get(id)) { unmatched++; continue }
      if (seen.has(id)) continue
      seen.add(id)
      trackIds.push(id)
    }
    return {
      ok: true,
      name: path.basename(file, path.extname(file)),
      trackIds,
      unmatched
    }
  })

  // —— 收藏 / 历史 / 播放次数 ——
  ipcMain.handle('favorites:get', () => store.get().favorites || [])
  ipcMain.handle('favorites:toggle', (e, trackId) => {
    const favs = store.get().favorites || []
    const i = favs.indexOf(trackId)
    if (i >= 0) favs.splice(i, 1)
    else favs.unshift(trackId)
    store.patch({ favorites: favs })
    return favs
  })

  ipcMain.handle('history:get', () => store.get().history || [])
  ipcMain.handle('history:add', (e, trackId) => {
    const hist = (store.get().history || []).filter((h) => h.id !== trackId)
    hist.unshift({ id: trackId, at: Date.now() })
    store.patch({ history: hist.slice(0, 300) })
    return true
  })

  ipcMain.handle('playcount:get', () => store.get().playCounts || {})
  ipcMain.handle('playcount:inc', (e, trackId) => {
    const pc = store.get().playCounts || {}
    pc[trackId] = (pc[trackId] || 0) + 1
    store.patch({ playCounts: pc })
    return pc[trackId]
  })

  ipcMain.handle('session:get', () => store.get().session || null)
  ipcMain.handle('session:set', (e, session) => {
    store.patch({ session })
    return true
  })

  // —— 歌词 ——
  ipcMain.handle('lyric:read', async (e, trackId) => {
    const track = library.get(trackId)
    if (!track || !track.lyric) return null
    try {
      const buf = await fsp.readFile(track.lyric)
      return decodeText(buf)
    } catch (err) {
      return null
    }
  })

  // —— 联网版：在线音乐 ——
  ipcMain.handle('online:sources', () => online.listSources())
  ipcMain.handle('online:proxyBase', () => ensureStreamBase())

  ipcMain.handle('online:search', async (e, { keyword, page, limit, sources } = {}) => {
    const kw = String(keyword || '').trim()
    if (!kw) return { list: [], keyword: '' }
    const useSources = Array.isArray(sources) && sources.length
      ? sources
      : (store.get().settings.onlineSources || ['kw', 'qq', 'kg', 'wy'])
    const t0 = Date.now()
    const list = await online.search(kw, Number(page) || 1, Number(limit) || 30, useSources)
    logLine(`[online] 搜索「${kw}」p${page || 1} → ${list.length} 条 ${Date.now() - t0}ms`)
    return { list, keyword: kw, page: Number(page) || 1 }
  })

  /**
   * 播放前先解析：这样「无版权/只有试听」能在界面上说清楚，
   * 而不是让 <audio> 或 mpv 直接报一个用户看不懂的错误。
   */
  ipcMain.handle('online:playable', async (e, song) => {
    if (!song || !song.source || !song.id) return { ok: false, error: '参数不完整' }
    const prefer = qualityPref()
    try {
      const info = await online.getPlayable(song, prefer)
      if (!info) return { ok: false, error: '各音源都没有这首歌的可用地址（多半是版权限制）' }
      const actual = info.song || song
      const q = new URLSearchParams({
        q: prefer,
        t: actual.title || '',
        a: actual.artist || '',
        d: String(actual.duration || 0)
      })
      const streamUrl = `${await ensureStreamBase()}/stream?src=${encodeURIComponent(actual.source)}&id=${encodeURIComponent(actual.id)}&${q}`
      return {
        ok: true,
        streamUrl,
        song: actual,
        fallback: !!info.fallback,
        partial: !!info.partial,
        lossless: !!info.lossless,
        level: info.level || '',
        from: info.from || '',
        bitrate: info.bitrate || 0,
        ext: info.ext || 'mp3',
        size: info.size || 0
      }
    } catch (err) {
      return { ok: false, error: err.message || '解析失败' }
    }
  })

  /**
   * v3.2.1：列表里的「音质」探测。
   *
   * 搜索接口给的码率是平台标称值（酷我一律 128k、QQ 一律 128k），既不反映实际，
   * 也看不出有没有无损——用户看到一列 128k 就以为放不了 flac。
   * 这里对可见的十几行各问一次解析服务，拿真实文件大小算码率，
   * 顺带把直链塞进缓存：真点播放时就不用再解析了。
   */
  ipcMain.handle('online:probe', async (e, song) => {
    if (!song || !song.source || !song.id) return { ok: false }
    const prefer = qualityPref()
    if (prefer === '128k') return { ok: false, skipped: true }
    const ck = `${song.source}:${song.id}:${prefer}`
    const hit = probeCache.get(ck)
    if (hit && Date.now() - hit.at < PROBE_TTL) return hit.data
    const run = async () => {
      const info = await Promise.race([
        online.getPlayable(song, prefer),
        new Promise((r) => setTimeout(() => r(null), 8000))
      ])
      if (!info) throw new Error('no info')
      const data = {
        ok: true,
        lossless: !!info.lossless,
        level: info.level || '',
        bitrate: info.bitrate || 0,
        ext: info.ext || 'mp3',
        size: info.size || 0
      }
      probeCache.set(ck, { at: Date.now(), data })
      return data
    }
    try {
      return await probeLimit(run)
    } catch (err) {
      return { ok: false }
    }
  })

  ipcMain.handle('online:lyric', async (e, song) => {
    if (!song || !song.source || !song.id) return null
    try {
      return await online.getLyric(song)
    } catch (err) {
      return null
    }
  })

  // —— 在线音乐下载管理（v3.3）：任务可见 / 可暂停 / 可删除 ——
  ipcMain.handle('online:download', async (e, song) => {
    if (!song || !song.source || !song.id) return { ok: false, error: '参数不完整' }
    const key = `${song.source}:${song.id}`
    for (const t of dlTasks.values()) {
      if (t.key !== key) continue
      if (t.status === 'paused') return { ok: false, error: '这首在下载列表里（已暂停），去列表点继续', id: t.id }
      if (t.status === 'downloading' || t.status === 'queued') return { ok: false, error: '这首正在下载中', id: t.id }
    }
    const task = {
      id: 'd' + Date.now().toString(36) + (++dlSeq),
      key,
      song: { source: song.source, id: song.id, title: song.title || '', artist: song.artist || '', duration: song.duration || 0 },
      status: 'queued',
      received: 0, total: 0, speed: 0,
      path: '', ext: '', at: Date.now()
    }
    dlTasks.set(task.id, task)
    dlBroadcast(true)
    dlRun(task)
    return { ok: true, id: task.id, dir: downloadDir() }
  })

  ipcMain.handle('online:dlList', () => Array.from(dlTasks.values()).map(dlDto))

  ipcMain.handle('online:dlPause', (e, id) => {
    const t = dlTasks.get(String(id))
    if (!t || t.status !== 'downloading') return { ok: false }
    t.status = 'pausing'
    try { if (t.abort) t.abort.abort() } catch (err) { /* 忽略 */ }
    dlBroadcast(true)
    return { ok: true }
  })

  ipcMain.handle('online:dlResume', (e, id) => {
    const t = dlTasks.get(String(id))
    if (!t || t.status === 'downloading' || t.status === 'queued') return { ok: false }
    t.status = 'paused'
    dlRun(t)
    return { ok: true }
  })

  ipcMain.handle('online:dlDelete', (e, id) => {
    const t = dlTasks.get(String(id))
    if (!t) return { ok: false }
    if (t.status === 'downloading' || t.status === 'queued') {
      // 让下载线程自己收尾：abort → catch 里发现 deleted → 删残片、摘任务
      t.deleted = true
      try { if (t.abort) t.abort.abort() } catch (err) { /* 忽略 */ }
      return { ok: true }
    }
    dlTasks.delete(t.id)
    // 已完成的文件是用户的音乐，不删；没完成的残片才清（带重试，见 dlUnlinkRetry）
    if (t.status !== 'done' && t.path) dlUnlinkRetry(t.path + '.part')
    dlBroadcast(true)
    return { ok: true }
  })

  ipcMain.handle('online:dlClearDone', () => {
    let n = 0
    for (const [id, t] of dlTasks) {
      if (t.status === 'done' || t.status === 'error') { dlTasks.delete(id); n++ }
    }
    dlBroadcast(true)
    return { ok: true, removed: n }
  })

  ipcMain.handle('online:dlReveal', (e, id) => {
    const t = dlTasks.get(String(id))
    if (!t || !t.path) return false
    try { shell.showItemInFolder(t.path) } catch (err) { /* 忽略 */ }
    return true
  })

  ipcMain.handle('online:pickDownloadDir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return null
    const dir = res.filePaths[0]
    store.patch({ settings: { ...store.get().settings, onlineDownloadDir: dir } })
    return dir
  })

  ipcMain.handle('online:openDownloadDir', async () => {
    const dir = downloadDir()
    try {
      await fsp.mkdir(dir, { recursive: true })
      shell.openPath(dir)
    } catch (err) { /* 忽略 */ }
    return dir
  })

  // —— 联网版：在线缓存 ——
  ipcMain.handle('online:cacheInfo', () => cacheStats())

  ipcMain.handle('online:cacheClear', () => {
    const r = cacheClear()
    logLine('[cache] 用户清理缓存，删除', r.removed, '首')
    return { ...cacheStats(), removed: r.removed }
  })

  ipcMain.handle('online:pickCacheDir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择缓存目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return null
    const dir = res.filePaths[0]
    // 换目录不动老文件：用户可能还想手动找回；真要腾地方有「清理缓存」
    cacheIdx = null
    store.patch({ settings: { ...store.get().settings, onlineCacheDir: dir } })
    return cacheStats()
  })

  ipcMain.handle('online:openCacheDir', async () => {
    const dir = cacheDirPath()
    try {
      await fsp.mkdir(dir, { recursive: true })
      shell.openPath(dir)
    } catch (err) { /* 忽略 */ }
    return dir
  })

  // —— 联网版：可选的高级音源（ChKSz，用户自己的 apikey） ——
  ipcMain.handle('online:extraKeyGet', () => {
    const k = String(store.get().settings.onlineChkszKey || '')
    return {
      set: !!k,
      // 只回显头尾，避免截屏/录屏时整串漏出去
      masked: k ? k.slice(0, 4) + '••••' + k.slice(-4) : ''
    }
  })

  ipcMain.handle('online:extraKeySet', async (e, key) => {
    const k = String(key || '').trim()
    if (!k) {
      online.setExtraKey('')
      store.patch({ settings: { ...store.get().settings, onlineChkszKey: '' } })
      return { ok: true, cleared: true }
    }
    const r = await online.testExtraKey(k)
    if (!r.ok) return { ok: false, error: r.error }
    online.setExtraKey(k)
    store.patch({ settings: { ...store.get().settings, onlineChkszKey: k } })
    logLine('[online] 已配置 ChKSz key')
    return { ok: true, gotUrl: !!r.gotUrl }
  })

  ipcMain.handle('online:openChksz', () => {
    shell.openExternal('https://api.chksz.com/login.html')
    return true
  })

  // —— 联网版 v3.2：青听网关（四家通吃，含母带档） ——
  ipcMain.handle('online:qingGet', () => ({
    on: store.get().settings.onlineQingOn !== false
  }))

  ipcMain.handle('online:qingSet', (e, on) => {
    const v = on !== false
    online.setQingEnabled(v)
    store.patch({ settings: { ...store.get().settings, onlineQingOn: v } })
    logLine('[online] 青听网关', v ? '已启用' : '已关闭')
    return { ok: true, on: v }
  })

  ipcMain.handle('online:qingTest', async () => online.qingSelfTest())

  // —— 对话框 / 系统集成 ——
  ipcMain.handle('dialog:pickDirs', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle('shell:showItem', (e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
  })

  // —— 窗口控制 ——
  ipcMain.handle('win:minimize', () => win && win.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('win:close', () => win && win.close())
  ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false))
  // 迷你模式：渲染层只表达意图，缩放/持久化都在主进程做
  ipcMain.handle('win:setMini', (e, on) => applyMini(!!on))
  ipcMain.handle('win:isMini', () => miniActive)
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData
  }))

  // —— 桌面歌词 ——
  ipcMain.handle('dlyric:open', () => {
    store.patch({ settings: { desktopLyric: { enabled: true } } })
    createLyricWindow()
    notifyDlyricState()
    return dlyricCfg()
  })
  ipcMain.handle('dlyric:close', () => {
    closeLyricWindow()
    notifyDlyricState()
    return true
  })
  ipcMain.handle('dlyric:isOpen', () => !!(dlyricWin && !dlyricWin.isDestroyed()))
  ipcMain.handle('dlyric:unlock', () => {
    store.patch({ settings: { desktopLyric: { locked: false } } })
    applyDlyricLock()
    notifyDlyricState()
    return dlyricCfg()
  })
  // 主窗口 → 歌词窗口：当前歌词行（同时缓存，供窗口就绪时补发）
  ipcMain.handle('dlyric:state', (e, payload) => {
    lastDlyricData = payload || null
    sendToDlyric('dlyric:data', payload)
    return true
  })
  // 歌词窗口 → 主进程：配置修改（锁定/字号/颜色）→ 同步主窗口按钮
  ipcMain.handle('dlyric:cfg', (e, patch) => {
    store.patch({ settings: { desktopLyric: patch } })
    applyDlyricLock()
    notifyDlyricState()
    return dlyricCfg()
  })
  // 歌词窗口加载完成：立即回推一次完整配置 + 当前歌词行（否则要等下一句才出词）
  ipcMain.handle('dlyric:ready', (e) => {
    replayDlyricState()
    return true
  })

  // —— 独占输出（mpv 后端） ——
  ipcMain.handle('mpv:start', (e, exclusive) => ensureMpv(exclusive !== false))
  ipcMain.handle('mpv:load', async (e, filePath, opts) => {
    let target = filePath
    // 旧会话里可能还存着 lxstream:// 地址（早期实现），这里兜一下；新地址都是 http 代理
    if (typeof filePath === 'string' && filePath.startsWith('lxstream://')) {
      const info = await online.resolveStreamUrl(filePath)
      if (!info || !info.url) {
        logLine('[mpv] 在线直链解析失败', filePath)
        return false
      }
      target = info.url
    }
    if (mpvEngine) mpvEngine.load(target, opts || {})
    return true
  })
  ipcMain.handle('mpv:play', () => { if (mpvEngine) mpvEngine.play(); return true })
  ipcMain.handle('mpv:pause', () => { if (mpvEngine) mpvEngine.pause(); return true })
  ipcMain.handle('mpv:stop', () => { if (mpvEngine) mpvEngine.stop(); return true })
  ipcMain.handle('mpv:seek', (e, sec) => { if (mpvEngine) mpvEngine.seek(Number(sec) || 0); return true })
  ipcMain.handle('mpv:volume', (e, v) => { if (mpvEngine) mpvEngine.setVolume(Number(v) || 0); return true })
  ipcMain.handle('mpv:mute', (e, m) => { if (mpvEngine) mpvEngine.setMute(!!m); return true })
  // A-B 循环（v2.1）：a=null 清除
  ipcMain.handle('mpv:setAbLoop', (e, a, b) => {
    if (mpvEngine) mpvEngine.setAbLoop(a, b)
    return true
  })
  ipcMain.handle('mpv:quit', () => { stopMpv(); return true })
  // 开启独占前的确认框（把不可逆的副作用说清楚，避免误触）
  ipcMain.on('win:play-state', (e, playing) => updateThumbar(!!playing))

  ipcMain.handle('mpv:confirmEnable', async () => {
    if (!win) return false
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['开启独占输出', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '开启独占输出（位完美）',
      message: '改用 mpv + WASAPI 独占输出',
      detail: [
        '· 独占期间声卡被本程序占用，浏览器、微信、视频等其他程序没有声音；',
        '· 均衡器、音量均衡、实时频谱会自动禁用（任何软件处理都会破坏位完美）；',
        '· 音量 100% 时是位完美，拖低音量即为软件增益，界面会标注状态；',
        '· 开启后界面会重新加载，播放中断一次（队列与进度会保留）。',
        '',
        '如果声卡驱动不支持独占或已被占用，会自动回退共享输出。'
      ].join('\n')
    })
    return response === 0
  })

  /**
   * 枚举 WASAPI 输出设备。独占需求的人基本都接了 USB DAC，
   * 而系统默认设备经常不是它 —— 没有这个就无法把独占输出指到指定设备。
   */
  ipcMain.handle('mpv:devices', async () => {
    let startedHere = false
    try {
      if (!mpvEngine || !mpvEngine.running) {
        const r = await ensureMpv(false)
        if (!r.ok) return { ok: false, devices: [], error: r.error || '引擎未启动' }
        startedHere = true
      }
      const devices = await mpvEngine.listDevices()
      return { ok: true, devices }
    } catch (err) {
      return { ok: false, devices: [], error: err.message }
    } finally {
      // 只为枚举而临时拉起的引擎（当前并非独占输出）用完即关，不留空闲进程
      if (startedHere && !store.get().settings.exclusiveOutput) stopMpv()
    }
  })

  /** 切换输出设备：存设置；正在独占播放时重启引擎并回到原位置 */
  ipcMain.handle('mpv:setDevice', async (e, device) => {
    const name = String(device || '')
    store.patch({ settings: { audioDevice: name } })
    if (!mpvEngine || !mpvEngine.running) return { ok: true, applied: false }
    if (!store.get().settings.exclusiveOutput) return { ok: true, applied: false }
    // v2.5：重启时带上当前音量（重启后不再被重置成 100；播放状态由 restart 内部恢复）
    const startVolume = Math.max(0, Math.min(1, Number(store.get().settings.volume ?? 1)))
    const r = await mpvEngine.restart({ exclusive: true, audioDevice: name, volume: startVolume })
    // 新设备起不来时 mpv.js 会退回原设备；这时设置也得跟着回退，否则界面显示的和实际用的不一致
    if (r.ok && r.audioDevice && r.audioDevice !== name) {
      store.patch({ settings: { ...store.get().settings, audioDevice: r.audioDevice } })
      return { ok: true, applied: true, reverted: true, device: r.audioDevice, error: '该设备不可用，已退回原设备' }
    }
    return { ok: !!r.ok, applied: true, error: r.error }
  })

  /* ---------------- 诊断面板（v1.8） ---------------- */

  // 环境快照：版本、路径、引擎状态、曲库规模
  ipcMain.handle('diag:info', () => {
    const s = store.get().settings || {}
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
      dataDir: DATA_DIR,
      logFile: LOG_FILE,
      musicDirs: s.musicDirs || [],
      exclusiveOutput: s.exclusiveOutput === true,
      audioDevice: s.audioDevice || '',
      watchFolders: s.watchFolders !== false,
      mpvExe: mpvExePath(),
      mpvExeExists: (() => { try { return fs.existsSync(mpvExePath()) } catch { return false } })(),
      mpvRunning: !!(mpvEngine && mpvEngine.running),
      mpvExclusive: mpvEngine ? !!mpvEngine.exclusive : null,
      mpvFellBack: mpvEngine ? !!mpvEngine.fellBack : false,
      trackCount: library.list().length,
      failureCount: library.listFailures().length,
      scanning: !!activeScan || library.scanning
    }
  })

  // 解析失败清单（完整路径 + 原因；文件是否还在另行核对）
  ipcMain.handle('diag:failures', () => {
    const list = library.listFailures().map((f) => ({
      ...f,
      exists: (() => { try { return fs.existsSync(f.path) } catch { return false } })()
    }))
    const counts = { parse: 0, metadata: 0, stat: 0, duration: 0 }
    for (const f of list) counts[f.stage] = (counts[f.stage] || 0) + 1
    return { ok: true, failures: list, counts }
  })

  // mpv 实时日志：按 seq 增量取，避免每次重画整个列表
  ipcMain.handle('diag:mpvLog', (e, sinceSeq) => {
    const since = Number(sinceSeq) || 0
    return {
      ok: true,
      seq: mpvLogSeq,
      entries: mpvLogs.filter((x) => x.seq > since),
      running: !!(mpvEngine && mpvEngine.running),
      exclusive: mpvEngine ? !!mpvEngine.exclusive : null
    }
  })

  // 日志文件尾部（含启动阶段 stage:* 与外挂进程相关行）
  ipcMain.handle('diag:logTail', async (e, maxLines) => {
    const n = Math.max(50, Math.min(4000, Number(maxLines) || 400))
    try {
      const st = await fsp.stat(LOG_FILE)
      const readBytes = Math.min(st.size, 256 * 1024)   // 只读尾部 256 KB，日志再大也不卡
      const fd = await fsp.open(LOG_FILE, 'r')
      let text = ''
      try {
        const buf = Buffer.alloc(readBytes)
        await fd.read(buf, 0, readBytes, st.size - readBytes)
        text = buf.toString('utf8')
      } finally {
        await fd.close()
      }
      const lines = text.split(/\r?\n/).filter((l) => l.length)
      return { ok: true, lines: lines.slice(-n), file: LOG_FILE, size: st.size, truncated: lines.length > n }
    } catch (err) {
      return { ok: false, error: err.message, lines: [], file: LOG_FILE }
    }
  })

  ipcMain.handle('diag:openLog', () => {
    try {
      if (fs.existsSync(LOG_FILE)) shell.showItemInFolder(LOG_FILE)
      else shell.openPath(DATA_DIR)
    } catch {}
    return true
  })

  ipcMain.handle('diag:clearFailures', async () => {
    const n = library.clearAllFailures()
    await library.persistFailures()
    logLine('[diag] 已清空失败清单 ' + n + ' 条')
    return { ok: true, cleared: n }
  })

  // 剪贴板：file:// 页面里 navigator.clipboard 与 execCommand('copy') 都不可靠，
  // 必须走主进程的 clipboard 模块（诊断面板要能一键复制给下一个人看）
  ipcMain.handle('diag:copy', (e, text) => {
    try {
      clipboard.writeText(String(text == null ? '' : text))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /* ---------------- 播放结束后动作 / A-B（v2.1） ---------------- */

  // 渲染层上报"整队播完"（列表回卷 / 顺序模式最后一首结束）
  ipcMain.on('player:queue-end', () => runPowerAction())
  ipcMain.handle('power:get', () => powerAfterQueue)
  ipcMain.handle('power:set', (e, kind) => { setPowerAfterQueue(kind); return powerAfterQueue })
  ipcMain.handle('power:cancel', () => cancelPowerAction())

  // 睡眠定时（v2.2：入口从托盘移到 app 内播放条）
  ipcMain.handle('sleep:set', (e, minutes) => { setSleepTimer(minutes); return { minutes: sleepMinutes, endsAt: sleepEndsAt || null } })
  ipcMain.handle('sleep:get', () => ({ minutes: sleepMinutes, endsAt: sleepEndsAt || null }))
}

/** 文本解码：优先 UTF-8，失败回退 GBK（Windows 中文 lrc 常见） */
function decodeText(buf) {
  let text = buf.toString('utf8')
  const bad = (text.match(/\uFFFD/g) || []).length
  if (bad > 0) {
    try {
      const decoder = new TextDecoder('gbk')
      const alt = decoder.decode(buf)
      if ((alt.match(/\uFFFD/g) || []).length < bad) text = alt
    } catch {}
  }
  return text.replace(/^\uFEFF/, '')
}

/** 转成渲染层用的精简结构（路径换成自定义协议 URL） */
function toClientTrack(t) {
  return {
    id: t.id,
    path: t.path,
    // 所属目录（v1.7）：文件夹视图按它分组，渲染层不好自己切路径
    dir: t.path ? path.dirname(t.path) : '',
    fileName: t.fileName,
    title: t.title,
    artist: t.artist,
    artists: t.artists,
    album: t.album,
    albumArtist: t.albumArtist,
    year: t.year,
    trackNo: t.trackNo,
    genre: t.genre,
    duration: t.duration,
    bitrate: t.bitrate,
    sampleRate: t.sampleRate,
    bitsPerSample: t.bitsPerSample,
    codec: t.codec,
    lossless: t.lossless,
    ext: t.ext,
    size: t.size,
    // 入库时间（v1.9）：「最近添加」视图与 addedAt 排序用
    addedAt: t.addedAt || t.mtime || 0,
    // v2.0：DSD 标记（普通输出放不了，界面要标注）与 ReplayGain 标签
    isDsd: !!t.isDsd,
    rgTrackDb: t.rgTrackDb == null ? null : t.rgTrackDb,
    rgAlbumDb: t.rgAlbumDb == null ? null : t.rgAlbumDb,
    hasLyric: !!t.lyric,
    // 拼音检索字段（v1.6）：主进程预先算好，渲染层只做 includes
    py: t.py || '',
    pyf: t.pyf || '',
    // 内嵌封面走 lxcover://（内存 LRU），同目录的封面图仍走 lxfile://
    cover: t.cover === COVER_EMBEDDED
      ? 'lxcover://local/' + encodeURIComponent(t.id)
      : toLxUrl(resolveCoverPath(t.cover, library.coverDir)),
    audio: toLxUrl(t.path)
  }
}

/* ---------------- 启动 ---------------- */

logLine('stage: dataDir=' + DATA_DIR)

// 单实例锁：拿不到锁 = 已有实例在运行（Electron 会向其发送 second-instance 事件，
// 由那边弹出/聚焦窗口）。此时本进程必须直接退出，否则会开双实例（抢 mpv、抢缓存）。
let gotLock = false
try {
  gotLock = app.requestSingleInstanceLock()
} catch (err) {
  logLine('WARN 单实例锁异常，忽略', err.message)
}
logLine('stage: lock=' + gotLock)
if (!gotLock) {
  logLine('已有实例在运行，本进程退出')
  app.exit(0)
}

// 只在确认是唯一实例时清缓存：多实例情况下删的是正在运行实例的文件（多半删不掉）
if (gotLock) cleanChromiumCache()
{
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    logLine('stage: ready')
    userData = app.getPath('userData')
    logLine('stage: userData=' + userData)
    store = new Store(path.join(userData, 'settings.json'), {
      settings: DEFAULT_SETTINGS,
      playlists: [],
      favorites: [],
      history: [],
      playCounts: {},
      session: null,
      window: {}
    }, { onError: (msg) => logLine('STORE_ERROR', msg) })
    // v2.1：恢复「播放结束后」的设定（关机这类动作要跨重启记住）
    powerAfterQueue = store.get().settings.powerAfterQueue || 'off'

    // v3.1 一次性迁移：老版本的音质默认是 best，新版本默认无损。
    // 只在「从没迁移过」时动一次，之后用户自己选什么就是什么。
    {
      const st0 = store.get().settings
      if (!st0.onlineQualityMigrated) {
        const q = st0.onlineQuality === '128k' ? '128k' : 'lossless'
        store.patch({ settings: { ...st0, onlineQuality: q, onlineQualityMigrated: true } })
        logLine('[settings] 音质迁移到', q)
      }
    }

    // 异步清上次残留的 mpv，不阻塞启动
    killOrphanMpv()

    library = new Library({
      cacheFile: path.join(userData, 'library.json'),
      coverDir: path.join(userData, 'covers'),
      lyricDir: path.join(userData, 'lyrics')
    })

    cacheCleanupParts()
    dlLoad()
    registerFileProtocol()
    registerCoverProtocol()
    online.setLogger(logLine)
    online.setExtraKey(store.get().settings.onlineChkszKey || '')
    online.setQingEnabled(store.get().settings.onlineQingOn !== false)
    startStreamServer()
    await library.init()
    registerIpc()

    // 首次启动（或解析器升级导致缓存作废）时自动建库。
    // 必须在 createWindow 之前启动，好让渲染进程的首次 lib:list 能与它串行。
    // 设置里开了「启动时扫描音乐文件夹」也会自动扫一次（增量、很快）。
    const needScan = library.list().length === 0 || store.get().settings.autoScanOnStart === true
    if (needScan) {
      const run = library.scan(store.get().settings.musicDirs, (p) => {
        sendToRenderer('lib:scan-progress', {
          phase: p.phase, done: p.done, total: p.total,
          track: p.track ? toClientTrack(p.track) : null
        })
      })
      activeScan = run
      run
        .then((res) => sendToRenderer('lib:scan-done', res))
        .catch((err) => console.error('[library] 首次扫描失败:', err))
        .finally(() => { if (activeScan === run) activeScan = null })
    }

    createWindow()
    createTray()
    startWatching()
    const failed = registerShortcuts()
    if (failed.length) console.warn('[shortcut] 注册失败:', failed.join(', '))

    // 上次开着桌面歌词 → 启动时恢复
    if (store.get().settings.desktopLyric && store.get().settings.desktopLyric.enabled) {
      createLyricWindow()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else if (win) win.show()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    stopWatching()
    stopMpv()
    if (store) store.flush()
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
