'use strict'
/**
 * 全屏播放页拖动 + 队列入口运行时单测 · v2.8.37 / v3.3.45
 *
 * 不启动 Electron：假 DOM + 假 IPC，把 dragwin.js / fullscreen.js 原样放进 vm 里跑。
 * 覆盖：#fsView 空白处可拖、控件区不抢拖动、位移链、队列按钮开关与高亮同步。
 * 用法：node test/fullscreen-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

/* ---------------- 最小 DOM ---------------- */
class El {
  constructor(id = '', tag = 'div') {
    this.id = id
    this.tagName = tag.toUpperCase()
    this.hidden = false
    this._classes = new Set()
    this._ls = {}
    this.dataset = {}
    this.style = { setProperty() {} }
    this.parentElement = null
    this.children = []
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
      toggle: (c, f) => {
        const on = f == null ? !this._classes.has(c) : !!f
        on ? this._classes.add(c) : this._classes.delete(c)
        return on
      }
    }
  }
  matchesOne(sel) {
    const s = sel.trim()
    if (s.startsWith('#')) return this.id === s.slice(1)
    if (s.startsWith('.')) return this._classes.has(s.slice(1))
    return this.tagName === s.toUpperCase()
  }
  closest(sel) {
    const list = String(sel).split(',').map((x) => x.trim()).filter(Boolean)
    let n = this
    while (n) {
      if (n.matchesOne && list.some((one) => n.matchesOne(one))) return n
      n = n.parentElement
    }
    return null
  }
  addEventListener(type, fn, capture) { (this._ls[type] ||= []).push({ fn, capture }) }
  fire(type, ev) {
    const ls = this._ls[type] || []
    for (const l of ls.filter((x) => x.capture)) { l.fn(ev); if (ev.__stopped) return }
    for (const l of ls.filter((x) => !x.capture)) l.fn(ev)
  }
  click() { this.fire('click', { target: this, preventDefault() {}, stopPropagation() { this.__stopped = true } }) }
  setPointerCapture() {}
  releasePointerCapture() {}
}

const els = new Map()
const make = (id, tag = 'div') => {
  const e = new El(id, tag)
  els.set(id, e)
  return e
}
const ids = [
  'pbCover', 'fsView', 'fsClose', 'fsQueue', 'queuePanel',
  'fsPlay', 'btnPlay', 'fsPrev', 'btnPrev', 'fsNext', 'btnNext',
  'fsMode', 'btnMode', 'fsFav', 'btnFav', 'fsBar', 'titlebar',
  // v3.3.70 / v2.8.57：全屏页右上角窗口控制条（转发目标也要在，才能数点击）
  'fsHifi', 'fsMin', 'fsMax', 'fsWinClose', 'btnHifi', 'btnMin', 'btnMax', 'btnClose'
]
ids.forEach((id) => make(id, /^(btn|fs|pb)/.test(id) ? 'button' : 'div'))
els.get('fsView').tagName = 'DIV'
els.get('queuePanel').hidden = true
// 控件挂在 #fsView 下，closest 才能沿父链找到 BLOCK 命中
const fsView = els.get('fsView')
for (const id of ['fsPlay', 'fsPrev', 'fsNext', 'fsMode', 'fsFav', 'fsFav', 'fsQueue', 'fsClose', 'fsBar',
  'fsHifi', 'fsMin', 'fsMax', 'fsWinClose']) {
  const e = els.get(id)
  if (e) e.parentElement = fsView
}
const fsLyrics = make('fsLyrics', 'div')
fsLyrics.parentElement = fsView
const lyricLine = make('lyricLine', 'div')
lyricLine._classes.add('lyric-line')
lyricLine.parentElement = fsLyrics

const observers = []
class MO {
  constructor(cb) { this.cb = cb; observers.push(this) }
  observe(target, opts) { this.target = target; this.opts = opts }
}
const document = {
  body: new El('body', 'body'),
  getElementById: (id) => els.get(id) || null,
  querySelector: (sel) => (sel === '#fsView' ? fsView : sel === '#titlebar' ? els.get('titlebar') : null),
  addEventListener: (t, fn, cap) => (document._ls[t] ||= []).push({ fn, cap }),
  _ls: {}
}
const winLs = {}
const calls = { dragStart: 0, dragMove: [], dragEnd: 0, queueToggle: 0, setFs: [], seekRatios: [] }
// 标题栏同名按钮的点击计数：全屏页只做转发，不该自己写逻辑
for (const id of ['btnHifi', 'btnMin', 'btnMax', 'btnClose']) {
  const e = els.get(id)
  e.addEventListener('click', () => { calls[id] = (calls[id] || 0) + 1 })
}
// v3.3.70：独占开关重载后要能恢复全屏页，靠 sessionStorage 传话
const store = new Map()
const sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
const window = {
  api: {
    dragStart: () => { calls.dragStart++ },
    dragMove: (dx, dy) => { calls.dragMove.push([dx, dy]) },
    dragEnd: () => { calls.dragEnd++ }
  },
  addEventListener: (t, fn, cap) => (winLs[t] ||= []).push({ fn, cap })
}
const UI = {
  els: { fsView },
  setFullscreen: (s) => { calls.setFs.push(s); return !!s },
  isFullscreen: () => fsView.classList.contains('open'),
  toggleQueue: () => {
    calls.queueToggle++
    // v3.3.48：队列改右侧滑出侧栏，开态是 .show 类（hidden 由关闭过渡补）
    const q = els.get('queuePanel')
    q.classList.toggle('show')
    q.hidden = !q.classList.contains('show')
    observers.filter((o) => o.target === q).forEach((o) => o.cb([]))
  }
}
const fireWin = (type, ev) => {
  for (const l of (winLs[type] || []).filter((x) => x.capture)) { l.fn(ev); if (ev.__stopped) return }
  for (const l of (winLs[type] || []).filter((x) => !x.capture)) l.fn(ev)
}

