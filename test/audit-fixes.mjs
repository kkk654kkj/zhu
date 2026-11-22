'use strict'
/**
 * v2.8.63 审查修复 · 回归哨兵（2026-11-22，本地版）
 *
 * 与联网版 test/audit-fixes.mjs 同源，去掉本地版没有的模块（在线代理/下载器/在线点播）：
 *   A. lxfile 白名单：DATA_DIR 子树硬拒（settings.json / library.json），只放行 covers。
 *   B. 上游地址闸门：私网/IPv6/非 http(s)/DNS 失败都拒；重定向逐跳校验；跳数上限。
 *   C. 其余修复的静态哨兵（mpv 看门狗 / 迟到 eof / 桌面歌词连点 / 监视扫描 / 退出期窗口）。
 *
 * 用法：node test/audit-fixes.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require2 = createRequire(import.meta.url)
const Module = require2('module')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-audit-fix-m-'))
const dataDir = path.join(tmp, 'data')
const musicDir = path.join(tmp, 'music')
const outsideDir = path.join(tmp, 'outside')
for (const d of [dataDir, path.join(dataDir, 'covers'), musicDir, outsideDir]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'settings.json'), '{"volume":0.8}')
fs.writeFileSync(path.join(dataDir, 'library.json'), '{}')
fs.writeFileSync(path.join(dataDir, 'covers', 'aaaa.jpg'), 'x')
fs.writeFileSync(path.join(musicDir, 'song.mp3'), 'x')
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'x')

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') return { protocol: { handle() {} }, shell: { openPath() {} } }
  return origLoad.apply(this, arguments)
}
const PROTO = require2(path.join(ROOT, 'src/main/protocols.js'))
const HTTPU = require2(path.join(ROOT, 'src/main/http-util.js'))
Module._load = origLoad

let musicDirs = [musicDir]
PROTO.init({
  DATA_DIR: dataDir,
  MIME_BY_EXT: {},
  logLine() {},
  store: { get: () => ({ settings: { musicDirs } }) },
  downloadDir: () => path.join(tmp, 'downloads'),
  cacheDirPath: () => path.join(tmp, 'cache')
})

console.log('\nA. lxfile 白名单（P2-2：DATA_DIR 子树硬拒）')
ok('A1 DATA_DIR\\settings.json 被拒', PROTO.isAllowedMediaPath(path.join(dataDir, 'settings.json')) === false)
ok('A2 DATA_DIR\\library.json 被拒', PROTO.isAllowedMediaPath(path.join(dataDir, 'library.json')) === false)
ok('A3 DATA_DIR\\covers 下的旧封面仍放行', PROTO.isAllowedMediaPath(path.join(dataDir, 'covers', 'aaaa.jpg')) === true)
ok('A4 音乐目录里的歌放行', PROTO.isAllowedMediaPath(path.join(musicDir, 'song.mp3')) === true)
ok('A5 目录外的文件被拒', PROTO.isAllowedMediaPath(path.join(outsideDir, 'secret.txt')) === false)
musicDirs = [dataDir]
ok('A6 把 musicDirs 改指 DATA_DIR 后 settings.json 仍被拒（绕道封锁）',
  PROTO.isAllowedMediaPath(path.join(dataDir, 'settings.json')) === false)
musicDirs = [musicDir]

console.log('\nB. 上游地址闸门（P2-9）')
const chk = async (u, o) => {
  try { return await HTTPU.checkUrlAllowed(u, o) } catch (e) { return { ok: null, reason: 'no-api' } }
}
ok('B1 回环 127.0.0.1 被拒', (await chk('http://127.0.0.1:8080/x')).reason === 'loopback')
ok('B2 allowLoopback 时放行回环', (await chk('http://127.0.0.1:8080/x', { allowLoopback: true })).ok === true)
ok('B3 私网 10.0.0.5 被拒', String((await chk('http://10.0.0.5/x')).reason).startsWith('private-host'))
ok('B4 IPv6 回环 [::1] 被拒', (await chk('http://[::1]:9000/x')).ok === false)
ok('B5 非 http(s) 协议被拒', (await chk('ftp://example.com/x')).reason === 'bad-protocol')
ok('B6 解析不了的域名按拒绝处理', (await chk('http://no-such-host-4a7f.invalid/x')).ok === false)

const REAL_FETCH = global.fetch
global.fetch = async () => ({
  status: 302, ok: false,
  headers: new Headers({ location: 'http://127.0.0.1:9/steal' }),
  body: { cancel() {} }
})
let blocked = null
try { await HTTPU.fetchSafe('https://example.com/a', {}) } catch (e) { blocked = e }
global.fetch = REAL_FETCH
ok('B7 首跳合法、302 跳内网 → 拦下（BlockedUrlError）',
  !!blocked && blocked.name === 'BlockedUrlError', blocked ? String(blocked.message).slice(0, 60) : 'no-error')

console.log('\nC. 其余修复的静态哨兵')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const mainSrc = read('src/main/main.js')
const mpvSrc = read('src/main/mpv.js')
const mpvaSrc = read('src/renderer/js/mpvaudio.js')
const dlyricSrc = read('src/main/dlyric-window.js')
const protoSrc = read('src/main/protocols.js')

ok('C1 独占看门狗：idle 后 2 秒仍无音频且上是 eof → 清零意图',
  /_lastEndReason === 'eof'/.test(mpvSrc) && /idle-after-eof/.test(mpvSrc) && /this\._lastEndReason = ''/.test(mpvSrc))
ok('C2 停止后 mpv 补发的 eof 被丢弃', /if \(!this\._srcPath\) break/.test(mpvaSrc))
ok('C3 桌面歌词关→开连点不复用正在关闭的窗口',
  /dlyricClosing = true/.test(dlyricSrc) && /dlyricReopen = false/.test(dlyricSrc))
ok('C8 监视增量扫描过白名单', /library\.scan\(dirs,/.test(mainSrc) && /Array\.isArray\(s\.musicDirs\)/.test(mainSrc))
ok('C9 移除目录后清理幽灵曲', /library\.pruneOutsideRoots\(next\.musicDirs\)/.test(mainSrc))
ok('C10 退出清理期点托盘不再重建主窗口', /if \(quitting\) return/.test(mainSrc))
ok('C11 后台实例的关窗询问/原生框不阻塞', /if \(TEST_HIDDEN\(\)\) \{\s*\n\s*if \(win && !win\.isDestroyed\(\)\)/.test(mainSrc))
ok('C12 白名单根不再直接放 DATA_DIR',
  !/^\s*G\.DATA_DIR,\s*$/m.test(protoSrc) && /path\.join\(G\.DATA_DIR, 'covers'\)/.test(protoSrc))
ok('C15 mpv 内网拦截走统一闸门（含域名/IPv6）',
  /HTTPU\.checkUrlAllowed\(u, \{ allowLoopback: true \}\)/.test(mainSrc) && /await isBlockedMpvHttp\(filePath\)/.test(mainSrc))

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败')
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)