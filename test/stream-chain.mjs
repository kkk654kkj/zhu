'use strict'
/**
 * 在线播放流式链路运行时单测 · v2.8.49 / v3.3.57 / v3.3.58
 *
 * 以前这条链路只有正则哨兵：/stream 的 HTTP 转发、上游失败降级、缓存写盘背压、
 * 正文低速看门狗全都没有运行时断言，所以「测试全绿」与真机转圈 / 断续能长期并存。
 * 这里用打桩的 req/res/fetch/DC 真跑 streamproxy.js 导出的函数。
 *
 * v3.3.58 增补：缓存「播完却永远不落盘」的回归测试 —— 写盘背压、chunked 上游、
 * start=0 的 Range 首请求、正文不完整时的残片校验。
 *
 * 用法：node test/stream-chain.mjs
 */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_CACHE = path.join(ROOT, '.stream-test-cache')
const require2 = createRequire(import.meta.url)
const Module = require2('module')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/* ---------- 打桩装载真实 streamproxy.js ---------- */
const fakeDC = {
  // v2.8.53 / v3.3.62：finishCache 收尾要看索引里有没有这条 key ——
  // 只判「同名文件在不在」会让清缓存后被占用的孤儿文件永久占位（自锁）。
  _idx: {},
  cacheLoad: () => fakeDC._idx,
  cacheHit: () => null,
  cacheTry: () => null,
  cacheClassOf: () => 'mp3',
  cacheKeyOf: () => 'key',
  cacheDirPath: () => TEST_CACHE,
  cachePut: () => {}
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
    this.writes = []
    this.ended = false
    this.writableEnded = false
    this.writableFinished = false
    this.headersSent = false
    this.destroyed = false
  }
  writeHead(s) { this.status = s; this.headersSent = true; return this }
  end() { this.ended = true; this.writableEnded = true; return this }
  write(buf) { this.writes.push(Buffer.from(buf)); return true }
  destroy() { this.destroyed = true; return this }
}

const upstreamHeaders = (extra = {}) => ({
  get: (k) => (k === 'content-type' ? 'audio/mpeg' : (extra[k] || null))
})

const logLines = []
function initG(overrides = {}) {
  const G = Object.assign({
    store: { get: () => ({ settings: { onlineCacheOn: false } }) },
    online: {
      getPlayable: async () => ({ url: 'http://up/x', ext: 'mp3', lossless: false }),
      invalidateUrl: () => {}
    },
    logLine: (...a) => logLines.push(a.join(' ')),
    sendToRenderer: () => {}
  }, overrides)
  SP.init(G)
  return G
}

/** 造一个带头/不带头的上游响应，chunks 发完就 done */
function stubUpstream(chunks, headers = {}) {
  let i = 0
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: upstreamHeaders(headers),
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        cancel: async () => {}
      })
    }
  })
}