const ctx = vm.createContext({
  console, document, window, MutationObserver: MO, UI, sessionStorage,
  requestAnimationFrame: (fn) => { fn(); return 1 },
  cancelAnimationFrame: () => {},
  player: { seekRatio: (r) => calls.seekRatios.push(r) },
  audio: { duration: 200, currentTime: 0 },
  setTimeout, clearTimeout
})
for (const rel of ['src/renderer/js/dragwin.js', 'src/renderer/js/fullscreen.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel })
}

/* ---------------- 1) 全屏页空白处可拖 ---------------- */
const pd = (target, extra = {}) => {
  const ev = Object.assign({
    button: 0, detail: 1, pointerId: 1, screenX: 100, screenY: 100, target,
    preventDefault() { this.__pd = true }
  }, extra)
  fsView.fire('pointerdown', ev)
  return ev
}
let ev = pd(fsView)
ok('#fsView 空白处按下 → 启动拖动（dragStart + win-dragging）',
  calls.dragStart === 1 && document.body.classList.contains('win-dragging') && ev.__pd === true)
fireWin('pointermove', { screenX: 137, screenY: 121 })
ok('pointermove 把累计位移送到主进程（rAF 节流）',
  calls.dragMove.length === 1 && calls.dragMove[0][0] === 37 && calls.dragMove[0][1] === 21,
  JSON.stringify(calls.dragMove))
fireWin('pointerup', {})
ok('松手收尾：dragEnd + 清掉 win-dragging',
  calls.dragEnd === 1 && !document.body.classList.contains('win-dragging'))

/* ---------------- 2) 控件区不启动拖动 ---------------- */
calls.dragStart = 0
pd(els.get('fsPlay'))
pd(els.get('fsBar'))
pd(fsLyrics)
pd(lyricLine)
pd(els.get('fsQueue'))
ok('按钮 / 进度条 / 歌词区 / 队列按钮上按下都不启动拖动（5 次全被 BLOCK 拦下）',
  calls.dragStart === 0, String(calls.dragStart))
calls.dragStart = 0
pd(fsView, { detail: 2 })
ok('双击仍不启动拖动（只由 dblclick 处理）', calls.dragStart === 0)

/* ---------------- 3) 全屏页队列入口 ---------------- */
calls.queueToggle = 0
const btnEv = { target: els.get('fsQueue'), preventDefault() {}, stopPropagation() { this.__stopped = true } }
els.get('fsQueue').fire('click', btnEv)
ok('点全屏页队列按钮 → UI.toggleQueue() 且截断冒泡',
  calls.queueToggle === 1 && btnEv.__stopped === true)
ok('队列打开后按钮进入点亮态、抽屉 hidden=false',
  els.get('fsQueue').classList.contains('on') && els.get('queuePanel').hidden === false)
els.get('fsQueue').fire('click', { target: els.get('fsQueue'), preventDefault() {}, stopPropagation() {} })
ok('再点一次收起，按钮点亮态同步撤销',
  calls.queueToggle === 2 && els.get('queuePanel').hidden === true &&
  !els.get('fsQueue').classList.contains('on'))

/* ---------------- 4) 收起全屏页 ---------------- */
calls.setFs.length = 0
els.get('fsClose').fire('click', { target: els.get('fsClose'), preventDefault() {}, stopPropagation() {} })
ok('右上角收起按钮 → UI.setFullscreen(false)',
  calls.setFs.length === 1 && calls.setFs[0] === false, JSON.stringify(calls.setFs))
calls.setFs.length = 0
fsView.classList.add('open')
for (const l of (document._ls.keydown || [])) {
  // v3.3.70：v3.3.67 起 Esc 处理里多了 e.stopPropagation()（全屏退出优先，别让主界面再吃一次），
  // 假事件缺这个方法就会 TypeError 直接中断整套断言。
  l.fn({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
}
ok('Esc 在全屏页打开时 → UI.setFullscreen(false)',
  calls.setFs.length === 1 && calls.setFs[0] === false, JSON.stringify(calls.setFs))

/* ---------------- 5) 右上角窗口控制条（v3.3.70 / v2.8.57） ---------------- */
const fireClick = (id) => {
  const ev = { target: els.get(id), preventDefault() {}, stopPropagation() { this.__stopped = true } }
  els.get(id).fire('click', ev)
  return ev
}
fireClick('fsMin')
ok('全屏页最小化 → 转发给标题栏 #btnMin', calls.btnMin === 1, String(calls.btnMin))
fireClick('fsMax')
ok('全屏页最大化 → 转发给标题栏 #btnMax（图标同步靠 app.js 的 setMaxIcon）',
  calls.btnMax === 1)
fireClick('fsWinClose')
ok('全屏页关闭 → 转发给标题栏 #btnClose（退出前串行落盘只有那一份）',
  calls.btnClose === 1)

store.delete('lx_fs_reopen')
fsView.classList.add('open')
fireClick('fsHifi')
ok('全屏页独占开关 → 转发给标题栏 #btnHifi，且留下重载恢复标记',
  calls.btnHifi === 1 && store.get('lx_fs_reopen') === '1')
store.delete('lx_fs_reopen')
fsView.classList.remove('open')
fireClick('fsHifi')
ok('不在全屏页时点同一个键 → 不留恢复标记（重载后仍停主界面）',
  calls.btnHifi === 2 && !store.has('lx_fs_reopen'))

/* 重载后恢复：新开一个干净 vm，sessionStorage 预置标记，脚本应在 DOM 就绪后展开全屏页 */
const reopenStore = new Map([['lx_fs_reopen', '1']])
const reopenCalls = []
const reopenView = { classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) }, contains(c) { return this._s.has(c) }, toggle(c, f) { const on = f == null ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on } } }
const reopenCtx = vm.createContext({
  console,
  document: {
    readyState: 'complete',
    body: new El('body', 'body'),
    getElementById: (id) => (id === 'fsView' ? reopenView : null),
    querySelector: () => null,
    addEventListener: () => {}
  },
  window: { api: {}, addEventListener: () => {} },
  MutationObserver: MO,
  sessionStorage: {
    getItem: (k) => (reopenStore.has(k) ? reopenStore.get(k) : null),
    setItem: (k, v) => reopenStore.set(k, String(v)),
    removeItem: (k) => reopenStore.delete(k)
  },
  UI: {
    els: { fsView: reopenView },
    isFullscreen: () => reopenView.classList.contains('open'),
    setFullscreen: (s) => { reopenCalls.push(s); reopenView.classList.toggle('open', s !== false); return !!s },
    toggleQueue: () => {}
  },
  setTimeout, clearTimeout
})
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/js/fullscreen.js'), 'utf8'), reopenCtx,
  { filename: 'fullscreen.js#reopen' })
