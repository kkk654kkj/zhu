'use strict'
/**
 * 播放队列编辑工具（queue-tools.js）运行时单测 · 联网版 v3.3.44
 *
 * 不启动 Electron：假 DOM + 假播放器 + 假 IPC，把 queue-tools.js 原样放进 vm 里跑。
 * 覆盖：挂载 → 重建队列补 × → 点 × 移除（不能顺带播放）→ 清空 → 空会话落盘。
 * 用法：node test/queue-check.mjs
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
const observers = []
class MO {
  constructor(cb) { this.cb = cb; observers.push(this) }
  observe(target) { this.target = target }
}
class El {
  constructor(tag = 'div', cls = '') {
    this.tagName = tag.toUpperCase()
    this.nodeType = 1
    this._classes = new Set()
    Object.defineProperty(this, 'className', {
      get: () => [...this._classes].join(' '),
      set: (v) => { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)) }
    })
    this.className = cls
    this.dataset = {}
    this.children = []
    this.parentElement = null
    this.id = ''
    this.textContent = ''
    this.title = ''
    this.disabled = false
    this.attrs = {}
    this._ls = {}
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
      toggle: (c, f) => { const on = f == null ? !this._classes.has(c) : !!f; on ? this._classes.add(c) : this._classes.delete(c) }
    }
  }
  matches(sel) {
    const s = sel.trim()
    const m = s.match(/^\.([\w-]+)(?:\[([\w-]+)\])?$/)
    if (m) {
      if (!this._classes.has(m[1])) return false
      if (m[2] === 'data-qi') return this.dataset.qi != null
      if (m[2] === 'data-qr') return this.dataset.qr != null
      return !m[2]
    }
    if (s.startsWith('#')) return this.id === s.slice(1)
    return false
  }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c }
  setAttribute(k, v) { this.attrs[k] = v }
  addEventListener(type, fn, capture) { (this._ls[type] ||= []).push({ fn, capture }) }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
  querySelectorAll(sel) {
    const out = []
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c) } }
    walk(this)
    return out
  }
  closest(sel) {
    let n = this
    while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentElement }
    return null
  }
  /** 模拟 UI.renderQueue 的整块重建：只解析 .qp-item[data-qi] */
  set innerHTML(html) {
    this.children = []
    const added = []
    const re = /<div class="qp-item([^"]*)" data-qi="(\d+)"/g
    let m
    while ((m = re.exec(html))) {
      const item = new El('div', 'qp-item' + (m[1] || ''))
      item.dataset.qi = m[2]
      this.appendChild(item)
      added.push(item)
    }
    if (!added.length) { const ph = new El('div', 'qp-item'); this.appendChild(ph); added.push(ph) }
    observers.filter((o) => o.target === this).forEach((o) => o.cb([{ addedNodes: added }]))
  }
  get innerHTML() { return '' }
  fire(type, ev) {
    const ls = this._ls[type] || []
    // 捕获期先跑；捕获期里 stopPropagation 会连目标与冒泡期一起截断。
    // 冒泡期同元素上的其它监听器不受 stopPropagation 影响（这正是必须用捕获期的原因）。
    for (const l of ls.filter((x) => x.capture)) { l.fn(ev); if (ev.__stopped) return }
    for (const l of ls.filter((x) => !x.capture)) l.fn(ev)
  }
}

const head = new El('div', 'qp-head')
const closeBtn = new El('button', 'mini-btn')
closeBtn.id = 'btnQueueClose'
head.appendChild(closeBtn)
const body = new El('div', 'qp-body')
body.id = 'queueBody'
const roots = [head, body]
const findById = (id) => {
  const walk = (n) => {
    if (n.id === id) return n
    for (const c of n.children) { const r = walk(c); if (r) return r }
    return null
  }
  for (const r of roots) { const x = walk(r); if (x) return x }
  return null
}
const document = {
  readyState: 'complete',
  getElementById: findById,
  querySelector: (sel) => (sel === '#queuePanel .qp-head' ? head : null),
  querySelectorAll: (sel) => (sel === '#tableBody .tr.playing' ? [] : []),
  createElement: (tag) => new El(tag),
  addEventListener: () => {}
}

/* ---------------- 假运行时 ---------------- */
const calls = []
const sessions = []
const player = {
  tracks: [], index: -1, mode: 'list',
  removeFromQueue(i) {
    const wasCurrent = i === this.index
    this.tracks.splice(i, 1)
    if (i < this.index) this.index--
    else if (wasCurrent) this.index = Math.min(this.index, this.tracks.length - 1)
    calls.push(['removeFromQueue', i])
    // 模拟 queue-change → UI.renderQueue 重建
    body.innerHTML = player.tracks.map((_, k) => `<div class="qp-item" data-qi="${k}"></div>`).join('')
  },
  clearQueue() {
    calls.push(['clearQueue'])
    this.tracks = []
    this.index = -1
    body.innerHTML = '<div class="qp-item" style="cursor:default">队列为空</div>'
  }
}
const state = { currentId: 'old' }
const UI = {
  _tCurrentId: 'old',
  renderNowPlaying: (t, p) => calls.push(['renderNowPlaying', t, p]),
  renderLyric: (a, b) => calls.push(['renderLyric', a, b]),
  setProgress: (a, b) => calls.push(['setProgress', a, b])
}
const Online = { markPlaying: (id) => calls.push(['markPlaying', id]) }
const saveSession = () => calls.push(['saveSession'])
const toast = (m) => calls.push(['toast', m])
const syncMediaSessionState = (p) => calls.push(['syncMediaSessionState', p])
const pushDesktopLyric = (f) => calls.push(['pushDesktopLyric', f])