function resetCacheDir() {
  try { fs.rmSync(TEST_CACHE, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
  fakeDC.cachePut = () => {}
}

/* ---------- ① 上游打开失败 → 作废直链 + 降级到 best 重试一次 ---------- */
{
  const calls = []
  let fetchCalls = 0
  global.fetch = async () => {
    fetchCalls++
    if (fetchCalls === 1) {
      const e = new Error('This operation was aborted')
      e.name = 'AbortError'
      throw e
    }
    return {
      ok: true, status: 200, headers: upstreamHeaders(),
      body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }
    }
  }
  let invalidated = 0
  initG({
    online: {
      getPlayable: async (song, prefer) => {
        calls.push(prefer)
        return { url: 'http://up/' + prefer, ext: prefer === 'master' ? 'flac' : 'mp3',
                 lossless: prefer === 'master' }
      },
      invalidateUrl: () => { invalidated++ }
    },
    sendToRenderer: (ev, payload) => calls.push(ev + ':' + (payload && payload.lossless))
  })
  const req = { url: '/stream?src=kg&id=abc&q=master&t=&a=&d=0', headers: {}, method: 'GET' }
  const res = new FakeRes()
  await SP.handleStreamRequest(req, res)
  global.fetch = REAL_FETCH
  ok('母带档上游打开失败 → 作废直链缓存', invalidated === 1, 'invalidated=' + invalidated)
  ok('降级到普通档重新解析并再取流一次（只试一次）',
    calls[0] === 'master' && calls[1] === 'best' && fetchCalls === 2,
    JSON.stringify(calls) + ' fetch=' + fetchCalls)
  ok('降级成功后正常出流（200 而非 502）且 now-playing 用降级后的音质',
    res.status === 200 && res.ended === true && calls.includes('online:now-playing:false'),
    'status=' + res.status + ' ended=' + res.ended)
  ok('降级失败日志可见（便于真机排查）',
    logLines.some((l) => l.includes('上游打开失败')) && logLines.some((l) => l.includes('降级重试成功')),
    logLines.join(' | '))
}

/* ---------- ② 写盘背压：音频先走，缓存不丢 ---------- */
{
  initG()
  resetCacheDir()
  const order = []
  class FakeWrite extends EventEmitter {
    constructor() { super(); this.written = [] }
    write(b) {
      order.push('disk')
      this.written.push(Buffer.from(b).length)
      setImmediate(() => this.emit('drain'))   // 磁盘稍后腾出手
      return false                              // 每个块都背压
    }
    destroy() {}
    end(cb) { if (cb) cb() }
  }
  const w = new FakeWrite()
  const part = { path: 'x.part', stream: w, bytes: 0 }
  let drops = 0, finished = 0
  const dropPart = () => { drops++; part.stream = null; part.path = null }
  const writer = SP.createCacheWriter(part, () => dropPart())
  const res = new FakeRes()
  res.write = (buf) => { order.push('net'); res.writes.push(Buffer.from(buf)); return true }
  let n = 0
  const reader = {
    read: async () => (n++ < 2 ? { done: false, value: Buffer.alloc(64, 1) } : { done: true }),
    cancel: async () => {}
  }
  const t0 = Date.now()
  await SP.pumpUpstreamBody({
    reader, res, ctrl: new AbortController(), part, dropPart,
    finishCache: async () => { finished++ }, cacheWrite: writer.write
  })
  const elapsed = Date.now() - t0
  await writer.flush()
  ok('每个 chunk 都先送给 <audio> 再投递写盘队列',
    order[0] === 'net' && order[1] === 'disk' && order.filter((x) => x === 'net').length === 2,
    JSON.stringify(order))
  ok('全程背压也不丢弃整首缓存，后台队列照样把两个块写完',
    drops === 0 && part.bytes === 128 && w.written.length === 2 && finished === 1,
    'drops=' + drops + ' bytes=' + part.bytes + ' written=' + JSON.stringify(w.written))
  ok('写盘背压不阻塞音频转发（不等待磁盘 drain）',
    elapsed < 1000 && res.writes.length === 2 && res.ended === true,
    'elapsed=' + elapsed + 'ms chunks=' + res.writes.length)
  resetCacheDir()
}

/* ---------- ③ 上游「每秒滴几字节」也要被最低速率看门狗终止 ---------- */
{
  initG()
  let rateCb = null
  const origSetInterval = global.setInterval
  const origClearInterval = global.clearInterval
  global.setInterval = (fn, ms) => {
    if (ms === 20000) { rateCb = fn; return 987654 }
    return origSetInterval(fn, ms)
  }
  global.clearInterval = (id) => { if (id !== 987654) origClearInterval(id) }
  const ctrl = new AbortController()
  const res = new FakeRes()
  let n = 0
  const reader = {
    read: () => {
      n++
      if (n === 1) return Promise.resolve({ done: false, value: Buffer.from([1]) })
      return new Promise((_resolve, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(new Error('aborted by rate watchdog')), { once: true })
      })
    },
    cancel: async () => {}
  }
  const part = { path: null, stream: null, bytes: 0 }
  const pending = SP.pumpUpstreamBody({
    reader, res, ctrl, part, dropPart: () => {}, finishCache: async () => {}
  })
  // 让循环进入第二次 read（挂起），再手动触发 20 秒速率窗口
  await new Promise((r) => setImmediate(r))
  const gotCb = typeof rateCb === 'function'
  if (gotCb) rateCb()
  await pending
  global.setInterval = origSetInterval
  global.clearInterval = origClearInterval
  ok('20 秒窗口内不足 32KB 时终止上游（不依赖 chunk 刷新空闲看门狗）',
    gotCb && ctrl.signal.aborted === true, 'aborted=' + ctrl.signal.aborted)
  ok('终止后响应连接正常收掉，<audio> 能收到明确失败', res.ended === true, 'ended=' + res.ended)
  ok('低速终止有日志线索', logLines.some((l) => l.includes('速率过低')), logLines.join(' | '))
}