ok('独占开关重载后自动展开全屏页，标记只用一次',
  reopenCalls.length === 1 && reopenCalls[0] === true && !reopenStore.has('lx_fs_reopen'),
  JSON.stringify(reopenCalls))

/* 回归（v3.3.70 成品实测踩到）：boot 挂在 window 的 DOMContentLoaded 上，document 阶段的
   监听先跑，那一刻 UI.els 还是空的。此时不能把恢复标记白吃掉，必须等 els 就绪再展开。 */
const lateStore = new Map([['lx_fs_reopen', '1']])
const lateCalls = []
const lateUI = {
  els: {},
  isFullscreen: () => false,
  setFullscreen: (s) => { lateCalls.push(s); return !!s },
  toggleQueue: () => {}
}
const lateCtx = vm.createContext({
  console,
  document: {
    readyState: 'loading',
    body: new El('body', 'body'),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {}
  },
  window: { api: {}, addEventListener: (t, fn) => { if (t === 'load') setTimeout(fn, 10) } },
  MutationObserver: MO,
  sessionStorage: {
    getItem: (k) => (lateStore.has(k) ? lateStore.get(k) : null),
    setItem: (k, v) => lateStore.set(k, String(v)),
    removeItem: (k) => lateStore.delete(k)
  },
  UI: lateUI,
  setTimeout, clearTimeout
})
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/js/fullscreen.js'), 'utf8'), lateCtx,
  { filename: 'fullscreen.js#late' })
setTimeout(() => { lateUI.els.fsView = { classList: { contains: () => false } } }, 60)
await new Promise((r) => setTimeout(r, 320))
ok('boot 晚于 load 时等 els 就绪再展开（恢复标记不被白吃）',
  lateCalls.length === 1 && lateCalls[0] === true, JSON.stringify(lateCalls))

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
