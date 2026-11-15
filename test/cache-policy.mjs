'use strict'
/**
 * 在线缓存策略运行时单测 · v3.3.58
 *
 * 「保留缓存 / 退出时自动清除」做成设置面板可切换开关后，必须真跑一遍：
 * 默认值、settings patch 白名单、cacheStats 回传、以及退出清理只删自己的文件。
 *
 * 用法：node test/cache-policy.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
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

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-policy-'))
const fakePROTO = { realpathCached: (d) => d, isSafeMediaRoot: () => true }
const origLoad = Module._load
Module._load = function (request) {
  if (request === './protocols') return fakePROTO
  return origLoad.apply(this, arguments)
}
const DC = require2(path.join(ROOT, 'src/main/dircache.js'))
const SS = require2(path.join(ROOT, 'src/main/settings-schema.js'))
Module._load = origLoad

const settings = {
  onlineCacheOn: true,
  onlineCacheDir: DIR,
  onlineCacheLimitMB: 4096
}
const G = {
  store: { get: () => ({ settings }) },
  DATA_DIR: DIR,
  logLine: () => {},
  DEFAULT_SETTINGS: settings
}
DC.init(G)
SS.init(G)

const DEFAULT = {
  onlineCacheOn: true,
  onlineCacheDir: '',
  onlineCacheLimitMB: 4096,
  onlineCacheClearOnExit: false
}

/* ---------- ① 默认值：保留缓存（退出不清） ---------- */
ok('默认策略是「保留缓存」，退出自动清除为关',
  DC.cacheStats().clearOnExit === false, JSON.stringify(DC.cacheStats()))
settings.onlineCacheClearOnExit = true
ok('开关打开后 cacheStats 回传给面板 true',
  DC.cacheStats().clearOnExit === true, 'clearOnExit=' + DC.cacheStats().clearOnExit)

/* ---------- ② settings patch 白名单：布尔放行、其它拒绝 ---------- */
const a = SS.sanitizeSettingsPatch({ onlineCacheClearOnExit: true }, DEFAULT)
const b = SS.sanitizeSettingsPatch({ onlineCacheClearOnExit: false }, DEFAULT)
const c = SS.sanitizeSettingsPatch({ onlineCacheClearOnExit: 'true' }, DEFAULT)
const d = SS.sanitizeSettingsPatch({ onlineCacheClearOnExitMaybe: true }, DEFAULT)
ok('布尔 true / false 都能写进 settings', a.onlineCacheClearOnExit === true && b.onlineCacheClearOnExit === false,
  JSON.stringify([a, b]))
ok('字符串 / 拼错的键一律被清洗掉（面板误传不会写脏配置）',
  !Object.prototype.hasOwnProperty.call(c, 'onlineCacheClearOnExit') &&
  Object.keys(d).length === 0, JSON.stringify([c, d]))

/* ---------- ③ 退出清理只删自己的缓存文件与 .part ---------- */
const mine = path.join(DIR, 'a.mp3')
const minePart = path.join(DIR, 'f'.repeat(64) + '.abc123.part')
const other = path.join(DIR, 'other.txt')
const otherPart = path.join(DIR, 'other-downloader.part')
fs.writeFileSync(mine, 'x'.repeat(128))
fs.writeFileSync(minePart, 'part')
fs.writeFileSync(other, 'keep me')
fs.writeFileSync(otherPart, 'keep me too')
DC.cacheIdx = null
fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify({
  k1: { file: 'a.mp3', title: 'T', artist: 'A', ext: 'mp3', size: 128, at: Date.now() }
}), 'utf8')
const r = DC.cacheClear()
ok('cacheClear 删掉索引内缓存并回报数量',
  r.removed === 1 && !fs.existsSync(mine) && !fs.existsSync(minePart),
  'removed=' + r.removed)
ok('不碰用户目录里的其它文件 / 其它下载器的 .part',
  fs.existsSync(other) && fs.existsSync(otherPart) && DC.cacheStats().count === 0,
  'count=' + DC.cacheStats().count)

/* ---------- ④ 退出链先 cacheSave 再 cacheClear：索引不许被写空 ---------- */
const DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-policy-exit-'))
const mp3b = path.join(DIR2, 'bbbb.mp3')
fs.writeFileSync(mp3b, 'y'.repeat(256))
fs.writeFileSync(path.join(DIR2, 'index.json'), JSON.stringify({
  k2: { file: 'bbbb.mp3', title: 'T2', artist: 'A', ext: 'mp3', size: 256, at: Date.now() }
}), 'utf8')
settings.onlineCacheDir = DIR2
DC.cacheIdx = null              // 本次会话没碰过缓存，模拟退出链的真实状态
DC.cacheSave()                 // finishQuit 无条件补的第一次写盘
let idxAfter = null
try { idxAfter = JSON.parse(fs.readFileSync(path.join(DIR2, 'index.json'), 'utf8')) } catch (e) { /* 忽略 */ }
ok('退出链先 cacheSave（索引未加载）不会把 index.json 写成空表',
  !!idxAfter && Object.keys(idxAfter).length === 1 && idxAfter.k2 && idxAfter.k2.size === 256,
  JSON.stringify(idxAfter))
DC.cacheIdx = null
const r2 = DC.cacheClear()
ok('紧接着 cacheClear 仍能删掉这首缓存（不再「删除 0 首」）',
  r2.removed === 1 && !fs.existsSync(mp3b), 'removed=' + r2.removed)

try { fs.rmSync(DIR, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
try { fs.rmSync(DIR2, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
