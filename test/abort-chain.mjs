/**
 * v3.3.18 回归测试：无损解析整链 AbortSignal（交接文档 §6.2 第 3 项）
 *
 * 跑法：node test/abort-chain.mjs
 * 不依赖 Electron / 网络：fetch 全部打桩，用 new Function 把 online.js 的内部函数暴露给测试。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.resolve(here, '../src/main/online.js')
const src = fs.readFileSync(target, 'utf8')

function loadOnline() {
  const mod = { exports: {} }
  const factory = new Function(
    'module', 'exports', 'require', '__filename', '__dirname',
    src + '\nmodule.exports.__test = {' +
      ' reqOnce, req, probeStream, invalidateUrl, urlCache, urlCachePut,' +
      ' anySignal, abortError, sleepAbortable, qingEnsureTicket,' +
      ' getPlayable, qingTicketExp: () => qingTicketExp }'
  )
  factory(mod, mod.exports, require, target, path.dirname(target))
  return mod.exports
}

const origFetch = globalThis.fetch
let passed = 0
function ok(name) { passed++; console.log('  PASS ' + name) }

function hangingFetch(captured) {
  return (url, init) => {
    captured.push(init.signal)
    return new Promise((resolve, reject) => {
      if (init.signal && init.signal.aborted) return reject(abortErr())
      init.signal && init.signal.addEventListener('abort', () => reject(abortErr()), { once: true })
    })
  }
}
function abortErr() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}
function fakeJsonResponse(obj, extra = {}) {
  return {
    ok: true,
    status: extra.status || 200,
    headers: {
      get: (k) => {
        const key = String(k).toLowerCase()
        if (key === 'content-range') return extra.contentRange || ''
        if (key === 'content-type') return extra.contentType || 'application/json'
        return null
      }
    },
    body: { cancel() {} },
    text: async () => JSON.stringify(obj),
    json: async () => obj
  }
}
async function withDeadline(p, ms, label) {
  let t = null
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout: ' + label)), ms) })
    ])
  } finally {
    if (t) clearTimeout(t)
  }
}

try {
  // ① reqOnce：外部 signal 必须桥接到底层 fetch，并清掉超时计时器
  {
    const A = loadOnline()
    const captured = []
    globalThis.fetch = hangingFetch(captured)
    const ctrl = new AbortController()
    const p = A.__test.reqOnce('https://example.test/x', { signal: ctrl.signal, timeout: 60000 })
    assert.equal(captured.length, 1)
    assert.equal(captured[0].aborted, false)
    ctrl.abort()
    await assert.rejects(p)
    assert.equal(captured[0].aborted, true, 'fetch 的 signal 应随外部 abort 一起中止')
    ok('reqOnce 把外部 signal 桥到 fetch')
  }

  // ② 已 abort 的 signal 不应再发请求
  {
    const A = loadOnline()
    let calls = 0
    globalThis.fetch = () => { calls++; return Promise.resolve(fakeJsonResponse({})) }
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(A.__test.reqOnce('https://example.test/x', { signal: ctrl.signal }))
    assert.equal(calls, 0)
    ok('已取消的 signal 不再发请求')
  }

  // ③ invalidateUrl：flac: 前缀缓存与全档清除
  {
    const A = loadOnline()
    globalThis.fetch = () => Promise.resolve(fakeJsonResponse({}))
    const T = A.__test
    const song = { source: 'qq', id: '1' }
    T.urlCache.set('flac:qq:1:lossless', { url: 'a', at: Date.now() })
    T.urlCache.set('qq:1:lossless', { url: 'b', at: Date.now() })
    T.urlCache.set('qq:1:best', { url: 'c', at: Date.now() })
    assert.equal(T.invalidateUrl(song, 'lossless'), true)
    assert.equal(T.urlCache.has('flac:qq:1:lossless'), false, '无损死链必须能被作废')
    assert.equal(T.urlCache.has('qq:1:lossless'), false)
    T.urlCache.set('flac:qq:1:master', { url: 'd', at: Date.now() })
    T.invalidateUrl(song, null)
    assert.equal(T.urlCache.size, 0, '全清分支要覆盖 flac: 前缀')
    ok('invalidateUrl 覆盖 flac: 前缀缓存')
  }

  // ④ probeStream：实测码率优先于接口标称值
  {
    const A = loadOnline()
    // 3.5MB / 200s -> 140kbps；接口谎报 999
    globalThis.fetch = () => Promise.resolve(fakeJsonResponse({}, {
      status: 206, contentRange: 'bytes 0-1/3500000', contentType: 'audio/flac'
    }))
    const r = await A.__test.probeStream({ url: 'https://example.test/a.flac', bitrate: 999 }, 200, 200)
    assert.equal(r.bitrate, 140, '应采信 Content-Range 实测值，而不是接口标称 999')
    assert.equal(r.partial, false)
    ok('probeStream 用实测码率，不采信标称值')
  }

  // ⑤ qingEnsureTicket：expiresAt 为相对 TTL 秒时不能判成 1970 年
  {
    const A = loadOnline()
    globalThis.fetch = () => Promise.resolve(fakeJsonResponse({ ticket: 'tk', expiresAt: 43200 }))
    const before = Date.now()
    const ticket = await A.__test.qingEnsureTicket({})
    assert.equal(ticket, 'tk')
    assert.ok(A.__test.qingTicketExp() > before + 11 * 3600 * 1000,
      '相对 TTL 43200 应换成 now+12h，而不是 1970 年')
    ok('票据 expiresAt 兼容相对 TTL')
  }

  // ⑥ 主链路：外部 signal 一 abort，无损链 + 降级链的所有在途请求都要被收掉
  {
    const A = loadOnline()
    const captured = []
    globalThis.fetch = hangingFetch(captured)
    const ctrl = new AbortController()
    const song = { source: 'qq', id: 'mid001', title: '起风了', artist: '买辣椒也用券', duration: 225 }
    const p = A.getPlayable(song, 'lossless', { signal: ctrl.signal })
    await new Promise((r) => setTimeout(r, 40))
    assert.ok(captured.length > 0, '应已发出请求')
    ctrl.abort()
    const got = await withDeadline(p, 1500, 'getPlayable 应在 abort 后立刻收敛')
    assert.equal(got, null)
    assert.ok(captured.every((s) => s && s.aborted),
      '所有在途请求的 signal 都应已 abort（否则后台仍会扣 ChKSz 额度）')
    ok('getPlayable 外部取消收掉整条解析链（含降级链）')
  }

  // ⑦ 无损窗口超时：输家自行 abort（不依赖外部 signal），且不留下 7 秒定时器
  {
    const A = loadOnline()
    const captured = []
    globalThis.fetch = hangingFetch(captured)
    const song = { source: 'qq', id: 'mid002', title: '稻香', artist: '周杰伦', duration: 223 }
    const origSetTimeout = globalThis.setTimeout
    const origAbort = AbortController.prototype.abort
    let firstAbortAt = 0
    AbortController.prototype.abort = function (...args) {
      if (!firstAbortAt) firstAbortAt = Date.now()
      return origAbort.apply(this, args)
    }
    // 7 秒窗口压到 60ms；各请求的 8/15 秒超时压到 100ms 让桩快速收敛
    globalThis.setTimeout = (fn, ms, ...a) =>
      origSetTimeout(fn, ms === 7000 ? 60 : (ms >= 8000 ? 100 : ms), ...a)
    const t0 = Date.now()
    try {
      const got = await withDeadline(A.getPlayable(song, 'lossless'), 1500, '无损窗口超时应立刻降级收敛')
      assert.equal(got, null)
      assert.ok(captured.length > 0)
      assert.ok(firstAbortAt > 0, '窗口超时必须主动调用 abort')
      assert.ok(firstAbortAt - t0 < 95,
        '首次 abort 应来自 60ms 的无损窗口超时，而不是 100ms 的请求超时')
      assert.ok(captured.every((s) => s && s.aborted),
        '窗口超时后输家的请求必须全部被 abort（§6.2 第 3 项）')
      ok('无损窗口超时主动 abort 输家')
    } finally {
      globalThis.setTimeout = origSetTimeout
      AbortController.prototype.abort = origAbort
    }
  }

  console.log('\nOK ' + passed + '/7 项回归断言通过')
} finally {
  globalThis.fetch = origFetch
}
