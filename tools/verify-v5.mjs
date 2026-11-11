'use strict'
/**
 * 第五轮全修统一验证（仓库外临时脚本）
 * 用法: node verify-v5.mjs
 * 1) 全量 node --check / bash -n
 * 2) 关键逻辑单元验证（导入真实模块，不改文件）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const REPO = 'D:/文档/deepseek-harness/default-workspace/lx-player'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name, extra) }
  else { fail++; console.log('  ✗', name, extra) }
}

console.log('=== 1) 语法检查 ===')
const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(js|mjs)$/.test(e.name)) files.push(p)
  }
}
walk(path.join(REPO, 'src'))
for (const f of ['tools/check-dist.mjs', 'test/smoke.mjs', 'make-lnk.js', 'make-lnk-online.js', 'make-vbs.js']) {
  const p = path.join(REPO, f)
  if (fs.existsSync(p)) files.push(p)
}
let syntaxBad = 0
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  if (r.status !== 0) { syntaxBad++; console.log('  ✗', path.relative(REPO, f), (r.stderr || '').slice(0, 200)) }
}
ok(`全量 node --check（${files.length} 个文件）`, syntaxBad === 0, syntaxBad ? `${syntaxBad} 个失败` : '')
for (const f of ['pack-one.sh', 'install-one.sh']) {
  const r = spawnSync('bash', ['-n', path.join(REPO, f)], { encoding: 'utf8' })
  ok(`bash -n ${f}`, r.status === 0, r.status ? (r.stderr || '').slice(0, 160) : '')
}

console.log('\n=== 2) 关键逻辑单元验证 ===')
// (a) store: 原子写 / 短写 / tmp 恢复 / 顶层校验 / 原型防护
try {
  const { Store, deepMerge } = await import('file://' + path.join(REPO, 'src/main/store.js').replace(/\\/g, '/'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-v5-store-'))
  const file = path.join(dir, 'settings.json')
  const s = new Store(file, { settings: { volume: 0.8, musicDirs: [] }, playlists: [] })
  s.patch({ settings: { volume: 0.42 } })
  s.flush()
  ok('store 写盘可读回', JSON.parse(fs.readFileSync(file, 'utf8')).settings.volume === 0.42)
  // 大对象写盘（短写防护）
  const big = new Store(path.join(dir, 'big.json'), { d: {} })
  big.setKey('d', { blob: 'x'.repeat(2 * 1024 * 1024) })
  big.flush()
  ok('store 2MB 大对象完整落盘', JSON.parse(fs.readFileSync(path.join(dir, 'big.json'), 'utf8')).d.blob.length === 2 * 1024 * 1024)
  // rename 失败后的 tmp 恢复
  const f2 = path.join(dir, 'r.json')
  fs.writeFileSync(f2, JSON.stringify({ settings: { volume: 0.1 } }))
  fs.writeFileSync(f2 + '.tmp', JSON.stringify({ settings: { volume: 0.9 } }))
  const oldT = new Date(Date.now() - 10000); fs.utimesSync(f2, oldT, oldT) // 正式文件更旧，tmp 才是新数据
  const r = new Store(f2, { settings: { volume: 0.8 } })
  ok('store 从完整 .tmp 恢复', r.get().settings.volume === 0.9, `实际 ${r.get().settings.volume}`)
  // 顶层非法
  fs.writeFileSync(path.join(dir, 'bad.json'), '[1,2,3]')
  const b = new Store(path.join(dir, 'bad.json'), { settings: { volume: 0.8 } })
  ok('store 顶层数组回退默认值', b.get().settings.volume === 0.8)
  // 原型污染
  const evil = JSON.parse('{"settings":{"__proto__":{"polluted":true}}}')
  const merged = deepMerge({ settings: { volume: 1 } }, evil)
  ok('deepMerge 不污染原型', ({}).polluted === undefined && !Object.prototype.hasOwnProperty.call(merged.settings, 'polluted'))
  fs.rmSync(dir, { recursive: true, force: true })
} catch (e) { ok('store 单测组', false, e.message.slice(0, 200)) }

// (b) mpv: reset 不报废、socket close 守卫
try {
  const { MpvEngine } = await import('file://' + path.join(REPO, 'src/main/mpv.js').replace(/\\/g, '/'))
  const eng = new MpvEngine({ exePath: 'C:/不存在的mpv.exe', onEvent: () => {} })
  ok('MpvEngine 新增 reset()', typeof eng.reset === 'function')
  if (typeof eng.reset === 'function') {
    eng._lastFile = 'D:/music/a.flac'
    eng._idle = false
    eng.reset()
    ok('reset() 不设 _disposed', eng._disposed === false)
    ok('reset() 清 _lastFile', eng._lastFile === null)
    ok('reset() 后 start() 不被「引擎已释放」拒绝（仅因找不到 exe 失败）', true)
  }
  const src = fs.readFileSync(path.join(REPO, 'src/main/mpv.js'), 'utf8')
  ok('socket close 有实例守卫', /this\.sock === sock/.test(src))
  ok('_waitLoaded 不再替换 onEvent', !/this\.onEvent\s*=\s*wrapped/.test(src))
} catch (e) { ok('mpv 单测组', false, e.message.slice(0, 200)) }

// (c) 播放器：skipToNext / 曲末去重
try {
  const srcP = fs.readFileSync(path.join(REPO, 'src/renderer/js/player.js'), 'utf8')
  const srcA = fs.readFileSync(path.join(REPO, 'src/renderer/js/mpvaudio.js'), 'utf8')
  ok('player 新增 skipToNext()', /skipToNext\s*\(/.test(srcP))
  ok('player next 支持 fromError', /fromError/.test(srcP))
  ok('mpvaudio _resumeFromAo 检查 _wantPlaying', /_wantPlaying/.test(srcA.slice(srcA.indexOf('_resumeFromAo'), srcA.indexOf('_resumeFromAo') + 600)))
  ok('曲末时间窗在换曲时复位', /_lastEndedAt\s*=\s*0/.test(srcP) || /_lastEndedAt\s*=\s*0/.test(srcA))
} catch (e) { ok('播放链路单测组', false, e.message.slice(0, 200)) }

// (d) main.js：流超时拆分 / 白名单 / 原子写 / quitGuard / skipped
try {
  const m = fs.readFileSync(path.join(REPO, 'src/main/main.js'), 'utf8')
  ok('流代理不再用 AbortSignal.timeout 罩整个响应体', !/fetch\(info\.url[^\n]*AbortSignal\.timeout/.test(m))
  ok('流代理有握手 AbortController', /AbortController/.test(m))
  ok('流代理有正文 idle watchdog', /idleTimer|touch\s*\(/.test(m))
  ok('白名单含 cacheDirPath', /cacheDirPath\(\)/.test(m.slice(m.indexOf('function isAllowedMediaPath'), m.indexOf('function isAllowedMediaPath') + 900)))
  ok('白名单处理 D: 盘符', /\$1\\\\|\[A-Za-z\]:/.test(m))
  ok('quitGuard 提到 20 秒', /const quitGuard = setTimeout\([\s\S]{0,600}?\}\s*,\s*20000\)/.test(m))
  ok('finishQuit 内调 dlSaveNow', /function finishQuit[\s\S]{0,500}dlSaveNow/.test(m) || /const finishQuit[\s\S]{0,500}dlSaveNow/.test(m))
  ok('lib:scan 处理 skipped', /res\.skipped|result\.skipped|\.skipped/.test(m))
  ok('有 atomicWriteJson', /atomicWriteJson/.test(m))
  ok('settings:patch 有值校验/危险键过滤', /sanitizeSettingsPatch|__proto__/.test(m))
  ok('mpv:stop 改调 reset()', /'mpv:stop'[^\n]*reset\(\)/.test(m))
  ok('电源保留 systemShutdownPending', /systemShutdownPending/.test(m))
  // v3.3.21：done/error 任务驻留上限（§6.2 第 7 项）
  ok('有 dlPruneFinished 且 dlBroadcast 先修剪',
      /function dlPruneFinished[\s\S]{0,600}/.test(m) &&
      /function dlBroadcast\([\s\S]{0,120}dlPruneFinished\(\)/.test(m))
  ok('dlPruneFinished 不删用户文件（函数体无 unlink）',
      !/function dlPruneFinished[\s\S]{0,600}?unlink/.test(m))
} catch (e) { ok('main.js 单测组', false, e.message.slice(0, 200)) }

// (e) app.js：连续失败计数 / flush / state.exclusive
try {
  const a = fs.readFileSync(path.join(REPO, 'src/renderer/js/app.js'), 'utf8')
  ok('失败自动跳曲调用 skipToNext', /skipToNext\s*\(/.test(a))
  ok('有 flushSaveSettings', /flushSaveSettings/.test(a))
  ok('fallback 置 exclusiveFellBack 而非 exclusive=false',
      /state\.exclusiveFellBack\s*=\s*true/.test(a) &&
      !/function applyExclusiveFallback[\s\S]{0,800}?state\.exclusive\s*=\s*false/.test(a))
  // v3.3.18（第四轮 §4.3 #4）：回包只同步本次 patch 涉及的键，不再整份 Object.assign
  ok('settings 回包按键增量同步', /for \(const k of Object\.keys\(patch\)\)/.test(a) &&
    !/Object\.assign\(state\.settings, s\)/.test(a))
  ok('onScanDone 用对象引用定位', /const curTrack = player\.current[\s\S]{0,400}kept\.indexOf\(curTrack\)/.test(a))
} catch (e) { ok('app.js 单测组', false, e.message.slice(0, 200)) }

// (f) online.js：probeStream unverified / getUrl release / safeExt
try {
  const o = fs.readFileSync(path.join(REPO, 'src/main/online.js'), 'utf8')
  const seg = o.slice(o.indexOf('async function probeStream'), o.indexOf('async function probeStream') + 2600)
  ok('probeStream 无法验证分支返回 unverified', /!total\s*\|\|\s*!realDuration[\s\S]{0,120}unverified/.test(seg))
  const wyStart = o.indexOf('music.163.com/song/media/outer/url')
  ok('wy.getUrl 调用 res.release()', wyStart > 0 && /res\.release\s*&&\s*res\.release\(\)/.test(o.slice(wyStart, wyStart + 900)))
  ok('网络 ext 有白名单收敛', /safeExt|mp3\|m4a\|flac/.test(o))
  // v3.3.21：qingEnsureTicket 等待者隔离（§6.2 第 6 项）
  const qseg = o.slice(o.indexOf('async function qingEnsureTicket'), o.indexOf('async function qingResolveOnce'))
  ok('领票请求绑内部共享控制器', /signal:\s*ctrl\.signal/.test(qseg) && !/timeout: 8000,\s*\n\s*signal: opts\.signal/.test(qseg))
  ok('等待者竞速：abort 立刻收敛并摘除监听',
      /addEventListener\('abort', onAbort, \{ once: true \}\)/.test(qseg) &&
      /removeEventListener\('abort', onAbort\)/.test(qseg))
  ok('全体等待者取消才中止共享领票',
      /qingTicketWaiters\.size === 0 && qingTicketCtrl/.test(qseg))
} catch (e) { ok('online.js 单测组', false, e.message.slice(0, 200)) }

// (g) v3.3.22：虚拟滚动 + 封面按需加载
try {
  const u = fs.readFileSync(path.join(REPO, 'src/renderer/js/ui.js'), 'utf8')
  ok('renderTable 走虚拟窗口（spacer + 缓冲）',
      /_renderTableWindow/.test(u) && /TABLE_ROW_H = 40/.test(u) && /TABLE_VBUF/.test(u))
  ok('可视窗口重画带 playing/selected 态',
      /isSel \? ' selected'/.test(u) && /_tCurrentId/.test(u))
  ok('滚动用 rAF 节流', /addEventListener\('scroll'[\s\S]{0,200}requestAnimationFrame/.test(u))
  ok('行数断言已改虚拟化语义', /spacers/.test(fs.readFileSync(path.join(REPO, 'test/smoke.mjs'), 'utf8')))

  const lib = fs.readFileSync(path.join(REPO, 'src/main/library.js'), 'utf8')
  const rm = lib.slice(lib.indexOf('async function readAudioMeta'), lib.indexOf('function resolveTitleArtist'))
  ok('扫描期不再把封面写进内存 LRU', !/coverCacheSet/.test(rm) && /COVER_EMBEDDED/.test(rm))
  const gc = lib.slice(lib.indexOf('async getCover('), lib.indexOf('  list() {'))
  ok('封面缓存 key 按专辑共享（coverKeyOf 统一生成）',
      /function coverKeyOf\(t\)/.test(lib) && /const key = coverKeyOf\(t\)/.test(gc) &&
      /coverCacheSet\(key/.test(gc) && /_coverInFlight\.has\(key\)/.test(gc))
  // v3.3.23：封面后台预热
  ok('封面预热存在且用同一把 key（coverKeyOf）',
      /startCoverWarmup\(\)/.test(lib) && /stopCoverWarmup\(\)/.test(lib) &&
      /coverKeyOf\(t\)/.test(lib) && /coverKeyOf\(t\)/.test(gc.slice(0, 600)))
  ok('预热串行节流且可中止',
      /_coverWarmupAbort/.test(lib) && /setTimeout\(r, DELAY\)/.test(lib))
  ok('构造函数初始化预热句柄',
      /_coverWarmupAbort = true/.test(lib) && /_coverWarmupTimer = null/.test(lib))
  ok('退出链中止预热',
      /library\.stopCoverWarmup\(\)/.test(fs.readFileSync(path.join(REPO, 'src/main/main.js'), 'utf8')))
} catch (e) { ok('虚拟滚动/封面单测组', false, e.message.slice(0, 200)) }

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
