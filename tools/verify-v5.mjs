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
  const src = fs.readFileSync(path.join(REPO, 'src/main/mpv.js'), 'utf8')
  if (typeof eng.reset === 'function') {
    eng._lastFile = 'D:/music/a.flac'
    eng._idle = false
    eng.reset()
    ok('reset() 不设 _disposed', eng._disposed === false)
    ok('reset() 清 _lastFile', eng._lastFile === null)
    // 以前这里直接写 true：53/53 里有一项空转，释放态回归照样全绿
    ok('reset() 后 start() 不被「引擎已释放」拒绝',
      typeof eng.start === 'function' && eng._disposed === false &&
      !/this\._disposed\s*=\s*true/.test(src.slice(src.indexOf('reset('), src.indexOf('reset(') + 500)))
  }
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

// (d) main.js 模块组：流超时拆分 / 白名单 / 原子写 / quitGuard / skipped
// v3.3.24 拆分后：流代理与白名单在 streamproxy.js / protocols.js，下载在 downloader.js，缓存在 dircache.js
try {
  const m = fs.readFileSync(path.join(REPO, 'src/main/main.js'), 'utf8')
  const sp = fs.readFileSync(path.join(REPO, 'src/main/streamproxy.js'), 'utf8')
  const proto = fs.readFileSync(path.join(REPO, 'src/main/protocols.js'), 'utf8')
  const dl = fs.readFileSync(path.join(REPO, 'src/main/downloader.js'), 'utf8')
  ok('流代理不再用 AbortSignal.timeout 罩整个响应体', !/fetch\(info\.url[^\n]*AbortSignal\.timeout/.test(sp))
  ok('流代理有握手 AbortController', /AbortController/.test(sp))
  ok('流代理有正文 idle watchdog', /idleTimer|touch\s*\(/.test(sp))
  ok('白名单含 cacheDirPath', /cacheDirPath\(\)/.test(proto.slice(proto.indexOf('function isAllowedMediaPath'), proto.indexOf('function isAllowedMediaPath') + 900)))
  ok('白名单处理 D: 盘符', /\$1\\\\|\[A-Za-z\]:/.test(proto))
  ok('quitGuard 提到 20 秒', /const quitGuard = setTimeout\([\s\S]{0,600}?\}\s*,\s*20000\)/.test(m))
  ok('finishQuit 内调 dlSaveNow', /function finishQuit[\s\S]{0,500}dlSaveNow/.test(m) || /const finishQuit[\s\S]{0,500}dlSaveNow/.test(m))
  ok('lib:scan 处理 skipped', /res\.skipped|result\.skipped|\.skipped/.test(m))
  ok('有 atomicWriteJson', /atomicWriteJson/.test(fs.readFileSync(path.join(REPO, 'src/main/dircache.js'), 'utf8')))
  ok('settings:patch 有值校验/危险键过滤', /sanitizeSettingsPatch|__proto__/.test(m))
  ok('mpv:stop 改调 reset()', /'mpv:stop'[^\n]*reset\(\)/.test(m))
  ok('电源保留 systemShutdownPending', /systemShutdownPending/.test(m))
  // v3.3.21：done/error 任务驻留上限（§6.2 第 7 项）
  ok('有 dlPruneFinished 且 dlBroadcast 先修剪',
      /function dlPruneFinished[\s\S]{0,600}/.test(dl) &&
      /function dlBroadcast\([\s\S]{0,120}dlPruneFinished\(\)/.test(dl))
  ok('dlPruneFinished 不删用户文件（函数体无 unlink）',
      !/function dlPruneFinished[\s\S]{0,600}?unlink/.test(dl))
} catch (e) { ok('main.js 单测组', false, e.message.slice(0, 200)) }

// (e) app.js 模块组：连续失败计数 / flush / state.exclusive
// v3.3.24 渲染层拆分后：回退在 exclusive.js、回包增量在 persist.js、onScanDone 在 scan.js
try {
  const a = fs.readFileSync(path.join(REPO, 'src/renderer/js/app.js'), 'utf8')
  const ex = fs.readFileSync(path.join(REPO, 'src/renderer/js/exclusive.js'), 'utf8')
  const per = fs.readFileSync(path.join(REPO, 'src/renderer/js/persist.js'), 'utf8')
  const sc = fs.readFileSync(path.join(REPO, 'src/renderer/js/scan.js'), 'utf8')
  ok('失败自动跳曲调用 skipToNext', /skipToNext\s*\(/.test(a))
  ok('有 flushSaveSettings', /flushSaveSettings/.test(per) || /flushSaveSettings/.test(a))
  ok('fallback 置 exclusiveFellBack 而非 exclusive=false',
      /state\.exclusiveFellBack\s*=\s*true/.test(ex) &&
      !/function applyExclusiveFallback[\s\S]{0,800}?state\.exclusive\s*=\s*false/.test(ex))
  // v3.3.18（第四轮 §4.3 #4）：回包只同步本次 patch 涉及的键，不再整份 Object.assign
  ok('settings 回包按键增量同步', /for \(const k of Object\.keys\(patch\)\)/.test(per) &&
    !/Object\.assign\(state\.settings, s\)/.test(per))
  ok('onScanDone 用对象引用定位', /const curTrack = player\.current[\s\S]{0,400}kept\.indexOf\(curTrack\)/.test(sc))
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
      /_renderTableWindow/.test(u) && /TABLE_ROW_H = 52/.test(u) && /TABLE_VBUF/.test(u))
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

// (h) v3.3.37：每日推荐（仅 online 分支）+ 全屏页歌词点击跳进度
try {
  const html = fs.readFileSync(path.join(REPO, 'src/renderer/index.html'), 'utf8')
  const app = fs.readFileSync(path.join(REPO, 'src/renderer/js/app.js'), 'utf8')
  const daily = fs.readFileSync(path.join(REPO, 'src/renderer/js/daily.js'), 'utf8')
  const css = fs.readFileSync(path.join(REPO, 'src/renderer/css/app.css'), 'utf8')
  ok('每日推荐有侧栏导航项 + 独立面板 + 换一批按钮',
    /data-view="daily"/.test(html) && /id="dailyPane"/.test(html) &&
    /id="dailyRefresh"/.test(html) && /id="dailyBody"/.test(html))
  ok('daily.js 在 app.js 之后引入且只引入一次',
    html.indexOf('js/daily.js') > html.indexOf('js/app.js') &&
    (html.match(/js\/daily\.js/g) || []).length === 1)
  ok('每次进页重算，换一批 / 切页作废旧在线请求',
    /view === 'daily' && typeof Daily !== 'undefined'\) Daily\.recompute\(\)/.test(app) &&
    /const token = \+\+this\.token/.test(daily) && /token !== this\.token/.test(daily))
  ok('全在线口径：不再保留本地 24 首目标，冷启动有内置歌手池',
    !/DAILY_LOCAL_TARGET/.test(daily) && /DAILY_COLD_SEEDS/.test(daily) &&
    /onlineSongs\(\)/.test(daily) && /DAILY_TOTAL = 30/.test(daily))
  ok('多歌手轮搜 + 每路超时兜底 + 一首都没有才本地兜底',
    /seedArtists\(\)/.test(daily) && /searchArtist\(name, 1, token\)/.test(daily) &&
    /withTimeout\(p, DAILY_SEARCH_TIMEOUT\)/.test(daily) &&
    /if \(items\.length\)/.test(daily) && /fillLocal\(DAILY_TOTAL\)/.test(daily))
  ok('音质优先级：探测 + 档位排序 + 全局默认母带',
    /async probeAll\(token\)/.test(daily) && /qualityOf\(song, r\)/.test(daily) &&
    /sortByQuality\(\)/.test(daily) && /onlineProbe\(x\.song, token\)/.test(daily) &&
    /onlineQuality: 'master'/.test(fs.readFileSync(path.join(REPO, 'src/main/main.js'), 'utf8')) &&
    /onlineQualityMasterMigrated/.test(fs.readFileSync(path.join(REPO, 'src/main/main.js'), 'utf8')))
  const playAllBody = daily.slice(daily.indexOf('async playAll()'), daily.indexOf('async downloadAt('))
  ok('播放全部 = 全 30 首在线入队（不再只播本地）',
    /async playAll\(\)/.test(daily) && /const songs = this\.onlineSongs\(\)/.test(daily) &&
    /const queue = songs\.map\(\(s\) => Online\.toTrack\(s, null\)\)/.test(playAllBody) &&
    !/localTracks\(\)/.test(playAllBody))
  // v3.3.41：每日推荐视图头补上在线搜索同款的小工具（缓存设置 / 下载管理 / 下载目录）
  ok('每日推荐有缓存 / 下载管理 / 下载目录四个按钮（与在线搜索同款 mini-btn）',
    /id="dailyCacheBtn"/.test(html) && /id="dailyDlBtn"/.test(html) &&
    /id="dailyDirBtn"/.test(html) && /id="dailyOpenDir"/.test(html) &&
    (html.match(/class="mini-btn" id="daily(?:Cache|Dl|Dir|OpenDir)/g) || []).length === 4)
  ok('这四个按钮复用同一批面板与 IPC（不另写一套）',
    /on\('dailyCacheBtn', 'click', \(\) => toggleCachePanel\(\)\)/.test(daily) &&
    /on\('dailyDlBtn', 'click', \(\) => Online\.toggleDlPanel\(\)\)/.test(daily) &&
    /on\('dailyDirBtn', 'click'/.test(daily) && /onlinePickDownloadDir\(\)/.test(daily) &&
    /on\('dailyOpenDir', 'click', \(\) => window\.api\.onlineOpenDownloadDir/.test(daily))
  const dailyCssForTools = fs.readFileSync(path.join(REPO, 'src/renderer/css/daily.css'), 'utf8')
  ok('工具组排布写在 daily.css（共享 app.css 不加专属规则）',
    /#dailyPane \.vh-tools \{/.test(dailyCssForTools) &&
    /#dailyPane \.vh-tools \.mini-btn \{/.test(dailyCssForTools) &&
    !/\.vh-tools/.test(css))
  ok('每日推荐是独立 pane（隐藏本地视图头与表格）',
    /const isDaily = state\.view === 'daily'/.test(app) &&
    /isPane = isOnline \|\| isDaily/.test(app) && /dailyPane'\).hidden = !isDaily/.test(app))
  ok('dailyPane 布局与在线面板同源（共享 CSS）', /#onlinePane, #dailyPane \{/.test(css))
  // v3.3.39：列宽/对齐单独一个 online-only 样式文件（app.css 是共享文件，不动它）
  const dcss = fs.readFileSync(path.join(REPO, 'src/renderer/css/daily.css'), 'utf8')
  ok('每日推荐独立样式表已引入且只引入一次',
    /css\/daily\.css/.test(html) && (html.match(/css\/daily\.css/g) || []).length === 1)
  ok('列宽按面板宽度分三档（容器查询，不是按窗口）',
    /#dailyPane \{ container-type: inline-size; \}/.test(dcss) &&
    (dcss.match(/@container \(max-width: \d+px\)/g) || []).length === 2 &&
    /minmax\(0, 1\.6fr\)/.test(dcss) &&
    !/minmax\(160px/.test(dcss))
  ok('表头补偿滚动条 + 列体常驻 gutter（表头与行逐列对齐）',
    /#dailyPane \.op-th \{ padding-right: 33px; \}/.test(dcss) &&
    /#dailyPane \.op-body \{ scrollbar-gutter: stable; \}/.test(dcss))
  ok('规格居中 / 时长右对齐 / 理由徽标撑满本列',
    /#dailyPane \.op-c-q \{ text-align: center; \}/.test(dcss) &&
    /#dailyPane \.op-c-dur \{ text-align: right; \}/.test(dcss) &&
    /#dailyPane \.op-c-src \.op-badge \{\s*\n\s*width: 100%;/.test(dcss) &&
    /#dailyPane \.op-th \.op-c-src \{ display: block; text-align: center; \}/.test(dcss))
  ok('全屏页与侧栏歌词共用点击跳进度处理器',
    /\['lpLyrics', 'fsLyrics'\]/.test(app) &&
    /addEventListener\('click', seekByLyricLine\)/.test(app))
} catch (e) { ok('每日推荐单测组', false, e.message.slice(0, 200)) }


// (i) v3.3.40：在线封面 https 化 + 搜索队列整页跨源
try {
  const onlineMain = fs.readFileSync(path.join(REPO, 'src/main/online.js'), 'utf8')
  const onlineJs = fs.readFileSync(path.join(REPO, 'src/renderer/js/online.js'), 'utf8')
  ok('封面地址统一升 https（酷狗/网易返回 http 图会被 CSP 拦掉）',
    /function httpsify\(u\)/.test(onlineMain) &&
    /httpsify\(String\(s\.Image\)\.replace\('\{size\}', '400'\)\)/.test(onlineMain) &&
    /httpsify\(clean\(album\.picUrl \|\| ''\)\)/.test(onlineMain))
  ok('在线搜索队列 = 整页结果（不再按「当前播放的源」过滤）',
    /const queue = listAtStart\.map\(\(s\) => this\.toTrack\(s, null\)\)/.test(onlineJs) &&
    !/filter\(\(s\) => s\.source === song\.source\)/.test(onlineJs))
} catch (e) { ok('在线封面/队列单测组', false, e.message.slice(0, 200)) }

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
