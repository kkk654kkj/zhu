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
  'fsMode', 'btnMode', 'fsFav', 'btnFav', 'fsBar', 'titlebar'
]
ids.forEach((id) => make(id, /^(btn|fs|pb)/.test(id) ? 'button' : 'div'))
els.get('fsView').tagName = 'DIV'
els.get('queuePanel').hidden = true
// 控件挂在 #fsView 下，closest 才能沿父链找到 BLOCK 命中
const fsView = els.get('fsView')
for (const id of ['fsPlay', 'fsPrev', 'fsNext', 'fsMode', 'fsFav', 'fsFav', 'fsQueue', 'fsClose', 'fsBar']) {
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
    els.get('queuePanel').hidden = !els.get('queuePanel').hidden
    observers.filter((o) => o.target === els.get('queuePanel')).forEach((o) => o.cb([]))
  }
}
const fireWin = (type, ev) => {
  for (const l of (winLs[type] || []).filter((x) => x.capture)) { l.fn(ev); if (ev.__stopped) return }
  for (const l of (winLs[type] || []).filter((x) => !x.capture)) l.fn(ev)
}

const ctx = vm.createContext({
  console, document, window, MutationObserver: MO, UI,
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
for (const l of (document._ls.keydown || [])) l.fn({ key: 'Escape', preventDefault() {} })
ok('Esc 在全屏页打开时 → UI.setFullscreen(false)',
  calls.setFs.length === 1 && calls.setFs[0] === false, JSON.stringify(calls.setFs))

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
