'use strict'
const path = require('path')
const fs = require('fs')
const http = require('http')
/**
 * v3.3.24 模块拆分：从 main.js 原样搬出（只做 G. 前缀注入，不改逻辑）。
 * init(G) 注入 main 的共享状态访问器（getter，见 main.js 的 G 定义）。
 */
const DC = require('./dircache')
// v3.3.32：serveLocalFile 用 PROTO.mimeFor 取 Content-Type；v3.3.24 拆分时漏搬这个
// require（错留了 electron 的 protocol），缓存命中播放必抛 ReferenceError → 500。
const PROTO = require('./protocols')

let G = null
function init(g) { G = g }

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
  if (!streamReady) startStreamServer()
  if (!streamReady) return Promise.resolve('')
  // 第四轮 §4.5.3 #14：绑定失败时 streamReady 会永久 resolve('')，渲染层把它拼成相对
  // /stream，整个会话在线播放全废、而且没有任何重试入口 —— 而「端口被安全软件临时拦住」
  // 属于可恢复故障。拿到空串就作废这一轮的 promise 并关掉失败的 server，下次请求重新绑定。
  return streamReady.then((base) => {
    if (base) return base
    streamReady = null
    streamBase = ''
    try {
      if (streamServer) {
        // v3.3.20：close() 只停止接受新连接，keep-alive 的旧连接会一直挂到 socket 超时 ——
        // 退出时 electron 还得等它们，用户看到的是「关了窗口进程不退」。
        if (typeof streamServer.closeAllConnections === 'function') streamServer.closeAllConnections()
        streamServer.close()
        streamServer = null
      }
    } catch (e) { /* 忽略 */ }
    G.logLine('[stream] 本地代理未就绪，下次请求会重新绑定端口')
    return ''
  }).catch(() => { streamReady = null; return '' })
}

/**
 * 解析 Range 头。三种结果由调用方决定怎么回：
 *  - 'full'    没有 Range 头 / 多段区间 → 按 200 全量发
 *  - 'invalid' 语法非法或区间越界       → 416
 *  - 'range'   单段有效                 → 206
 *
 * v3.3.13：语法全文锚定（以前松匹配会把畸形头当合法）；
 * v3.3.7：后缀区间 `bytes=-N` 的语义是「最后 N 字节」，不是开头 N 字节。
 */
function parseRangeHeader(rawHeader, total) {
  const raw = String(rawHeader || '').trim()
  if (!raw) return { kind: 'full' }
  if (!/^bytes=\d*-\d*(,\d*-\d*)*$/.test(raw)) return { kind: 'invalid' }
  if (raw.includes(',')) return { kind: 'full' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw)
  let start = 0
  let end = total - 1
  if (m) {
    if (m[1]) {
      start = parseInt(m[1], 10)
      end = m[2] ? parseInt(m[2], 10) : total - 1
    } else if (m[2]) {
      start = Math.max(0, total - parseInt(m[2], 10))
      end = total - 1
    }
  }
  if (!Number.isFinite(start) || start < 0) start = 0
  if (!Number.isFinite(end) || end >= total) end = total - 1
  if (start > end || start >= total) return { kind: 'invalid' }
  return { kind: 'range', start, end }
}

