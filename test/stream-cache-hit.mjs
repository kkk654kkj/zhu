'use strict'
/**
 * 缓存命中两条分支的真响应测试（T02-01 回归）
 *
 * 背景：v3.3.71 引入单飞后，「解析后降级档命中缓存」这条分支调 serveLocalFile
 * （内部 rs.pipe(res) 立即返回）后直接 return，handleStreamRequest 的 finally
 * 紧接着 res.end() —— 真实 ServerResponse 会因此不再输出正文，客户端拿到
 * 声明的 Content-Length 和 0 字节。FakeRes 里 write/end 是同步假实现，测不出来，
 * 所以这里用**真 http.Server + 真 fetch**。
 *
 * 覆盖：
 *   ① 首查缓存命中（cacheHit）→ 整段出流
 *   ② 解析后降级档命中（cacheTry）→ 整段出流（本次回归点）
 *   ③ 降级档命中 + Range → 206 且只发请求的那段
 *
 * 用法：node test/stream-cache-hit.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, '.stream-cache-hit')
const require2 = createRequire(import.meta.url)
const Module = require2('module')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const SIZE = 200000
try { fs.rmSync(CACHE, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
fs.mkdirSync(CACHE, { recursive: true })
const FILE = path.join(CACHE, 'hit.mp3')
const BUF = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i++) BUF[i] = (i * 7) % 251
fs.writeFileSync(FILE, BUF)

const hit = { path: FILE, cls: 'mp3', rec: { title: 'T', artist: 'A', ext: 'mp3' } }
const fakeDC = {
  _idx: {},
  cacheLoad: () => fakeDC._idx,
  // hit1：首查就命中；hit2：首查不中、解析后按实际档位命中
  cacheHit: (song) => (song.id === 'hit1' ? hit : null),
  cacheTry: (song) => (song.id === 'hit2' ? hit : null),
  cacheClassOf: () => 'mp3',
  cacheKeyOf: (song) => song.id,
  cacheDirPath: () => CACHE,
  cachePut: () => {},
  isReadableFromCacheOrData: (p) => String(p).startsWith(CACHE)
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

const logs = []
SP.init({
  store: { get: () => ({ settings: { onlineCacheOn: true } }) },
  online: {
    // 无损请求被上游降级成 mp3 的那条路：返回的 info 是 mp3 档
    getPlayable: async () => ({ url: 'http://up/x', ext: 'mp3', lossless: false, bitrate: 320 }),
    invalidateUrl: () => {}
  },
  logLine: (...a) => logs.push(a.join(' ')),
  sendToRenderer: () => {}
})

const server = http.createServer((req, res) => { SP.handleStreamRequest(req, res) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

async function get(q, range) {
  const opt = { signal: AbortSignal.timeout(8000) }
  if (range) opt.headers = { Range: range }
  try {
    const r = await fetch(base + '/stream?src=kw&id=' + q.id + '&q=' + (q.prefer || 'master') + '&t=&a=&d=0', opt)
    const buf = Buffer.from(await r.arrayBuffer())
    return { status: r.status, len: buf.length, buf, error: null, headers: r.headers }
  } catch (err) {
    return { status: 0, len: 0, buf: Buffer.alloc(0), error: err && err.message }
  }
}

/* ① 首查命中 */
{
  const r = await get({ id: 'hit1' })
  ok('首查缓存命中 → 整段 200KB 正文送达',
    !r.error && r.status === 200 && r.len === SIZE && r.buf.equals(BUF),
    'status=' + r.status + ' len=' + r.len + (r.error ? ' err=' + r.error : ''))
}

/* ② 解析后降级档命中（回归点） */
{
  const r = await get({ id: 'hit2' })
  ok('解析后降级档命中 → 仍然整段送达（不再被 finally 的 end 截断）',
    !r.error && r.status === 200 && r.len === SIZE && r.buf.equals(BUF),
    'status=' + r.status + ' len=' + r.len + (r.error ? ' err=' + r.error : ''))
}

/* ③ 降级档命中 + Range */
{
  const r = await get({ id: 'hit2' }, 'bytes=1000-')
  ok('降级档命中 + Range → 206 且只发后半段',
    !r.error && r.status === 206 && r.len === SIZE - 1000 && r.buf.equals(BUF.slice(1000)),
    'status=' + r.status + ' len=' + r.len + (r.error ? ' err=' + r.error : ''))
}

/* ④ 走完以后连接能正常收尾（不是挂着） */
{
  const t0 = Date.now()
  const r = await get({ id: 'hit2' })
  ok('请求能自行结束（连接不悬挂）', !r.error && Date.now() - t0 < 8000, 'elapsed=' + (Date.now() - t0) + 'ms')
}

server.close()
try { fs.rmSync(CACHE, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
