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
    /body\.win-dragging\s+\.scan-overlay[\s\S]{0,220}?backdrop-filter:\s*none/.test(appCss) &&
    !/body\.win-dragging\s*\*\s*\{/.test(appCss))
  // v2.8.39 帧率轮：合成层 / 视觉不变量
  ok('帧率轮：整屏 blur 与常驻动画提到独立合成层，且不用绘制裁剪裁掉 blur',
    /#fsView::before\s*\{[\s\S]{0,400}?will-change:\s*transform/.test(appCss) &&
    /#miniView::before\s*\{[\s\S]{0,300}?will-change:\s*transform/.test(appCss) &&
    /body::before\s*\{[\s\S]{0,300}?will-change:\s*transform/.test(appCss) &&
    !/#fsView::before\s*\{[^}]*contain:/.test(appCss))
  ok('帧率轮：视觉参数一字未动（blur 值 / 动画时长）',
    /blur\(52px\) saturate\(1\.35\) brightness\(\.42\)/.test(appCss) &&
    /blur\(52px\) saturate\(1\.15\) brightness\(1\.02\)/.test(appCss) &&
    /blur\(46px\) saturate\(1\.4\) brightness\(\.5\)/.test(appCss) &&
    /uixMesh 30s/.test(appCss) && /uixGallery 68s/.test(appCss) &&
    /uixCoverPulse 5s/.test(appCss) && /eqjump 1s/.test(appCss))
  // v3.3.40（master 2.8.36）：右上角按钮组整块带 no-drag 时，那 400px 宽的空白带
  // （按钮左侧到搜索框之间）全按不动窗口 —— 只留容器不排除，按钮本身仍由 button 规则挡住。
  const tbHtml = read('src/renderer/index.html')
  ok('标题栏右上按钮组不再整块 no-drag（空白带可拖）',
    /<div class="tb-right">/.test(tbHtml) && !/<div class="tb-right no-drag">/.test(tbHtml))
  ok('「⋯」折叠菜单容器排除在拖动之外（点它开菜单）',
    /\.row-act,\s*\.tb-fold'/.test(dragSrc) || /,\s*\.tb-fold'/.test(dragSrc))
  const uiSrc = read('src/renderer/js/ui.js')
  // v2.8.40：虚拟滚动内核搬到 vlist.js（列表/网格共用），断言跟着内核走
  const vlSrc = read('src/renderer/js/vlist.js')
  ok('虚拟滚动改为头尾增删（行模板单点：列表 _rowHtml / 网格 _gridRowHtml）',
    /_rowHtml\(i\)/.test(uiSrc) && /_gridRowHtml\(row\)/.test(uiSrc) &&
    /data-sp="top"/.test(vlSrc) && /opts\.renderRow\(i\)/.test(vlSrc))
  // 旧断言要求 `<div ` 后紧跟 `style="height:${start`，而实际模板是
  // `<div data-sp="top" style=...`，全库零匹配 → 48/48 里有一项恒真空转。
  // 改为：跳跃分支必须走增量插入，且整块重建只允许首帧/强制分支那一处。
  ok('滚动帧不再整块重建行容器（只有首帧/强制分支能整块重建一次）',
    /b\.insertAdjacentHTML\('beforebegin', buildRows\(s, e\)\)/.test(vlSrc) &&
    /t\.insertAdjacentHTML\('afterend', buildRows\(s, oldS\)\)/.test(vlSrc) &&
    (vlSrc.match(/host\.innerHTML\s*=\s*[\s\S]{0,120}<div data-sp="top"/g) || []).length === 1)
  const fxSrc = read('src/renderer/js/audiofx.js')
  ok('帧率轮：--beat 只在全屏页显示时写、值未变不写；隐藏画布零绘制',
    /classList\.contains\('open'\)/.test(fxSrc) &&
    /_beatVal === v/.test(fxSrc) &&
    /c\.hidden \|\| w < 24/.test(fxSrc) &&
    /_drawExtra\(bins\)/.test(fxSrc) && /_updateBeat\(bins\)/.test(fxSrc))
  ok('帧率轮：虚拟滚动缓存容器高度、滚动帧只读一次 scrollTop；歌词读写分离',
    /let viewH = 0/.test(vlSrc) && /const st = scroller\.scrollTop/.test(vlSrc) &&
    /fsScroll !== null/.test(uiSrc) && /boxScroll !== null/.test(uiSrc) &&
    /TABLE_ROW_H = 52/.test(vlSrc))
  ok('帧率轮：虚拟滚动高度缓存只认 clientHeight，禁止用内容矩形高度',
    /viewH = Math\.max\(1, scroller\.clientHeight \|\| 600\)/.test(vlSrc) &&
    !/contentRect/.test(vlSrc) && !/contentRect/.test(uiSrc))
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
    /\.tr\s*\{[^}]*height:\s*52px/.test(appCss) && /TABLE_ROW_H = 52/.test(vlSrc) &&
    !/TABLE_ROW_H\s*=/.test(uiSrc))
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

  /* === 9) 九条 UI 建议全实装（v2.8.40 / v3.3.48） === */
  {
    const html = read('src/renderer/index.html')
    const thSrc = read('src/renderer/js/theme.js')
    const mSrc = read('src/main/main.js')
    const appJs = read('src/renderer/js/app.js')
    const scSrc = read('src/renderer/js/shortcuts.js')

    ok('九条·图标：线性描边体系（24 网格 + 1.5 描边，只有主控 4 枚实心）',
      (html.match(/fill="currentColor"/g) || []).length === 4 &&
      /stroke-width: 1\.5/.test(appCss) && /stroke-linecap: round/.test(appCss))
    ok('九条·图标：列表/卡片两枚切换图标 + 全屏页文字钮全部图标化',
      /id="i-grid"/.test(html) && /id="i-list-view"/.test(html) &&
      !/>◉</.test(html) && !/>▦</.test(html) && !/>✦</.test(html))
    ok('九条·网格：卡片视图按行虚拟化（列数按容器宽算，行高与 CSS 同源）',
      /_gridRowHtml\(row\)/.test(uiSrc) && /function gridCols/.test(vlSrc) &&
      /function gridRowHeight/.test(vlSrc) &&
      /--gcols/.test(appCss) && /--growh/.test(appCss))
    ok('九条·网格：视图模式持久化到 settings.viewMode（白名单已放行）',
      /saveSettings\(\{ viewMode: next \}\)/.test(appJs) && /viewMode: 'list'/.test(mSrc))
    ok('九条·sticky：单一滚动容器 + 表头吸顶',
      /id="viewScroll"/.test(html) &&
      /\.view-scroll\s*\{[\s\S]{0,220}?overflow-y: auto/.test(appCss) &&
      /\.table-head\s*\{[\s\S]{0,160}?position: sticky[\s\S]{0,80}?top: 0/.test(appCss))
    ok('九条·键盘：列表有焦点时方向键选行、Enter 播放、Ctrl+Enter 插播',
      /function bindListKeyboard/.test(appJs) && /case 'ArrowDown'/.test(appJs) &&
      /addToQueue\(t, \{ next: true \}\)/.test(appJs) &&
      /activeElement !== document\.getElementById\('tableBody'\)/.test(appJs))
    ok('九条·队列：右侧滑出侧栏（transform 过渡 + .show 两段式）',
      /#queuePanel\s*\{[\s\S]{0,500}?transform: translateX/.test(appCss) &&
      /#queuePanel\.show/.test(appCss) && /classList\.add\('show'\)/.test(uiSrc))
    ok('九条·队列：Esc 收起 + 全屏页之上 z-index 60',
      /queuePanel\.classList\.contains\('show'\)[\s\S]{0,160}?toggleQueue\(false\)/.test(scSrc) &&
      /body\.fs-open #queuePanel[\s\S]{0,120}?z-index: 60/.test(appCss))
    ok('九条·tonal：OKLCH 保色相派生 + on-accent 自动黑白',
      /rgbToOklab/.test(thSrc) && /oklabToRgb/.test(thSrc) &&
      /function normalize/.test(thSrc) && /--on-accent/.test(thSrc))
    ok('九条·tonal：默认跟随封面 + 存量裸色值一次性迁移',
      /accent: 'auto'/.test(mSrc) && /accentAutoMigrated/.test(mSrc))
    ok('九条·tonal：换曲钩子把封面色带进取色链路（本地版只查内嵌封面）',
      /accentForTrack\(track\.id, track\.cover \|\| ''\)/.test(thSrc) &&
      /ipcMain\.handle\('ui:accentForTrack'/.test(mSrc))
    ok('九条·逐词：词级 clip-path 填充 + rAF 推进（无 words 仍整行高亮）',
      /data-t="\$\{esc\(w\.text\)\}"/.test(uiSrc) &&
      /clip-path: inset\(0 var\(--rest/.test(appCss) &&
      /_ensureWordLoop/.test(uiSrc) && /--rest/.test(uiSrc))
    ok('九条·交互态：hover/active/selected token + 全站 focus-visible',
      /--state-hover/.test(appCss) && /--state-selected/.test(appCss) &&
      /:focus-visible\s*\{/.test(appCss))
    ok('九条·WCAG：三级文字达到 4.5:1（深 #8a92a0 / 浅 #5f6b7d）',
      /--txt-3: #8a92a0/.test(appCss) && /--txt-3: #5f6b7d/.test(appCss))
    ok('九条·reduced-motion：滚动/侧栏/卡片变换一并降级',
      /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,900}?#queuePanel \{ transition: none; \}/.test(appCss) &&
      /\.mc:hover \.mc-cv[\s\S]{0,80}?transform: none !important/.test(appCss))
    ok('九条·aria：按钮均有可读标签（≥50 处）',
      (html.match(/aria-label=/g) || []).length >= 50)
    ok('九条·脚本顺序：vlist.js 必须先于 ui.js（ui.js 依赖内核与行高常量）',
      html.indexOf('js/vlist.js') > 0 && html.indexOf('js/vlist.js') < html.indexOf('js/ui.js'))
    ok('九条·不变量收窄：#fsView::before 的 blur 参数仍一字未改',
      /blur\(52px\) saturate\(1\.35\) brightness\(\.42\)/.test(appCss) &&
      /blur\(52px\) saturate\(1\.15\) brightness\(1\.02\)/.test(appCss))
    ok('播放图标：音波节点常驻、靠 .playing 显隐（切歌不再残留 / 新行立刻有图标）',
      !/isCur \? '<span class="eq-bars">/.test(uiSrc) &&
      (uiSrc.match(/const eq = '<span class="eq-bars">/g) || []).length === 2 &&
      /\.tr\.playing \.eq-bars, \.mc\.playing \.eq-bars \{ display: inline-flex; \}/.test(appCss) &&
      /el\.classList\.remove\('paused'\)/.test(uiSrc))
    ok('歌词：渲染完立刻按当前时间落高亮（切歌瞬间不留空窗）',
      /this\.updateLyricIndex\(audio\.currentTime \+ off\)/.test(uiSrc))
    // v2.8.43 / v3.3.51：行内爱心就地同步 —— 收藏后不必切视图/刷新才看见红心
    ok('收藏：行内爱心就地翻状态（右键/行内钮/多选条/迷你卡四条链路都接）',
      /syncFavMarks\(ids, favorites\) \{/.test(uiSrc) &&
      /el\.querySelector\('\.row-act\[data-act="fav"\]'\)/.test(uiSrc) &&
      /UI\.syncFavMarks\(targets\.map\(\(t\) => t\.id\), state\.favorites\)/.test(read('src/renderer/js/menus.js')) &&
      /UI\.syncFavMarks\(\[state\.currentId\], state\.favorites\)/.test(read('src/renderer/js/mini.js')))
    ok('收藏：行内爱心带 aria-pressed（初始态也交给屏幕阅读器）',
      /data-act="fav" aria-pressed="\$\{favOn \? 'true' : 'false'\}"/.test(uiSrc))
    // v2.8.44：主进程拉起的每个子进程都要隐藏控制台窗口。
    // `shutdown.exe` 是控制台程序、Electron 主进程没有控制台 —— 少一个
    // `windowsHide: true` 就会新开一个黑框一闪（用户实报「测试时一直闪黑窗」）。
    {
      const bad = []
      const dir = path.join(ROOT, 'src', 'main')
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8')
        const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
        const re = /(?<![.\w])(?:G\.)?(execFile|execFileSync|spawn|exec)\s*\(/g
        let m
        while ((m = re.exec(src))) {
          // 排除「get execFile() { return execFile }」这类 getter 定义，不是真的调用
          if (/\b(get|set)\s+$/.test(src.slice(0, m.index))) continue
          if (/^\(\s*\)\s*\{/.test(src.slice(re.lastIndex - 1))) continue
          let i = re.lastIndex - 1
          let depth = 0
          for (; i < src.length; i++) {
            if (src[i] === '(') depth++
            else if (src[i] === ')') { depth--; if (!depth) break }
          }
          const call = src.slice(m.index, i + 1)
          if (!/windowsHide:\s*true/.test(call)) bad.push(f + ' → ' + call.replace(/\s+/g, ' ').slice(0, 90))
        }
      }
      ok('主进程子进程一律带 windowsHide（shutdown / taskkill / mpv / powershell 都不许闪控制台）',
        bad.length === 0, bad.join(' || '))
    }
    // v2.8.44：频谱 —— 附加画布/节拍取数必须在主画布尺寸检查之前（不变量 #39），
    // 否则主画布一缩小，全屏页频谱与 --beat 会一起断。
    {
      const fxSrc = read('src/renderer/js/audiofx.js')
      const iExtra = fxSrc.indexOf('this._drawExtra(bins)')
      const iBeat = fxSrc.indexOf('this._updateBeat(bins)')
      const iSmall = fxSrc.indexOf('if (this._w < 24 || this._h < 8) return')
      ok('频谱：附加画布 + --beat 在尺寸早退之前（全屏页不再随主画布一起断）',
        iExtra > 0 && iBeat > 0 && iSmall > 0 && iExtra < iSmall && iBeat < iSmall)
      const uSrc = read('src/renderer/js/uix.js')
      ok('频谱光效开关：关闭时给可见提示 + aria-pressed（误触后能自己找回来）',
        /id = 'fsFxHint'/.test(uSrc) && /setAttribute\('aria-pressed'/.test(uSrc) &&
        /\.uix-btn\.off \{/.test(appCss))
      ok('频谱：附加画布缓存为 0 时会补测尺寸（RO 没投递也能画出来）',
        /if \(w < 24 \|\| h < 8\) \{/.test(fxSrc) && /item\.w = cw/.test(fxSrc))
    }
    // v2.8.42 / v3.3.50：歌词同步体检 —— 直接跑解析器，断言语义而不是字面
    {
      const lyricSrc2 = read('src/renderer/js/lyric.js')
      const { parseLrc: parse2 } = new Function(lyricSrc2 + '\nreturn { parseLrc }')()
      const sample = '[ti:测试]\n[00:00.00]测试歌 - 某歌手\n[00:00.50]词：甲\n[00:01.00]曲：乙\n'
        + '[00:01.50]编曲：丙\n[00:02.10]混音/母带：丁\n[00:05.00]第一句歌词\n[00:09.00]第二句歌词'
      const sp = parse2(sample)
      ok('歌词体检：开头制作信息整段脱同步（不再抢跑）',
        sp.sync.creditSkip === true &&
        sp.lines.filter((l) => l.skip).length === 5 &&
        Math.abs(sp.sync.firstVocal - 5) < 1e-6 &&
        sp.lines[sp.lines.length - 1].skip === undefined)
      const np = parse2('[00:01.00]他说：别走\n[00:03.00]我没有说话')
      ok('歌词体检：正常歌词里的冒号不被误判成制作信息',
        np.sync.creditSkip === false && np.lines.every((l) => !l.credit))
      ok('歌词体检：高亮索引跳过 skip 行 + 面板提示已接线',
        /while \(idx >= 0 && st\.lines\[idx\] && st\.lines\[idx\]\.skip\) idx--/.test(uiSrc) &&
        /setLyricDiag\(parsed && parsed\.sync, track\.duration\)/.test(read('src/renderer/js/app.js')) &&
        /id="lpDiag"/.test(read('src/renderer/index.html')))
      ok('测试静音双保险：Chromium mute-audio + 渲染层 audio.muted（不再只静音 mpv）',
        /appendSwitch\('mute-audio'\)/.test(read('src/main/main.js')) &&
        /testMute: process\.env\.LX_TEST_MUTE === '1'/.test(read('src/main/main.js')) &&
        /info\.testMute && audio\) audio\.muted = true/.test(read('src/renderer/js/app.js')))
    }

    // v2.8.45：toast 两条用户实报 —— ① 浅色主题下深底 + 深字看不见；
    // ② 30 秒同类去重把用户主动点击的回执也吞了（外观模式 / 频谱开关点几次后不弹）。
    {
      const cssSrc = read('src/renderer/css/app.css')
      ok('浅色主题 toast 给独立墨色（白底 + 深字，不再深底叠深字）',
        /html\[data-theme="light"\] #toast \{\s*background: rgba\(255, 255, 255, \.97\);\s*border-color: rgba\(8, 19, 31, \.14\);\s*color: #172031;/.test(cssSrc))

      // 真跑一遍 toast（切出配置段 + 打桩 $ / window / 定时器），断言语义而不是字面
      const utilSrc = read('src/renderer/js/util.js')
      const seg = utilSrc.slice(
        utilSrc.indexOf('let toastTimer = null'),
        utilSrc.indexOf('/** 极简事件器 */')
      )
      const el = { hidden: true, textContent: '', classList: { s: new Set(), add(c) { this.s.add(c) }, remove(c) { this.s.delete(c) } } }
      const mkToast = () => new Function(
        '$', 'window', 'setTimeout', 'clearTimeout',
        seg + '\nreturn { toast, setInput: (t) => { lastUserInputAt = t } }'
      )(() => el, { addEventListener() {} }, () => 1, () => {})

      const u1 = mkToast()
      u1.setInput(Date.now())
      u1.toast('外观：浅色')
      const firstShown = el.hidden === false && el.textContent === '外观：浅色'
      el.hidden = true
      u1.toast('外观：浅色')          // 同文本立刻再点一次（用户主动操作）
      const againShown = el.hidden === false

      const a1 = mkToast()
      a1.setInput(Date.now() - 5000)  // 非交互：模拟自动循环触发
      a1.toast('设备已断开')
      el.hidden = true
      a1.toast('设备已断开')          // 30 秒内第二条必须仍被去重
      const autoDeduped = el.hidden === true

      ok('toast 去重不再吞用户主动操作的提示（交互 1.5 秒内必弹）', firstShown && againShown)
      ok('toast 去重仍拦住自动循环的重复提示（防刷屏不回退）', autoDeduped)
    }

  }

  console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
  process.exit(fail ? 1 : 0)
}

main()
