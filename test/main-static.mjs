#!/usr/bin/env node
'use strict'
/**
 * 主进程静态断言（第四轮审查 §九，v3.3.18 新增）
 *
 * 为什么需要这个文件：
 *   `test/smoke.mjs` 的 17 项断言全部打在渲染层 DOM / state 上，**主进程零断言**；
 *   `node --check` 只查语法。于是 v2.8.16 出现了「17/17 全过」与「5 个必抛
 *   ReferenceError」并存 —— 退出链、关机链、桌面歌词配置、文件关联四条链路全废。
 *
 * 本文件不启动 Electron、不出声，做三件事：
 *   1) 全量 `node --check`（src / test / tools / 根目录脚本）
 *   2) 关键函数体装载 + 打桩调用：sanitizeSettingsPatch / isSafeMediaRoot /
 *      cancelPowerAction 的依赖标识符必须都有声明
 *   3) 已知的 5 个「曾经漏声明」标识符 + 退出链/关机链关键字的回归哨兵
 *
 * 用法：node test/main-static.mjs        （退出码 0 = 全过）
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 从源码里切出 `function NAME(...) { ... }`（按行首 `}` 收尾） */
function sliceFn(src, name) {
  const head = new RegExp('^function ' + name + '\\s*\\(', 'm')
  const m = head.exec(src)
  if (!m) return null
  const end = src.indexOf('\n}\n', m.index)
  if (end < 0) return null
  return src.slice(m.index, end + 2)
}

/** 从源码里切出 `const NAME = ...` 到该语句结束（简单实现：到行尾，或平衡括号） */
function sliceConst(src, name) {
  const re = new RegExp('^const ' + name + '\\s*=', 'm')
  const m = re.exec(src)
  if (!m) return null
  let i = m.index
  // 初始化式是正则字面量时直接取整行 —— 按括号配平会被正则里的 () 打断
  const headEnd = src.indexOf('\n', m.index)
  const firstLine = src.slice(m.index, headEnd < 0 ? src.length : headEnd)
  if (/^const \w+\s*=\s*\//.test(firstLine)) return firstLine
  let depth = 0
  let seen = false
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '{' || c === '[') { depth++; seen = true }
    else if (c === ')' || c === '}' || c === ']') { depth--; if (seen && depth === 0) { i++; break } }
    else if (c === '\n' && depth === 0) { break }
  }
  return src.slice(m.index, i)
}