/** 从磁盘出流，支持 Range（拖动进度条要靠它） */
function serveLocalFile(filePath, req, res) {
  if (!DC.isReadableFromCacheOrData(filePath)) {
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
    'Content-Type': PROTO.mimeFor(filePath),
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
  const sendRangeNotSatisfiable = () => {
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Access-Control-Allow-Origin': '*' })
    res.end()
  }

  const range = parseRangeHeader(req.headers.range, total)
  // HEAD 只回元数据：以前会走 sendFull 把整首 flac 读出来再被 Node 丢掉
  if (req.method === 'HEAD') {
    if (range.kind === 'invalid') { sendRangeNotSatisfiable(); return }
    const len = range.kind === 'range' ? range.end - range.start + 1 : total
    const head = { ...base, 'Content-Length': String(len) }
    if (range.kind === 'range') {
      head['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`
      res.writeHead(206, head)
    } else {
      res.writeHead(200, head)
    }
    res.end()
    return
  }
  if (range.kind === 'invalid') { sendRangeNotSatisfiable(); return }
  if (range.kind === 'full') { sendFull(); return }
  res.writeHead(206, {
    ...base,
    'Content-Length': String(range.end - range.start + 1),
    'Content-Range': `bytes ${range.start}-${range.end}/${total}`
  })
  pipe(fs.createReadStream(filePath, { start: range.start, end: range.end }))
}

function startStreamServer() {
  const http = require('http')
  let readyResolve = () => {}
  streamReady = new Promise((resolve) => { readyResolve = resolve })
  streamServer = http.createServer((req, res) => { handleStreamRequest(req, res) })
  streamServer.on('error', (err) => {
    G.logLine('[online] 代理服务错误', err.message)
    // v3.3.7：监听失败（端口被占/被安全软件拦）时必须把等待方放出来，
    // 否则 ensureStreamBase() 永久 pending，所有在线播放无声无息挂死且无提示
    if (!streamBase) { try { readyResolve('') } catch (e) { /* 已 resolve */ } }
  })
  // v3.3.63：回调里不能再用模块变量 streamServer —— closeStreamServer() 在监听完成前
  // 跑过（退出瞬间）会把它置 null，`streamServer.address()` 抛 TypeError 冒到
  // uncaughtException；而且孤儿 resolve 还会把 streamBase 写成死端口，本会话在线播放
  // 全部 502 且不会自愈。这里锁住本次要监听的实例并比对。
  const srv = streamServer
  srv.listen(0, '127.0.0.1', () => {
    if (!srv || streamServer !== srv) return
    const addr = srv.address()
    if (!addr) return
    streamBase = `http://127.0.0.1:${addr.port}`
    G.logLine('[online] 代理就绪', streamBase)
    readyResolve(streamBase)
  })
  return streamBase
}

/**
 * 处理一个 /stream 请求：缓存命中 → 解析直链 → 上游取流 → 边转边缓存。
 *
 * 这是在线音频唯一的取流入口（<audio> 与 mpv 都走这里），所以也是全项目
 * 最容易出「卡住/截断/脏缓存」的地方，改动前请先读函数尾部的收尾约定。
 */
async function handleStreamRequest(req, res) {
  // 缓存残片的兜底清理：正常路径在 pumpUpstreamBody 的 finally 里做；
  // 这里提到外层声明，好在任何早期异常时也能清掉
  let dropPart = () => {}
  // v3.3.18：客户端断开（切歌 / 拖进度）必须能收掉解析与上游握手。
  // 以前只在 pumpUpstreamBody 里监听 close，早于正文阶段的断开永远收不到。
  let clientGone = false
  const reqCtrl = new AbortController()
  const onClientClose = () => {
    if (res.writableFinished) return
    clientGone = true
    try { reqCtrl.abort() } catch (e) { /* 忽略 */ }
  }
  res.on('close', onClientClose)
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
    const cacheOn = G.store.get().settings.onlineCacheOn !== false

    // 先看缓存：命中就连解析都省了（无损解析要 1~7 秒，重放不该再等）
    if (cacheOn) {
      const hit = DC.cacheHit(song, prefer)
      if (hit) { sendCachedStream(req, res, song, hit, null); return }
    }

    let info = await G.online.getPlayable(song, prefer, { signal: reqCtrl.signal })
    if (clientGone) return
    if (!info || !info.url) {
      G.logLine('[online] 代理无地址', source, id)
      if (!res.writableEnded) res.writeHead(404).end('no source')
      return
    }
    // 解析出来的实际音质如果正好有缓存，就别再拉一遍流。
    // （无损请求在「网易没这首/只有 mp3」时会降级，降级档位同样值得复用缓存）
    if (cacheOn) {
      const hit2 = DC.cacheTry(song, DC.cacheClassOf(info))
      if (hit2) { sendCachedStream(req, res, song, hit2, info); return }
    }

    let headers = buildUpstreamHeaders(info, req)
    let opened
    try {
      opened = await openUpstream(info, headers, reqCtrl.signal)
    } catch (err) {
      // 第四轮 §4.5.2 #1：openUpstream 抛错（握手超时 / DNS / TLS）以前直接冒到外层，
      // 既不回 502 也不作废直链缓存 —— 死链会继续在 20 分钟缓存里被反复命中。
      G.logLine('[online] 上游打开失败', (err && err.message) || err)
      try { G.online.invalidateUrl(song, prefer) } catch (e) { /* 忽略 */ }
      // v2.8.49 / v3.3.57：母带 / 无损档的上游打不开（真机日志里的
      // 「上游打开失败 This operation was aborted」）以前直接 502，界面卡在 0:00。
      // 这里作废坏链后降级到普通档再取一次：只试一次，客户端已断开就不试。
      if (!clientGone && (prefer === 'master' || prefer === 'lossless')) {
        try {
          const alt = await G.online.getPlayable(song, 'best', { signal: reqCtrl.signal })
          if (alt && alt.url && !clientGone) {
            info = alt
            headers = buildUpstreamHeaders(alt, req)
            opened = await openUpstream(alt, headers, reqCtrl.signal)
            G.logLine('[online] 上游降级重试成功', source, id)
          }
        } catch (e2) {
          G.logLine('[online] 上游降级重试失败', (e2 && e2.message) || e2)
        }
      }
      if (!opened) {
        if (!res.writableEnded) res.writeHead(502).end('upstream error')
        return
      }
    }
    const upstream = opened.upstream
    if (clientGone) {
      try { Promise.resolve(upstream.body && upstream.body.cancel()).catch(() => {}) } catch (e) { /* 忽略 */ }
      return
    }
    if (!upstream.ok && upstream.status !== 206) {
      // v3.3.20：只留 origin+路径，丢掉 query —— 直链的鉴权参数（?vkey= / ?sign= / token）
      // 就在 query 前段，日志会被用户「复制诊断」带出去。前 70 字符恰好切进 key 本体。
      let safeUrl = ''
      try { const u = new URL(info.url); safeUrl = u.origin + u.pathname.slice(0, 40) } catch (e) { safeUrl = '(非法 URL)' }
      G.logLine('[online] 上游失败', upstream.status, safeUrl)
      // v3.3.18：签名直链提前失效时不能让 20 分钟的直链缓存继续命中
      try { G.online.invalidateUrl(song, prefer) } catch (e) { /* 忽略 */ }
      // 第四轮 §4.5.2 #1：非 2xx 的响应体不取消会一直占着连接
      try { Promise.resolve(upstream.body && upstream.body.cancel()).catch(() => {}) } catch (e) { /* 忽略 */ }
      if (!res.writableEnded) res.writeHead(502).end('upstream ' + upstream.status)
      return
    }
    const out = buildProxyHeaders(upstream)

    // 只有「从头整段请求」才顺手存缓存；用户拖进度条发来的 Range 请求
    // 存下来的是一段残片，反而会把缓存搞脏。
    // v3.3.58：Chromium / mpv 的首请求不只会发 bytes=0-，也会发 bytes=0-N
    // 这类从 0 起的整段请求；以前只认精确字面，绝大多数歌曲直接不缓存。
    // 上游若只回了其中一段，finishCache 的 Content-Range 校验仍会拦下残片。
    const rangeHdr = String(req.headers.range || '').trim()
    const canCache = cacheOn && (!rangeHdr || /^bytes=0-(\d*)$/.test(rangeHdr))
    const cKey = DC.cacheKeyOf(song, DC.cacheClassOf(info))
    // part：本次请求的缓存残片。stream=null 表示「不缓存」或「已收尾」
    const part = { path: null, stream: null, bytes: 0 }
    // 后台写盘队列在 dropPart 之后创建；error 回调可能在创建前就触发，用 let 提前声明
    let writer = null

    if (canCache) {
      try {
        fs.mkdirSync(DC.cacheDirPath(), { recursive: true })
        // 每个请求用自己的临时文件名：同一首歌可能被连点两次，
        // 共用一个 .part 的话，先结束的那个会把后一个正在写的文件删掉。
        const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
        part.path = path.join(DC.cacheDirPath(), `${cKey}.${uniq}.part`)
        part.stream = fs.createWriteStream(part.path)
        // v3.3.13：error 回调捕获「这个具体 .part」——finishCache 清空 part.path
        // 后写流才报错时，仍能定位并删掉半截残片
        const errP = part.path
        const errS = part.stream
        // v3.3.20：写流出错（盘满/目录被删）时，除了删残片还要把 part.stream 摘掉。
        // 以前只删文件、不清状态 —— 后续 chunk 还往这个已销毁的流 write()，
        // 每个字节都要等 3 秒的 drain 兜底，在线播放直接卡成「不动了」。
        part.stream.on('error', (err) => {
          if (writer) writer.stop()
          if (part.stream === errS) part.stream = null
          if (part.path === errP) part.path = null
          G.logLine('[cache] 写盘出错，放弃本次缓存', (err && err.message) || '')
          removePartFile(errP, errS)
        })
      } catch (err) {
        part.path = null
        part.stream = null
      }
    }
    dropPart = () => {
      if (writer) writer.stop()
      const ps = part.stream
      const p = part.path
      part.stream = null
      part.path = null
      removePartFile(p, ps)
    }
    // v3.3.58：写盘改走后台队列。主转发循环只做同步投递，磁盘再慢也不占着音频。
    if (canCache && part.stream) writer = createCacheWriter(part, () => dropPart())
    // 上游是否给了「整段」的凭据：第四轮 §4.5.5 #2 指出只比 Content-Length 会被残片骗过 ——
    // 上游对 bytes=0- 回一段 206 时，bytes === Content-Length 成立，于是残片被 rename 成完整缓存，
    // 重播只听到开头。这里解析 Content-Range 的分母，只认「真的覆盖到 total-1」。
    const crHdr = String((upstream.headers && upstream.headers.get && upstream.headers.get('content-range')) || '')
    const crTotal = Number(crHdr.split('/')[1]) || 0
    const crEnd = Number((crHdr.match(/bytes\s+\d+-(\d+)/) || [])[1])
    // v2.8.53 / v3.3.62：206 必须凭 Content-Range **证明**覆盖到 total-1 才算整段。
    // 以前 `!crTotal` 直接判真（缺头 / `bytes 0-1023/*` 让 Number('*') 得 0），
    // 配合下面 expect = declared || bytes 的自证，1KB 探针残片会被 rename 成完整缓存，
    // 此后每次播放都命中这个坏缓存（只播开头几秒，且不自愈）——本轮审查 P1。
    // 200 才允许「没有 Content-Range」：整段响应本来就不带它，那属于正常形态。
    const crCoversAll = upstream.status === 206
      ? (crTotal > 0 && !Number.isNaN(crEnd) && crEnd === crTotal - 1)
      : (!crTotal || (!Number.isNaN(crEnd) && crEnd === crTotal - 1))
    // 收尾：字节数、Range 覆盖范围都一致才算缓存成功，半截的直接丢。
    // v3.3.58：① 先等后台队列把排队的 chunk 写完再取字节数，否则会拿半截的
    // part.bytes 去比对 Content-Length，明明写完了也被判残片删掉；
    // ② 上游 chunked（无 Content-Length）时按实际收到的完整正文长度落盘，
    // 以前直接静默丢弃，很多音源因此永远缓存不上；
    // ③ 等写流真正 end 完再做 rename，finishCache 返回时缓存已确定可用。
    const finishCache = async () => {
      if (!part.stream || !part.path) return
      if (writer) await writer.flush()
      if (!part.stream || !part.path) return
      const declared = Number(out['Content-Length']) || 0
      const bytes = part.bytes
      const expect = declared || bytes
      const target = part.path
      const key = cKey
      const meta = {
        title: info.song ? info.song.title : song.title,
        artist: info.song ? info.song.artist : song.artist,
        ext: info.ext
      }
      const stream = part.stream
      part.stream = null
      part.path = null
      await new Promise((resolve) => {
        let done = false
        let timer = null
        const fin = () => {
          if (done) return
          done = true
          if (timer) clearTimeout(timer)
          stream.off('error', fin)
          resolve()
        }
        timer = setTimeout(fin, 5000)   // 写流出错时 end 的回调可能永远不来
        if (timer.unref) timer.unref()
        stream.once('error', fin)
        try { stream.end(fin) } catch (e) { fin() }
      })
      if (!bytes || bytes !== expect || !crCoversAll) {
        G.logLine('[cache] 正文不完整，丢弃缓存', key, bytes + '/' + expect)
        try { fs.unlinkSync(target) } catch (e) { /* 忽略 */ }
        return
      }
      // v3.3.13：ext 来自网络字段，只放行白名单扩展名，否则退回 mp3
      const CACHE_EXTS = ['mp3', 'm4a', 'flac', 'ogg', 'aac']
      const ext = String(meta.ext || '').toLowerCase()
      const safeExt = CACHE_EXTS.includes(ext) ? ext : 'mp3'
      const file = `${key}.${safeExt}`
      try {
        const target2 = path.join(DC.cacheDirPath(), file)
        // 另一个并发请求可能已经先写完了，那就用它的 —— 但**必须索引里真有这条**。
        // v2.8.53 / v3.3.62：以前只判文件在不在。清缓存时文件被占用删不掉、索引
        // 却被清空之后，这里会把此后每一份新数据都丢掉且不 cachePut，于是该曲
        // 永久无索引、永远命中不到、每次播放都完整重下一遍（本轮审查 P1 的自锁环）。
        const idxNow = DC.cacheLoad()
        if (fs.existsSync(target2) && idxNow && idxNow[key]) {
          try { fs.unlinkSync(target) } catch (e) { /* 忽略 */ }
          return
        }
        // 索引里没有（孤儿文件）→ 覆盖它并重建索引；占用中删不掉就让 rename 覆盖
        try { if (fs.existsSync(target2)) fs.unlinkSync(target2) } catch (e) { /* 忽略 */ }
        fs.renameSync(target, target2)
        DC.cachePut(key, file, meta, bytes)
        G.logLine('[cache] 缓存完成', file, (bytes / 1048576).toFixed(1) + 'MB' + (declared ? '' : '（chunked）'))
      } catch (e) {
        G.logLine('[cache] 缓存落盘失败', (e && e.message) || e)
        try { fs.unlinkSync(target) } catch (e2) { /* 忽略 */ }
      }
    }

    if (clientGone) { dropPart(); return }
    res.writeHead(upstream.status === 206 ? 206 : 200, out)
    // 告诉界面「这首实际是什么音质」——界面拿到的是解析时那一刻的结论，
    // 而真正取流发生在这里，两边可能不一致（第一次解析失败、重试成功之类）。
    G.sendToRenderer('online:now-playing', {
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
    await pumpUpstreamBody({
      reader: upstream.body.getReader(),
      res,
      ctrl: opened.ctrl,
      part,
      dropPart,
      finishCache,
      cacheWrite: writer ? writer.write : null
    })
  } catch (err) {
    try { dropPart() } catch (e) { /* 忽略 */ }
    G.logLine('[online] 代理异常', err.message)
    try {
      if (res.headersSent) res.destroy()      // 头已发出，不能再次 writeHead
      else res.writeHead(500).end('proxy error')
    } catch (e) { try { res.destroy() } catch (e2) { /* 已断开 */ } }
  }
}

/**
 * 两条缓存命中路径的统一响应：推「实际音质」给界面，再从磁盘按 Range 出流。
 * @param {object} hit cacheHit / cacheTry 的结果
 * @param {object|null} fallback 降级档命中时的解析信息（首选档命中传 null）
 */
function sendCachedStream(req, res, song, hit, fallback) {
  G.logLine(fallback ? '[cache] 命中(降级档)' : '[cache] 命中', path.basename(hit.path))
  G.sendToRenderer('online:now-playing', {
    id: `${song.source}:${song.id}`,
    song: { title: hit.rec.title || song.title, artist: hit.rec.artist || song.artist },
    lossless: hit.cls === 'flac' || hit.cls === 'master',
    bitrate: fallback ? (fallback.bitrate || 0) : 0,
    ext: hit.rec.ext || (fallback && fallback.ext) || path.extname(hit.path).slice(1),
    cached: true
  })
  serveLocalFile(hit.path, req, res)
}

/**
 * 组装上游请求头：UA + 平台要求的 Referer/Cookie 等。
 * 逐跳头（host/content-length/connection/range）不透传 —— Range 由本端按需补。
 */
function buildUpstreamHeaders(info, req) {
  const headers = { 'User-Agent': 'Mozilla/5.0' }
  if (info.referer) headers.Referer = info.referer
  // 有些平台的直链要带它自己指定的头（比如 QQ 的 Cookie/Referer），网关会一起给
  if (info.headers && typeof info.headers === 'object') {
    for (const [k, v] of Object.entries(info.headers)) {
      if (typeof v === 'string' && !/^(host|content-length|connection|range)$/i.test(k)) headers[k] = v
    }
  }
  if (req.headers.range) headers.Range = req.headers.range
  return headers
}

/**
 * 向上游发起取流请求。
 *
 * v3.3.13：超时分两段。这里只管握手（建连/首字节）15 秒；正文的空闲超时由
 * pumpUpstreamBody 每收到一个 chunk 刷新的 20 秒看门狗负责。
 * 之前用 AbortSignal.timeout(15000) 一把罩住整个响应体，>15 秒的在线音频必被截断、
 * 缓存永远写不成 —— 所以 signal 保留但不再设总体超时。
 *
 * @returns {{upstream: Response, ctrl: AbortController}} ctrl 供正文阶段复用
 */
async function openUpstream(info, headers, externalSignal) {
  const ctrl = new AbortController()
  const headTimer = setTimeout(() => { try { ctrl.abort() } catch (e) { /* 忽略 */ } }, 15000)
  // v3.3.18：客户端断开时连握手阶段的 fetch 也要收掉；listener 留到正文阶段，
  // 由 pumpUpstreamBody 的空闲看门狗共用同一个 ctrl
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort()
    else externalSignal.addEventListener('abort', () => { try { ctrl.abort() } catch (e) { /* 忽略 */ } }, { once: true })
  }
  try {
    const upstream = await fetch(info.url, { headers, redirect: 'follow', signal: ctrl.signal })
    return { upstream, ctrl }
  } finally {
    clearTimeout(headTimer)
  }
}

/** 回给浏览器的响应头：透传长度/区间，其余按本端策略固定 */
function buildProxyHeaders(upstream) {
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
  return out
}

/**
 * 把上游响应体边转发给浏览器边写缓存。
 *
 * 约定（改之前务必读）：
 *  - 客户端断开（切歌/拖进度条）要同时收掉上游读者与写盘，否则请求会永远悬着；
 *  - 只有「正常读完」才落缓存，中途断开一律丢弃残片；
 *  - 无论成功/异常/断开，响应连接都必须收掉；
 *  - v3.3.58：缓存写盘只做同步投递，等磁盘的动作留在后台队列里。
 *    主循环里除了网络背压（res）不允许等写盘，否则音频会「断一下」。
 *
 * @param {object} p
 * @param {ReadableStreamDefaultReader} p.reader 上游 body reader
 * @param {import('http').ServerResponse} p.res
 * @param {AbortController} p.ctrl 正文空闲看门狗用
 * @param {{path:string|null, stream:fs.WriteStream|null, bytes:number}} p.part 缓存残片状态
 * @param {() => void} p.dropPart
 * @param {() => Promise<void>} p.finishCache
 * @param {((buf:Buffer)=>void)|null} p.cacheWrite 后台写盘队列的同步投递口
 */
async function pumpUpstreamBody({ reader, res, ctrl, part, dropPart, finishCache, cacheWrite }) {
  // 正文阶段：可刷新的空闲看门狗 —— 每读到一个 chunk 就刷新 20 秒，
  // 慢速但持续的大文件不会被误杀，真正卡死的连接才会被 abort
  let idleTimer = null
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { try { ctrl.abort() } catch (e) { /* 忽略 */ } }, 20000)
  }
  touch()   // 启动正文空闲看门狗（首字节也要限时）

  // v2.8.49 / v3.3.57：固定 20 秒窗口内至少要有 32KB 正文。
  // 上面那个「每来一个 chunk 就刷新」的空闲看门狗，会被「每 19 秒滴 1 字节」的上游
  // 永远续住，音频凑不满一帧、界面永远 0:00。这个窗口不被 chunk 刷新；
  // 正常码率（128k ≈ 16KB/s）远高于阈值，不会被误杀。
  let rateBytes = 0
  const RATE_MIN_BYTES = 32 * 1024
  const rateTimer = setInterval(() => {
    if (rateBytes < RATE_MIN_BYTES) {
      G.logLine('[online] 上游速率过低，终止取流', rateBytes)
      try { ctrl.abort() } catch (e) { /* 忽略 */ }
    }
    rateBytes = 0
  }, 20000)

  // 客户端一断开（切歌、拖进度条）就把上游和写盘一起收掉。
  // 只等 'drain' 是不够的：连接没了就没有 drain，这个请求会永远悬着。
  let aborted = false
  const onClose = () => {
    if (res.writableFinished) return
    aborted = true
    try { ctrl.abort() } catch (e) { /* 已结束 */ }
    try { Promise.resolve(reader.cancel()).catch(() => {}) } catch (e) { /* 已结束 */ }
    dropPart()
  }
  res.on('close', onClose)

  let complete = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (aborted) break
      touch()   // 每读到一个 chunk 就刷新空闲看门狗
      const buf = Buffer.from(value)
      rateBytes += buf.length
      // v2.8.49 / v3.3.57：先把音频数据送给 <audio>，缓存写盘绝不阻塞播放。
      // v3.3.58：以前一见写盘背压就丢掉整首缓存（WriteStream 16KB 水位，
      // 第一个音频块就返回 false），结果在线播放永远缓存不上。改成同步投递到
      // 后台队列，磁盘的 drain 由队列自己等，主循环这里一步都不停。
      if (!res.write(buf)) await waitDrain(res)
      if (cacheWrite) cacheWrite(buf)
    }
    complete = !aborted
  } catch (err) {
    complete = false
  } finally {
    clearTimeout(idleTimer)
    clearInterval(rateTimer)
    res.off('close', onClose)
    // v3.3.13：无论成功/异常/断开，连接都必须收掉。先 end，客户端不必等写盘收尾。
    try { if (!res.writableEnded) res.end() } catch (e) { /* 已断开 */ }
    // 正常读完才落缓存；中途断开就把残片丢掉。finishCache 内部会等后台队列写完。
    if (complete) await finishCache()
    else dropPart()
  }
}

