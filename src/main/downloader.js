'use strict'
const path = require('path')
const fs = require('fs')
/**
 * v3.3.24 模块拆分：从 main.js 原样搬出（只做 G. 前缀注入，不改逻辑）。
 * init(G) 注入 main 的共享状态访问器（getter，见 main.js 的 G 定义）。
 */
const DC = require('./dircache')
const SP = require('./streamproxy')
const { app, BrowserWindow } = require('electron')

let G = null
function init(g) { G = g }

/* ---------------- IPC ---------------- */

/* ---------------- 联网版：下载目录 / 进行中的下载 ---------------- */

/** 下载目录：用户设置优先，否则「我的音乐\猪专属下载」 */
function downloadDir() {
  const custom = String(G.store.get().settings.onlineDownloadDir || '').trim()
  if (custom) return custom
  try {
    return path.join(app.getPath('music'), '猪专属下载')
  } catch (err) {
    return path.join(G.DATA_DIR, 'downloads')
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

function dlFile() { return path.join(G.userData, 'downloads.json') }

function toDownloadDto(t) {
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
const dlSentSig = new Map()   // id → 上次推送的签名（增量推送用）

// v3.3.21：done/error 任务以前只有用户手动「清除已完成」才摘，长会话里 Map 与 dlSentSig 慢慢涨。
// 现在超过上限自动摘最旧的（按创建时间 at；done 的文件是用户音乐不动，error 的 .part 在置 error 时已清）。
// 上限给 100：正常一次会话下不满，只有挂机数天才会触达。
const DL_FINISHED_MAX = 100

function dlPruneFinished() {
  const fin = Array.from(dlTasks.values()).filter((t) => t.status === 'done' || t.status === 'error')
  if (fin.length <= DL_FINISHED_MAX) return
  fin.sort((a, b) => (a.at || 0) - (b.at || 0))
  let removed = 0
  for (const t of fin.slice(0, fin.length - DL_FINISHED_MAX)) {
    if (t.rescanTimer) { clearTimeout(t.rescanTimer); t.rescanTimer = null }
    dlTasks.delete(t.id); removed++
  }
  // error 任务会落盘，摘了要触发保存，否则重启后又复活
  if (removed) dlSaveSoon()
}

function dlBroadcast(save) {
  dlPruneFinished()
  // 第四轮 §4.5.3 #13：以前每 250ms 把**全表**推一遍（几十个任务 × 每秒 4 次）。
  // 改成只推有变化的条目，并用 full 标记告诉渲染层「这次是全量快照」。
  const all = Array.from(dlTasks.values())
  const full = save !== false      // 结构性变化（新增/暂停/删除/完成）→ 发全量；进度 tick → 发增量
  const changed = []
  for (const t of all) {
    const sig = [t.status, t.received, t.total, t.speed, t.error, t.path].join('|')
    if (full || dlSentSig.get(t.id) !== sig) { dlSentSig.set(t.id, sig); changed.push(toDownloadDto(t)) }
  }
  for (const id of Array.from(dlSentSig.keys())) {
    if (!dlTasks.has(id)) dlSentSig.delete(id)
  }
  if (changed.length || full) {
    const payload = { full, items: full ? all.map(toDownloadDto) : changed }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('online:dl-update', payload)
    }
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
      .filter((t) => t.status !== 'done')
      .map((t) => ({
        id: t.id, key: t.key, song: t.song,
        // 第四轮 §4.5.3 #9：error 任务也要落盘 —— 以前重启后任务消失，
        // 磁盘上的 .part 孤儿文件再没有任何清理入口
        status: t.status === 'error' ? 'error' : 'paused',
        error: t.error || '',
        received: t.received || 0, total: t.total || 0,
        path: t.path || '', ext: t.ext || '', at: t.at || 0
      }))
    DC.atomicWriteJson(dlFile(), keep)
  } catch (err) { /* 写不进去就算了，不影响下载 */ }
}

/**
 * taskId → 本次下载实际用的 { url, ext }。
 * v3.3.20：暂停后继续时，解析可能拿到**另一条**直链（换源、签名刷新），
 * 而 .part 里是上一份直链的字节 —— 直接 append 就是一个坏文件却显示「完成」。
 * 这里记住本次的直链与格式，续传前比对；不一致就丢弃残片重下。
 */
const dlTargetCache = new Map()

function dlLoad() {
  try {
    const arr = JSON.parse(fs.readFileSync(dlFile(), 'utf8'))
    if (!Array.isArray(arr)) return
    for (const r of arr) {
      if (!r || !r.id || !r.song) continue
      dlTasks.set(r.id, { ...r, status: 'paused', speed: 0, abort: null, deleted: false })
    }
    if (arr.length) G.logLine('[dl] 恢复', arr.length, '个未完成任务')
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
  // v3.3.20：用 'wx' 原子占位代替 existsSync 检查。同一首歌从两个源各点一次下载
  // （或两首同名歌）时，两个任务都会通过 existsSync 检查、然后各自隔一次网络握手
  // 才真正打开 .part —— 互相截断/交错写，最后各自 rename 成同一个文件名，
  // 产物是两份编码流的混合体，任务却都显示「完成」。
  // 'wx' 在创建失败（EEXIST）时才换序号，天然原子。
  for (;;) {
    const part = target + '.part'
    try {
      const fd = fs.openSync(part, 'wx')
      fs.closeSync(fd)
      return target
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    n++
    target = path.join(dir, `${base} (${n}).${ext}`)
  }
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
  let reader = null     // v3.3.18：提到 try 外，异常路径也能 cancel 上游读者
  let endTimer = null   // 写盘收尾的 10 秒超时句柄，finally 里兜底清理
  try {
    let info = null
    try { info = await G.online.getPlayable(task.song, qualityPref(), { signal: ctrl.signal }) } catch (err) { info = null }
    // 暂停/删除可能发生在解析期间（最长十几秒），解析回来必须立刻收手
    if (ctrl.signal.aborted || task.deleted) {
      throw Object.assign(new Error('download aborted'), { name: 'AbortError' })
    }
    if (!info || !info.url) throw new Error('没有可用地址（可能版权限制）')

    if (!task.path) {
      const ext = info.ext === 'm4a' ? 'm4a' : info.ext === 'flac' ? 'flac' : 'mp3'
      task.ext = ext
      task.path = dlPickPath(task.song, ext)
    }
    const part = task.path + '.part'
    // v3.3.20：同一个任务的直链/格式变了，旧 .part 就不是同一份内容 —— 不能续传
    const tgt = dlTargetCache.get(task.id)
    const curExt = (task.ext || info.ext || '').toString()
    if (tgt && (tgt.url !== info.url || tgt.ext !== curExt)) {
      G.logLine('[dl] 直链或格式已变化，丢弃残片从头下载')
      try { fs.unlinkSync(part) } catch (e) { /* 不存在 */ }
    }
    dlTargetCache.set(task.id, { url: info.url, ext: curExt })
    let offset = 0
    try { offset = fs.statSync(part).size } catch (err) { offset = 0 }

    const headers = { 'User-Agent': 'Mozilla/5.0' }
    if (info.referer) headers.Referer = info.referer
    if (info.headers && typeof info.headers === 'object') Object.assign(headers, info.headers)
    if (offset > 0) headers.Range = 'bytes=' + offset + '-'

    // v3.3.16：握手阶段单独限时。下载同样会卡在「连接已建立、响应头一直不来」，
    // 而 ctrl 只服务于用户暂停/删除 —— 拿它当超时会把「超时」误判成「用户暂停」。
    const openOnce = async (from) => {
      const headCtrl = new AbortController()
      const headTimer = setTimeout(() => { try { headCtrl.abort() } catch (e) { /* 忽略 */ } }, 20000)
      const h = { ...headers }
      if (from > 0) h.Range = 'bytes=' + from + '-'
      else delete h.Range
      try {
        return await fetch(info.url, {
          headers: h,
          signal: typeof AbortSignal.any === 'function'
            ? AbortSignal.any([ctrl.signal, headCtrl.signal])
            : ctrl.signal,
          redirect: 'follow'
        })
      } finally {
        clearTimeout(headTimer)
      }
    }
    let res = await openOnce(offset)
    if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status)
    // 服务端不认 Range 就会回 200 全量，这时只能从头写
    if (res.status === 200 && offset > 0) offset = 0
    let cr = res.headers.get('content-range') || ''
    // 第四轮 §4.5.2 #6：续传必须校验服务端给的 Content-Range 起点**真的等于**我们请求的 offset。
    // 以前完全不校验：服务端改回别的段（或忽略 Range 却仍回 206）时，新数据会被 append 到
    // 已有 .part 后面，直接写出一个损坏文件，而且任务显示「下载完成」。
    if (offset > 0) {
      const m = cr.match(/bytes\s+(\d+)-/)
      if (!m || Number(m[1]) !== offset) {
        G.logLine('[dl] 续传起点与请求不符，丢弃残片重下', offset, cr || '(no content-range)')
        try { if (res.body) res.body.cancel() } catch (e) { /* 忽略 */ }
        try { fs.unlinkSync(part) } catch (e) { /* 忽略 */ }
        offset = 0
        res = await openOnce(0)
        if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status)
        cr = res.headers.get('content-range') || ''
      }
    }
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
    reader = res.body.getReader()
    // 只建一个 drain 等待器：以前每次写阻塞都新建一个 once('drain')，
    // 而被 wsError / abort 赢下的 race 不会移除那个监听，长下载会累积到
    // MaxListenersExceededWarning，且监听闭包一直攥着 buffer 引用
    let drainWait = null
    const waitDrain = () => {
      if (!drainWait) {
        drainWait = new Promise((r) => ws.once('drain', () => { drainWait = null; r() }))
      }
      return drainWait
    }
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
          waitDrain(),
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
    G.logLine('[dl] 完成', path.basename(task.path), (task.received / 1048576).toFixed(1) + 'MB')
    // 落盘后丢给曲库做增量扫描，下载完就能在「最近添加」里看到
    // v3.3.9：下载目录也要一并扫（用户自选目录往往不在 musicDirs 里，
    // 以前下完的歌永远不进库）；扫描进行中被跳过时 30 秒后补一次
    if (G.library) {
      const scanDirs = Array.from(new Set([...(G.store.get().settings.musicDirs || []), downloadDir()]))
      G.library.scan(scanDirs).then((r) => {
        if (r && r.skipped) {
          // 补扫 timer 存句柄：触发即清，任务被删除时 dlDelete 也会清
          task.rescanTimer = setTimeout(() => {
            task.rescanTimer = null
            try { G.library.scan(scanDirs).catch(() => {}) } catch (e) { /* 忽略 */ }
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
    } else if (task.abort !== ctrl) {
      // 这一轮已被新一轮接管（暂停后立刻点继续）：状态归新一轮管，不要覆盖
    } else if (ctrl.signal.aborted) {
      // v3.3.16：判据收紧为「本轮自己的控制器被 abort」。以前只看 err.name/消息里有没有
      // abort，握手超时（另一个 controller）也会被当成用户暂停，任务永远停在 paused。
      task.status = 'paused'
      task.speed = 0
    } else if (err && err.name === 'AbortError') {
      task.status = 'error'
      task.error = '连接超时或已中断'
      task.speed = 0
      // v3.3.20：占位的 .part 记得清掉，否则重试时 'wx' 会误以为名字被占而换新文件名，
      // 旧的空占位永远留在下载目录里
      dlUnlinkRetry(task.path ? task.path + '.part' : '')
      G.logLine('[dl] 中断', path.basename(task.path || ''), task.error)
    } else {
      task.status = 'error'
      task.error = (err && err.message) || '下载失败'
      task.speed = 0
      dlUnlinkRetry(task.path ? task.path + '.part' : '')
      G.logLine('[dl] 失败', task.error)
    }
  } finally {
    if (endTimer) { clearTimeout(endTimer); endTimer = null }
    // v3.3.18：异常/断开时上游连接不能挂到 undici 自己超时
    if (reader) { try { const r = reader.cancel(); if (r && r.catch) r.catch(() => {}) } catch (e) { /* 忽略 */ } }
    // v3.3.13：异常路径也要释放写流句柄
    if (ws) { try { ws.destroy() } catch (e) { /* 忽略 */ } }
    // v3.3.9：只清掉自己这轮的 abort 控制器，别抹掉新一轮任务的
    if (task.abort === ctrl) task.abort = null
    dlBroadcast(true)
  }
}

/** 音质设置 → 各音源认的 prefer 值（只有 lossless / best / 128k 三种） */
function qualityPref() {
  const q = G.store.get().settings.onlineQuality
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

/** 并发闸门包装：音质探测最多 3 个同时跑（见上方 PROBE_TTL/probeCache），
 *  多余的调用排队等前面完成。返回值透传 fn 的 Promise。 */
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
module.exports = {
  init,
  downloadDir,
  dlFile,
  toDownloadDto,
  DL_FINISHED_MAX,
  dlPruneFinished,
  dlBroadcast,
  dlSaveSoon,
  dlSaveNow,
  dlLoad,
  dlUnlinkRetry,
  dlSafeName,
  dlPickPath,
  dlRun,
  qualityPref,
  // v3.3.31：main.js 的 online:probe 直接读写 DL.probeCache。
  // v3.3.24 拆分时只搬走定义、漏了导出 → DL.probeCache 为 undefined，
  // 每次音质探测 0ms 抛 TypeError，列表只剩平台标称码率（看不到无损/高解析）。
  probeCache,
  PROBE_TTL,
  probeLimit,
}
