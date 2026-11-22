#!/usr/bin/env node
'use strict'
/**
 * R02-07：上游 416 补救分支的桩测试（v3.3.75）
 *
 * 为什么要有这支测试：`streamproxy.js:572-596` 那段补救代码在真实音源下**不可达** ——
 *   · 断点登记表 `resumeParts` 是进程内 Map，不落盘，造不出跨进程的「已登记完整残片」；
 *   · kw / qq / kg / wy 四家 × 128k/母带 实测全部回 `Content-Length`（无 chunked），
 *     于是 `expectTotal` 恒 > 0，`:720` 的提前拦截必然先把「收满的残片」转正，
 *     `bytes == 真总长` 的断点永远登记不出来。
 * 所以只能在测试里用桩数据把它的两个关键步骤拉出来验：
 *   ① `promoteResumeToCache`：残片 rename 成缓存 + cachePut 记账（含幂等与非法 ext）
 *   ② `serveLocalFile`：`Range: bytes=<total>-` 必须回 `416` + Content-Range 的 `bytes * /<total>``
 *      —— 证明客户端看到的那条 416 是 RFC 正解，不是死链
 * 分支接线（`total416 === startAt` 才 promote、promote 成功才 `serveLocalFile` 出流）
 * 用静态断言钉住，因为不注入桩上游就没法运行时跑到那段代码。
 *
 * 只在 online 分支跑（master 没有 streamproxy.js）。
 * 用法：node test/stream-416-promote.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const req = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/* ---------------- 桩：dircache / protocols / 日志 ---------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx416-'))
const puts = []
const logs = []
let cacheIndex = {}

const DC = {
  cacheDirPath: () => tmp,
  cacheLoad: () => cacheIndex,
  cachePut: (key, file, meta, bytes) => { puts.push({ key, file, meta, bytes }) },
  isReadableFromCacheOrData: () => true,
  cacheKeyOf: () => 'k',
  cacheClassOf: () => 'c',
  CACHE_PART_RE: /\.[a-z0-9]+\.part$/i
}
const PROTO = { mimeFor: () => 'audio/flac', isSafeMediaRoot: () => true }
const HTTPU = {}

/** 用 vm 载入真实 streamproxy.js，require 换成桩（原生模块仍走真实现） */
const sandbox = {
  require: (id) => {
    if (id === 'path') return path
    if (id === 'fs') return fs
    if (id === 'http') return req('node:http')
    if (id === 'crypto') return req('node:crypto')
    if (id === './dircache') return DC
    if (id === './protocols') return PROTO
    if (id === './http-util') return HTTPU
    throw new Error('未桩的 require: ' + id)
  },
  module: { exports: {} },
  exports: {},
  console,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  URLSearchParams,
  TextDecoder,
  AbortController,
  fetch: () => Promise.reject(new Error('测试里不该发真请求'))
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
const src = fs.readFileSync(path.join(ROOT, 'src/main/streamproxy.js'), 'utf8')
vm.runInContext(src + '\n;globalThis.__SP = module.exports\n', sandbox, { filename: 'streamproxy.js' })
const SP = sandbox.__SP
SP.init({ logLine: (...a) => logs.push(a.join(' ')) })

ok('streamproxy.js 能在桩环境装载', SP && typeof SP.serveLocalFile === 'function')
ok('promoteResumeToCache 已导出（旧代码没导出 → 这里必须红）', typeof SP.promoteResumeToCache === 'function')

/* ---------------- ① 残片转正 ---------------- */

const partA = path.join(tmp, 'k1.abc.part')
fs.writeFileSync(partA, Buffer.alloc(2048, 7))
const got1 = SP.promoteResumeToCache(partA, 'k1', { ext: 'flac' }, { title: '晴天', artist: '周杰伦' }, 2048)
const target1 = path.join(tmp, 'k1.flac')
ok('返回缓存文件绝对路径', got1 === target1, 'got=' + got1)
ok('缓存文件已生成且字节数对', fs.existsSync(target1) && fs.statSync(target1).size === 2048)
ok('残片已 rename 走（不残留 .part）', !fs.existsSync(partA))
ok('cachePut 记账 bytes 正确', puts.length === 1 && puts[0].bytes === 2048 && puts[0].file === 'k1.flac',
  JSON.stringify(puts[0] || null))
ok('日志出现「残片已完整」', logs.some((l) => /残片已完整/.test(l)), logs.join(' | '))

/* ---------------- ② 目标已存在时幂等 ---------------- */

const partB = path.join(tmp, 'k1.bcd.part')
fs.writeFileSync(partB, Buffer.alloc(1024, 1))
cacheIndex = { k1: { file: 'k1.flac' } }
puts.length = 0
const got2 = SP.promoteResumeToCache(partB, 'k1', { ext: 'flac' }, { title: '晴天', artist: '周杰伦' }, 1024)
ok('目标已登记时复用已有缓存', got2 === target1)
ok('自己那份残片被删掉', !fs.existsSync(partB))
ok('不重复记账（cachePut 没再调）', puts.length === 0, 'puts=' + puts.length)
ok('已有缓存文件内容没被覆盖', fs.statSync(target1).size === 2048)

/* ---------------- ③ 非法 ext 落回 mp3 ---------------- */

cacheIndex = {}
const partC = path.join(tmp, 'k2.xyz.part')
fs.writeFileSync(partC, Buffer.alloc(64, 3))
const got3 = SP.promoteResumeToCache(partC, 'k2', { ext: 'exe' }, { title: 't', artist: 'a' }, 64)
ok('非法 ext 落回 .mp3（不写 .exe）', got3 === path.join(tmp, 'k2.mp3'), 'got=' + got3)

/* ---------------- ④ serveLocalFile 对 bytes=<total>- 回 416 ---------------- */

const served = path.join(tmp, 'k3.flac')
fs.writeFileSync(served, Buffer.alloc(5000, 9))

function fakeRes() {
  const out = { status: 0, headers: null, body: Buffer.alloc(0), ended: false }
  out.writeHead = (code, headers) => { out.status = code; out.headers = headers || null }
  out.end = () => { out.ended = true }
  out.write = (b) => { out.body = Buffer.concat([out.body, Buffer.from(b)]); return true }
  out.on = () => out
  out.once = () => out
  out.emit = () => out
  out.destroy = () => {}
  return out
}

const res1 = fakeRes()
SP.serveLocalFile(served, { method: 'GET', headers: { range: 'bytes=5000-' } }, res1)
ok('起点=总长 → 416', res1.status === 416, 'status=' + res1.status)
ok('416 带 Content-Range: bytes */5000', res1.headers && res1.headers['Content-Range'] === 'bytes */5000',
  JSON.stringify(res1.headers))

const res2 = fakeRes()
SP.serveLocalFile(served, { method: 'GET', headers: { range: 'bytes=0-' } }, res2)
ok('正常 range → 206 且 Content-Range 覆盖到 total-1',
  res2.status === 206 && /bytes 0-4999\/5000/.test(String(res2.headers && res2.headers['Content-Range'])),
  'status=' + res2.status + ' cr=' + (res2.headers && res2.headers['Content-Range']))

/* ---------------- ⑤ 分支接线的静态断言 ---------------- */

const raw = fs.readFileSync(path.join(ROOT, 'src/main/streamproxy.js'), 'utf8')
ok('416 分支只在 total416 === startAt 时转正',
  /total416 > 0 && total416 === startAt[\s\S]{0,80}promoteResumeToCache/.test(raw))
ok('转正成功后对所有订阅者 serveLocalFile 出流',
  /const promoted =[\s\S]{0,900}serveLocalFile\(promoted, sub\.req, sub\.res\)/.test(raw))
ok('转正失败/残片非整首时删残片自愈（不留在登记表）',
  /removePartFile\(resume\.path, null\)[\s\S]{0,200}resume = null/.test(raw))
ok('提前拦截：收满且覆盖到 total-1 才走 finishCache',
  /part\.bytes >= expectTotal && crCoversAll/.test(raw))

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
process.exit(fail ? 1 : 0)
