'use strict'
/**
 * /stream 同曲并发单飞（T02-01 / v3.3.71）
 *
 * 以前同一首歌被 <audio> 与 mpv 同时加载、或列表连点，每个请求各解析各拉流：
 * 无损解析 1~7 秒，几秒内能把上游打三次，用户看到「点了没反应」。
 * 这里真跑 streamproxy.js，断言：
 *   ① 3 个同 Range 并发请求 → 只解析 1 次、只拉上游 1 次、三份正文都完整
 *   ② Range 不同不并（各段字节不同，共用一条上游必然是错的）
 *   ③ 已发响应头的在途请求不再接受插队（后来的自己另起一条上游）
 *   ④ 单个订阅者断开不踢掉另一个，另一个照样收完整首
 *
 * 用法：node test/stream-singleflight.mjs
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
  _idx: {},
  cacheLoad: () => fakeDC._idx,
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
  destroy() { this.destroyed = true; return this }
  body() { return Buffer.concat(this.writes) }
}

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

const upstreamHeaders = () => ({
  get: (k) => (k === 'content-type' ? 'audio/mpeg' : null)
})

/** 可控制节奏的上游：chunks 逐个给出，gate 用来在块之间挂住（每条 fetch 各一份游标） */
function stubUpstream(chunks, gate) {
  global.fetch = async () => {
    let i = 0
    return {
      ok: true,
      status: 200,
      headers: upstreamHeaders(),
      body: {
        getReader: () => ({
          read: async () => {
            if (i === 1 && gate) await gate
            return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }
          },
          cancel: async () => {}
        })
      }
    }
  }
}

const reqOf = (range, id = 'abc', q = 'best') => ({
  url: `/stream?src=kw&id=${id}&q=${q}&t=&a=&d=0`,
  headers: range ? { range } : {},
  method: 'GET'
})

/* ---------- ① 3 个同 Range 并发 → 1 次解析、1 次上游、三份完整正文 ---------- */
{
  initG()
  let fetchCalls = 0
  let playableCalls = 0
  const chunks = [Buffer.alloc(1024, 1), Buffer.alloc(2048, 2)]
  const origFetch = global.fetch
  stubUpstream(chunks)
  const inner = global.fetch
  global.fetch = async (...a) => { fetchCalls++; return inner(...a) }
  const G = initG({
    online: {
      getPlayable: async () => { playableCalls++; return { url: 'http://up/x', ext: 'mp3' } },
      invalidateUrl: () => {}
    }
  })
  void G

  const rests = [new FakeRes(), new FakeRes(), new FakeRes()]
  await Promise.all(rests.map((res) => SP.handleStreamRequest(reqOf('bytes=0-'), res)))

  const sizes = rests.map((r) => r.body().length)
  ok('3 个并发只解析一次直链', playableCalls === 1, 'getPlayable=' + playableCalls)
  ok('3 个并发只拉一次上游', fetchCalls === 1, 'fetch=' + fetchCalls)
  ok('三份正文都完整（1024+2048）',
    sizes.every((n) => n === 3072) && rests.every((r) => r.ended && r.status === 200),
    'sizes=' + JSON.stringify(sizes) + ' status=' + JSON.stringify(rests.map((r) => r.status)))
  ok('合并有日志线索（便于真机确认单飞生效）',
    logLines.filter((l) => l.includes('单飞合并')).length === 2,
    logLines.filter((l) => l.includes('单飞合并')).join(' | '))
  global.fetch = origFetch
}

/* ---------- ② Range 不同不并 → 两条上游 ---------- */
{
  initG()
  let fetchCalls = 0
  const origFetch = global.fetch
  stubUpstream([Buffer.alloc(512, 3)])
  const inner = global.fetch
  global.fetch = async (...a) => { fetchCalls++; return inner(...a) }
  const r1 = new FakeRes()
  const r2 = new FakeRes()
  await Promise.all([
    SP.handleStreamRequest(reqOf('bytes=0-'), r1),
    SP.handleStreamRequest(reqOf('bytes=1024-'), r2)
  ])
  ok('Range 不同各拉各的上游（不共用字节）', fetchCalls === 2 && r1.body().length === 512 && r2.body().length === 512,
    'fetch=' + fetchCalls + ' lens=' + r1.body().length + '/' + r2.body().length)
  global.fetch = origFetch
}

/* ---------- ③ 已发响应头的在途请求不接受插队 ---------- */
{
  initG()
  let fetchCalls = 0
  let release
  const gate = new Promise((r) => { release = r })
  const origFetch = global.fetch
  stubUpstream([Buffer.alloc(1000, 4), Buffer.alloc(1000, 5)], gate)
  const inner = global.fetch
  global.fetch = async (...a) => { fetchCalls++; return inner(...a) }

  const first = new FakeRes()
  const p1 = SP.handleStreamRequest(reqOf('bytes=0-'), first)
  // 等第一块发出（= 响应头已发、已封口）
  for (let i = 0; i < 200 && first.writes.length === 0; i++) await new Promise((r) => setImmediate(r))
  const sealedWhileStreaming = first.writes.length === 1 && fetchCalls === 1

  const late = new FakeRes()
  const pLate = SP.handleStreamRequest(reqOf('bytes=0-'), late)
  for (let i = 0; i < 200 && fetchCalls < 2; i++) await new Promise((r) => setImmediate(r))
  const lateOwnUpstream = fetchCalls === 2

  release()
  await Promise.all([p1, pLate])
  ok('已开始转发的请求不再接受插队（不会缺开头）',
    sealedWhileStreaming && lateOwnUpstream && late.ended,
    'sealed=' + sealedWhileStreaming + ' fetch=' + fetchCalls)
  ok('先到的请求本身仍收完整两段', first.body().length === 2000, 'len=' + first.body().length)
  global.fetch = origFetch
}

/* ---------- ④ 一个订阅者断开不踢掉另一个 ---------- */
{
  initG()
  let fetchCalls = 0
  let aborted = false
  const origFetch = global.fetch
  let i = 0
  global.fetch = async () => {
    fetchCalls++
    return {
      ok: true,
      status: 200,
      headers: upstreamHeaders(),
      body: {
        getReader: () => ({
          read: async () => {
            if (i === 1) await new Promise((r) => setTimeout(r, 10))
            if (i >= 2) return { done: true }
            return { done: false, value: Buffer.alloc(1500, 6 + i++) }
          },
          cancel: async () => { aborted = true }
        })
      }
    }
  }
  const a = new FakeRes()
  const b = new FakeRes()
  const pa = SP.handleStreamRequest(reqOf('bytes=0-', 'dup'), a)
  const pb = SP.handleStreamRequest(reqOf('bytes=0-', 'dup'), b)
  await new Promise((r) => setImmediate(r))
  // a 切歌：模拟客户端断开
  a.writableFinished = false
  a.emit('close')
  await Promise.all([pa, pb])
  ok('单个订阅者断开不取消上游（另一个接着收）', !aborted && fetchCalls === 1, 'aborted=' + aborted + ' fetch=' + fetchCalls)
  ok('留下的订阅者仍收完整首', b.body().length === 3000 && b.ended, 'len=' + b.body().length)
  global.fetch = origFetch
}

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
