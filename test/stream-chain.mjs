'use strict'
/**
 * 在线播放流式链路运行时单测 · v2.8.49 / v3.3.57
 *
 * 以前这条链路只有正则哨兵：/stream 的 HTTP 转发、上游失败降级、缓存写盘背压、
 * 正文低速看门狗全都没有运行时断言，所以「测试全绿」与真机转圈 / 断续能长期并存。
 * 这里用打桩的 req/res/fetch/DC 真跑 streamproxy.js 导出的函数。
 *
 * 用法：node test/stream-chain.mjs
 */
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require2 = createRequire(import.meta.url)
const Module = require2('module')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/* ---------- 打桩装载真实 streamproxy.js ---------- */
const fakeDC = {
  cacheHit: () => null,
  cacheTry: () => null,
  cacheClassOf: () => 'mp3',
  cacheKeyOf: () => 'key',
  cacheDirPath: () => path.join(ROOT, '.stream-test-cache'),
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
Module._load = origLoad

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
let G = null
function initG(overrides = {}) {
  G = Object.assign({
    store: { get: () => ({ settings: { onlineCacheOn: false } }) },
    online: {
      getPlayable: async () => ({ url: 'http://up/x', ext: 'mp3', lossless: false }),
      invalidateUrl: () => {}
    },
    logLine: (...a) => logLines.push(a.join(' ')),
    sendToRenderer: () => {}
  }, overrides)
  SP.init(G)
}

/* ---------- ① 上游打开失败 → 作废直链 + 降级到 best 重试一次 ---------- */
{
  const calls = []
  const origFetch = global.fetch
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
  global.fetch = origFetch
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

/* ---------- ② 缓存写盘背压不许挡在音频转发前面 ---------- */
{
  initG()
  const order = []
  class FakeWrite extends EventEmitter {
    write() { order.push('disk'); return false }   // 模拟磁盘背压
    destroy() {}
    end() {}
  }
  const part = { path: 'x.part', stream: new FakeWrite(), bytes: 0 }
  let drops = 0
  const dropPart = () => { drops++; part.stream = null; part.path = null }
  const res = new FakeRes()
  res.write = (buf) => { order.push('net'); res.writes.push(Buffer.from(buf)); return true }
  let n = 0
  const reader = {
    read: async () => (n++ < 2 ? { done: false, value: Buffer.alloc(64, 1) } : { done: true }),
    cancel: async () => {}
  }
  const t0 = Date.now()
  await SP.pumpUpstreamBody({
    reader, res, ctrl: new AbortController(), part, dropPart, finishCache: () => {}
  })
  const elapsed = Date.now() - t0
  ok('每个 chunk 都先送给 <audio> 再尝试写盘',
    order[0] === 'net' && order[1] === 'disk' && order[2] === 'net', JSON.stringify(order))
  ok('写盘背压直接放弃缓存，不再 await waitDrain 阻塞音频',
    drops === 1 && elapsed < 1000, 'drops=' + drops + ' elapsed=' + elapsed + 'ms')
  ok('音频数据完整转发且响应正常收尾',
    res.writes.length === 2 && res.ended === true, 'chunks=' + res.writes.length)
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
    reader, res, ctrl, part, dropPart: () => {}, finishCache: () => {}
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

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
