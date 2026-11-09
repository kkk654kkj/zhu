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
const crypto = require('crypto')

const { Store } = require('./store')
const { Library, fileId, MIME_BY_EXT, resolveCoverPath, COVER_EMBEDDED, readEmbeddedLyric } = require('./library')
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
// v3.3.9：日志超 5MB 就轮转成 .old.log —— 以前无限增长且每条都是同步追加
try {
  const _st = fs.statSync(LOG_FILE)
  if (_st.size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log'))
} catch (err) { /* 首次运行没有日志 */ }
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
    "  if ($p -and ($p.ProcessName -like '猪专属播放器*' -or $p.Path -like '*lx-dev*')) { return }",
    // 开发模式主进程是 electron.exe（进程名匹配不到），按路径放行开发镜像
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
/** 第二实例在窗口页面就绪前发来的 open-files，缓存到渲染层 did-finish-load 时补发 */
let lastOpenFiles = null

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

/**
 * v3.3.13：媒体路径白名单（模块作用域，协议层与 IPC 共用）。
 * 只允许曲库目录 / 下载目录 / 数据目录 / 在线缓存目录之内的文件，防止渲染层被注入后
 * 通过 lxfile:// 或 mpv:load 读任意本地文件。
 */
// realpath 结果缓存：lxfile 每次请求都会走这里，不能反复 stat。
// 带 TTL + 上限，曲库目录里的 junction/符号链接被重新指向后最多 5 秒即重新解析。
const REALPATH_TTL = 5000
const REALPATH_MAX = 512
const realpathCache = new Map()
function realpathCached(p) {
  const now = Date.now()
  const hit = realpathCache.get(p)
  if (hit && now - hit.at < REALPATH_TTL) return hit.val
  let val = null
  try { val = fs.realpathSync.native(p) } catch (e) { val = null }
  if (realpathCache.size >= REALPATH_MAX) realpathCache.clear()
  realpathCache.set(p, { val, at: now })
  return val
}
// Windows 驱动器相对根「D:」（无斜杠）path.resolve 会落到 cwd，补上分隔符
function fixDriveRoot(s) {
  const t = String(s == null ? '' : s).trim()
  return /^[A-Za-z]:$/.test(t) ? t + path.sep : t
}
function isAllowedMediaPath(p) {
  // abs 与每个 root 都取 realpath：曲库里的 junction/符号链接指向系统目录时，
  // real 之后的绝对路径前缀对不上白名单，从而被拒绝
  const abs = realpathCached(path.resolve(fixDriveRoot(p)))
  if (!abs) return false   // realpath 失败（路径不存在/非法）→ 拒绝
  const real = abs.toLowerCase()
  const roots = [
    ...(store.get().settings.musicDirs || []),
    downloadDir(),
    DATA_DIR,
    cacheDirPath()
  ]
    .filter((r) => r && String(r).trim())
    .map((r) => realpathCached(path.resolve(fixDriveRoot(r))))
    .filter(Boolean)
    .map((r) => {
      const rl = r.toLowerCase()
      return (rl.endsWith(path.sep) ? rl.slice(0, -path.sep.length) : rl) + path.sep
    })
  return roots.some((r) => real.startsWith(r) || (real + path.sep).startsWith(r))
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
      // v3.3.13：协议层也要收口（以前只有 mpv:load / shell:showItem 有）
      if (!isAllowedMediaPath(filePath)) return new Response('forbidden', { status: 403 })

      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) return new Response('not a file', { status: 404 })

      const type = mimeFor(filePath)
      const range = request.headers.get('range')
      const total = stat.size

      if (range) {
        // v3.3.13：Range 语法全文锚定，非法/多段都不按部分内容处理
        const raw = String(range).trim()
        if (!/^bytes=\d*-\d*(,\d*-\d*)*$/.test(raw)) {
          return new Response('bad range', { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
        }
        if (raw.includes(',')) {
          // 多段 Range 不支持：按 200 全量返回（不能假装满足任一单段）
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
        }
        const m = /^bytes=(\d*)-(\d*)$/.exec(raw)
        let start = 0
        let end = total - 1
        if (m) {
          if (m[1]) {
            start = parseInt(m[1], 10)
            end = m[2] ? parseInt(m[2], 10) : total - 1
          } else if (m[2]) {
            // v3.3.9：后缀区间 bytes=-N = 最后 N 字节（以前解析成开头 N 字节，
            // 拖尾元数据/某些下载器会拿到错数据）
            start = Math.max(0, total - parseInt(m[2], 10))
            end = total - 1
          }
        }
        if (Number.isNaN(start)) start = 0
        if (Number.isNaN(end) || end >= total) end = total - 1
        if (start > end || start >= total) {
          return new Response('bad range', { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
        }
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
      logLine('[lxfile] 读取失败', err.message)
      return new Response('not found', { status: 404 })   // 不回显绝对路径/系统错误
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
      return new Response('cover error', { status: 500 })
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
  const custom = String(store.get().settings.onlineCacheDir || '').trim()
  return custom || path.join(DATA_DIR, 'music-cache')
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
        logLine('[cache] 索引损坏已备份', err.message)
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
    logLine('[cache] 索引写入失败', err.message)
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
  // v3.3.13：索引可能被篡改，rec.file 必须是纯文件名且解析后仍在缓存目录内
  const rf = String(rec.file || '')
  const dirResolved = path.resolve(cacheDirPath())
  const fp = path.resolve(dirResolved, rf)
  if (!rf || /[\\/]/.test(rf) || rf.includes('..') ||
      (fp !== dirResolved && !fp.startsWith(dirResolved + path.sep))) {
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
    rec.at = Date.now() // 命中即刷新，做 LRU
    cacheSaveSoon()
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
    try {
      fs.unlinkSync(path.join(cacheDirPath(), it.v.file))
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
  // v3.3.13：这是白名单外的第二条本地读通道，必须在函数入口断言文件仍落在
  // 缓存目录 / 数据目录之内（realpath 后比较，防被篡改索引 + junction 绕过）
  let realFile = null
  try { realFile = fs.realpathSync.native(filePath) } catch (e) { realFile = null }
  const inAllowedDir = realFile && [cacheDirPath(), DATA_DIR].some((d) => {
    let rd = realpathCached(d)
    if (!rd) return false
    rd = rd.toLowerCase()
    const rf = realFile.toLowerCase()
    const prefix = (rd.endsWith(path.sep) ? rd.slice(0, -path.sep.length) : rd) + path.sep
    return rf === rd || rf.startsWith(prefix)
  })
  if (!inAllowedDir) {
    try { res.writeHead(403); res.end('forbidden') } catch (e) { /* 已断开 */ }
    return
  }
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (err) {
    // v3.3.13：缓存命中到 open 之间文件被淘汰/删除 → 404，不要冒 500
    try { res.writeHead(404); res.end('file gone') } catch (e) { /* 已断开 */ }
    return
  }
  const total = stat.size
  const base = {
    'Content-Type': mimeFor(filePath),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  }
  // v3.3.7：客户端断开（切歌/拖进度条）时把读流一起销毁 ——
  // 以前 .pipe(res) 之后读流会继续把文件读到 EOF 才释放句柄，
  // 白读几十 MB IO，而且这段时间句柄被占，缓存淘汰的 unlink 会失败
  const pipe = (rs) => {
    res.on('close', () => { try { rs.destroy() } catch (e) { /* 已结束 */ } })
    rs.on('error', () => {
      try { res.destroy() } catch (e) { /* 已断开 */ }
      try { rs.destroy() } catch (e) { /* 已结束 */ }
    })
    rs.pipe(res)
  }
  const sendFull = () => {
    res.writeHead(200, { ...base, 'Content-Length': String(total) })
    pipe(fs.createReadStream(filePath))
  }
  const range = req.headers.range
  if (range) {
    // v3.3.13：Range 语法全文锚定；非法 → 416，多段 → 按 200 全量
    const raw = String(range).trim()
    if (!/^bytes=\d*-\d*(,\d*-\d*)*$/.test(raw)) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Access-Control-Allow-Origin': '*' })
      res.end()
      return
    }
    if (raw.includes(',')) { sendFull(); return }
    const m = /^bytes=(\d*)-(\d*)$/.exec(raw)
    let start = 0
    let end = total - 1
    if (m) {
      if (m[1]) {
        start = parseInt(m[1], 10)
        end = m[2] ? parseInt(m[2], 10) : total - 1
      } else if (m[2]) {
        // v3.3.7：后缀区间 bytes=-N 的正确语义是「最后 N 字节」，
        // 以前解析成开头 N 字节，拿到的是错数据
        start = Math.max(0, total - parseInt(m[2], 10))
        end = total - 1
      }
    }
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= total) end = total - 1
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Access-Control-Allow-Origin': '*' })
      res.end()
      return
    }
    res.writeHead(206, {
      ...base,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${total}`
    })
    pipe(fs.createReadStream(filePath, { start, end }))
    return
  }
  sendFull()
}

function startStreamServer() {
  const http = require('http')
  let readyResolve = () => {}
  streamReady = new Promise((resolve) => { readyResolve = resolve })
  streamServer = http.createServer(async (req, res) => {
    // 缓存临时文件的清理由外层 try 内赋值；提到这里声明，好让外层 catch 也能兜底清理
    let dropPart = () => {}
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
      // v3.3.13：握手超时 + 正文空闲超时两段。
      // AbortSignal.timeout 会覆盖整个响应体读取，>15 秒的在线音频会被截断、缓存永远写不成；
      // 改成「建连/首字节 15 秒，正文每 20 秒没数据才断」，signal 保留但不再设总体超时。
      const ctrl = new AbortController()
      const headTimer = setTimeout(() => { try { ctrl.abort() } catch (e) { /* 忽略 */ } }, 15000)
      let upstream
      try {
        upstream = await fetch(info.url, { headers, redirect: 'follow', signal: ctrl.signal })
      } finally {
        clearTimeout(headTimer)
      }
      if (!upstream.ok && upstream.status !== 206) {
        logLine('[online] 上游失败', upstream.status, info.url.slice(0, 70))
        res.writeHead(502).end('upstream ' + upstream.status)
        return
      }
      // 正文阶段：可刷新的空闲看门狗 —— 每读到一个 chunk 就刷新 20 秒，
      // 慢速但持续的大文件不会被误杀，真正卡死的连接才会被 abort
      let idleTimer = null
      const touch = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => { try { ctrl.abort() } catch (e) { /* 忽略 */ } }, 20000)
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
      // 关闭写流并删掉指定 .part：Windows 上不能删还开着的文件，等 close 再删；
      // 1 秒兜底 timer 保存句柄，del 成功即 clearTimeout，避免 del 被调两次
      const removePart = (p, ps) => {
        if (!p) return
        let fallback = null
        let done = false
        const del = () => {
          if (done) return
          done = true
          if (fallback) { clearTimeout(fallback); fallback = null }
          try { fs.unlinkSync(p) } catch (e) { /* 忽略 */ }
        }
        if (!ps) { del(); return }
        try {
          ps.once('close', del)
          ps.destroy()
          if (!done) fallback = setTimeout(del, 1000)
        } catch (e) { del() }
      }
      if (canCache) {
        try {
          fs.mkdirSync(cacheDirPath(), { recursive: true })
          // 每个请求用自己的临时文件名：同一首歌可能被连点两次，
          // 共用一个 .part 的话，先结束的那个会把后一个正在写的文件删掉。
          const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
          partPath = path.join(cacheDirPath(), `${cKey}.${uniq}.part`)
          partStream = fs.createWriteStream(partPath)
          // v3.3.13：error 回调捕获「这个具体 .part」——finishCache 清空 partPath
          // 后写流才报错时，仍能定位并删掉半截残片
          const errP = partPath
          const errS = partStream
          partStream.on('error', () => removePart(errP, errS))
        } catch (err) {
          partPath = null
          partStream = null
        }
      }
      dropPart = () => {
        const ps = partStream
        const p = partPath
        partStream = null
        partPath = null
        removePart(p, ps)
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
          // v3.3.13：ext 来自网络字段，只放行白名单扩展名，否则退回 mp3
          const CACHE_EXTS = ['mp3', 'm4a', 'flac', 'ogg', 'aac']
          const ext = String(meta.ext || '').toLowerCase()
          const safeExt = CACHE_EXTS.includes(ext) ? ext : 'mp3'
          const file = `${key}.${safeExt}`
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
      if (!upstream.body) {
        dropPart()
        try { res.end() } catch (e) { /* 已断开 */ }
        return
      }
      const reader = upstream.body.getReader()
      touch()   // 启动正文空闲看门狗（首字节也要限时）
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
        let timer = null
        const go = () => {
          if (done) return
          done = true
          if (timer) clearTimeout(timer)
          // v3.3.13：once 注册的是包装函数，off 必须配对；用 on + off 才能真清掉
          emitter.off('drain', go)
          emitter.off('close', go)
          r()
        }
        emitter.on('drain', go)
        emitter.on('close', go)
        timer = setTimeout(go, 3000) // 宁可丢掉缓存，也不能卡住播放
      })
      let complete = false
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (aborted) break
          touch()   // 每读到一个 chunk 就刷新空闲看门狗
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
        clearTimeout(idleTimer)
        clearTimeout(headTimer)
        res.off('close', onClose)
        // 正常读完才落缓存；中途断开就把残片丢掉
        if (complete) finishCache()
        else dropPart()
        // v3.3.13：无论成功/异常/断开，连接都必须收掉
        try { if (!res.writableEnded) res.end() } catch (e) { /* 已断开 */ }
      }
    } catch (err) {
      try { dropPart() } catch (e) { /* 忽略 */ }
      logLine('[online] 代理异常', err.message)
      try {
        if (res.headersSent) res.destroy()      // 头已发出，不能再次 writeHead
        else res.writeHead(500).end('proxy error')
      } catch (e) { try { res.destroy() } catch (e2) {} }
    }
  })
  streamServer.on('error', (err) => {
    logLine('[online] 代理服务错误', err.message)
    // v3.3.7：监听失败（端口被占/被安全软件拦）时必须把等待方放出来，
    // 否则 ensureStreamBase() 永久 pending，所有在线播放无声无息挂死且无提示
    if (!streamBase) { try { readyResolve('') } catch (e) { /* 已 resolve */ } }
  })
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
    let timer = null
    const fin = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { win.removeListener(ev, fin) } catch {}
      resolve()
    }
    win.on(ev, fin)          // once 的包装函数 removeListener 匹配不到
    timer = setTimeout(fin, timeout)
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
      // Windows 上 unmaximize 是异步的，必须先挂监听再触发，否则会漏掉事件（只剩超时兜底）
      const wait = waitWindowEvent(win, 'unmaximize')
      win.unmaximize()
      await wait
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

  const placed = clampToWorkArea({ width, height, x, y })
  win = new BrowserWindow({
    width: placed.width,
    height: placed.height,
    x: placed.x,
    y: placed.y,
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

  // v3.3.13：第二实例可能在页面加载完成前就发来 open-files，这里补发一次
  win.webContents.on('did-finish-load', () => {
    if (lastOpenFiles) {
      const payload = lastOpenFiles
      lastOpenFiles = null
      sendToRenderer('open-files', payload)
    }
  })

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
    // v3.3.7：只放行网页链接。file:// 等任何协议都交给系统打开是不必要的攻击面
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
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
  // v3.3.13：超 2^31-1ms 会被 Node clamp 成 1ms，定时器立刻触发
  sleepMinutes = Math.min(24 * 60, Math.max(0, Math.floor(Number(minutes) || 0)))
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
  sendToRenderer('power-after-queue', 'off')
  sendToRenderer('power-action', { kind, delay: 15 })
  logLine('[power] 队列结束，执行 ' + kind + '（15 秒内可在托盘取消）')

  // 给用户 15 秒反悔时间：误触关机比少关一次机难受得多
  // v3.3.7：先清掉可能还挂着的旧定时器 —— 反悔窗口内重新设置、队列又播完一次时，
  // 直接覆盖会让第一个定时器到点照常执行（届时「取消」只能取消第二个）
  if (powerPending) { clearTimeout(powerPending); powerPending = null }
  powerPending = setTimeout(() => {
    powerPending = null
    refreshTrayMenu()
    if (kind === 'quit') { quitting = true; app.quit(); return }
    try {
      if (kind === 'shutdown') {
        execFile('shutdown', ['/s', '/t', '30'], onShutdownDone)
        // v3.3.13：shutdown /s /t 30 之后系统还有 30 秒可取消窗口，
        // 不能随 15 秒反悔窗口一起消失 —— 单独记标志并排一个 30 秒清理定时器
        systemShutdownPending = true
        if (systemShutdownTimer) clearTimeout(systemShutdownTimer)
        systemShutdownTimer = setTimeout(() => {
          systemShutdownTimer = null
          systemShutdownPending = false
          refreshTrayMenu()
        }, 30000)
        if (systemShutdownTimer.unref) systemShutdownTimer.unref()
      } else if (kind === 'hibernate') {
        execFile('shutdown', ['/h'], onShutdownDone)
      }
    } catch (err) {
      logLine('[power] 执行失败 ' + err.message)
    }
  }, 15000)
  refreshTrayMenu()   // v3.3.13：赋值之后重建，「取消关机」菜单项才真的出现
}

let powerPending = null
/** 系统 shutdown /s /t 30 的 30 秒可取消窗口（独立于 15 秒反悔窗口） */
let systemShutdownPending = false
let systemShutdownTimer = null
function onShutdownDone(err) {
  if (err) logLine('[power] shutdown 命令失败 ' + (err.message || String(err)))
}
function cancelPowerAction() {
  // v3.3.13：15 秒反悔窗口结束后系统关机还有 30 秒可取消，两种状态都要能取消
  if (!powerPending && !systemShutdownPending) return false
  if (powerPending) { clearTimeout(powerPending); powerPending = null }
  if (systemShutdownTimer) { clearTimeout(systemShutdownTimer); systemShutdownTimer = null }
  systemShutdownPending = false
  try { execFile('shutdown', ['/a'], onShutdownDone) } catch (err) { logLine('[power] 取消执行失败 ' + err.message) }
  logLine('[power] 已取消')
  refreshTrayMenu()   // v3.3.9：不然「⚠ 取消关机」菜单项一直残留
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
      ...((powerPending || systemShutdownPending) ? [{ label: '⚠ 取消关机 / 休眠', click: () => cancelPowerAction() }] : []),
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
  // v3.3.10：run 必须声明在 try 外 —— 上一版 const run 在 try 块内，
  // finally 里引用必然 ReferenceError → activeScan 永远清不掉，
  // 后续 watch 扫描全部失效（每 8 秒空转重试）+ 每次一个 unhandledRejection
  let run = null
  try {
    run = library.scan(s.musicDirs, (p) => {
      sendToRenderer('lib:scan-progress', {
        phase: p.phase, done: p.done, total: p.total,
        track: p.track ? toClientTrack(p.track) : null
      })
    })
    activeScan = run
    const res = await run
    if (res && res.skipped) return   // 别把 skipped 当成「扫描完成」广播出去
    logLine('[watch] 完成 ' + JSON.stringify({
      added: res.added, updated: res.updated, removed: res.removed, total: res.total, failed: res.failed
    }))
    sendToRenderer('lib:scan-done', res)
  } catch (err) {
    logLine('[watch] 扫描失败 ' + err.message)
  } finally {
    // v3.3.7：必须条件清空 —— watch 扫描运行中用户手动扫了库，activeScan 已被
    // 换成手动任务的 promise，这里无条件置 null 会让 lib:list 不再等手动扫描。
    // 注意不能再 scheduleWatchScan()：它是文件事件驱动的，这里无条件排一次
    // 会变成「每 16 秒空扫一遍全库」的死循环；扫描期间来的文件事件本来就有挂起的定时器兜底
    if (activeScan === run) activeScan = null
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

/**
 * 只盯当前这首的 lrc 文件：用户在外面改了歌词，立刻告诉渲染层重新读，
 * 不用切歌也不用重启。切到下一首会自动把上一个监听关掉。
 */
let lyricWatch = []
function watchLyricFile(files, trackId) {
  for (const w of lyricWatch) { try { w.close() } catch (err) { /* 忽略 */ } }
  lyricWatch = []
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
  if (!list.length) return
  for (const f of list) {
    try {
      const w = fs.watch(f, { persistent: false }, () => {
        sendToRenderer('lyric:changed', trackId)
      })
      w.on('error', () => { /* 文件被删/改名，下次读的时候重建 */ })
      lyricWatch.push(w)
    } catch (err) { /* 监视不了就算了，mtime 兜底 */ }
  }
}

/* ---------------- 内嵌歌词（按音频 mtime 缓存） ---------------- */

/** trackId → { audioMtime, text }：同一份文件没被改过就不重复解析标签 */
const embLyricCache = new Map()
async function readEmbeddedCached(trackId, audioPath, audioMtime) {
  if (!audioPath || !audioMtime) return null
  const hit = embLyricCache.get(trackId)
  if (hit && hit.audioMtime === audioMtime) return hit.text
  const text = await readEmbeddedLyric(audioPath)
  embLyricCache.delete(trackId)   // v3.3.9：先删再插，淘汰才真的是「最久未用」
  embLyricCache.set(trackId, { audioMtime, text })
  // v3.3.7：加上限 —— 几千首全听一遍会攒几十 MB 歌词全文，不能无限涨
  if (embLyricCache.size > 500) embLyricCache.delete(embLyricCache.keys().next().value)
  return text
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
  let lastLyricBounds = null
  const saveBounds = debounce(() => {
    if (!dlyricWin || dlyricWin.isDestroyed()) return
    lastLyricBounds = dlyricWin.getNormalBounds ? dlyricWin.getNormalBounds() : dlyricWin.getBounds()
    store.patch({ settings: { desktopLyric: { bounds: lastLyricBounds } } })
  }, 400)
  dlyricWin.on('resize', saveBounds)
  dlyricWin.on('move', saveBounds)
  // 关闭前窗口还在，记下最后一次位置（去抖那次可能来不及触发）
  dlyricWin.on('close', () => {
    if (dlyricWin && !dlyricWin.isDestroyed()) {
      try { lastLyricBounds = dlyricWin.getNormalBounds ? dlyricWin.getNormalBounds() : dlyricWin.getBounds() } catch (e) { /* 忽略 */ }
    }
  })

  // 歌词窗口自行关闭（控制条 ✕ 或系统方式）→ 通知主窗口同步按钮状态。
  // 注意退出App时也会触发 closed，用 quitting 区分，避免把 enabled 改没。
  dlyricWin.on('closed', () => {
    // v3.3.13：去抖的那次落盘可能被进程退出吞掉，这里用最后一次位置同步兜一次
    if (lastLyricBounds) {
      try { store.patch({ settings: { desktopLyric: { bounds: lastLyricBounds } } }) } catch (e) { /* 忽略 */ }
    }
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
        ? { type: 'fallback', message: (evt.message || ''), exclusive: false }
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
  if (evt.type === 'ao-lost') {
    logLine('[mpv] ' + (evt.message || '独占输出中断'))
    pushMpvLog('warn', evt.message || '独占输出中断')
  }
  if (evt.type === 'ao-recovered') {
    logLine('[mpv] 独占输出已自动恢复')
    pushMpvLog('info', '独占输出已自动恢复')
  }
  if (evt.type === 'exclusive-lost') {
    logLine('[mpv] ' + (evt.message || '自动夺回独占失败'))
    pushMpvLog('error', evt.message || '自动夺回独占失败')
  }
  if (evt.type === 'error') pushMpvLog('error', evt.message || '引擎错误')
  if (evt.type === 'loaded') pushMpvLog('info', 'file-loaded')
  sendToRenderer('mpv:event', evt)
}

async function ensureMpv(exclusive, opts = {}) {
  if (!mpvEngine) {
    mpvEngine = new MpvEngine({ exePath: mpvExePath(), onEvent: onMpvEvent })
  }
  const wantExclusive = exclusive !== false
  const audioDevice = String(store.get().settings.audioDevice || '').trim()
  const startVolume = Math.max(0, Math.min(1, Number(store.get().settings.volume ?? 1)))
  if (mpvEngine.running) {
    // v3.3.6 / v2.8.6：以前只要引擎在跑就直接返回，不管它现在是独占还是共享 ——
    // 于是「要独占但引擎是共享」时独占根本开不起来（用户看到：开了独占却没位完美），
    // 「要共享但引擎是独占」时则一直霸着声卡。模式对不上就重启到目标模式。
    if (opts.forceMode && mpvEngine.exclusive !== wantExclusive) {
      pushMpvLog('info', '引擎模式与请求不一致（当前 ' + (mpvEngine.exclusive ? '独占' : '共享') + '），重启为' + (wantExclusive ? '独占' : '共享'))
      const r = await mpvEngine.restart({ exclusive: wantExclusive, audioDevice, volume: startVolume })
      if (r.ok) startDeviceWatch()
      return r
    }
    return { ok: true, exclusive: mpvEngine.exclusive }
  }
  // 输出设备来自设置；空字符串 = 跟随系统默认
  // v2.5：启动音量跟随设置（以前 mpv 固定 --volume=100，重启引擎音量就被重置）
  pushMpvLog('info', '启动引擎：exclusive=' + wantExclusive + ' ao=' + (process.env.LX_TEST_MUTE === '1' ? 'null(测试静音)' : 'wasapi') + ' device=' + (audioDevice || '(系统默认)') + ' volume=' + Math.round(startVolume * 1000) / 10)
  const r = await mpvEngine.start({ exclusive: wantExclusive, audioDevice, volume: startVolume })
  logLine('[mpv] start exclusive=' + wantExclusive + ' ' + JSON.stringify(r) + ' exe=' + mpvExePath())
  pushMpvLog(r.ok ? 'info' : 'error',
    '启动结果：' + (r.ok ? 'ok' : '失败 ' + (r.error || '')) + ' exe=' + mpvExePath())
  // 独占流跑起来之后才开始盯设备（共享模式下 mpv 自己会跟系统默认设备走）
  if (r.ok && wantExclusive) startDeviceWatch()
  return r
}

/**
 * 关掉引擎，并**确认声卡真的还回来了**。
 *
 * v3.3.6 / v2.8.6：用户报「开了独占再关掉，其他软件还是没声音，播放器自己还能继续放」。
 * 根因是「关独占」以前只做了两件事：发信号杀进程 + 立刻重载界面，
 * 既没等进程真退出，也没检查设备是否真的释放，更没扫掉可能残留的孤儿进程。
 * 现在这条路径做全套：
 *   1) 等 mpv 进程真正退出（stop()）；
 *   2) 扫一遍属于本进程却还活着的 mpv（竞态产生的孤儿），一律杀掉；
 *   3) 用一个共享模式的 mpv 实测设备能不能打开；
 *   4) 还占着就把结果回报给界面，明确告诉用户，而不是让用户自己猜。
 */
async function releaseMpv({ probe = true } = {}) {
  const eng = mpvEngine
  mpvEngine = null
  stopDeviceWatch()
  let exited = true
  if (eng) {
    pushMpvLog('info', '关闭引擎')
    const r = await eng.stop()
    exited = !!r.exited
    if (!exited) pushMpvLog('warn', '引擎进程没有正常退出（pid ' + r.pid + '），已强制结束')
  }
  // 扫残留：属于本进程（管道名里带本 PID）的 mpv 一定是我们的，活着就是孤儿
  const leftover = await sweepOurMpv()
  if (leftover.length) {
    pushMpvLog('warn', '发现残留的 mpv 进程（已强杀）：' + leftover.join(', '))
    logLine('[mpv] 残留孤儿进程已清理: ' + leftover.join(','))
  }
  let blocked = false
  let detail = ''
  if (probe) {
    const p = await probeDeviceFree()
    blocked = !!p.blocked
    detail = p.detail || ''
    pushMpvLog(blocked ? 'warn' : 'info', blocked ? '声卡仍被占用：别的程序可能还是没声音' : '声卡已释放，其他程序可以正常发声')
  }
  return { ok: true, exited, leftover, blocked, detail }
}

/** 列出（并杀掉）属于本进程的残留 mpv —— 竞态产生的孤儿会一直霸着声卡 */
async function sweepOurMpv(listTimeout = 8000, killTimeout = 5000) {
  if (process.platform !== 'win32') return []
  const selfPid = process.pid
  const script = [
    'Get-CimInstance Win32_Process -Filter "Name=\'mpv.exe\'" | ForEach-Object {',
    '  $m = [regex]::Match($_.CommandLine, \'lxmpv-(\\d+)-\')',
    '  if (-not $m.Success) { return }',
    '  if ([int]$m.Groups[1].Value -ne ' + selfPid + ') { return }',
    '  $_.ProcessId',
    '}'
  ].join('\n')
  // v3.3.9：改异步 —— 同步版（execFileSync 8 秒 + 逐个 taskkill 各 5 秒）会把主进程
  // 事件循环卡到 13 秒，期间流代理和所有 IPC 全部停摆
  const listPids = () => new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: listTimeout }, (err, stdout) => {
        if (err || !stdout) return resolve([])
        resolve(String(stdout).split(/\r?\n/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x)))
      })
  })
  const killPid = (pid) => new Promise((resolve) => {
    execFile('taskkill', ['/PID', pid, '/F'], { windowsHide: true, timeout: killTimeout }, () => resolve())
  })
  const pids = await listPids()
  for (const pid of pids) await killPid(pid)
  return pids
}

/** 探测用的 0.5 秒静音 wav（mpv 得有东西播才会去开声卡） */
let probeWavPath = ''
function ensureProbeWav() {
  if (probeWavPath) { try { if (fs.existsSync(probeWavPath)) return probeWavPath } catch {} }
  try {
    const rate = 48000
    const frames = Math.floor(rate * 0.5)
    const bytes = frames * 2
    const buf = Buffer.alloc(44 + bytes)
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8)
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
    buf.write('data', 36); buf.writeUInt32LE(bytes, 40)
    probeWavPath = path.join(DATA_DIR, 'probe-silence.wav')
    fs.writeFileSync(probeWavPath, buf)
    return probeWavPath
  } catch (err) {
    return ''
  }
}

/**
 * 实测声卡现在能不能被别人用：拿共享模式的 mpv 试着打开默认设备。
 * 打不开（AUDCLNT_E_DEVICE_IN_USE）就说明还被谁占着 —— 这就是「其他软件没声音」的判定依据。
 * 顺带效果：以共享方式打开一次，Windows 会把端点的独占状态清干净，别人更容易立刻接回来。
 */
function probeDeviceFree() {
  return new Promise((resolve) => {
    const wav = ensureProbeWav()
    const exe = mpvExePath()
    if (!wav || !exe || !fs.existsSync(exe)) {
      resolve({ blocked: false, detail: 'mpv 不可用，跳过探测' })
      return
    }
    const args = [
      '--no-config', '--no-video', '--ao=wasapi', '--audio-exclusive=no',
      '--length=0.4', '--msg-level=all=warn', wav
    ]
    // 探测的必须是「用户实际在用的那个设备」：独占是按设备占的，
    // 探测默认设备而用户选的是 USB DAC，就会漏判（明明还占着却报可用）。
    const dev = String(store.get().settings.audioDevice || '').trim()
    if (dev) args.splice(3, 0, '--audio-device=' + dev)
    execFile(exe, args, { windowsHide: true, timeout: 12000 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '')
      const blocked = /AUDCLNT_E_DEVICE_IN_USE|0x8889000a|EXCLUSIVE_MODE/i.test(out)
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || ''
      resolve({ blocked, detail: blocked ? first : '' })
    })
  })
}

function stopMpv() {
  // 保留旧的同步入口（退出流程用），真正等待进程退出的逻辑在 releaseMpv() 里
  const eng = mpvEngine
  mpvEngine = null
  stopDeviceWatch()
  if (!eng) return Promise.resolve({ ok: true, exited: true })
  pushMpvLog('info', '关闭引擎')
  return eng.stop()
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
    // v3.3.6 / v2.8.6：抓住这一轮的引擎实例。下面 await 期间用户可能已经关了独占
    // （引擎被换掉/停掉）。这时如果还拿旧实例去 restart()，就会在「关独占」之后
    // 又起一个新的独占 mpv —— 那个进程没人管，就是一个霸着声卡的孤儿。
    const eng = mpvEngine
    const cur = String(store.get().settings.audioDevice || '')
    let devs
    try {
      devs = await eng.listDevices()
    } catch {
      return
    }
    // await 之后重新确认：引擎还是同一个、还在跑、独占仍然开着
    if (mpvEngine !== eng || !eng.running || !store.get().settings.exclusiveOutput) return
    const names = new Set(devs.map((d) => d.name))
    if (cur && !names.has(cur)) {
      lostDevice = cur
      pushMpvLog('error', '输出设备已断开：' + cur + ' → 自动切回系统默认')
      logLine('[device] 设备断开，回退系统默认：' + cur)
      store.patch({ settings: { audioDevice: '' } })
      sendToRenderer('device-lost', { device: cur, restored: false })
      try { await eng.restart({ exclusive: true, audioDevice: '' }) } catch {}
      return
    }
    if (!cur && lostDevice && names.has(lostDevice)) {
      const back = lostDevice
      lostDevice = ''
      pushMpvLog('info', '输出设备已接回：' + back + ' → 自动切回')
      logLine('[device] 设备接回，自动切回：' + back)
      store.patch({ settings: { audioDevice: back } })
      sendToRenderer('device-lost', { device: back, restored: true })
      try { await eng.restart({ exclusive: true, audioDevice: back }) } catch {}
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
    dlSaveNow()
  }, 700)
}

/** 立即落盘（退出前调用；平时走去抖） */
function dlSaveNow() {
  if (dlSaveTimer) { clearTimeout(dlSaveTimer); dlSaveTimer = null }
  try {
    const keep = Array.from(dlTasks.values())
      .filter((t) => t.status !== 'done' && t.status !== 'error')
      .map((t) => ({
        id: t.id, key: t.key, song: t.song, status: 'paused',
        received: t.received || 0, total: t.total || 0,
        path: t.path || '', ext: t.ext || '', at: t.at || 0
      }))
    atomicWriteJson(dlFile(), keep)
  } catch (err) { /* 写不进去就算了，不影响下载 */ }
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
  let endTimer = null   // 写盘收尾的 10 秒超时句柄，finally 里兜底清理
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
    // v3.3.9：写流必须有 error 监听 + drain 要与「写错误/abort」竞速 ——
    // 以前磁盘满/文件被锁时：error 无人处理直接 uncaughtException，
    // 而循环卡在 await drain 上永远出不来（abort 只作用于下一次 read），
    // 任务永久停在 downloading，暂停/删除全部失效
    const wsError = new Promise((resolve) => ws.once('error', (e) => resolve(e)))
    const abortedEv = new Promise((resolve) => {
      if (ctrl.signal) {
        if (ctrl.signal.aborted) resolve({ aborted: true })
        else ctrl.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true })
      }
    })
    const reader = res.body.getReader()
    let lastT = Date.now()
    let lastB = task.received
    let lastEmit = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      task.received += buf.length
      if (!ws.write(buf)) {
        const ev = await Promise.race([
          new Promise((r) => ws.once('drain', r)),
          wsError.then((e) => ({ wsErr: e })),
          abortedEv
        ])
        if (ev && ev.wsErr) throw ev.wsErr
        if (ev && ev.aborted) throw Object.assign(new Error('download aborted'), { name: 'AbortError' })
      }
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
    // v3.3.13：写流在 end() 前/中出错时 finish 永不触发 → 任务永久挂起。
    // 与 drain 一样必须与「写错误/abort/超时」竞速
    const ended = await Promise.race([
      new Promise((r) => ws.end(r)),
      wsError.then((e) => ({ wsErr: e })),
      abortedEv,
      new Promise((r) => { endTimer = setTimeout(() => r({ timeout: true }), 10000) })
    ])
    if (endTimer) { clearTimeout(endTimer); endTimer = null }
    if (ended && ended.wsErr) throw ended.wsErr
    if (ended && ended.aborted) throw Object.assign(new Error('download aborted'), { name: 'AbortError' })
    if (ended && ended.timeout) throw new Error('写盘收尾超时')
    ws = null
    if (task.deleted) throw Object.assign(new Error('__deleted'), { name: 'AbortError' })
    if (task.total && task.received + 1024 < task.total) throw new Error('下载不完整（连接中断）')
    fs.renameSync(part, task.path)
    task.status = 'done'
    task.speed = 0
    if (task.total) task.received = task.total
    logLine('[dl] 完成', path.basename(task.path), (task.received / 1048576).toFixed(1) + 'MB')
    // 落盘后丢给曲库做增量扫描，下载完就能在「最近添加」里看到
    // v3.3.9：下载目录也要一并扫（用户自选目录往往不在 musicDirs 里，
    // 以前下完的歌永远不进库）；扫描进行中被跳过时 30 秒后补一次
    if (library) {
      const scanDirs = Array.from(new Set([...(store.get().settings.musicDirs || []), downloadDir()]))
      library.scan(scanDirs).then((r) => {
        if (r && r.skipped) {
          // 补扫 timer 存句柄：触发即清，任务被删除时 dlDelete 也会清
          task.rescanTimer = setTimeout(() => {
            task.rescanTimer = null
            try { library.scan(scanDirs).catch(() => {}) } catch (e) { /* 忽略 */ }
          }, 30000)
          if (task.rescanTimer.unref) task.rescanTimer.unref()
        }
      }).catch(() => {})
    }
  } catch (err) {
    if (ws) { try { ws.destroy() } catch (e) { /* 忽略 */ } }
    if (task.deleted) {
      dlTasks.delete(task.id)
      dlUnlinkRetry(task.path ? task.path + '.part' : '')
      dlUnlinkRetry(task.path || '')
    } else if (err && (err.name === 'AbortError' || /abort/i.test(err.message || ''))) {
      // v3.3.10：回落判据改用 abort 归属（与 finally 同构）——
      // 上一版用 status==='downloading' 判断，而 dlPause 是先置 pausing 再 abort，
      // 守卫永不满足 → 每次点暂停任务都永久卡在 pausing（继续/删除/重下全部失效）
      if (task.abort === ctrl) { task.status = 'paused'; task.speed = 0 }
    } else {
      task.status = 'error'
      task.error = (err && err.message) || '下载失败'
      task.speed = 0
      logLine('[dl] 失败', task.error)
    }
  } finally {
    if (endTimer) { clearTimeout(endTimer); endTimer = null }
    // v3.3.13：异常路径也要释放写流句柄
    if (ws) { try { ws.destroy() } catch (e) { /* 忽略 */ } }
    // v3.3.9：只清掉自己这轮的 abort 控制器，别抹掉新一轮任务的
    if (task.abort === ctrl) task.abort = null
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

/** 递归剔除 __proto__ / constructor / prototype 等原型污染键（保留其它值） */
const FORBIDDEN_SETTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function sanitizePlainValue(v) {
  if (Array.isArray(v)) return v.map(sanitizePlainValue)
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_SETTING_KEYS.has(k)) continue
      o[k] = sanitizePlainValue(x)
    }
    return o
  }
  return v
}
/**
 * 按 DEFAULT_SETTINGS 的形状校验一个 settings patch：
 *  · 只放行模板里已有的键（顶层白名单）；
 *  · 数组元素类型须与模板一致、数值键须为有限数、布尔键须为布尔、字符串键须为字符串；
 *  · 空对象模板 = 数值 map（歌词偏移/增益/断点），只留有限数；
 *  · 递归拒绝 __proto__/constructor/prototype，未知类型一律丢弃。
 * template 传 DEFAULT_SETTINGS.desktopLyric 即可用于 dlyric:cfg 的子对象过滤。
 */
function sanitizeSettingsPatch(patch, template = DEFAULT_SETTINGS) {
  const out = {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  if (!template || typeof template !== 'object') return out
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_SETTING_KEYS.has(k)) continue
    if (!Object.prototype.hasOwnProperty.call(template, k)) continue  // 白名单
    const tv = template[k]
    if (Array.isArray(tv)) {
      if (!Array.isArray(v)) continue
      if (tv.length && !v.every((x) => typeof x === typeof tv[0])) continue
      out[k] = v.map(sanitizePlainValue)
    } else if (tv && typeof tv === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const tvKeys = Object.keys(tv)
      if (tvKeys.length === 0) {
        // 空对象模板 = 数值 map（lyricOffsetById / trackGains / manualGains / resumePos）
        const clean = {}
        for (const [mk, mv] of Object.entries(v)) {
          if (FORBIDDEN_SETTING_KEYS.has(mk)) continue
          if (typeof mv === 'number' && Number.isFinite(mv)) clean[mk] = mv
        }
        out[k] = clean
      } else {
        out[k] = sanitizeSettingsPatch(v, tv)
      }
    } else if (tv === null) {
      // 模板为 null = 自由结构（窗口 bounds 等），只做递归去污染键
      out[k] = sanitizePlainValue(v)
    } else if (typeof tv === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    } else if (typeof tv === 'boolean') {
      if (typeof v === 'boolean') out[k] = v
    } else if (typeof tv === 'string') {
      if (typeof v === 'string') out[k] = v
    }
    // 其余类型（undefined/function/...）→ 拒绝该键
  }
  return out
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
    // v3.3.13：已有扫描在跑时 library.scan() 会立刻返回 { skipped: true }。
    // 绝不能把这个 skipped 的 run 赋给 activeScan（会覆盖真扫描引用，
    // lib:list 的 await activeScan 便不再等待 → 渲染层读到半成品曲库），
    // 也不能广播「扫描完成」让界面提前收起进度。
    if (library.scanning || activeScan) {
      return { skipped: true, added: 0, updated: 0, removed: 0, failed: 0, total: library.list().length }
    }
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
      if (res && res.skipped) return res   // 竞态兜底：不要广播 skipped
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
    // v3.3.13：键白名单 + 按 DEFAULT_SETTINGS 形状做值校验 + 递归防原型污染
    const filtered = sanitizeSettingsPatch(patch, DEFAULT_SETTINGS)
    const blocked = []
    for (const k of Object.keys(patch && typeof patch === 'object' ? patch : {})) {
      if (!Object.prototype.hasOwnProperty.call(filtered, k)) blocked.push(k)
    }
    if (blocked.length) logLine('[settings] 拒绝非法/未知设置键:', blocked.join(', '))
    const prevDirs = JSON.stringify(before.musicDirs || [])
    const prevWatch = before.watchFolders
    const next = store.patch({ settings: filtered }).settings
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
    // v3.3.10：改整体替换（Store.setKey）—— deepMerge 会让旧 session 的键永久残留，
    // 恢复播放可能拿到过时字段
    store.setKey('session', session && typeof session === 'object' ? session : {})
    return true
  })

  // —— 歌词 ——
  /**
   * v3.3.3：返回值从「纯文本」改成 { text, mtimeMs }，并顺手监听这个 lrc 文件。
   *
   * 之前渲染层按 trackId 永久缓存解析结果，用户在资源管理器里改完 .lrc，
   * 不重启播放器就一直是旧歌词（用户反馈的「改了歌词软件里还是旧的」）。
   * 现在渲染层用 mtime 判断要不要重新读；文件一改还会推 lyric:changed 让它立刻刷新。
   */
  ipcMain.handle('lyric:read', async (e, trackId) => {
    const track = library.get(trackId)
    if (!track) {
      watchLyricFile(null)
      return null
    }

    const lrc = track.lyric || null
    const audio = track.path || null
    const mtimeOf = (p) => { try { return p ? fs.statSync(p).mtimeMs : 0 } catch (err) { return 0 } }
    const lrcMtime = mtimeOf(lrc)
    const audioMtime = mtimeOf(audio)

    // v3.3.4：外置 .lrc 与内嵌 LYRICS 谁改得新用谁。
    // 只比「文件修改时间」：改 .lrc 会让 lrc 变新，改标签（Mp3tag 等）会让音频文件变新，
    // 两边都不用手动选。之前固定外置优先，才出现「标签改了但界面还是旧词」。
    if (lrc && lrcMtime && lrcMtime >= audioMtime) {
      try {
        const buf = await fsp.readFile(lrc)
        watchLyricFile([lrc, audio], trackId)
        return { text: decodeText(buf), mtimeMs: lrcMtime, source: 'lrc' }
      } catch (err) { /* 读不到就往下试内嵌 */ }
    }

    const emb = await readEmbeddedCached(trackId, audio, audioMtime)
    if (emb) {
      watchLyricFile([audio], trackId)
      return { text: emb, mtimeMs: audioMtime, source: 'embedded' }
    }

    if (lrc) {
      try {
        const buf = await fsp.readFile(lrc)
        watchLyricFile([lrc], trackId)
        return { text: decodeText(buf), mtimeMs: lrcMtime, source: 'lrc' }
      } catch (err) { /* 忽略 */ }
    }
    watchLyricFile(null)
    return null
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
      // v3.3.13：streamUrl 是无人读取的死字段（渲染层走 online:proxyBase 自己拼 /stream），移除
      return {
        ok: true,
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
      const probeRun = online.getPlayable(song, prefer)
      probeRun.catch(() => {})   // v3.3.9：超时后丢弃的那份别变成 unhandledRejection
      let probeTimer = null
      const timerP = new Promise((r) => { probeTimer = setTimeout(() => r(null), 8000) })
      let info
      try {
        info = await Promise.race([probeRun, timerP])
      } finally {
        clearTimeout(probeTimer)   // v3.3.13：成功也要清，别留 8 秒空定时器
      }
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
      // v3.3.7：加上限淘汰，长会话不再缓慢膨胀
      if (probeCache.size > 500) {
        const now = Date.now()
        for (const [k, v] of probeCache) { if (now - v.at > PROBE_TTL) probeCache.delete(k) }
        while (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value)
      }
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
      if (t.status === 'downloading' || t.status === 'queued' || t.status === 'pausing') return { ok: false, error: '这首正在下载中', id: t.id }
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
    // v3.3.9：pausing 必须拦 —— abort 还在途时续传会双写同一个 .part（文件损坏），
    // 且旧循环的 finally 会把新任务的 abort 控制器抹掉，任务从此无法暂停/删除
    // v3.3.13：done/error 也拒绝，避免重跑覆盖已完成/已失败的任务
    if (!t || t.status === 'downloading' || t.status === 'queued' || t.status === 'pausing' ||
        t.status === 'done' || t.status === 'error') return { ok: false }
    t.status = 'paused'
    dlRun(t)
    return { ok: true }
  })

  ipcMain.handle('online:dlDelete', (e, id) => {
    const t = dlTasks.get(String(id))
    if (!t) return { ok: false }
    // v3.3.10：卡在 pausing 且下载循环已退出（abort 控制器已被 finally 清掉）的
    // 兜底 —— abort() 不会有人响应，直接当 paused 走下面的正常删除路径
    if (t.status === 'pausing' && !t.abort) t.status = 'paused'
    if (t.status === 'downloading' || t.status === 'queued' || t.status === 'pausing') {
      // 让下载线程自己收尾：abort → catch 里发现 deleted → 删残片、摘任务
      // v3.3.9：pausing 也走这条路 —— 在途写盘没结束时直接摘任务会与写盘竞态
      t.deleted = true
      try { if (t.abort) t.abort.abort() } catch (err) { /* 忽略 */ }
      return { ok: true }
    }
    dlTasks.delete(t.id)
    if (t.rescanTimer) { clearTimeout(t.rescanTimer); t.rescanTimer = null }
    // 已完成的文件是用户的音乐，不删；没完成的残片才清（带重试，见 dlUnlinkRetry）
    if (t.status !== 'done' && t.path) dlUnlinkRetry(t.path + '.part')
    dlBroadcast(true)
    return { ok: true }
  })

  ipcMain.handle('online:dlClearDone', () => {
    let n = 0
    for (const [id, t] of dlTasks) {
      if (t.status === 'done' || t.status === 'error') {
        // v3.3.13：error/未完成任务的 .part 残片别留着
        if (t.status !== 'done' && t.path) dlUnlinkRetry(t.path + '.part')
        if (t.rescanTimer) { clearTimeout(t.rescanTimer); t.rescanTimer = null }
        dlTasks.delete(id); n++
      }
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
    if (filePath && fs.existsSync(filePath) && isAllowedMediaPath(filePath)) shell.showItemInFolder(filePath)
  })

  // —— 窗口控制 ——
  ipcMain.handle('win:minimize', () => win && win.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win) return false
    // v3.3.7：unmaximize 在 Windows 上是异步的，紧接着 isMaximized() 拿到的是
    // 切换前的旧值，渲染层图标会和实际状态相反 —— 返回「切换意图」
    const wasMax = win.isMaximized()
    if (wasMax) win.unmaximize()
    else win.maximize()
    return !wasMax
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
    // v3.3.13：复用 settings patch 过滤（只允许 desktopLyric 已有键 + 值校验 + 防原型污染）
    const clean = sanitizeSettingsPatch(patch, DEFAULT_SETTINGS.desktopLyric)
    store.patch({ settings: { desktopLyric: clean } })
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
  ipcMain.handle('mpv:start', (e, exclusive) => ensureMpv(exclusive !== false, { forceMode: true }))
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
    // v3.3.7：引擎没跑起来还返回 true，渲染层会以为加载成功，界面假「播放中」
    if (!mpvEngine || !mpvEngine.running) return false
    // v3.3.9：本地文件只放行曲库/下载/数据目录之内（网址不受限，播放走的是本机代理）
    if (!/^https?:\/\//i.test(target) && !isAllowedMediaPath(target)) {
      logLine('[mpv] 拒绝加载曲库目录之外的文件:', target)
      return false
    }
    mpvEngine.load(target, opts || {})
    return true
  })
  ipcMain.handle('mpv:play', () => { if (mpvEngine) mpvEngine.play(); return true })
  ipcMain.handle('mpv:pause', () => { if (mpvEngine) mpvEngine.pause(); return true })
  // v3.3.13：日常「停止播放」用 reset()（不报废引擎）；stop() 是关独占/退出语义，
  // 会置 _disposed 让引擎永久报废，绝不能用于这里
  ipcMain.handle('mpv:stop', () => { if (mpvEngine) mpvEngine.reset(); return true })
  ipcMain.handle('mpv:seek', (e, sec) => { if (mpvEngine) mpvEngine.seek(Number(sec) || 0); return true })
  ipcMain.handle('mpv:volume', (e, v) => { if (mpvEngine) mpvEngine.setVolume(Number(v) || 0); return true })
  ipcMain.handle('mpv:mute', (e, m) => { if (mpvEngine) mpvEngine.setMute(!!m); return true })
  // A-B 循环（v2.1）：a=null 清除
  ipcMain.handle('mpv:setAbLoop', (e, a, b) => {
    if (mpvEngine) mpvEngine.setAbLoop(a, b)
    return true
  })
  ipcMain.handle('mpv:quit', () => { stopMpv(); return true })
  // v3.3.6 / v2.8.6：完整的「释放独占」流程 —— 等进程真退出 + 扫残留孤儿 + 实测声卡
  ipcMain.handle('mpv:release', async () => {
    try {
      return await releaseMpv({ probe: true })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  // 只探测「声卡现在能不能给别人用」，不动引擎（诊断面板用）
  ipcMain.handle('mpv:probeDevice', async () => {
    try {
      return await probeDeviceFree()
    } catch (err) {
      return { blocked: false, detail: err.message }
    }
  })
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
    let eng = null
    try {
      if (!mpvEngine || !mpvEngine.running) {
        const r = await ensureMpv(false)
        if (!r.ok) return { ok: false, devices: [], error: r.error || '引擎未启动' }
        startedHere = true
      }
      eng = mpvEngine
      const devices = await eng.listDevices()
      return { ok: true, devices }
    } catch (err) {
      return { ok: false, devices: [], error: err.message }
    } finally {
      // 只为枚举而临时拉起的引擎用完即关，不留空闲进程。
      // v3.3.9：但枚举的几百毫秒里用户可能点了播放（引擎被复用加载了文件），
      // 这时不能杀 —— 用「引擎还是同一个且从未加载过文件」作判据。
      // v3.3.13：枚举期间被切成独占的引擎（restart 不换实例也不改 _lastFile）不能误杀
      if (startedHere && mpvEngine === eng && !eng._lastFile && eng.exclusive === false) stopMpv()
    }
  })

  /** 切换输出设备：存设置；正在独占播放时重启引擎并回到原位置 */
  ipcMain.handle('mpv:setDevice', async (e, device) => {
    const name = String(device || '')
    const prevDevice = String(store.get().settings.audioDevice || '')
    store.patch({ settings: { audioDevice: name } })
    if (!mpvEngine || !mpvEngine.running) return { ok: true, applied: false }
    if (!store.get().settings.exclusiveOutput) return { ok: true, applied: false }
    // v2.5：重启时带上当前音量（重启后不再被重置成 100；播放状态由 restart 内部恢复）
    const startVolume = Math.max(0, Math.min(1, Number(store.get().settings.volume ?? 1)))
    const r = await mpvEngine.restart({ exclusive: true, audioDevice: name, volume: startVolume })
    // v3.3.13：重启彻底失败 → 设置回退到调用前的值，避免界面显示的设备与实际不符
    if (!r.ok) {
      store.patch({ settings: { ...store.get().settings, audioDevice: prevDevice } })
      return { ok: false, applied: true, error: r.error }
    }
    // 新设备起不来时 mpv.js 会退回原设备；这时设置也得跟着回退，否则界面显示的和实际用的不一致
    if (r.audioDevice && r.audioDevice !== name) {
      store.patch({ settings: { ...store.get().settings, audioDevice: r.audioDevice } })
      return { ok: true, applied: true, reverted: true, device: r.audioDevice, error: '该设备不可用，已退回原设备' }
    }
    return { ok: true, applied: true, error: r.error }
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
  // v3.3.13：只接受主窗口 webContents，别让其它窗口/注入内容触发关机
  ipcMain.on('player:queue-end', (e) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return
    runPowerAction()
  })
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
  // v3.3.10：锁 API 抛异常 ≠ 已有实例在跑。以前 gotLock 保持 false 直接退出，
  // 变成「永远启动不了」（data 目录被杀软锁定等便携环境常见）。fail-open 更安全：
  // 双实例的最坏后果（抢 mpv）远好过永远起不来
  logLine('WARN 单实例锁异常，按拿到锁处理', err.message)
  gotLock = true
}
logLine('stage: lock=' + gotLock)
if (!gotLock) {
  logLine('已有实例在运行，本进程退出')
  app.exit(0)
}

// 只在确认是唯一实例时清缓存：多实例情况下删的是正在运行实例的文件（多半删不掉）
if (gotLock) cleanChromiumCache()
{
  app.on('second-instance', async (event, argv) => {
    if (win) {
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    // v3.3.10：第二实例带的文件参数以前被完全忽略（双击关联文件/拖到 exe 上毫无反应）。
    // 应用按「文件夹」组织曲库、单文件导入尚未实现，先把路径转给渲染层给出可见反馈
    // v3.3.13：路径统一 resolve 成绝对路径；stat 改异步；缓存 payload 供窗口就绪后补发
    const media = []
    for (const raw of (argv || [])) {
      const a = String(raw)
      if (a.length > 240 || a.startsWith('\\\\') ||
          !/\.(mp3|flac|m4a|wav|ogg|opus|dsf|dff|aac|wma|ape|alac|m3u|m3u8)$/i.test(a)) continue
      const abs = path.resolve(a)
      try {
        const st = await fsp.stat(abs)
        if (st.isFile()) media.push(abs)
      } catch (e) { /* 排除目录/不存在/UNC 阻塞 */ }
    }
    if (media.length) {
      lastOpenFiles = { paths: media }
      sendToRenderer('open-files', lastOpenFiles)
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
        .then((res) => { if (res && res.skipped) return; sendToRenderer('lib:scan-done', res) })
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

  // v3.3.10：托盘「退出」的最后一次窗口 bounds patch 发生在窗口 close 事件里
  // （晚于 before-quit 里的 flush），这里再兜一次，不然 250ms 的去抖定时器会被进程退出吞掉
  app.on('will-quit', () => { try { if (store) store.flush() } catch (err) { /* 忽略 */ } })

  // v3.3.7：退出前必须等清理真正做完再退 ——
  // 以前 stopMpv 的 Promise 没 await，后面的同步清扫还会阻塞事件循环，
  // 让「等 mpv 进程退出」形同虚设；进程万一没死透就退出，声卡就被孤儿占着。
  let quitCleanupDone = false
  let cleanupStarted = false
  app.on('before-quit', (event) => {
    // v3.3.13：一进入就置位，清理窗口内重复 app.quit() 不再重复跑整条链；
    // 未清理完前顺手 preventDefault，避免重复退出请求把进程提前带走、腰斩清理
    if (cleanupStarted) {
      if (!quitCleanupDone) event.preventDefault()
      return
    }
    cleanupStarted = true
    event.preventDefault()
    quitting = true
    stopWatching()
    const hadEngine = !!mpvEngine
    // v3.3.13：清理链必须能收敛 —— stopMpv 的 Promise 万一永不 settle，
    // 也不能让用户只能 taskkill。20 秒后无条件退出（> _stopProcess 最坏 8.2s + sweep 8s）。
    const finishQuit = () => {
      if (quitCleanupDone) return
      quitCleanupDone = true
      try { dlSaveNow() } catch (err) { /* 忽略 */ }   // 任何退出路径都不丢下载任务（幂等）
      try { if (store) store.flush() } catch (err) { /* 忽略 */ }
      try { if (tray) tray.destroy() } catch (err) { /* 忽略 */ }
      app.quit()
    }
    const quitGuard = setTimeout(() => {
      // 兜底：清理链没收敛也要退。best-effort 短超时清一次孤儿 mpv，
      // 用硬超时保证 finishQuit 一定执行，绝不长时间阻塞事件循环
      const hard = setTimeout(finishQuit, 3500)
      try {
        sweepOurMpv(2000, 1500).catch(() => {}).finally(() => {
          clearTimeout(hard)
          finishQuit()
        })
      } catch (e) { clearTimeout(hard); finishQuit() }
    }, 20000)
    try {
      stopMpv().catch(() => {}).finally(() => {
        (async () => {
          if (hadEngine) { try { await sweepOurMpv() } catch (err) { /* 忽略 */ } }
          try { dlSaveNow() } catch (err) { /* 忽略 */ }
          clearTimeout(quitGuard)
          finishQuit()
        })()
      })
    } catch (err) {
      clearTimeout(quitGuard)
      finishQuit()
    }
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
