'use strict'
/** master（本地版）第五轮移植验证：检查适用修复都在、联网独有功能没被带进来 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const REPO = 'D:/文档/deepseek-harness/default-workspace/lx-player'
let pass = 0, fail = 0
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n, x) } else { fail++; console.log('  ✗', n, x) } }
const R = (f) => fs.readFileSync(path.join(REPO, f), 'utf8')

console.log('=== 1) 语法检查 ===')
let bad = 0
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if (e.name === 'node_modules' || e.name === '.git') continue
  const p = path.join(d, e.name)
  if (e.isDirectory()) walk(p)
  else if (/\.(js|mjs)$/.test(e.name)) {
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' })
    if (r.status !== 0) { bad++; console.log('  ✗', path.relative(REPO, p), (r.stderr || '').slice(0, 160)) }
  }
} }
walk(path.join(REPO, 'src'))
for (const f of ['tools/check-dist.mjs', 'test/smoke.mjs', 'make-lnk.js', 'make-vbs.js']) {
  const p = path.join(REPO, f)
  if (fs.existsSync(p)) { const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' }); if (r.status !== 0) { bad++; console.log('  ✗', f) } }
}
ok('全量 node --check', bad === 0, bad ? `${bad} 个失败` : '')
for (const f of ['pack-one.sh', 'install-one.sh']) {
  const r = spawnSync('bash', ['-n', path.join(REPO, f)], { encoding: 'utf8' })
  ok(`bash -n ${f}`, r.status === 0)
}

console.log('\n=== 2) 主进程：适用修复都在 ===')
const m = R('src/main/main.js')
// v3.3.24 拆分后：白名单/lxfile 协议在 protocols.js，fallback 载荷在 mpv-manager.js
const protoM = R('src/main/protocols.js')
const mpvmM = R('src/main/mpv-manager.js')
ok('P0 mpv:stop 改调 reset()', /'mpv:stop'[^\n]*reset\(\)/.test(m))
ok('fallback 载荷带 exclusive:false', /type: 'fallback'[^\n]*exclusive: false/.test(mpvmM))
ok('白名单盘符 D: 归一化', /fixDriveRoot|\[A-Za-z\]:/.test(m))
ok('白名单 realpath 防 junction', /realpathSync\.native|realpathCached/.test(protoM))
ok('lxfile Range 全文锚定', /\^bytes=\\d\*-\\d\*\(,/.test(protoM))
ok('settings:patch 值校验', /sanitizeSettingsPatch/.test(m))
ok('dlyric:cfg 复用过滤', /sanitizeSettingsPatch[\s\S]{0,2000}dlyric:cfg|dlyric:cfg[\s\S]{0,400}sanitizeSettingsPatch/.test(m))
ok('lib:scan 处理 skipped', /res\.skipped|\.skipped/.test(m))
ok('quitGuard 提到 20 秒', /const quitGuard = setTimeout\([\s\S]{0,700}?\}\s*,\s*20000\)/.test(m))
ok('cleanupStarted 防重入', /cleanupStarted/.test(m))
ok('电源 systemShutdownPending', /systemShutdownPending/.test(m))
ok('shutdown 命令补 callback', /execFile\('shutdown'[^\n]*,\s*\w+\)/.test(m) || /onShutdownDone/.test(m))
ok('mpv:devices 判据加 exclusive', /startedHere[\s\S]{0,200}eng\.exclusive === false/.test(m))
ok('player:queue-end 发送者校验', /player:queue-end[\s\S]{0,200}senderFrame|player:queue-end[\s\S]{0,200}webContents/.test(m))
ok('second-instance 异步 stat', /second-instance[\s\S]{0,600}async \(event, argv\)/.test(m) && /await fsp\.stat\(abs\)/.test(m))
ok('曲末配对去重（mpv.js）', /_eofAt/.test(R('src/main/mpv.js')))
ok('MpvEngine.reset() 存在', /^\s+reset\(\)/m.test(R('src/main/mpv.js')))

console.log('\n=== 3) 主进程：联网独有功能没有被带进来 ===')
for (const [n, p] of [
  ['无 startStreamServer', 'startStreamServer'],
  ['无 cacheDirPath', 'cacheDirPath'],
  ['无 dlSaveNow', 'dlSaveNow'],
  ['无 dlRun', 'async function dlRun'],
  ['无 AbortSignal.timeout 流代理', 'AbortSignal.timeout'],
  ['无 atomicWriteJson', 'atomicWriteJson'],
  ['无 cacheKeyOf', 'function cacheKeyOf'],
  ['无 serveLocalFile', 'function serveLocalFile'],
  ['无 online:dl* IPC', "online:dlDelete"],
]) ok(n, !m.includes(p), m.includes(p) ? '← 误带入！' : '')

console.log('\n=== 4) 渲染层 ===')
const a = R('src/renderer/js/app.js')
// v3.3.24 渲染层拆分后：onScanDone 在 scan.js；master 的持久化留在 app.js（无 persist.js）
const scanM = R('src/renderer/js/scan.js')
const exM = R('src/renderer/js/exclusive.js')
const p = R('src/renderer/js/player.js')
const u = R('src/renderer/js/ui.js')
ok('连续失败计数', /consecutiveFails/.test(a))
ok('skipToNext 调用', /player\.skipToNext\s*\(/.test(a))
ok('cancelSkipTimer', /cancelSkipTimer/.test(a))
ok('flushSaveSettings', /flushSaveSettings/.test(a))
ok('退出前 flush 有调用点', /flushSaveSettingsForExit|flushSaveSettings\(\)/.test(a))
ok('fallback 置 exclusiveFellBack 而非 exclusive=false',
    /state\.exclusiveFellBack\s*=\s*true/.test(exM) &&
    !/function applyExclusiveFallback[\s\S]{0,800}?state\.exclusive\s*=\s*false/.test(exM))
// v3.3.18（第四轮 §4.3 #4）：回包只同步本次 patch 涉及的键，不再整份 Object.assign
// v3.3.24：master 的 applySettings 随多选分节落在 selection.js（两分支分节边界略有差异）
ok('settings 回包按键增量同步', /for \(const k of Object\.keys\(patch\)\)/.test(R('src/renderer/js/selection.js')) &&
  !/Object\.assign\(state\.settings, s\)/.test(R('src/renderer/js/selection.js')))
ok('响度预跳过独立计数', /preSkipped/.test(R('src/renderer/js/eq.js')))
ok('onScanDone 对象引用', /kept\.indexOf\(curTrack\)/.test(scanM))
ok('btnMax 意图 token', /maxIntent/.test(a))
ok('player.skipToNext 已定义', /skipToNext\s*\(/.test(p))
ok('player.next 支持 fromError', /fromError/.test(p))
ok('_loadCurrent 复位 _lastEndedAt', /_lastEndedAt\s*=\s*0/.test(p))
ok('UI.setEqDisabled 存在', /setEqDisabled/.test(u))
ok('util.debounce.cancel', /debounced\.cancel|fn\.cancel/.test(R('src/renderer/js/util.js')))
ok('util toast 去重', /toastShownAt|TOAST_DEDUP/.test(R('src/renderer/js/util.js')))
ok('diag epoch', /_liveEpoch/.test(R('src/renderer/js/diag.js')))
ok('loudness 解码前限长', /maxSeconds/.test(R('src/renderer/js/loudness.js')))
ok('dragdrop 对象引用', /dragQRef|indexOf\(/.test(R('src/renderer/js/dragdrop.js')))

console.log('\n=== 5) 冲突标记 / 版本号 / 脚本 ===')
ok('无冲突标记', !/^<<<<<<<|^>>>>>>>/m.test(m + a + p))
ok('install-one.sh 有 PIPESTATUS', /PIPESTATUS/.test(R('install-one.sh')))
ok('pack-one.sh 有参数校验', /:\s*"\$\{1:\?|exit 1/.test(R('pack-one.sh')))
ok('check-dist 有 size 校验', /\.size > 0/.test(R('tools/check-dist.mjs')))
ok('smoke 断言加强', /v\.hit\s*>\s*0|hit > 0/.test(R('test/smoke.mjs')))

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
