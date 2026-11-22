'use strict'
/**
 * 断流残片保留与 Range 续传（T02-02 / v3.3.71）
 *
 * 现实场景：在线音频播到一半上游掐断（CDN 抖动 / 切网），播放器带着
 * `Range: bytes=<已收字节>-` 重连。以前残片当场删掉、重连不写缓存，
 * 同一首歌每次断流都要从上游从头拉一遍，缓存永远补不齐。
 *
 * 这里真跑 streamproxy.js：
 *   ① 断流后残片被保留（不再一删了之），字节数与磁盘一致
 *   ② 客户端重新要「从 0 开始整段」→ 上游只从残片末尾续，前缀由本地残片供给
 *   ③ 客户端要「从残片末尾开始」→ 边转发边补齐，缓存最终落盘
 *   ④ 上游不认 Range（回 200 整段）→ 残片作废，绝不把整首拼成重复两段
 *
 * 用法：node test/stream-resume.mjs
 */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, '.stream-resume-cache')
const require2 = createRequire(import.meta.url)
const Module = require2('module')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const puts = []
const fakeDC = {
  _idx: {},
  cacheLoad: () => fakeDC._idx,
  cacheHit: () => null,
  cacheTry: () => null,
  cacheClassOf: () => 'mp3',
  cacheKeyOf: (song) => song.id,
  cacheDirPath: () => CACHE,
  cachePut: (key, file, meta, size) => puts.push({ key, file, size })
}
const fakePROTO = { mimeFor: () => 'audio/mpeg' }
const origLoad = Module._load
Module._load = function (request) {
  if (request === './dircache') return fakeDC
  if (request === './protocols') return fakePROTO
  return origLoad.apply(this, arguments)
}
const SP = require2(path.join(ROOT, 'src/main/streamproxy.js'))
const HTTPU_T = require2(path.join(ROOT, 'src/main/http-util.js'))
// v3.3.77（P2-6）：上游取流现在逐跳校验协议/私网/DNS；这些单测的上游是 127.0.0.1 打桩，
// 用测试接缝统一放行（生产路径仍然走 checkUrlAllowed，见 http-util 单测）。
HTTPU_T.__setUrlGuard(async () => ({ ok: true }))

Module._load = origLoad

const REAL_FETCH = global.fetch

class FakeRes extends EventEmitter {
  constructor() {
    super()
    this.status = null
    this.headers = null
    this.writes = []
    this.ended = false
    this.writableEnded = false
    this.writableFinished = false
    this.headersSent = false
    this.destroyed = false
  }
  writeHead(s, h) { this.status = s; this.headers = h || null; this.headersSent = true; return this }
  end() { this.ended = true; this.writableEnded = true; return this }
  write(buf) { this.writes.push(Buffer.from(buf)); return true }
  destroy() { this.destroyed = true; this.writableEnded = true; return this }
  body() { return Buffer.concat(this.writes) }
}

const logLines = []
function initG() {
  const G = {
    store: { get: () => ({ settings: { onlineCacheOn: true } }) },
    online: {
      getPlayable: async () => ({ url: 'http://up/x', ext: 'mp3', lossless: false }),
      invalidateUrl: () => {}
    },
    logLine: (...a) => logLines.push(a.join(' ')),
    sendToRenderer: () => {}
  }
  SP.init(G)
  return G
}

const BUF = Buffer.alloc(3000)
for (let i = 0; i < BUF.length; i++) BUF[i] = i % 251

/**
 * 假上游：按 Range 返回 206/200，chunk 500 字节。
 * opts.dropAfter：只给这么多字节然后抛错（模拟断流）
 * opts.ignoreRange：无视 Range 一律回 200 整段（模拟不认续传的上游）
 */
function stubUpstream(opts = {}) {
  const ranges = []
  global.fetch = async (url, init = {}) => {
    const h = (init && init.headers) || {}
    const range = h.Range || h.range || ''
    ranges.push(range)
    let start = 0
    let status = 200
    const m = /^bytes=(\d+)-$/.exec(range)
    if (m && !opts.ignoreRange) { start = Number(m[1]); status = 206 }
    const body = BUF.slice(start)
    const headers = {
      get: (k) => {
        if (k === 'content-type') return 'audio/mpeg'
        if (k === 'content-length') return String(body.length)
        if (k === 'content-range') return status === 206 ? `bytes ${start}-${BUF.length - 1}/${BUF.length}` : null
        return null
      }
    }
    const limit = opts.dropAfter != null ? Math.min(opts.dropAfter, body.length) : body.length
    let sent = 0
    return {
      ok: true,
      status,
      headers,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent >= limit) {
              if (opts.dropAfter != null) throw new Error('upstream reset')
              return { done: true }
            }
            const n = Math.min(500, limit - sent)
            const chunk = body.slice(sent, sent + n)
            sent += n
            return { done: false, value: chunk }
          },
          cancel: async () => {}
        })
      }
    }
  }
  return ranges
}