/**
 * 等 drain 或 close。3 秒兜底：宁可丢掉缓存，也不能卡住播放。
 * v3.3.13：once 注册的是包装函数，off 必须配对；用 on + off 才能真清掉。
 */
function waitDrain(emitter) {
  return new Promise((r) => {
    let done = false
    let timer = null
    const go = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      emitter.off('drain', go)
      emitter.off('close', go)
      r()
    }
    emitter.on('drain', go)
    emitter.on('close', go)
    timer = setTimeout(go, 3000)
  })
}

/**
 * v3.3.58：在线播放缓存的后台写入队列。
 *
 * 音频转发是主角：主循环只把 Buffer 同步投递进来，磁盘的 drain 放在这个
 * 独立协程里等。磁盘再慢，也只是队列变长，<audio> 该收的字节一个不少。
 * 队列堆到 32MB 说明磁盘长期跟不上，就放弃本次缓存，别让内存被拖爆。
 * 收尾必须先 flush()，否则 finishCache 拿到的是还没写完的字节数。
 */
function createCacheWriter(part, dropPart) {
  const MAX_QUEUED = 32 * 1024 * 1024
  const queue = []
  let queued = 0
  let running = false
  let stopped = false
  let wake = null

  const stop = () => {
    stopped = true
    queue.length = 0
    queued = 0
    if (wake) { const w = wake; wake = null; w() }
  }

  const pumpQueue = async () => {
    running = true
    try {
      while (!stopped && part.stream && queue.length) {
        const b = queue.shift()
        queued -= b.length
        const w = part.stream
        part.bytes += b.length
        try {
          if (!w.write(b)) await waitDrain(w)
        } catch (e) {
          stop()
          break
        }
      }
    } finally {
      running = false
      if (wake) { const w = wake; wake = null; w() }
    }
  }

  const write = (buf) => {
    if (stopped || !part.stream) return
    queue.push(buf)
    queued += buf.length
    if (queued > MAX_QUEUED) {
      G.logLine('[cache] 写盘长期跟不上，放弃本次缓存')
      stop()
      try { dropPart() } catch (e) { /* 忽略 */ }
      return
    }
    if (!running) void pumpQueue().catch(() => {})
  }

  const flush = () => new Promise((resolve) => {
    if (stopped || (!running && !queue.length)) { resolve(); return }
    let timer = null
    const fin = () => {
      if (timer) clearTimeout(timer)
      if (wake === fin) wake = null
      resolve()
    }
    // 写流既不 drain 也不 close 时不能让收尾悬着（Promise 只会被 resolve 一次）
    timer = setTimeout(fin, 5000)
    if (timer.unref) timer.unref()
    wake = fin
  })

  return { write, flush, stop }
}