function main() {
  const mainSrc = read('src/main/main.js')
  // v3.3.24 模块拆分后：设置清洗在 settings-schema.js、路径白名单在 protocols.js。
  // 直接 require 真模块（比切片+vm 更接近运行时），G 注入只喂测试用到的最小集。
  let SCHEMA = null
  let PROTO = null
  let modErr = ''
  try {
    const req = createRequire(import.meta.url)
    // electron 在纯 node 下 require 不到 —— 测试只调纯函数，桩掉即可
    const Module = req('module')
    const origLoad = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') {
        return { app: {}, protocol: {}, shell: {}, BrowserWindow: class {}, ipcMain: {}, net: {}, dialog: {}, screen: {} }
      }
      return origLoad.apply(this, arguments)
    }
    PROTO = req(path.join(ROOT, 'src/main/protocols.js'))
    SCHEMA = req(path.join(ROOT, 'src/main/settings-schema.js'))
    const G = { PROTO, cacheDirPath: () => '', downloadDir: () => '', logLine: () => {}, store: null, library: null, DATA_DIR: '' }
    PROTO.init(G); SCHEMA.init(G)
  } catch (err) { modErr = err.message }

  console.log('=== 1) 全量语法检查 ===')
  const targets = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs|cjs)$/.test(e.name)) targets.push(p)
    }
  }
  for (const d of ['src', 'test', 'tools']) {
    const p = path.join(ROOT, d)
    if (fs.existsSync(p)) walk(p)
  }
  for (const f of ['make-lnk.js', 'make-vbs.js', 'make-lnk-online.js']) {
    if (fs.existsSync(path.join(ROOT, f))) targets.push(path.join(ROOT, f))
  }
  let bad = 0
  for (const t of targets) {
    const r = spawnSync(process.execPath, ['--check', t], { encoding: 'utf8' })
    if (r.status !== 0) {
      bad++
      console.log('  ✗ ' + path.relative(ROOT, t) + ' ' + String(r.stderr || '').slice(0, 200))
    }
  }
  ok('node --check 全量通过', bad === 0, targets.length + ' 个文件')

  // v3.3.42：不依赖基准的「裸引用漏声明」扫描 —— pickMediaDir 在 v3.3.24 拆分时丢的，
  // 基准里同样没有，`--base` 模式永远查不出来；这里直接跑 --self-strict。
  // 只扫 main.js：目录模式会把 class 方法名当成裸引用（decls 只认 function / const）
  const strict = spawnSync('python', [
    path.join(ROOT, 'tools/check-decls.py'), '--self-strict', path.join(ROOT, 'src/main/main.js')
  ], { encoding: 'utf8' })
  if (strict.error && strict.error.code === 'ENOENT') {
    ok('主进程裸引用扫描（python 缺失，跳过）', true, '未安装 python')
  } else {
    ok('主进程没有「引用了但没声明」的裸标识符', strict.status === 0,
      String(strict.stdout || strict.stderr || '').trim().split('\n').slice(-4).join(' | '))
  }

  console.log('\n=== 2) 关键函数装载（真模块 require，不启动 Electron）===')
  // v3.3.24：设置清洗与白名单已拆到独立模块，直接 require 真模块验证
  const schemaSrc = read('src/main/settings-schema.js')
  const protoSrc = read('src/main/protocols.js')
  ok('模块 require 成功（settings-schema / protocols）', !!SCHEMA && !!PROTO, modErr)

  if (SCHEMA) {
    // 数值夹取：volume:5 必须变 1（以前只过滤键名，值原样落盘 → IndexSizeError）
    try {
      const out = SCHEMA.sanitizeSettingsPatch({ volume: 5, fadeMs: -1000 }, {
        volume: 0, fadeMs: 0, musicDirs: [], onlineCacheLimitMB: 0, desktopLyric: null
      })
      ok('sanitizeSettingsPatch 把 volume 夹到 1', out && out.volume === 1, JSON.stringify(out))
      ok('sanitizeSettingsPatch 把 fadeMs 夹到 0', out && out.fadeMs === 0)
    } catch (err) {
      ok('sanitizeSettingsPatch 可调用', false, err.message)
    }
    try {
      // 数组上限：这条会真的执行到 `v.length > SETTING_ARRAY_MAX`，
      // 常量没声明就会抛 ReferenceError —— 比字符串哨兵更硬
      const big = new Array(500).fill('D:/Music')
      const out2 = SCHEMA.sanitizeSettingsPatch({ musicDirs: big }, { musicDirs: [] })
      ok('musicDirs 超长数组被拒（SETTING_ARRAY_MAX 有声明）', !('musicDirs' in out2))
    } catch (err) {
      ok('musicDirs 超长数组被拒（SETTING_ARRAY_MAX 有声明）', false, err.message)
    }
    try {
      ok('未知键被拒', !('evilKey' in SCHEMA.sanitizeSettingsPatch({ evilKey: 1 }, { volume: 0 })))
      // 注意不能用 `'__proto__' in out` 判断 —— 原型链上永远为真
      const polluted = SCHEMA.sanitizeSettingsPatch(JSON.parse('{"__proto__":{"x":1}}'), { volume: 0 })
      ok('原型污染键被拒',
        !Object.prototype.hasOwnProperty.call(polluted, '__proto__') && !('x' in Object.prototype))
    } catch (err) {
      ok('键白名单可调用', false, err.message)
    }
  }
  if (PROTO) {
    try {
      ok('isSafeMediaRoot 接受普通目录', PROTO.isSafeMediaRoot('D:/Music') === true)
      ok('isSafeMediaRoot 拒绝 UNC', PROTO.isSafeMediaRoot('\\\\server\\share') === false)
      ok('isSafeMediaRoot 拒绝盘符根', PROTO.isSafeMediaRoot('D:\\') === false)
    } catch (err) {
      ok('isSafeMediaRoot 可调用', false, err.message)
    }
  }

  console.log('\n=== 3) 「曾漏声明」标识符哨兵 ===')
  // 这 5 个在 v2.8.16 的 master 上只有引用没有声明，4 条 P1 的根因
  // v2.8.18：SETTING_ARRAY_MAX 就是「引用搬过来了、声明没搬」的复发 —— 加进哨兵
  // v3.3.24：哨兵覆盖全部主进程模块（拆分后声明散在多文件）
  const allMainSrc = ['main.js', 'protocols.js', 'settings-schema.js', 'mpv-manager.js',
    'dlyric-window.js', 'downloader.js', 'dircache.js', 'streamproxy.js']
    .map((f) => { try { return read('src/main/' + f) } catch { return '' } }).join('\n')
  const mustDeclare = ['cleanupStarted', 'systemShutdownPending', 'systemShutdownTimer',
    'FORBIDDEN_SETTING_KEYS', 'lastOpenFiles', 'SETTING_ARRAY_MAX', 'SETTING_MAP_MAX']
  for (const n of mustDeclare) {
    const re = new RegExp('^\\s*(?:let|var|const)\\s+' + n + '\\b', 'm')
    ok('有声明：' + n, re.test(allMainSrc))
  }

  console.log('\n=== 4) 链路接线哨兵 ===')
  ok('before-quit 前 preventDefault 且读 cleanupStarted',
    /before-quit/.test(mainSrc) && /if \(cleanupStarted\)/.test(mainSrc))
  ok('settings:patch 接入 sanitizeSettingsPatch',
    /ipcMain\.handle\('settings:patch'[\s\S]{0,800}?sanitizeSettingsPatch\(patch/.test(mainSrc))
  ok('托盘取消项覆盖系统关机窗口',
    /powerPending \|\| systemShutdownPending/.test(mainSrc))
  ok('dlyric 配置入口用同一把清洗尺子',
    /dlyric:cfg[\s\S]{0,800}?sanitizeSettingsPatch\(/.test(mainSrc))

  console.log('\n=== 5) 标题栏拖动 + 虚拟滚动哨兵（v2.8.27 / v3.3.28） ===')
  /* 为什么盯这两条：
     1) 125% 缩放下 -webkit-app-region: drag 的系统命中矩形会整体下移约 19px，
        右上角按钮下半截被判成 HTCAPTION、点击被吞。修法是把拖动搬到主进程，
        一旦有人把 CSS 的 drag 写回来，问题会原样复发 —— 所以直接哨兵 CSS。
     2) 虚拟滚动以前每滚 40px 就把可视区 20+ 行 innerHTML 重建一次，行内封面
        重新请求 + 重新解码，表现为滚动时整屏封面闪。修法是头尾增删复用节点。 */
  ok('主进程接管标题栏拖动（drag-start / drag-move / drag-end）',
    /ipcMain\.on\('win:drag-start'/.test(mainSrc) &&
    /ipcMain\.on\('win:drag-move'/.test(mainSrc) &&
    /ipcMain\.on\('win:drag-end'/.test(mainSrc))
  ok('拖动改事件驱动，不再用 setInterval 轮询光标（16ms 定时器实测仅 34.6fps）',
    !/windowDragTimer\s*=\s*setInterval/.test(mainSrc) &&
    !/win:drag-start[\s\S]{0,1200}?setInterval/.test(mainSrc))
  ok('drag-move 用 setBounds 且显式带 width/height（防 125% 缩放下尺寸漂移）',
    /win:drag-move[\s\S]{0,700}?win\.setBounds\(\{\s*x[^}]*width:\s*windowDragOrigin\.width/.test(mainSrc))
  ok('拖动松手把尺寸拨回起始值',
    /win:drag-end[\s\S]{0,600}?windowDragOrigin\.width/.test(mainSrc))
  const preloadSrc = read('src/main/preload.js')
  ok('preload 暴露 dragStart / dragMove / dragEnd',
    /dragStart:\s*\(\)\s*=>\s*ipcRenderer\.send\('win:drag-start'\)/.test(preloadSrc) &&
    /dragMove:\s*\(dx,\s*dy\)\s*=>\s*ipcRenderer\.send\('win:drag-move',\s*dx,\s*dy\)/.test(preloadSrc) &&
    /dragEnd:\s*\(\)\s*=>\s*ipcRenderer\.send\('win:drag-end'\)/.test(preloadSrc))
  const appCss = read('src/renderer/css/app.css')
  ok('CSS 不再声明 app-region: drag（回退即复发按钮点不动）',
    !/^\s*-webkit-app-region:\s*drag\s*;/m.test(appCss))
  const dragSrc = read('src/renderer/js/dragwin.js')
  ok('渲染层 pointermove + rAF 节流 + 指针捕获驱动拖动',
    /pointermove/.test(dragSrc) && /requestAnimationFrame\(/.test(dragSrc) &&
    /setPointerCapture/.test(dragSrc) && /dragMove\(pendingDx, pendingDy\)/.test(dragSrc))
  ok('拖动态保留全屏页封面模糊层（v2.8.38：#fsView 成拖动源后不能关 filter）',
    !/body\.win-dragging\s+#fsView::before/.test(appCss) &&
    /#fsView::before\s*\{[\s\S]{0,300}?filter:\s*blur\(/.test(appCss) &&
    /body\.win-dragging #miniView::before\s*\{\s*filter:\s*none;/.test(appCss) &&
    /body\.win-dragging\s*\*\s*\{[^}]*backdrop-filter:\s*none/.test(appCss))
  // v3.3.40（master 2.8.36）：右上角按钮组整块带 no-drag 时，那 400px 宽的空白带
  // （按钮左侧到搜索框之间）全按不动窗口 —— 只留容器不排除，按钮本身仍由 button 规则挡住。
  const tbHtml = read('src/renderer/index.html')
  ok('标题栏右上按钮组不再整块 no-drag（空白带可拖）',
    /<div class="tb-right">/.test(tbHtml) && !/<div class="tb-right no-drag">/.test(tbHtml))
  ok('「⋯」折叠菜单容器排除在拖动之外（点它开菜单）',
    /\.row-act,\s*\.tb-fold'/.test(dragSrc) || /,\s*\.tb-fold'/.test(dragSrc))
  const uiSrc = read('src/renderer/js/ui.js')
  ok('虚拟滚动改为头尾增删（保留 _rowHtml 单一模板）',
    /_rowHtml\(i\)/.test(uiSrc) && /data-sp="top"/.test(uiSrc))
  // 旧断言要求 `<div ` 后紧跟 `style="height:${start`，而实际模板是
  // `<div data-sp="top" style=...`，全库零匹配 → 48/48 里有一项恒真空转。
  // 改为：跳跃分支必须走增量插入，且整块重建只允许首帧/强制分支那一处。
  ok('滚动帧不再整块重建 tableBody',
    /jumpBot\.insertAdjacentHTML\('beforebegin', html\)/.test(uiSrc) &&
    (uiSrc.match(/body\.innerHTML\s*=\s*[\s\S]{0,80}<div data-sp="top"/g) || []).length === 1)
  const dragSrc2 = read('src/renderer/js/dragwin.js')
  ok('双击标题栏只由 dblclick 处理（拖动链路不重复 toggleMaximize）',
    !/toggleMaximize/.test(dragSrc2) && /e\.detail === 2/.test(dragSrc2))
  const miniMainSrc = read('src/main/main.js')
  const miniApply = miniMainSrc.slice(miniMainSrc.indexOf('async function applyMiniOnce'), miniMainSrc.indexOf('function createWindow'))
  ok('进出迷你的 unmaximize/maximize 也压回隐藏（守 §2 #9）',
    (miniApply.match(/TEST_HIDDEN\(\)\)\s*win\.hide\(\)/g) || []).length >= 2)
  const appSrc = read('src/renderer/js/app.js')
  ok('迷你关闭同样串行等待落盘',
    /miniClose[\s\S]{0,320}await flushSaveSettingsForExit\(\)/.test(appSrc))

  console.log('\n=== 6) 浅色主题列表哨兵（v3.3.30） ===')
  /* .tr 行底是硬编码 #1a1f27；浅色模式若缺少 html[data-theme="light"] 的行级覆盖，
     整个列表会变回黑底 + 低对比文字（真机截图复现）。同时严禁把浅色专用变量
     搬进 :root —— 那会让深色主题一起变色。 */
  const lightFix = appCss.slice(appCss.indexOf('/* --- v3.4.0 浅色主题'))
  ok('浅色模式有行级白底覆盖（.tr 深色残留不再外露）',
    /html\[data-theme="light"\]\s*\.tr\s*\{[^}]*background:\s*var\(--row-bg\)/.test(appCss))
  ok('浅色专用变量定义在 data-theme="light" 块内',
    /html\[data-theme="light"\]\s*\{[^}]*--row-ink:/.test(appCss) &&
    !/^:root\s*\{[^}]*--row-ink:/m.test(appCss))
  // v3.4.0：列表行去掉卡片底（bg #1a1f27 + 圆角 + 左右内缩），改为透明连续列表。
  // 旧断言「.tr 硬编码深色底仍在」保护的是卡片设计，设计变了就得跟着改口径 ——
  // 现在反过来守「不许把卡片底加回来」。
  ok('列表行已扁平化（无 #1a1f27 卡片底 / 无行内圆角）',
    !/\.tr\s*\{[^}]*background:\s*#1a1f27/.test(appCss) &&
    /\.tr\s*\{[^}]*background:\s*transparent/.test(appCss))
  ok('CSS 行高与 TABLE_ROW_H 严格一致（52px，漂移即整屏错位）',
    /\.tr\s*\{[^}]*height:\s*52px/.test(appCss) && /TABLE_ROW_H = 52/.test(uiSrc))
  ok('浅色覆盖延伸到在线列表与队列抽屉',
    /html\[data-theme="light"\]\s*\.op-body\s*\.op-tr\s*\{/.test(appCss) &&
    /html\[data-theme="light"\]\s*\.qp-item\.active/.test(appCss))
  ok('浅色修复块内无硬编码深色底（防止回退）',
    lightFix.length > 0 &&
    !/html\[data-theme="light"\][^{}]*\{[^}]*background:\s*#(?:0|1|2)[0-9a-f]{5}/i.test(lightFix))
  ok('浅色行禁用背景过渡（防隐藏窗口切主题时底色卡在旧值）',
    /html\[data-theme="light"\]\s*\.tr\s*\{[^}]*transition-property:\s*transform,\s*box-shadow,\s*color/.test(appCss))

  console.log('\n=== 7) 拆分与渲染层回归哨兵（v3.3.32） ===')
  ok('sanitizeSettingsPatch 不再用裸 DEFAULT_SETTINGS 默认参数',
    !/sanitizeSettingsPatch\(patch,\s*template\s*=\s*DEFAULT_SETTINGS\)/.test(schemaSrc) &&
    /if \(!template\) template = G && G\.DEFAULT_SETTINGS/.test(schemaSrc))
  ok('卡片网格先清空虚拟滚动状态（专辑/文件夹滚动不再被旧列表覆盖）',
    /_renderCardGrid\([\s\S]{0,400}?this\._tTracks\s*=\s*\[\]/.test(uiSrc))
  const uixSrc = read('src/renderer/js/uix.js')
  ok('队列徽标只数真实队列项（空队列占位块不算 1）',
    /querySelectorAll\('\.qp-item\[data-qi\]'\)/.test(uixSrc))
  ok('打开画廊前先收起全屏页（双击封面两次 click 不再残留）',
    /function openGallery\(\)[\s\S]{0,400}?UI\.setFullscreen\(false\)/.test(uixSrc))
  const appJs = read('src/renderer/js/app.js')
  ok('行内 / 多选收藏快捷钮都接住 Promise 失败',
    (appJs.match(/handleCtxAction\('fav'\)\.catch\(/g) || []).length === 2)
  ok('音质列选择器与 DOM 一致（.op-c-q，不是永不命中的 .op-q）',
    !/\.op-q\b/.test(appCss) && /\.op-c-q\s*\{/.test(appCss))
  ok('浅色下无损行改用高对比文字色',
    /html\[data-theme="light"\]\s*\.op-c-q\.lossless\s*\{\s*color:\s*var\(--row-ink\)/.test(appCss))
  const htmlSrc = read('src/renderer/index.html')
  ok('mediasession.js 只引入一次（重复加载会抛顶层 let 重复声明）',
    (htmlSrc.match(/js\/mediasession\.js/g) || []).length === 1)
  // v3.3.37 / v2.8.35：全屏播放页 #fsLyrics 的歌词行以前没有 click 代理，
  // 只有侧栏 #lpLyrics 能点行跳进度。两个容器必须共用同一个时间轴处理器。
  ok('全屏页与侧栏歌词行共用点击跳转（点歌词改进度）',
    /for \(const id of \['lpLyrics', 'fsLyrics'\]\)/.test(appJs) &&
    /addEventListener\('click', seekByLyricLine\)/.test(appJs) &&
    /const seekByLyricLine = \(e\) =>/.test(appJs) &&
    /player\.seek\(item\.t - state\.lyricOffset\)/.test(appJs))

  console.log('\n=== 8) G 注入完整性 + 桌面歌词启动链（v2.8.31 / v3.3.33） ===')
  /* v3.3.24 拆分后各模块靠 init(G) 拿共享状态。漏加 getter 时调用点在冷路径上
     （例如「启动时恢复桌面歌词」），默认设置 + LX_TEST_HIDDEN 实测都碰不到，
     直到用户双击桌面快捷方式才 FATAL。这里做根因级扫描：所有 G.xxx 引用必须
     都在 main.js 的 G getters 里。 */
  const gBlock = (mainSrc.match(/const G = \{([\s\S]*?)\n\}/) || ['', ''])[1]
  const gGetters = new Set([...gBlock.matchAll(/get\s+(\w+)\s*\(/g)].map((m) => m[1]))
  const gMissing = new Set()
  const mainDir = fs.readdirSync(path.join(ROOT, 'src/main')).filter((f) => f.endsWith('.js'))
  // 注释里讲解反例时可能写出 G.xxx 字面量，不算真实引用
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const f of mainDir) {
    const s = stripComments(fs.readFileSync(path.join(ROOT, 'src/main', f), 'utf8'))
    for (const m of s.matchAll(/\bG\.(\w+)/g)) if (!gGetters.has(m[1])) gMissing.add(m[1] + ' @ ' + f)
  }
  ok('所有 G.xxx 引用都在 G getters 里（漏注入会让冷路径启动即崩）',
    gGetters.size > 0 && gMissing.size === 0, [...gMissing].join(', ') || `${gGetters.size} 个 getter`)
  const dlyricSrc = stripComments(read('src/main/dlyric-window.js'))
  ok('桌面歌词浮窗自带 debounce，不依赖 G 注入',
    /function debounce\(fn, ms\)/.test(dlyricSrc) && !/G\.debounce/.test(dlyricSrc))

  // 运行时冒烟：用「不含 debounce」的 G 真正跑一遍 createLyricWindow。
  // electron 全部打桩，不创建任何真实窗口；临时摘掉 LX_TEST_HIDDEN 让守卫放行。
  let lyricBootErr = ''
  try {
    const req2 = createRequire(import.meta.url)
    const Module2 = req2('module')
    const origLoad2 = Module2._load
    const fakeWin = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'webContents') return new Proxy({}, { get: () => () => {} })
        if (k === 'isDestroyed') return () => false
        if (k === 'getNormalBounds' || k === 'getBounds') return () => ({ x: 0, y: 0, width: 900, height: 120 })
        return () => {}
      },
      set: () => true
    })
    Module2._load = function (request) {
      if (request === 'electron') return {
        BrowserWindow: class { constructor() { return fakeWin } },
        screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
        ipcMain: {}, app: {}, protocol: {}, shell: {}
      }
      return origLoad2.apply(this, arguments)
    }
    const DLYW = req2(path.join(ROOT, 'src/main/dlyric-window.js'))
    DLYW.init({
      store: { get: () => ({ settings: { desktopLyric: { enabled: true, bounds: null } } }), patch: () => {} },
      sendToRenderer: () => {}, logLine: () => {}, quitting: false
    })
    const savedHidden = process.env.LX_TEST_HIDDEN
    delete process.env.LX_TEST_HIDDEN
    try { DLYW.createLyricWindow() } finally {
      if (savedHidden === undefined) delete process.env.LX_TEST_HIDDEN
      else process.env.LX_TEST_HIDDEN = savedHidden
      Module2._load = origLoad2
    }
  } catch (e) { lyricBootErr = e.message }
  ok('桌面歌词浮窗在「G 无 debounce」下仍能创建（启动链不再崩）', !lyricBootErr, lyricBootErr)

  console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
  process.exit(fail ? 1 : 0)
}

main()