const reqOf = (id, range) => ({
  url: `/stream?src=kw&id=${id}&q=best&t=&a=&b=0`,
  headers: range ? { range } : {},
  method: 'GET'
})
const partsInCache = () => (fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter((f) => f.endsWith('.part')) : [])

try { fs.rmSync(CACHE, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
fs.mkdirSync(CACHE, { recursive: true })

/* ---------- ① 断流：残片保留而不是删掉 ---------- */
initG()
stubUpstream({ dropAfter: 1000 })
{
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('abc', 'bytes=0-'), res)
  const parts = partsInCache()
  const size = parts.length ? fs.statSync(path.join(CACHE, parts[0])).size : 0
  ok('断流后残片被保留（不再一删了之）',
    parts.length === 1 && size === 1000, 'parts=' + JSON.stringify(parts) + ' size=' + size)
  ok('断流保留有日志线索', logLines.some((l) => l.includes('断流残片已保留')), logLines.filter((l) => l.includes('残片')).join(' | '))
  ok('断流这一轮不写缓存索引', puts.length === 0, 'puts=' + puts.length)
}

/* ---------- ② 客户端重新要「从 0 开始整段」→ 上游只补后半段 ---------- */
{
  initG()
  const ranges = stubUpstream()
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('abc', 'bytes=0-'), res)
  const body = res.body()
  ok('重连时上游只从残片末尾续（不再从头下）',
    ranges.length === 1 && ranges[0] === 'bytes=1000-', 'ranges=' + JSON.stringify(ranges))
  ok('客户端拿到的仍是整首（前缀由本地残片补）',
    body.length === 3000 && body.equals(BUF) && res.status === 200,
    'len=' + body.length + ' status=' + res.status)
  ok('响应长度按整首算，不再带片段 Content-Range',
    res.headers && res.headers['Content-Length'] === '3000' && !res.headers['Content-Range'],
    JSON.stringify(res.headers && { len: res.headers['Content-Length'], cr: res.headers['Content-Range'] }))
  ok('补齐后缓存按整首落盘', puts.length === 1 && puts[0].size === 3000 && partsInCache().length === 0,
    'puts=' + JSON.stringify(puts) + ' parts=' + partsInCache().length)
}

/* ---------- ③ 客户端要「从残片末尾开始」→ 边转发边补齐 ---------- */
initG()
stubUpstream({ dropAfter: 1000 })
{
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('append', 'bytes=0-'), res)
}
{
  initG()
  puts.length = 0
  const ranges = stubUpstream()
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('append', 'bytes=1000-'), res)
  ok('客户端从残片末尾重连时，上游也从同一位置续',
    ranges.length === 1 && ranges[0] === 'bytes=1000-', 'ranges=' + JSON.stringify(ranges))
  ok('这一轮只发后半段（不重复发已下好的 1000 字节）',
    res.body().length === 2000 && res.body().equals(BUF.slice(1000)) && res.status === 206,
    'len=' + res.body().length + ' status=' + res.status)
  ok('续传完成后缓存是整首（不再每次断流都重拉）',
    puts.length === 1 && puts[0].size === 3000, 'puts=' + JSON.stringify(puts))
}

/* ---------- ④ 上游不认 Range → 残片作废，整首不重复 ---------- */
initG()
stubUpstream({ dropAfter: 1000 })
{
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('nores', 'bytes=0-'), res)
}
{
  initG()
  puts.length = 0
  const ranges = stubUpstream({ ignoreRange: true })
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('nores', 'bytes=0-'), res)
  ok('上游不认 Range 时残片作废，不硬拼前缀（否则整首会重复两段）',
    res.body().length === 3000 && res.body().equals(BUF) && res.status === 200,
    'len=' + res.body().length + ' status=' + res.status + ' ranges=' + JSON.stringify(ranges))
  ok('作废后仍按整段重新缓存', puts.length === 1 && puts[0].size === 3000, 'puts=' + JSON.stringify(puts))
}