/**
 * 关闭缓存写流并删掉指定 .part。
 * Windows 上不能删还开着的文件，所以等 close 再删；1 秒兜底 timer 保存句柄，
 * 删成功即 clearTimeout，避免 del 被调两次。
 */
function removePartFile(p, ps) {
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

/**
 * v3.3.32：退出链主动关掉本地代理。close() 只停止接受新连接，<audio> 的
 * keep-alive 旧连接会一直挂到 socket 超时，表现为「关了窗口进程不退」。
 * 同时清空 base/ready，避免退出瞬间还有请求拿旧端口重新起一个 server。
 */
function closeStreamServer() {
  const s = streamServer
  streamServer = null
  streamBase = ''
  streamReady = null
  if (!s) return
  try {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections()
    s.close()
  } catch (e) { /* 忽略 */ }
}

module.exports = {
  init,
  get streamServer() { return streamServer },
  get streamBase() { return streamBase },
  get streamReady() { return streamReady },
  ensureStreamBase,
  closeStreamServer,
  parseRangeHeader,
  serveLocalFile,
  startStreamServer,
  handleStreamRequest,
  sendCachedStream,
  buildUpstreamHeaders,
  openUpstream,
  buildProxyHeaders,
  pumpUpstreamBody,
  createCacheWriter,
  waitDrain,
  removePartFile,
}
