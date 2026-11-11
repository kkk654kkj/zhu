'use strict'
/**
 * v3.3.24 模块拆分：从 main.js 原样搬出（master 切片版——本地版白名单无缓存/下载目录分支）。
 * init(G) 注入 main 的共享状态访问器（getter，见 main.js 的 G 定义）。
 */
const path = require('path')
const fs = require('fs')
const { Readable } = require('stream')
const { protocol, shell } = require('electron')

let G = null
function init(g) { G = g }

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
  return AUDIO_MIME[ext] || G.MIME_BY_EXT[ext] || 'application/octet-stream'
}

/**
 * 带 TTL + 上限的 realpath 缓存：曲库目录里的 junction/符号链接被重新指向后
 * 最多 5 秒即重新解析。
 *
 * 注意：本地版此前**从未定义过这个函数**，而 isAllowedMediaPath / lxfile 协议
 * 一直在调用它 —— 每次打开本地文件都会抛 ReferenceError（被协议层的 catch 吞成 500），
 * 表现为「本地歌全部放不出来」。这里补齐（与联网版同源实现）。
 */
const REALPATH_TTL = 5000

const REALPATH_MAX = 512

const realpathCache = new Map()

function realpathCached(p) {
  const now = Date.now()
  const hit = realpathCache.get(p)
  if (hit && now - hit.at < REALPATH_TTL) return hit.val
  let val = null
  try { val = fs.realpathSync.native(p) } catch (e) { val = null }
  // 满了就逐条淘汰最早的，而不是整表 clear()：clear 会让每个 Range 请求
  // 都把所有 root 重新 realpathSync 一遍（主进程同步 IO）
  while (realpathCache.size >= REALPATH_MAX) realpathCache.delete(realpathCache.keys().next().value)
  realpathCache.set(p, { val, at: now })
  return val
}

// Windows 驱动器相对根「D:」（无斜杠）path.resolve 会落到 cwd，补上分隔符。
// 本地版此前缺这个函数（白名单一调用就 ReferenceError），这里补齐。
function fixDriveRoot(s) {
  const t = String(s == null ? '' : s).trim()
  return /^[A-Za-z]:$/.test(t) ? t + path.sep : t
}

/** v2.8.12：媒体路径白名单（模块作用域，协议层与 IPC 共用） */
/**
 * 明显不该当媒体根的位置：盘符根、Windows / Program Files / ProgramData。
 * settings.musicDirs 等键都能由渲染层 patch 写入，一旦渲染层被注入（恶意标签/歌词），
 * 把它们改成 'C:\\' 就能让 lxfile:// 读到任意文件。
 * 这里只挡「整盘 / 系统目录」，用户把音乐放在 C:\Users\me\Music 这类正常路径不受影响。
 */
const DANGEROUS_ROOT = /^[a-z]:[\\/]?$|^[a-z]:[\\/](windows|program files|program files \(x86\)|programdata)([\\/]|$)/i

const EXTRA_FORBIDDEN_ROOT = /^[a-z]:[\\/](users[\\/](public|default|all users|default user)|program files( \(x86\))?|windows|programdata|system volume information|\$recycle\.bin)([\\/]|$)/i

function isSafeMediaRoot(r) {
  const p = String(r == null ? '' : r).trim()
  if (!p) return false
  // 第四轮 §4.1 #4：DANGEROUS_ROOT 是黑名单，只挡盘符根与 4 个系统目录，
  // 共享路径（UNC）、设备路径、带协议的 URL 都会漏过；变成白名单根之后
  // 整个共享/设备树都能当媒体目录读。这里显式拒绝。
  if (!/[a-zA-Z]:[\\/]|^[\\/]{1,2}[^\\/]/.test(p)) return false
  if (/^[\\/]{2}(\?|\\.)[\\/]/.test(p)) return false   // 设备路径
  if (/^[\\/]{2}/.test(p)) return false                     // UNC
  if (/^[a-zA-Z]+:\/\//.test(p)) return false               // 带协议的 URL
  // 所有用户可写的共享目录同样是符号链接攻击面，DANGEROUS_ROOT 没覆盖，这里补一层
  if (EXTRA_FORBIDDEN_ROOT.test(p)) return false
  return !DANGEROUS_ROOT.test(p)
}

function isAllowedMediaPath(p) {
  // abs 与每个 root 都取 realpath：曲库里的 junction/符号链接指向系统目录时，
  // real 之后的绝对路径前缀对不上白名单，从而被拒绝
  const abs = realpathCached(path.resolve(fixDriveRoot(p)))
  if (!abs) return false   // realpath 失败（路径不存在/非法）→ 拒绝
  const real = abs.toLowerCase()
  const roots = [
    ...(G.store.get().settings.musicDirs || []),
    // 本地版没有在线下载/缓存目录（这两个根只在联网版存在）
    G.DATA_DIR,
  ]
    .filter((r) => r && String(r).trim() && isSafeMediaRoot(r))
    .map((r) => realpathCached(path.resolve(fixDriveRoot(r))))
    // v3.3.18：原始串通过不代表解析后也安全 —— 'D:/Music/../../Windows'
    // 会解析成系统目录，绕过上面的 DANGEROUS_ROOT 检查当上白名单根
    .filter((r) => r && isSafeMediaRoot(r))
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

      // v3.3.17：后续 stat 与 createReadStream 一律用 realpath 结果，
      // 消除「校验与打开不是同一个文件」的 TOCTOU
      filePath = realpathCached(filePath) || filePath

      const stat = await G.fsp.stat(filePath)
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
          return new Response(G.Readable.toWeb(stream), {
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
        return new Response(G.Readable.toWeb(stream), {
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

      // HEAD 只要头不要体（媒体元数据探测会用）
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': type,
            'Content-Length': String(total),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        })
      }

      const stream = fs.createReadStream(filePath)
      return new Response(G.Readable.toWeb(stream), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    } catch (err) {
      G.logLine('[lxfile] 读取失败', err.message)
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
      const cov = G.library ? await G.library.getCover(id) : null
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

function toLxUrl(filePath) {  if (!filePath) return null
  const norm = path.resolve(filePath).replace(/\\/g, '/')
  // 固定用 local 当 host，完整路径（含盘符）放在 path 里：
  // 若把盘符塞进 authority（lxfile:///D:/…），Chromium 会把它规范成 host，盘符就丢了。
  const body = norm.split('/').map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/')
  return 'lxfile://local/' + body.replace(/^\/+/, '')
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

module.exports = {
  init,
  AUDIO_MIME,
  mimeFor,
  REALPATH_TTL,
  REALPATH_MAX,
  realpathCache,
  realpathCached,
  fixDriveRoot,
  DANGEROUS_ROOT,
  EXTRA_FORBIDDEN_ROOT,
  isSafeMediaRoot,
  isAllowedMediaPath,
  registerFileProtocol,
  registerCoverProtocol,
  toLxUrl,
  decodeText,
}