/* ---------- ④ 真跑 /stream：chunked 上游 + start=0 Range → 缓存落盘 ---------- */
{
  resetCacheDir()
  let put = null
  fakeDC.cachePut = (key, file, meta, size) => { put = { key, file, size } }
  initG({ store: { get: () => ({ settings: { onlineCacheOn: true } }) } })
  const chunks = [Buffer.alloc(1000, 1), Buffer.alloc(2000, 2), Buffer.alloc(3000, 3)]
  stubUpstream(chunks)   // 故意不给 Content-Length，模拟 chunked 音源
  const req = { url: '/stream?src=kg&id=chunk&q=best&t=&a=&d=0',
                headers: { range: 'bytes=0-1048575' }, method: 'GET' }
  const res = new FakeRes()
  await SP.handleStreamRequest(req, res)
  global.fetch = REAL_FETCH
  const target = path.join(TEST_CACHE, 'key.mp3')
  const exists = fs.existsSync(target)
  const size = exists ? fs.statSync(target).size : 0
  ok('chunked 上游（无 Content-Length）完整播完照样落盘',
    exists && size === 6000 && put && put.size === 6000,
    'exists=' + exists + ' size=' + size + ' put=' + JSON.stringify(put))
  ok('start=0 的 Range 首请求（bytes=0-N）不再被挡在缓存门外',
    exists && logLines.some((l) => l.includes('缓存完成') && l.includes('chunked')),
    logLines.filter((l) => l.includes('缓存')).join(' | '))
  ok('音频正文仍完整转发且响应正常收尾',
    res.writes.length === 3 && res.ended === true && res.status === 200,
    'chunks=' + res.writes.length + ' status=' + res.status)
  resetCacheDir()
}

/* ---------- ⑤ 正文比声明短：必须丢残片，不能把半首歌写成缓存 ---------- */
{
  resetCacheDir()
  let put = null
  fakeDC.cachePut = () => { put = true }
  initG({ store: { get: () => ({ settings: { onlineCacheOn: true } }) } })
  stubUpstream([Buffer.alloc(6000, 7)], { 'content-length': '10000' })
  const req = { url: '/stream?src=kg&id=short&q=best&t=&a=&d=0', headers: {}, method: 'GET' }
  const res = new FakeRes()
  await SP.handleStreamRequest(req, res)
  global.fetch = REAL_FETCH
  const files = fs.existsSync(TEST_CACHE) ? fs.readdirSync(TEST_CACHE) : []
  ok('上游声明 10000 字节却只给 6000：残片被删且留日志',
    files.length === 0 && put === null && logLines.some((l) => l.includes('正文不完整')),
    'files=' + JSON.stringify(files))
  resetCacheDir()
}

/* ---------- ⑥ 非从头 Range（拖进度条）不许写脏缓存 ---------- */
{
  resetCacheDir()
  let put = null
  fakeDC.cachePut = () => { put = true }
  initG({ store: { get: () => ({ settings: { onlineCacheOn: true } }) } })
  stubUpstream([Buffer.alloc(1000, 9)], { 'content-length': '1000' })
  const req = { url: '/stream?src=kg&id=seek&q=best&t=&a=&d=0',
                headers: { range: 'bytes=1024-' }, method: 'GET' }
  const res = new FakeRes()
  await SP.handleStreamRequest(req, res)
  global.fetch = REAL_FETCH
  const files = fs.existsSync(TEST_CACHE) ? fs.readdirSync(TEST_CACHE) : []
  ok('拖进度条的 Range 请求不生成缓存文件', files.length === 0 && put === null,
    'files=' + JSON.stringify(files))
  ok('不缓存时音频照常转发', res.writes.length === 1 && res.ended === true,
    'chunks=' + res.writes.length)
  resetCacheDir()
}

/* ---------- ⑦ 索引里没有的孤儿缓存文件必须被覆盖重建（自锁环回归） ---------- */
{
  resetCacheDir()
  let put = null
  fakeDC._idx = {}                                   // 索引为空 = 清缓存后文件被占用的状态
  fakeDC.cachePut = (key, file, meta, size) => { put = { key, file, size } }
  initG({ store: { get: () => ({ settings: { onlineCacheOn: true } }) } })
  // 预先在目标位置放一个「孤儿」：索引里没有它，但文件还在
  fs.mkdirSync(TEST_CACHE, { recursive: true })
  fs.writeFileSync(path.join(TEST_CACHE, 'key.mp3'), Buffer.alloc(1024, 0xEE))
  stubUpstream([Buffer.alloc(6000, 5)])
  const req = { url: '/stream?src=kg&id=orphan&q=best&t=&a=&d=0', headers: {}, method: 'GET' }
  const res = new FakeRes()
  await SP.handleStreamRequest(req, res)
  global.fetch = REAL_FETCH
  const target = path.join(TEST_CACHE, 'key.mp3')
  const size = fs.existsSync(target) ? fs.statSync(target).size : 0
  ok('孤儿缓存文件被新数据覆盖并重新登记索引（不再永久自锁）',
    size === 6000 && put && put.size === 6000,
    'size=' + size + ' put=' + JSON.stringify(put))
  resetCacheDir()
  fakeDC._idx = {}
}

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