const ctx = vm.createContext({
  console, document, MutationObserver: MO,
  window: { api: { setSession: (s) => { sessions.push(s); return Promise.resolve() } } },
  navigator: { mediaSession: { metadata: { stale: true } } },
  player, state, UI, Online, saveSession, toast, syncMediaSessionState, pushDesktopLyric
})
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/js/queue-tools.js'), 'utf8'), ctx, { filename: 'queue-tools.js' })
const QT = vm.runInContext('QT', ctx)

/* ---------------- 1) 挂载 ---------------- */
const clearBtn = findById('btnQueueClear')
const countEl = findById('queueCount')
ok('运行时挂载：清空按钮 / 计数 / 原关闭按钮都在同一行',
  !!clearBtn && !!countEl && head.querySelector('.qp-tools') != null && closeBtn.parentElement === head.querySelector('.qp-tools'))
ok('空队列时清空按钮禁用、计数显示「空」', clearBtn.disabled === true && countEl.textContent === '空')

/* ---------------- 2) 队列重建后补 × ---------------- */
player.tracks = [
  { id: 'a', title: '晴天' }, { id: 'b', title: '发如雪' },
  { id: 'c', title: '青花瓷' }, { id: 'd', title: '枫' }
]
player.index = 1
body.innerHTML = player.tracks.map((_, k) => `<div class="qp-item" data-qi="${k}"></div>`).join('')
const items = body.querySelectorAll('.qp-item[data-qi]')
ok('4 行队列每行都有独立的移除钮，且下标与 data-qi 一致',
  items.length === 4 && items.every((it, i) => {
    const x = it.querySelector('.qi-x')
    return x && x.dataset.qr === String(i)
  }))
ok('计数与按钮态跟着队列更新', countEl.textContent === '4 首' && clearBtn.disabled === false)
ok('补钮幂等：同一批节点再喂一次 observer 不会重复插入',
  (() => {
    observers.filter((o) => o.target === body).forEach((o) => o.cb([{ addedNodes: items }]))
    return items.every((it) => it.querySelectorAll('.qi-x').length === 1)
  })())

/* ---------------- 3) 点 × 单独移除 ---------------- */
const x2 = items[2].querySelector('.qi-x')
const ev = {
  target: { closest: (sel) => (sel === '.qi-x' ? x2 : null) },
  preventDefault() { this.__prevented = true },
  stopPropagation() { this.__stopped = true }
}
// 同时挂一个「冒泡期点行即播放」监听器，验证 × 被截断
let played = false
body.addEventListener('click', () => { played = true })
body.fire('click', ev)
ok('点第 3 行的 × 只删这一首（b 仍是当前曲，index 未串位）',
  player.tracks.length === 3 && player.tracks.map((t) => t.id).join(',') === 'a,b,d' && player.index === 1)
ok('捕获期 stopPropagation 截断 app.js 的「点行即播放」', ev.__stopped === true && played === false)
ok('删完写回非空会话（saveSession）', calls.some((c) => c[0] === 'saveSession') && sessions.length === 0)
ok('重建后剩余 3 行仍各自带 ×',
  body.querySelectorAll('.qp-item[data-qi]').length === 3 &&
  body.querySelectorAll('.qp-item[data-qi]').every((it) => !!it.querySelector('.qi-x')))

/* ---------------- 4) 删到空 ---------------- */
calls.length = 0
for (let k = 2; k >= 0; k--) {
  const it = body.querySelectorAll('.qp-item[data-qi]')[k]
  const e = { target: { closest: (s) => (s === '.qi-x' ? it.querySelector('.qi-x') : null) }, preventDefault() {}, stopPropagation() {} }
  body.fire('click', e)
}
ok('逐首删到空：队列清空、清空按钮禁用、计数归零',
  player.tracks.length === 0 && clearBtn.disabled === true && countEl.textContent === '空')
ok('删到空写的是空会话（重启不会复活旧队列）',
  sessions.length > 0 && Array.isArray(sessions[sessions.length - 1].queueIds) &&
  sessions[sessions.length - 1].queueIds.length === 0)
ok('删到空把播放条 / 歌词 / 行高亮 / 媒体会话一起归零',
  state.currentId === null && UI._tCurrentId === null &&
  calls.some((c) => c[0] === 'renderNowPlaying' && c[1] === null) &&
  calls.some((c) => c[0] === 'renderLyric' && c[1] === null) &&
  calls.some((c) => c[0] === 'syncMediaSessionState' && c[1] === false))

/* ---------------- 5) 清空整队 ---------------- */
calls.length = 0; sessions.length = 0
player.tracks = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
player.index = 1
body.innerHTML = player.tracks.map((_, k) => `<div class="qp-item" data-qi="${k}"></div>`).join('')
clearBtn.fire('click', { preventDefault() {}, stopPropagation() {} })
ok('清空按钮走 player.clearQueue()', calls.some((c) => c[0] === 'clearQueue') && player.tracks.length === 0)
ok('清空同样覆盖成空会话', sessions.length === 1 && sessions[0].queueIds.length === 0 && sessions[0].index === -1)
ok('清空有可见反馈且不误触播放', calls.some((c) => c[0] === 'toast' && /已清空播放队列（3 首）/.test(c[1])))
ok('清空后 UI 归零', state.currentId === null && UI._tCurrentId === null &&
  calls.some((c) => c[0] === 'setProgress' && c[1] === 0))

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
