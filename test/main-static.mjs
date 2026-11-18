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
    /body\.win-dragging\s+\.scan-overlay[\s\S]{0,220}?backdrop-filter:\s*none/.test(appCss) &&
    !/body\.win-dragging\s*\*\s*\{/.test(appCss))
  // v2.8.39 / v3.3.47 帧率轮：合成层 / 视觉不变量
  ok('帧率轮：整屏 blur 与常驻动画提到独立合成层，且不用 contain:paint 裁掉 blur',
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
  // v3.3.48：虚拟滚动内核搬到 vlist.js（列表/网格共用），断言跟着内核走
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
  ok('帧率轮：虚拟滚动高度缓存只认 clientHeight，禁止用 contentRect.height',
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
    const plSrc = read('src/main/preload.js')

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
      /function rgbToOklab\(rgb\)/.test(thSrc) && /function oklabToRgb\(lab\)/.test(thSrc) &&
      /function normalize/.test(thSrc) && /--on-accent/.test(thSrc))
    ok('九条·tonal：默认跟随封面 + 存量裸色值一次性迁移',
      /accent: 'auto'/.test(mSrc) && /accentAutoMigrated/.test(mSrc))
    ok('九条·tonal：在线封面也取色（带 coverUrl 拉缓冲 + 限流兜底）',
      /accentForTrack: \(trackId, coverUrl\)/.test(plSrc) &&
      /function fetchCoverBuffer/.test(mSrc) && /512 \* 1024/.test(mSrc))
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
      /UI\.syncFavMarks\(\[(state\.currentId|id)\], state\.favorites\)/.test(read('src/renderer/js/mini.js')))
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

    // v2.8.46 / v3.3.54：全屏页歌词滚轮滚动（用户实报「全屏页也加个滚轮条滚动歌词」）。
    // 口径：滚轮可自由滚 + 滚动条悬停才着色；手动滚动后暂停自动居中 4 秒，到期归位。
    {
      const cssSrc = read('src/renderer/css/app.css')
      const uiSrc = read('src/renderer/js/ui.js')
      const appSrc = read('src/renderer/js/app.js')

      ok('全屏歌词面板可滚轮滚动（overflow-y:auto / overflow-x:hidden）',
        /#fsLyrics \{\r?\n  height: min\(44vh, 340px\);\r?\n  overflow-y: auto;\r?\n  overflow-x: hidden;/.test(cssSrc))

      ok('滚动条默认透明、仅悬停/聚焦时着色，槽位常驻不引起横向跳动',
        /#fsLyrics::-webkit-scrollbar-thumb \{\r?\n  background: transparent;/.test(cssSrc) &&
        /#fsLyrics:hover::-webkit-scrollbar-thumb,/.test(cssSrc) &&
        /#fsLyrics:focus-within::-webkit-scrollbar-thumb \{/.test(cssSrc) &&
        /color-mix\(in srgb, var\(--txt-3\) 42%, transparent\)/.test(cssSrc) &&
        /#playlistNav, \.qp-body, \.lp-lyrics, #fsLyrics \{ scrollbar-gutter: stable; \}/.test(cssSrc))

      ok('滚轮 / 触控板 / 拖动滚动条都接了手动浏览（点歌词行不算）',
        /box\.addEventListener\('wheel', note, \{ passive: true \}\)/.test(appSrc) &&
        /box\.addEventListener\('touchstart', note, \{ passive: true \}\)/.test(appSrc) &&
        /if \(e\.target === box\) note\(\)/.test(appSrc) &&
        /e\.target === box && e\.buttons === 1/.test(appSrc) &&
        /UI\.noteFsLyricScroll\(\)/.test(appSrc))

      ok('手动浏览期间只换高亮不抢位置；4 秒到期归位；切歌清 hold',
        /if \(Date\.now\(\) >= this\._fsHoldUntil\) fsScroll = this\._fsCenterTop\(fsBox, idx\)/.test(uiSrc) &&
        /FS_HOLD_MS: 4000/.test(uiSrc) &&
        /this\._fsRecenterFs\(\)/.test(uiSrc) &&
        /renderLyric\(parsed, trackTitle\) \{\r?\n    this\.clearFsLyricScrollHold\(\)/.test(uiSrc))

      // 真跑这组方法（打桩定时器 / DOM / 时间），断言语义而不是字面
      const seg = uiSrc.slice(uiSrc.indexOf('  _fsHoldUntil: 0,'),
        uiSrc.indexOf('  renderLyric(parsed, trackTitle)'))
      const mkBox = () => ({
        scrollTop: 500, clientHeight: 300, scrollHeight: 900,
        children: [{}, {}, { getBoundingClientRect: () => ({ top: 100, height: 30 }) }, {}, {}],
        getBoundingClientRect: () => ({ top: 0, height: 300 }),
        classList: {
          s: new Set(),
          toggle(c, on) { on ? this.s.add(c) : this.s.delete(c) },
          contains(c) { return this.s.has(c) }
        }
      })
      const mk = () => {
        const box = mkBox(), side = mkBox(), timers = [], cleared = []
        const obj = new Function('setTimeout', 'clearTimeout', 'Date', 'Math',
          'return {' + seg + '}')(
          (fn, ms) => { timers.push({ fn, ms }); return timers.length },
          (id) => { cleared.push(id) }, Date, Math)
        obj.els = { fsLyrics: box, lpLyrics: side }
        obj.lyricState = { index: 2 }
        return { obj, box, side, timers, cleared }
      }

      const a = mk()
      a.obj.noteFsLyricScroll()
      const held = a.obj._fsHoldUntil > Date.now() &&
        a.timers.length === 2 && a.timers.every((t) => t.ms === 4000) &&
        a.box.classList.contains('lyric-browsing') && a.side.classList.contains('lyric-browsing')
      if (a.timers[0]) a.timers[0].fn()     // 浏览态 4 秒到期
      const browseCleared = !a.box.classList.contains('lyric-browsing') &&
        !a.side.classList.contains('lyric-browsing')
      if (a.timers[1]) a.timers[1].fn()     // 自动跟随 4 秒到期 → 归位
      const centered = a.obj._fsHoldUntil === 0 && a.box.scrollTop === 465
      const b = mk()
      b.obj.noteFsLyricScroll()
      b.obj.clearFsLyricScrollHold()
      ok('真跑：滚轮后暂停 4 秒、浏览态全清晰、到期写回当前行居中位置；切歌立即撤销',
        held && browseCleared && centered && b.obj._fsHoldUntil === 0 &&
        !b.box.classList.contains('lyric-browsing') && b.cleared.includes(1),
        'scrollTop=' + a.box.scrollTop)

      const c = mk()
      c.box.scrollTop = 900
      ok('真跑：居中位置被夹在 [0, 可滚动上限]，没有当前行时安全返回 null',
        c.obj._fsCenterTop(c.box, 2) === 600 &&
        c.obj._fsCenterTop(c.box, -1) === null &&
        c.obj._fsCenterTop(c.box, 99) === null)
    }

    // v2.8.47 / v3.3.55：歌词景深模糊（参考 Apple Music / Salt Player）。
    // 口径：当前句清晰，±1/±2/≥3 行按 1/2/3px 渐糊渐淡；手动滚动 4 秒全清晰；
    // 桌面浮窗改上中下三行、上下两行轻糊。无高亮行（前奏/纯文本）不糊。
    {
      const cssSrc = read('src/renderer/css/app.css')
      const uiSrc2 = read('src/renderer/js/ui.js')
      const appSrc2 = read('src/renderer/js/app.js')
      const dlHtml = read('src/renderer/dlyric.html')
      const dlJs = read('src/renderer/js/dlyric.js')
      const pushJs = read('src/renderer/js/desktop-lyric.js')

      ok('景深只在有高亮行时启用，三档模糊半径与透明度渐变齐全',
        /\.lp-lyrics:has\(\.lyric-line\.active\) \.lyric-line,/.test(cssSrc) &&
        /#fsLyrics:has\(\.lyric-line\.active\) \.lyric-line \{/.test(cssSrc) &&
        /filter: blur\(3px\)/.test(cssSrc) &&
        /filter: blur\(1px\); opacity: var\(--lyric-depth-1\)/.test(cssSrc) &&
        /filter: blur\(2px\); opacity: var\(--lyric-depth-2\)/.test(cssSrc) &&
        /:has\(\+ \.lyric-line\.active\)/.test(cssSrc) &&
        /--lyric-depth-3: \.38/.test(cssSrc) && /--lyric-depth-3: \.5/.test(cssSrc))

      ok('浏览态全部清晰（!important 覆盖三档）+ reduced-motion 关过渡',
        /\.lp-lyrics\.lyric-browsing \.lyric-line,/.test(cssSrc) &&
        /#fsLyrics\.lyric-browsing \.lyric-line \{ filter: none !important; opacity: 1 !important; \}/.test(cssSrc) &&
        /\.lyric-line, \.lyric-line \.kw \{ transition: none !important; \}/.test(cssSrc))

      ok('两处歌词面板都绑了浏览态手势；全屏页仍走 4 秒 hold',
        /const note = \(\) => id === 'fsLyrics' \? UI\.noteFsLyricScroll\(\) : UI\.noteLyricBrowsing\(\)/.test(appSrc2) &&
        /box\.addEventListener\('wheel', note, \{ passive: true \}\)/.test(appSrc2) &&
        /_setLyricBrowsing\(on\)/.test(uiSrc2) && /noteLyricBrowsing\(\)/.test(uiSrc2) &&
        /this\.noteLyricBrowsing\(\)/.test(uiSrc2) &&
        /clearTimeout\(this\._lyricBrowseTimer\)/.test(uiSrc2) &&
        /this\._setLyricBrowsing\(false\)/.test(uiSrc2))

      ok('桌面歌词浮窗改成上中下三行：上下轻糊、缺句时占位隐藏',
        /<div id="prev"><\/div>/.test(dlHtml) &&
        /<div id="line">/.test(dlHtml) && /<div id="next"><\/div>/.test(dlHtml) &&
        /#prev, #next \{[\s\S]*?filter: blur\(\.6px\) drop-shadow/.test(dlHtml) &&
        /body\.noprev #prev, body\.nolyric #next \{ visibility: hidden; \}/.test(dlHtml) &&
        /#prev, #line, #next, #ctrl \{ transition: none !important; \}/.test(dlHtml))

      ok('浮窗三行数据链路：主窗口发 prev（含 idx>0 守卫）→ 浮窗写 prev + noprev 类',
        /if \(idx > 0 && st\.lines\[idx - 1\] && st\.lines\[idx - 1\]\.t != null\)/.test(pushJs) &&
        /const key = .*\+ prev \+/.test(pushJs) &&
        /line, next, prev,/.test(pushJs) &&
        /els\.prev\.textContent = d\.prev \|\| ''/.test(dlJs) &&
        /document\.body\.classList\.toggle\('noprev', !d\.prev\)/.test(dlJs) &&
        /els\.prev\.style\.color/.test(dlJs))

      ok('真跑：侧栏浏览只切景深，不动全屏自动跟随 hold（不变量 #50）',
        (() => {
          const seg2 = uiSrc2.slice(uiSrc2.indexOf('  _fsHoldUntil: 0,'),
            uiSrc2.indexOf('  renderLyric(parsed, trackTitle)'))
          const mkCls = () => ({
            s: new Set(),
            toggle(c, on) { on ? this.s.add(c) : this.s.delete(c) },
            contains(c) { return this.s.has(c) }
          })
          const box = { classList: mkCls() }, side = { classList: mkCls() }
          const timers = []
          const obj = new Function('setTimeout', 'clearTimeout', 'Date', 'Math',
            'return {' + seg2 + '}')(
            (fn, ms) => { timers.push({ fn, ms }); return timers.length },
            () => {}, Date, Math)
          obj.els = { lpLyrics: side, fsLyrics: box }
          obj.lyricState = { index: 2 }
          obj.noteLyricBrowsing()
          const on = box.classList.contains('lyric-browsing') && side.classList.contains('lyric-browsing')
          const noHold = obj._fsHoldUntil === 0 && timers.length === 1 && timers[0].ms === 4000
          if (timers[0]) timers[0].fn()
          return on && noHold && !box.classList.contains('lyric-browsing') &&
            !side.classList.contains('lyric-browsing')
        })())
    }

    // v2.8.48 / v3.3.56：桌面歌词浮窗上下两行太小（用户实报「几乎不可见」）。
    // 根因：.55em 相对的是父容器默认 16px（实际 8.8px），而当前句是 34px；
    // 再叠 .55 透明度 + 1px 模糊。口径：字号按当前句 .6 倍、透明度 .8、模糊 .6px，
    // 默认窗口 160px，已保存的矮窗口启动补到 160。
    {
      const dlHtml2 = read('src/renderer/dlyric.html')
      const dlJs2 = read('src/renderer/js/dlyric.js')
      const winSrc = read('src/main/dlyric-window.js')

      ok('浮窗上下行字号改按当前句 .6 倍（CSS 变量），不再用相对父级的 .55em',
        /#wrap \{[\s\S]{0,220}?--dl-side-fs: 20\.4px;/.test(dlHtml2) &&
        /#prev, #next \{[\s\S]{0,320}?font-size: var\(--dl-side-fs\);/.test(dlHtml2) &&
        !/font-size: \.55em/.test(dlHtml2))

      ok('上下行提亮到 .8、模糊减到 .6px；暂停态单独提亮，不回到全暗',
        /#prev, #next \{[\s\S]{0,420}?opacity: \.8;/.test(dlHtml2) &&
        /filter: blur\(\.6px\) drop-shadow/.test(dlHtml2) &&
        /body\.paused #line \{ opacity: \.45; \}/.test(dlHtml2) &&
        /body\.paused #prev, body\.paused #next \{ opacity: \.6; \}/.test(dlHtml2) &&
        !/filter: blur\(1px\) drop-shadow/.test(dlHtml2))

      ok('A- / A+ 调字号时上下行同步（applyCfg 按 fs×.6 写变量）',
        /const fs = Math\.max\(16, Math\.min\(80, cfg\.fontSize \|\| 34\)\)/.test(dlJs2) &&
        /els\.wrap\.style\.setProperty\('--dl-side-fs', \(fs \* \.6\)\.toFixed\(1\) \+ 'px'\)/.test(dlJs2) &&
        /els\.line\.style\.fontSize = fs \+ 'px'/.test(dlJs2))

      ok('浮窗默认高度 160px；已保存的矮窗口启动时补到 160（拖更高则保留）',
        /const MIN_DLYRIC_H = 160/.test(winSrc) &&
        /const winHeight = Number\.isFinite\(b\.height\) && b\.height >= 150 \? b\.height : MIN_DLYRIC_H/.test(winSrc) &&
        /height: winHeight,/.test(winSrc) &&
        !/height: b\.height \|\| 120/.test(winSrc))

      ok('真跑：窗口高度迁移（120→160 / 90→160 / 未保存→160 / 160→160 / 200→200）',
        (() => {
          const from = winSrc.indexOf('  const MIN_DLYRIC_H = 160')
          const to = winSrc.indexOf('  dlyricWin = new BrowserWindow')
          if (from < 0 || to < from) return false
          const seg = winSrc.slice(from, to)
          const calc = new Function('b', seg + '\nreturn winHeight')
          return calc({ height: 120 }) === 160 && calc({ height: 90 }) === 160 &&
            calc({}) === 160 && calc({ height: 160 }) === 160 && calc({ height: 200 }) === 200
        })())
    }

    // v2.8.49 / v3.3.57：在线播放「转圈加载不出来 / 概率断续」流式链路修复。
    // 真机日志：上游打开失败 This operation was aborted（母带档）→ 作废直链 → 502，
    // 界面没有加载失败终点就永久停在 0:00；断续来自缓存写盘背压串在 res.write 前。
    // v3.3.58：上轮为躲开背压把整首缓存丢了，导致在线播放永远不落盘。
    {
      const spSrc = read('src/main/streamproxy.js')
      const plSrc = read('src/renderer/js/player.js')
      const appSrc3 = read('src/renderer/js/app.js')

      const chain = spawnSync(process.execPath, ['test/stream-chain.mjs'], {
        cwd: ROOT, encoding: 'utf8'
      })
      ok('流式链路运行时单测 stream-chain（17 项：降级 / 背压 / 低速 / 落盘 / 残片 / 孤儿缓存）',
        chain.status === 0, (chain.stdout || '').trim().split('\n').slice(-1)[0])

      // v2.8.53 / v3.3.62：完整性判据不许 fail-open
      ok('206 必须凭 Content-Range 证明覆盖到 total-1 才算整段（缺头不再默认为真）',
        /const crCoversAll = upstream\.status === 206/.test(spSrc) &&
        /crTotal > 0 && !Number\.isNaN\(crEnd\) && crEnd === crTotal - 1/.test(spSrc) &&
        !/const crCoversAll = !crTotal \|\|/.test(spSrc))

      ok('收尾只看「文件在不在」的早退已改成「索引里有没有这条 key」',
        /const idxNow = DC\.cacheLoad\(\)/.test(spSrc) &&
        /fs\.existsSync\(target2\) && idxNow && idxNow\[key\]/.test(spSrc))

      ok('下载器：无 Content-Length 时不再静默当成功，改为标记 unverified',
        /if \(!task\.total\) \{/.test(read('src/main/downloader.js')) &&
        /task\.unverified = true/.test(read('src/main/downloader.js')) &&
        !/if \(task\.total && task\.received \+ 1024 < task\.total\) throw/.test(read('src/main/downloader.js')))

      ok('清缓存：删不掉的条目保留索引（不再无条件 cacheIdx = {}）',
        /const left = \{\}/.test(read('src/main/dircache.js')) &&
        /if \(err\.code !== 'ENOENT'\) left\[k\] = idx\[k\]/.test(read('src/main/dircache.js')) &&
        /cacheIdx = left/.test(read('src/main/dircache.js')))

      ok('转发顺序：先 res.write 给 <audio>，缓存只做同步投递，不再一见背压就丢',
        /if \(!sub\.res\.write\(buf\)\) waits\.push\(waitDrain\(sub\.res\)\)/.test(spSrc) &&
        /if \(cacheWrite\) cacheWrite\(buf\)/.test(spSrc) &&
        !/const ps = part\.stream\r?\n      if \(ps\)/.test(spSrc) &&
        !/await waitDrain\(ps\)/.test(spSrc))

      ok('主转发循环里没有写盘 drain 的 await（音频不被磁盘阻塞）',
        (() => {
          const from = spSrc.indexOf('async function pumpFlightBody(')
          const to = spSrc.indexOf('function waitDrain(', from)
          if (from < 0 || to < 0) return false
          const seg = spSrc.slice(from, to)
          // 只允许「等网络背压」的聚合等待：await Promise.all(waits)
          return !/await waitDrain\(/.test(seg) && /await Promise\.all\(waits\)/.test(seg)
        })())

      ok('缓存后台写盘队列：磁盘 drain 只在独立协程里等，32MB 上限保护内存',
        /function createCacheWriter\(/.test(spSrc) &&
        /MAX_QUEUED = 32 \* 1024 \* 1024/.test(spSrc) &&
        /await waitDrain\(w\)/.test(spSrc) &&
        /void pumpQueue\(\)\.catch/.test(spSrc) &&
        /createCacheWriter,/.test(spSrc))

      ok('收尾先等后台队列写完再校验，chunked 上游按实际正文长度落盘',
        /if \(writer\) await writer\.flush\(\)/.test(spSrc) &&
        /const expect = declared \|\| bytes/.test(spSrc) &&
        /stream\.end\(fin\)/.test(spSrc) &&
        !/上游无 Content-Length（chunked），跳过缓存/.test(spSrc))

      ok('start=0 的 Range 首请求允许缓存，拖进度条的 Range 仍不写脏缓存',
        spSrc.includes('/^bytes=0-(\\d*)$/') &&
        /const canCache = cacheOn && \(!rangeHdr \|\|/.test(spSrc))

      ok('正文最低速率看门狗（20 秒窗口 / 32KB / 不被 chunk 刷新 / 收尾清掉）',
        /const RATE_MIN_BYTES = 32 \* 1024/.test(spSrc) &&
        /rateTimer = setInterval\(/.test(spSrc) && /\}, 20000\)/.test(spSrc) &&
        /rateBytes \+= buf\.length/.test(spSrc) && /clearInterval\(rateTimer\)/.test(spSrc) &&
        /上游速率过低，终止取流/.test(spSrc))

      ok('母带 / 无损上游失败：作废坏链 + 降级 best 只重试一次 + 客户端断开不重试',
        /let info = await G\.online\.getPlayable/.test(spSrc) &&
        /!dead\(\) && \(prefer === 'master' \|\| prefer === 'lossless'\)/.test(spSrc) &&
        /getPlayable\(song, 'best', \{ signal: flight\.ctrl\.signal \}\)/.test(spSrc) &&
        /if \(!opened\) \{\r?\n        failAll\(flight, 502, 'upstream error'\)/.test(spSrc) &&
        /上游降级重试成功/.test(spSrc))

      ok('渲染层加载看门狗：20 秒无数据明确报错，progress 续期，元数据到达收掉',
        /_armLoadWatchdog = \(\) => \{/.test(plSrc) && /\}, 20000\)/.test(plSrc) &&
        /音频加载超时（上游无数据）/.test(plSrc) &&
        /audio\.addEventListener\('progress'/.test(plSrc) &&
        /audio\.addEventListener\('canplay'/.test(plSrc) &&
        /loadedmetadata', \(\) => \{\r?\n      this\._loadReady = true/.test(plSrc))

      ok('切歌 / 停止时收掉旧看门狗，避免误报新曲',
        /_loadCurrent\(autoplay = true\) \{[\s\S]{0,220}?this\._clearLoadWatchdog\(\)/.test(plSrc) &&
        /stop\(\) \{\r?\n    this\._clearLoadWatchdog\(\)/.test(plSrc) &&
        /this\.audio\.load\(\)\r?\n    this\._armLoadWatchdog\(\)/.test(plSrc))

      ok('作废直链不再走恒假的 cur.source（真正的 song 在 cur.online）',
        /const bad = cur && cur\.online/.test(appSrc3) &&
        /bad && bad\.source && bad\.id/.test(appSrc3) &&
        !/cur && cur\.online && cur\.source && cur\.id/.test(appSrc3))

      // v3.3.58：「保留缓存 / 退出时自动清除」做成缓存面板可切换开关，默认保留。
      const cpSrc = read('src/renderer/js/cache-panel.js')
      const dcSrc = read('src/main/dircache.js')
      const mjSrc = read('src/main/main.js')
      const htmlSrc4 = read('src/renderer/index.html')
      const policy = spawnSync(process.execPath, ['test/cache-policy.mjs'], {
        cwd: ROOT, encoding: 'utf8'
      })
      ok('缓存策略运行时单测 cache-policy（8 项：默认值 / 白名单 / 清理边界 / 索引写空回归）',
        policy.status === 0, (policy.stdout || '').trim().split('\n').slice(-1)[0])

      ok('默认保留缓存：开关默认 false，退出链按开关才调用 cacheClear',
        /onlineCacheClearOnExit: false/.test(mjSrc) &&
        /onlineCacheClearOnExit === true\)[\s\S]{0,180}?DC\.cacheClear\(\)/.test(mjSrc) &&
        /退出自动清理缓存/.test(mjSrc))

      ok('缓存面板开关接线：cacheStats 回传 + 回填 + patchSettings + HTML 控件成对',
        /clearOnExit: G\.store\.get\(\)\.settings\.onlineCacheClearOnExit === true/.test(dcSrc) &&
        /clr\.checked = info\.clearOnExit === true/.test(cpSrc) &&
        /patchSettings\(\{ onlineCacheClearOnExit: on \}\)/.test(cpSrc) &&
        /id="cacheClearOnExit"/.test(htmlSrc4))

      ok('退出链 cacheSave 先 load 再写：未加载的索引不许被写成空表',
        /atomicWriteJson\(path\.join\(cacheDirPath\(\), CACHE_INDEX\), cacheLoad\(\)\)/.test(dcSrc) &&
        !/cacheIdx \|\| \{\}/.test(dcSrc))

      // v2.8.51 / v3.3.60：保留 AO 看门狗兜底；坏帧解码警告改回静默（不打断单曲循环）。
      const mvSrc = read('src/main/mpv.js')
      const mgrSrc = read('src/main/mpv-manager.js')
      const maSrc = read('src/renderer/js/mpvaudio.js')
      const appSrc4 = read('src/renderer/js/app.js')
      const wd = spawnSync(process.execPath, ['test/mpv-watchdog.mjs'], {
        cwd: ROOT, encoding: 'utf8'
      })
      ok('独占看门狗运行时单测 mpv-watchdog（19 项：AO 兜底 / 坏帧静默 / 曲末 idle 恢复 / pause 轴）',
        wd.status === 0, (wd.stdout || '').trim().split('\n').slice(-1)[0])

      const eofLoop = spawnSync(process.execPath, ['test/eof-loop.mjs'], {
        cwd: ROOT, encoding: 'utf8'
      })
      ok('曲末循环运行时单测 eof-loop（6 项：旧写法不重载 / 新写法自动重载）',
        eofLoop.status === 0, (eofLoop.stdout || '').trim().split('\n').slice(-1)[0])

      ok('file-loaded 不来时用 load 时刻兜底，起播宽限不再永久豁免',
        /const graceBase = this\._fileLoadedAt \|\| this\._loadAt/.test(mvSrc) &&
        /this\._loadAt = Date\.now\(\)/.test(mvSrc) &&
        !/if \(this\._fileLoadedAt === 0 \|\|/.test(mvSrc))

      ok('坏帧解码警告改回静默：主进程 / 渲染层都不再接 decode-error 失败链',
        !/type: 'decode-error'/.test(mvSrc) &&
        !/decode-error/.test(mgrSrc) &&
        !/case 'decode-error'/.test(maSrc) &&
        !/decodeFailed/.test(maSrc) &&
        !/decodeFailed/.test(appSrc4))

      ok('独占 error 分支恢复 v3.3.18 原判据（坏帧不打断单曲循环）',
        /if \(state\.exclusive && !state\.exclusiveFellBack\) \{/.test(appSrc4) &&
        /toast\('音频输出失败：'/.test(appSrc4))

      ok('诊断轮：看门狗早退原因 + 状态快照写进主进程日志（只观测不改行为）',
        /_wdDiag\(/.test(mvSrc) &&
        /wd-diag/.test(mgrSrc) &&
        /G\.logLine\('\[wd\] '/.test(mgrSrc))

      ok('诊断轮 2：wantPlaying 进快照；异常 idle 单独标注',
        /wantPlaying: !!this\._wantPlaying/.test(mvSrc) &&
        /this\._wantPlaying = !paused/.test(mvSrc) &&
        /idle-while-want-playing/.test(mvSrc))

      const plSrc2 = read('src/renderer/js/player.js')
      ok('v2.8.52：曲末单曲循环不再先 seek(0)，ended 态直接 play() 触发重载',
        (plSrc2.match(/if \(this\.audio\.ended\) this\.play\(\)/g) || []).length === 2 &&
        !/this\._endingHandled = false\n      this\.seek\(0\)/.test(plSrc2))

      ok('MpvAudio currentTime setter 会复位 _ended（先 seek(0) 会让 play() 重载分支失效）',
        /set currentTime\(v\)[\s\S]{0,400}this\._ended = false/.test(maSrc) &&
        /if \(this\._ended && this\._srcPath\)[\s\S]{0,300}this\.load\(\)/.test(maSrc))

      ok('v2.8.52：异常 idle（wantPlaying=true）继续走 2.5 秒恢复，不再静默清零',
        /if \(this\._idle && !this\._wantPlaying\)/.test(mvSrc) &&
        /if \(this\._idle\) \{[\s\S]{0,500}Date\.now\(\) - this\._loadAt < 2000/.test(mvSrc) &&
        !/if \(this\._idle \|\| this\._paused \|\| !this\._lastFile\)/.test(mvSrc))

      ok('诊断轮 3：EOF 时序（pos/dur/seek/配对结果）写进快照',
        /pos: this\._lastPos, dur: this\._lastDur/.test(mvSrc) &&
        /end-file-eof-paired/.test(mvSrc) &&
        /end-file-eof-standalone/.test(mvSrc) &&
        /this\._wdDiag\('seek'\)/.test(mvSrc))

      // ===== v3.3.63 独立审查后的修复哨兵（每条对应一处修复，回退即报红） =====
      const stSrc63 = read('src/main/store.js')
      const dlSrc63 = read('src/main/downloader.js')
      const dcSrc63 = read('src/main/dircache.js')
      const spSrc63 = read('src/main/streamproxy.js')
      const plSrc63 = read('src/renderer/js/player.js')
      const scSrc63 = read('src/renderer/js/shortcuts.js')
      const selSrc63 = read('src/renderer/js/selection.js')
      const scanSrc63 = read('src/renderer/js/scan.js')
      const preSrc63 = read('src/main/preload.js')

      ok('v3.3.63：settings 不再把 onlineChkszKey 明文下发给渲染层',
        /function publicSettings\(s\)[\s\S]{0,400}delete out\.onlineChkszKey/.test(mjSrc) &&
        /handle\('settings:get', \(\) => publicSettings\(store\.get\(\)\.settings\)\)/.test(mjSrc) &&
        /return publicSettings\(next\)/.test(mjSrc))

      ok('v3.3.63：批量收藏一次落盘（favorites:setMany + preload + 渲染层不再串行循环）',
        /handle\('favorites:setMany'/.test(mjSrc) &&
        /setFavoritesMany: \(ids, fav\) => invoke\('favorites:setMany'/.test(preSrc63) &&
        !/for \(const t of targets\) \{[\s\S]{0,120}toggleFavorite\(t\.id\)/.test(read('src/renderer/js/menus.js')))

      ok('v3.3.63：下载任务「无法校验」标记能传到界面（DTO 带 unverified）',
        /unverified: !!t\.unverified/.test(dlSrc63) &&
        /if \(t\.unverified\) warn =/.test(read('src/renderer/js/online.js')))

      ok('v3.3.63：续传按同一资源判断 + 总长度比对（签名变化不再白下）',
        /function dlSameResource\(a, b\)/.test(dlSrc63) &&
        /!dlSameResource\(tgt\.url, info\.url\)/.test(dlSrc63) &&
        /Math\.abs\(total - tgt\.total\) > 1/.test(dlSrc63) &&
        /tgt: dlTargetCache\.get\(t\.id\) \|\| null/.test(dlSrc63))

      ok('v3.3.63：索引读失败（占用/权限）不回写空表；cachePut 走去抖不再同步 fsync',
        /cacheLoadBlocked = true/.test(dcSrc63) &&
        /if \(cacheLoadBlocked\) \{[\s\S]{0,160}return/.test(dcSrc63) &&
        /cacheSaveSoon\(\)\r?\n  cacheEvict\(\)/.test(dcSrc63) &&
        /code === 'ENOENT'\) \{ cacheIdx = \{\}; return cacheIdx \}/.test(dcSrc63))

      ok('v3.3.63：随机模式放完一轮也算整队播完（queue-end 会发）',
        /this\._shuffleWrapped = true/.test(plSrc63) &&
        /if \(this\._shuffleWrapped && auto && !fromError\) this\.emit\('queue-end'\)/.test(plSrc63))

      ok('v3.3.63：按住键不连发（e.repeat 守卫）+ 卡片视图选中态会刷新',
        /if \(e\.repeat\) return/.test(scSrc63) &&
        /#tableBody \.tr, #tableBody \.mc/.test(selSrc63))

      ok('v3.3.63：保存音乐目录失败不关弹窗、不静默（try/catch 后才 hideDirModal）',
        /patchSettings\(\{ musicDirs: draftDirs\.slice\(\), watchFolders \}\)[\s\S]{0,200}UI\.hideDirModal\(\)/.test(scanSrc63) &&
        /catch \(err\) \{\n      toast\('保存失败：'/.test(scanSrc63))

      ok('v3.3.63：引擎 stop() 不再同名重复定义；补刀条件不再被 p.killed 短路',
        (mvSrc.match(/^  (async )?stop\(/gm) || []).length === 1 &&
        /p\.exitCode === null\) p\.kill\('SIGKILL'\)/.test(mvSrc) &&
        /catch \{ wasPlaying = false \}/.test(mvSrc))

      ok('v3.3.63：代理端口回调锁实例（退出期不再 null.address 崩溃/写死端口）',
        /const srv = streamServer/.test(spSrc63) &&
        /if \(!srv \|\| streamServer !== srv\) return/.test(spSrc63))

      ok('v3.3.63：配置读失败走 onError（能落进 lx-player.log）',
        !/console\.error\('\[store\] 读取失败/.test(stSrc63) &&
        /this\.onError\('\[store\] 读取失败/.test(stSrc63) &&
        /STORE_RECOVERED/.test(mjSrc))

      // ===== v3.3.64 在线曲目收藏 / 加入歌单（每条对应一处改动，回退即报红） =====
      const olSrc64 = read('src/renderer/js/online.js')
      const appSrc64 = read('src/renderer/js/app.js')
      const uiSrc64 = read('src/renderer/js/ui.js')

      ok('v3.3.64：在线曲目元数据单独落盘（主进程三接口 + prune + 默认值）',
        /function pruneOnlineTracks\(\)/.test(mjSrc) &&
        /handle\('online:tracksGet'/.test(mjSrc) &&
        /handle\('online:tracksRemember'/.test(mjSrc) &&
        /handle\('online:tracksForget'/.test(mjSrc) &&
        /onlineTracks: \{\}/.test(mjSrc))

      ok('v3.3.64：收藏/歌单变更后按「仍被引用」清理元数据（不会无限膨胀也不会误删）',
        // 清理规则本体在 online-meta.js（可单测），这边只认调用点
        /OMETA\.pruneToRefs\(g\.onlineTracks, g\.favorites, g\.playlists\)/.test(mjSrc) &&
        /const OMETA = require\('\.\/online-meta'\)/.test(mjSrc) &&
        // 五个入口逐个点名：少一个都有「取消收藏后元数据永久残留」的漏口
        /store\.patch\(\{ favorites: out \}\)[\s\S]{0,40}pruneOnlineTracks\(\)/.test(mjSrc) &&
        /store\.patch\(\{ favorites: favs \}\)[\s\S]{0,40}pruneOnlineTracks\(\)/.test(mjSrc) &&
        /pl\.trackIds\.push\(t\)[\s\S]{0,80}pruneOnlineTracks\(\)/.test(mjSrc) &&
        /pl\.trackIds = pl\.trackIds\.filter[\s\S]{0,120}pruneOnlineTracks\(\)/.test(mjSrc) &&
        /store\.patch\(\{ playlists: \(store\.get\(\)\.playlists \|\| \[\]\)\.filter[\s\S]{0,120}pruneOnlineTracks\(\)/.test(mjSrc))

      ok('v3.3.64：preload 暴露三个元数据接口',
        /onlineTracksGet: \(\) => invoke\('online:tracksGet'\)/.test(read('src/main/preload.js')) &&
        /onlineTracksRemember: \(metas\) => invoke\('online:tracksRemember', metas\)/.test(read('src/main/preload.js')))

      ok('v3.3.64：在线行尾有 ♥ 收藏与 ＋ 加入歌单（状态跟 state.favorites 走）',
        /data-act="fav" aria-pressed/.test(olSrc64) &&
        /data-act="addpl"/.test(olSrc64) &&
        /const favOn = state\.favorites && state\.favorites\.has\(id\)/.test(olSrc64) &&
        /async toggleFavAt\(i\)/.test(olSrc64) &&
        /async addPlaylistAt\(i, btn\)/.test(olSrc64))

      ok('v3.3.64：先写元数据再写收藏/歌单（顺序反了会被 prune 当场剪掉）',
        /onlineTracksRemember\(\[this\.metaOf\(song[\s\S]{0,30}\)\]\)\.[\s\S]{0,400}handleCtxAction\('fav'\)/.test(olSrc64) &&
        /onlineTracksRemember\(\[this\.metaOf\(song[\s\S]{0,30}\)\]\)\.[\s\S]{0,1100}showContextMenu/.test(olSrc64))

      ok('v3.3.64：resolveTrack 覆盖收藏/歌单/最近播放/会话恢复（在线 id 不再被 filter 掉）',
        /function resolveTrack\(id\)/.test(appSrc64) &&
        /state\.onlineMeta\.get\(id\)[\s\S]{0,120}Online\.trackFromMeta/.test(appSrc64) &&
        /state\.favorites\)\.map\(\(id\) => resolveTrack\(id\)\)/.test(appSrc64) &&
        /pl\.trackIds\.map\(\(id\) => resolveTrack\(id\)\)/.test(appSrc64) &&
        !/const track = state\.byId\.get\(row\.dataset\.id\)/.test(appSrc64))

      ok('v3.3.64：原音源失效时换源重试一次，失败才跳曲（notePlaybackFailure 复用）',
        /async function recoverOnlineTrack\(cur\)/.test(appSrc64) &&
        /function notePlaybackFailure\(cur\)/.test(appSrc64) &&
        /cur\.onlineMeta && !state\.fallbackTried\.has\(cur\.id\)/.test(appSrc64) &&
        /const song = await Online\.recoverFromSources\(meta\)/.test(appSrc64) &&
        /return bestScore >= 60 \? best : null/.test(olSrc64))

      ok('v3.3.64：元数据表整表替换用 setKey（patch 走 deepMerge 不删键，清不掉旧条目）',
        (mjSrc.match(/store\.setKey\('onlineTracks'/g) || []).length >= 3 &&
        !/store\.patch\(\{ onlineTracks/.test(mjSrc))

      ok('v3.3.64：收藏/入歌单后同步渲染层元数据（否则「我的收藏」要重启才看得见）',
        /syncOnlineMeta\(map\)/.test(olSrc64) &&
        (olSrc64.match(/this\.syncOnlineMeta\(map\)/g) || []).length >= 2 &&
        /state\.onlineMeta = new Map\(Object\.entries\(map\)\)/.test(olSrc64))

      ok('v3.3.64：混排列表里在线曲带「在线」标记 + 行尾五键列宽',
        /tag-online/.test(uiSrc64) &&
        /#onlinePane \.op-tr \{[\s\S]{0,160}150px/.test(read('src/renderer/css/online.css')) &&
        /css\/online\.css/.test(read('src/renderer/index.html')))
    }

    // ===== v3.3.65 每日推荐对齐在线收藏 + 在线曲规格档位（回退即报红） =====
    {
      const omSrc = read('src/main/online-meta.js')
      const dSrc65 = read('src/renderer/js/daily.js')
      const olSrc65 = read('src/renderer/js/online.js')
      const uiSrc65 = read('src/renderer/js/ui.js')
      const dcSrc65 = read('src/renderer/css/daily.css')

      ok('v3.3.65：主进程校验探测档位（cls 白名单 + text/tip 限长）',
        /function sanitizeSpec\(sp\)/.test(omSrc) &&
        /text: clip\(sp\.text, 24\)/.test(omSrc) &&
        /\['lossless', 'high', 'ok', 'dim', ''\]\.includes\(cls\)/.test(omSrc) &&
        /spec: sanitizeSpec\(m\.spec\)/.test(omSrc))

      ok('v3.3.65：metaOf 落盘探测档位、songFromMeta 还原、toTrack 挂展示字段',
        /metaOf\(song, spec\)/.test(olSrc65) &&
        /spec: spec \|\| song\._q \|\| null/.test(olSrc65) &&
        /_q: meta\.spec \|\| null/.test(olSrc65) &&
        /specText: \(song\._q && song\._q\.text\)/.test(olSrc65))

      ok('v3.3.65：收藏/入歌单落盘时带探测档位',
        (olSrc65.match(/onlineTracksRemember\(\[this\.metaOf\(song, song\._q\)\]/g) || []).length === 2)

      ok('v3.3.65：每日推荐行尾 ♥/＋ 与本地兜底行隔离',
        /data-act="fav" aria-pressed/.test(dSrc65) &&
        /data-act="addpl"/.test(dSrc65) &&
        /async toggleFavAt\(i\)/.test(dSrc65) &&
        /async addPlaylistAt\(i, btn\)/.test(dSrc65) &&
        /\(isLocal \? '' :/.test(dSrc65))

      ok('v3.3.65：每日推荐收藏先落元数据（含 x.q）再写引用 + 同步渲染层',
        (dSrc65.match(/onlineTracksRemember\(\[Online\.metaOf\(song, x\.q\)\]/g) || []).length === 2 &&
        /Online\.syncOnlineMeta\(map\)/.test(dSrc65) &&
        /paintFavRows\(\)/.test(dSrc65))

      ok('v3.3.65：规格列在线曲读档位文本，无档位显示「在线」占位（不动本地曲）',
        /t\.specText \|\| '在线'/.test(uiSrc65) &&
        /!t\.online && isHires\(t\)/.test(uiSrc65) &&
        /t\.specTip \|\| '在线曲目：播放时按原音源解析实际档位'/.test(uiSrc65))

      ok('v3.3.65：每日推荐末列按 4 键放宽（118/104/104），不动共享 app.css',
        /46px 118px/.test(dcSrc65) && /42px 104px/.test(dcSrc65) && /52px 104px/.test(dcSrc65) &&
        /css\/daily\.css/.test(read('src/renderer/index.html')))

      ok('v3.3.65：新增 daily-fav 单测入库且覆盖 11 项',
        (read('test/daily-fav.mjs').match(/\bok\(/g) || []).length >= 11)
    }

    // ===== v3.3.66 审查修复（回退即报红） =====
    {
      const omSrc66 = read('src/main/online-meta.js')
      const huSrc66 = read('src/main/http-util.js')
      const dlSrc66 = read('src/main/downloader.js')
      const olMain66 = read('src/main/online.js')
      const spSrc66 = read('src/main/streamproxy.js')
      const libSrc66 = read('src/main/library.js')
      const pjSrc66 = read('src/renderer/js/player.js')
      const appSrc66 = read('src/renderer/js/app.js')
      const olSrc66 = read('src/renderer/js/online.js')
      const miniSrc66 = read('src/renderer/js/mini.js')

      ok('v3.3.66：mergeMeta 导出且「后到条目没带档位不清旧档位」',
        /function mergeMeta\(prev, next\)/.test(omSrc66) &&
        /if \(!out\.spec && prev && prev\.spec\) out\.spec = prev\.spec/.test(omSrc66) &&
        / mergeMeta,/.test(omSrc66))

      ok('v3.3.66：tracksRemember 走 mergeMeta（不整条覆盖）+ 收藏入口挡非字符串 id',
        /out\[m\.id\] = OMETA\.mergeMeta\(cur\[m\.id\], m\)/.test(mainSrc) &&
        /if \(typeof trackId !== 'string' \|\| !trackId\) return store\.get\(\)\.favorites \|\| \[\]/.test(mainSrc))

      ok('v3.3.66：换源 fallback 用 force 重载（同 id 不再被早退吞掉）',
        /if \(!force && targetId === prevId && this\.audio\.src\)/.test(pjSrc66) &&
        /player\.setQueue\(tracks, idx, true, true\)/.test(appSrc66) &&
        /test\/player-recover\.mjs/.test(read('package.json')) === false /* 单测靠 tools 枚举，不进 package.json */)

      ok('v3.3.66：在线曲写收藏/历史前先 rememberTrack（底栏 ♥ 不再留空行）',
        /async rememberTrack\(track, spec\)/.test(olSrc66) &&
        /await Online\.rememberTrack\(/.test(miniSrc66) &&
        /Online\.rememberTrack\(player\.current\)/.test(appSrc66) &&
        /rememberTrack\(cur( && cur\.id === id \? cur : \{ id \}| \|\|)/.test(miniSrc66))

      ok('v3.3.66：上游头统一走 http-util（过滤逐跳头，三处一致）',
        /HOP_HEADER = \/\^\(host\|content-length\|connection\|keep-alive\|transfer-encoding\|upgrade\|proxy-connection\|te\|trailer\|range\)\$\/i/.test(huSrc66) &&
        /HTTPU\.buildUpstreamHeaders\(info\)/.test(dlSrc66) &&
        /HTTPU\.buildUpstreamHeaders\(info\)/.test(olMain66) &&
        /HTTPU\.buildUpstreamHeaders\(info\)/.test(spSrc66) &&
        !/Object\.assign\(headers, info\.headers\)/.test(dlSrc66 + olMain66 + spSrc66))

      ok('v3.3.66：下载 done 复用 + 封面主色挡内网地址',
        /t\.status === 'done'\) return \{ ok: false, error: '这首已经下载过了'/.test(mainSrc) &&
        /HTTPU\.isPrivateHost\(new URL\(String\(coverUrl\)\)\.hostname\)/.test(mainSrc))

      ok('v3.3.66：probeLimit 同步抛错也唤醒排队 + 封面预热 promise 可结算',
        (dlSrc66.match(/probeWaiting\.shift\(\)/g) || []).length >= 2 &&
        /_coverWarmupResolve = r/.test(libSrc66) &&
        /if \(this\._coverWarmupResolve\)/.test(libSrc66))

      ok('v3.3.66：档位文案统一为「高解析」+ 探测结果回写 song + 下载警示不再二次转义',
        /text: hi \? '高解析' : '无损'/.test(read('src/renderer/js/daily.js')) &&
        /x\.song\._q = x\.q/.test(read('src/renderer/js/daily.js')) &&
        /\$\{esc\(line\)\}\$\{warn \?/.test(olSrc66) &&
        (read('test/player-recover.mjs').match(/\bok\(/g) || []).length >= 9)
    }

    // ===== v3.3.67 第二轮审查修复（回退即报红） =====
    {
      const libSrc67 = read('src/main/library.js')
      const main67 = read('src/main/main.js')
      const app67 = read('src/renderer/js/app.js')
      const ui67 = read('src/renderer/js/ui.js')
      const ol67 = read('src/renderer/js/online.js')
      const pkg67 = read('package.json')

      ok('v3.3.67：库扫描清理限定在本次扫描范围内（子集扫描不再清空别的根）',
        /const scopeRoots = scanDirs/.test(libSrc67) &&
        /const inScope = \(p\) =>/.test(libSrc67) &&
        /if \(!old \|\| !inScope\(old\.path\)\) continue/.test(libSrc67) &&
        /inScope\(f\.path\)/.test(libSrc67))

      ok('v3.3.67：内嵌歌词原子落盘（tmp + rename）',
        /const tmp = out \+ '\.tmp'/.test(libSrc67) &&
        /await fsp\.rename\(tmp, out\)/.test(libSrc67))

      ok('v3.3.67：history/playcount 挡非字符串 id + playlists:update 只放行展示字段',
        /history:add', \(e, trackId\) => \{[\s\S]{0,220}typeof trackId !== 'string'/.test(main67) &&
        (main67.match(/typeof trackId !== 'string'/g) || []).length >= 3 &&
        /const \{ id, patch \} = payload && typeof payload === 'object' \? payload : \{\}/.test(main67) &&
        /safe\.trackIds = patch\.trackIds\.filter/.test(main67) &&
        /if \(safe\.trackIds\) pruneOnlineTracks\(\)/.test(main67))

      ok('v3.3.67：启动扫描/监视目录过 isSafeMediaRoot + m3u 首字符 # 转义',
        /const startDirs = \(store\.get\(\)\.settings\.musicDirs \|\| \[\]\)\s*\n\s*\.filter\(\(d\) => typeof d === 'string' && PROTO\.isSafeMediaRoot\(d\)\)/.test(main67) &&
        /\.filter\(\(d\) => typeof d === 'string' && PROTO\.isSafeMediaRoot\(d\)\)/.test(main67) &&
        /line\.startsWith\('#'\) \? '\.\/' \+ line : line/.test(main67))

      ok('v3.3.67：首屏并发读取逐项兜底（单个接口失败不再整页堆栈）',
        /const soft = \(p, fallback\) => Promise\.resolve\(p\)\.catch/.test(app67) &&
        (app67.match(/soft\(window\.api\./g) || []).length >= 7)

      ok('v3.3.67：同视图刷新保滚动（keepScroll）',
        /const keepScroll = !!this\._tCtx\.keepScroll/.test(ui67) &&
        /if \(keepScroll && scroller && prevTop\) scroller\.scrollTop = prevTop/.test(ui67) &&
        (app67.match(/renderView\(\{ keepScroll: true \}\)/g) || []).length >= 4 &&
        /keepScroll\s+\/\/ v3\.3\.67/.test(app67))

      ok('v3.3.67：歌单删除按钮进模板 + 网格高亮清理 + 右键不拖进度条',
        /class="pl-del" type="button"/.test(ui67) &&
        /#tableBody \.tr\.playing, #tableBody \.mc\.playing/.test(read('src/renderer/js/queue-tools.js')) &&
        /if \(e\.button !== 0\) return/.test(app67) &&
        /e\.stopPropagation\(\)[\s\S]{0,80}UI\.setFullscreen\(false\)/.test(read('src/renderer/js/fullscreen.js')))

      ok('v3.3.67：mpv running 认 exitCode/signalCode + 下载标题不再拼出 undefined',
        /this\.proc\.exitCode === null && this\.proc\.signalCode === null/.test(read('src/main/mpv.js')) &&
        /t\.artist \? t\.artist \+ ' - ' : ''/.test(ol67))

      ok('v3.3.67：rememberTrack 给已存条目补档位（先收藏后探测可回填）',
        /const have = state\.onlineMeta && state\.onlineMeta\.get/.test(ol67) &&
        /if \(!want \|\| hasSpec\) return true/.test(ol67) &&
        /Object\.assign\(\{\}, have, \{ spec: want \}\)/.test(ol67))

      // v3.3.70：原来是 (67|68) 白名单，升到 3.3.69 就假失败一次；改成「3.3.x 且不低于 67」
      ok('v3.3.67：版本号已升（package.json）',
        /"version": "3\.3\.(\d+)"/.test(pkg67) &&
        Number(/"version": "3\.3\.(\d+)"/.exec(pkg67)[1]) >= 67)

      ok('v3.3.67：扫描作用域有真跑的回归测试（缺依赖时明确 SKIP 而非假通过）',
        fs.existsSync(path.join(ROOT, 'test/scan-scope.mjs')) &&
        (read('test/scan-scope.mjs').match(/\bok\(/g) || []).length >= 5 &&
        /SKIP：缺少运行时依赖/.test(read('test/scan-scope.mjs')))
    }

    // ===== v3.3.68 第三轮审查修复（回退即报红） =====
    {
      const app68 = read('src/renderer/js/app.js')
      const d68 = read('src/renderer/js/daily.js')
      const m68 = read('src/renderer/js/mini.js')

      ok('v3.3.68：换源搜索返回后校验当前曲（切歌后旧回调不再拽回旧曲）',
        /const song = await Online\.recoverFromSources\(meta\)/.test(app68) &&
        /if \(!player\.current \|\| player\.current\.id !== cur\.id\) return/.test(app68))

      ok('v3.3.68：每日推荐点播加并发 token（连点不再让旧解析覆盖新歌）',
        /const token = \(this\._playToken \|\| 0\) \+ 1/.test(d68) &&
        /this\._playToken = token/.test(d68) &&
        /if \(token !== this\._playToken\) return/.test(d68))

      ok('v3.3.68：底栏收藏固定入口 id（元数据与收藏同一首）',
        /const id = state\.currentId[\s\S]{0,400}const ready = await Online\.rememberTrack/.test(m68) &&
        /cur && cur\.id === id \? cur : \{ id \}/.test(m68) &&
        /toggleFavorite\(id\)/.test(m68) &&
        !/toggleFavorite\(state\.currentId\)/.test(m68))

      const cd68 = read('tools/check-dist.mjs')
      ok('v3.3.68：check-dist 接受联网版新 exe 名（换装不再假失败）',
        /exeNames = \['猪专属播放器\.exe', '猪专属播放器联网版\.exe'\]/.test(cd68) &&
        /hasExe/.test(cd68) &&
        !/const must = \['猪专属播放器\.exe'/.test(cd68))
    }

    // ===== v3.3.69 歌单增删曲 IPC 参数校验（放宽口径重审 P1，两版同源） =====
    {
      const mj69 = read('src/main/main.js')
      ok('v3.3.69：playlists:addTracks/removeTracks 校验 id 与 trackIds 数组',
        /playlists:addTracks', \(e, \{ id, trackIds \} = \{\}\) => \{[\s\S]{0,120}Array\.isArray\(trackIds\)/.test(mj69) &&
        /playlists:removeTracks', \(e, \{ id, trackIds \} = \{\}\) => \{[\s\S]{0,120}Array\.isArray\(trackIds\)/.test(mj69) &&
        (mj69.match(/typeof t === 'string' && t\)/g) || []).length >= 2)
    }

    // ===== v3.3.70 全屏页右上角窗口控制条（独占 / 最小化 / 最大化 / 关闭，两版同源） =====
    {
      const html70 = read('src/renderer/index.html')
      const css70 = read('src/renderer/css/app.css')
      const fs70 = read('src/renderer/js/fullscreen.js')
      const app70 = read('src/renderer/js/app.js')
      const ui70 = read('src/renderer/js/ui.js')
      ok('v3.3.70：全屏页四个窗口键齐全且都在 #fsView 内',
        /<div class="fs-winbar"[\s\S]{0,900}id="fsHifi"[\s\S]{0,400}id="fsMin"[\s\S]{0,400}id="fsMax"[\s\S]{0,400}id="fsWinClose"/.test(html70) &&
        html70.indexOf('id="fsWinbar"') > html70.indexOf('<div id="fsView">'))
      ok('v3.3.70：控制条贴右上角 + 工具组让位 + 关闭键危险态',
        /\.fs-winbar\s*\{[^}]*position:\s*absolute[^}]*right:\s*0/.test(css70) &&
        /#fsHeadTools\s*\{[^}]*margin-right:\s*168px/.test(css70) &&
        /\.fs-win\s*\{[^}]*width:\s*38px[^}]*height:\s*34px/.test(css70) &&
        /\.fs-win\.danger:hover\s*\{[^}]*var\(--danger\)/.test(css70))
      ok('v3.3.70：四键只转发不给逻辑，最大化图标与独占态两处同源',
        /fsWin\('fsMin', 'btnMin'\)/.test(fs70) &&
        /fsWin\('fsMax', 'btnMax'\)/.test(fs70) &&
        /fsWin\('fsWinClose', 'btnClose'\)/.test(fs70) &&
        /fsWin\('fsHifi', 'btnHifi'/.test(fs70) &&
        /for \(const id of \['btnMax', 'fsMax'\]\)/.test(app70) &&
        /\[this\.els\.btnHifi, this\.els\.fsHifi\]/.test(ui70))
    }

  }
  console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
  process.exit(fail ? 1 : 0)
}

main()