/* ---------- ⑤ 上游 502 / 打不开：残片必须归还，不能变孤儿 ---------- */
initG()
stubUpstream({ dropAfter: 1000 })
{
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('orphan', 'bytes=0-'), res)
  ok('前置：先造一份 1000 字节残片', partsInCache().length === 1, 'parts=' + JSON.stringify(partsInCache()))
}
{
  initG()
  puts.length = 0
  // 上游明确 502（真机里对应 CDN 拒绝 / 签名失效）
  global.fetch = async () => ({
    ok: false,
    status: 502,
    headers: { get: (k) => (k === 'content-type' ? 'audio/mpeg' : null) },
    body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }
  })
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('orphan', 'bytes=0-'), res)
  const parts = partsInCache()
  const size = parts.length ? fs.statSync(path.join(CACHE, parts[0])).size : 0
  ok('上游 502 后残片仍在盘上（不是没人认领的孤儿）', parts.length === 1 && size === 1000,
    'parts=' + JSON.stringify(parts) + ' size=' + size)
  ok('502 这一轮不写缓存索引', puts.length === 0, 'puts=' + puts.length)
}
{
  initG()
  puts.length = 0
  const ranges = stubUpstream()
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('orphan', 'bytes=0-'), res)
  ok('归还的残片下一轮还能续上（上游只收后半段）',
    ranges.length === 1 && ranges[0] === 'bytes=1000-' && res.body().length === 3000 && res.body().equals(BUF),
    'ranges=' + JSON.stringify(ranges) + ' len=' + res.body().length)
  ok('续上后缓存按整首落盘', puts.length === 1 && puts[0].size === 3000, 'puts=' + JSON.stringify(puts))
}

/* ---------- ⑥ 解析抛错：日志必须保留真因（catch 里要调得到兜底函数） ---------- */
initG()
stubUpstream({ dropAfter: 1000 })
{
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('throwparse', 'bytes=0-'), res)
}
{
  logLines.length = 0
  const G = initG()
  G.online.getPlayable = async () => { throw new Error('boom-parse-failed') }
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('throwparse', 'bytes=0-'), res)
  ok('解析抛错时日志保留真因，且不出现 ReferenceError',
    logLines.some((l) => l.includes('boom-parse-failed')) &&
    !logLines.some((l) => l.includes('is not defined')),
    logLines.join(' | '))
  ok('解析抛错仍回 500，残片原样在盘上',
    res.status === 500 && partsInCache().length === 1, 'status=' + res.status + ' parts=' + partsInCache().length)
}
{
  initG()
  puts.length = 0
  const ranges = stubUpstream()
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('throwparse', 'bytes=0-'), res)
  ok('抛错之后残片还能续上', ranges[0] === 'bytes=1000-' && res.body().length === 3000,
    'ranges=' + JSON.stringify(ranges) + ' len=' + res.body().length)
}

/* ---------- ⑦ 上游打不开：keepResume 必须在 catch 分支真的执行 ---------- */
initG()
stubUpstream({ dropAfter: 1000 })
{
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('fetchfail', 'bytes=0-'), res)
}
{
  initG()
  puts.length = 0
  logLines.length = 0
  const realFetch = global.fetch
  global.fetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1') }
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('fetchfail', 'bytes=0-'), res)
  ok('上游打不开 → 502 且残片归还（不再变孤儿）',
    res.status === 502 && partsInCache().length === 1 &&
    logLines.some((l) => l.includes('上游打开失败')) &&
    !logLines.some((l) => l.includes('is not defined')),
    'status=' + res.status + ' parts=' + partsInCache().length + ' logs=' + logLines.join(' | '))
  global.fetch = realFetch
}
{
  initG()
  const ranges = stubUpstream()
  const res = new FakeRes()
  await SP.handleStreamRequest(reqOf('fetchfail', 'bytes=0-'), res)
  ok('上游恢复后从残片末尾续上', ranges[0] === 'bytes=1000-' && res.body().length === 3000,
    'ranges=' + JSON.stringify(ranges) + ' len=' + res.body().length)
}

global.fetch = REAL_FETCH
try { fs.rmSync(CACHE, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
