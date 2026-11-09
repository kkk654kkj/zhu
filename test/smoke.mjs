#!/usr/bin/env node
'use strict'
/**
 * 冒烟测试（v1.6）：连 Chrome DevTools Protocol，在运行中的主窗口里跑一组断言。
 *
 * 用法：
 *   1) 按交接文档 §9.1 起开发版，必须带 --remote-debugging-port=9272
 *   2) node test/smoke.mjs            # 默认端口 9272
 *      CDP_PORT=9222 node test/smoke.mjs
 *
 * 退出码 0 = 全过，1 = 有失败或连不上。比"看截图"可靠得多。
 */

const PORT = Number(process.env.CDP_PORT || 9272)

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 1
    this.pending = new Map()
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (!msg.id || !this.pending.has(msg.id)) return
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'))
      else resolve(msg.result)
    }
  }

  static async attach(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('WebSocket 连接失败：' + url))
    })
    return new CDP(ws)
  }

  call(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expr) {
    const r = await this.call('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error((d.exception && d.exception.description) || d.text || '求值异常')
    }
    return r.result.value
  }

  close() { try { this.ws.close() } catch {} }
}

/**
 * 每条：[名称, 表达式, 结果校验]。
 * 表达式在渲染进程里执行，能直接摸到 app.js 的全局 state / player / UI。
 */
const CASES = [
  ['页面已渲染（表格有行）',
    `document.querySelectorAll('#tableBody .tr').length`,
    (v) => v > 0],

  ['DOM 行数与状态一致',
    `document.querySelectorAll('#tableBody .tr').length === state.visible.length`,
    (v) => v === true],

  ['曲目索引完整（byId === tracks）',
    `state.byId.size === state.tracks.length`,
    (v) => v === true],

  ['拼音检索字段已就位（py/pyf 均为字符串）',
    `state.tracks.length > 0 && state.tracks.every((t) => typeof t.py === 'string' && typeof t.pyf === 'string')`,
    (v) => v === true],

  ['拼音首字母能过滤（zj 至少过滤掉一些歌）',
    `(() => { const all = state.tracks.length
       const hit = state.tracks.filter((t) => (t.pyf || '').replace(/\\s+/g, '').includes('zj')).length
       return { all, hit } })()`,
    (v) => v && v.all > 0 && v.hit > 0 && v.hit < v.all],

  ['队列排序 API 存在',
    `typeof player.moveInQueue === 'function'`,
    (v) => v === true],

  ['队列排序不破坏索引（拖到末尾）',
    `(() => { const n = player.tracks.length
       if (n < 2) return { skip: true }
       // 未播放时 player.current 为 null，用 index 指向的曲目对象引用，
       // 避免 curId===afterId 退化成 null===null 恒真
       const curRef = player.tracks[player.index >= 0 ? player.index : 0]
       const before = player.index
       player.moveInQueue(0, n - 1)
       const ok = player.tracks.indexOf(curRef) >= 0
       player.moveInQueue(n - 1, 0)
       return { ok, before, after: player.index } })()`,
    (v) => v && (v.skip === true || (v.ok === true && v.before === v.after))],

  ['淡出定时器可被取消（连点播放不自停）',
    // 注意：音量被置 0 时 _fadeOut 会直接早退（from <= 0.01），所以先临时抬到 0.5
    `(() => { const keep = player.audio.volume
       player.audio.volume = 0.5
       player._fadeOut(() => {})
       const scheduled = !!player._fadeTimeout
       player._fadeIn()
       const afterPlay = player._fadeTimeout
       player._clearFade()
       player.audio.volume = keep
       return { scheduled, afterPlay } })()`,
    (v) => v && v.scheduled === true && v.afterPlay === null],

  ['拖拽已绑定 / 断点续播已加载',
    `typeof bindDragAndDrop === 'function' && typeof rememberResume === 'function' && typeof restoreResumePos === 'function'`,
    (v) => v === true],

  ['m3u 接口已暴露',
    `typeof window.api.importM3u === 'function' && typeof window.api.exportM3u === 'function'`,
    (v) => v === true],

  ['任务栏状态上报接口已暴露',
    `typeof window.api.setPlayState === 'function'`,
    (v) => v === true],

  ['封面真的加载了（有当前曲目时）',
    `(() => { if (!player.current) return { skip: true }
       const img = document.querySelector('#pbCover img')
       return { skip: false, w: img ? img.naturalWidth : 0 } })()`,
    (v) => v && (v.skip === true || v.w > 0)],

  ['歌词居中（有歌词行时）',
    `(() => { const box = document.querySelector('#lpLyrics')
       if (!box) return { skip: true }
       const a = [...box.querySelectorAll('.lyric-line')].find((n) => n.classList.contains('active'))
       if (!a) return { skip: true }
       const br = box.getBoundingClientRect(), ar = a.getBoundingClientRect()
       return { skip: false, delta: Math.round((ar.top - br.top) - (br.height - ar.height) / 2) } })()`,
    (v) => v && (v.skip === true || Math.abs(v.delta) <= 40)],

  /* ---- v1.7 ---- */
  ['每曲歌词偏移已接入（改一首不影响全局）',
    `(() => {
       if (!state.tracks.length) return { skip: true }
       const id = state.tracks[0].id
       const before = state.settings.lyricOffsetById || {}
       const map = Object.assign({}, before); map['__probe__'] = 0.5
       state.settings.lyricOffsetById = map
       const hit = offsetFor('__probe__') === 0.5
       const fallback = offsetFor('__nope__') === (Number(state.settings.lyricOffset) || 0)
       state.settings.lyricOffsetById = before
       return { hit, fallback } })()`,
    (v) => v && (v.skip === true || (v.hit === true && v.fallback === true))],

  ['最常播放视图按次数降序',
    `(() => {
       const prev = state.view
       switchView('most')
       const counts = state.visible.map((t) => state.playCounts[t.id] || 0)
       const sorted = counts.every((c, i) => i === 0 || counts[i - 1] >= c)
       const head = document.getElementById('vhTitle').textContent
       switchView(prev)
       return { rows: counts.length, sorted, head } })()`,
    (v) => v && v.sorted === true && v.head === '最常播放'],

  ['拖拽多选（选中集合参与批量加入）',
    `(() => {
       if (state.visible.length < 3) return { skip: true }
       clearSelection()
       toggleSelection(state.visible[0].id, 0)
       toggleSelection(state.visible[2].id, 2)
       const n = selectedTracks().length
       clearSelection()
       return { n, after: state.selected.size } })()`,
    (v) => v && (v.skip === true || (v.n === 2 && v.after === 0))],

  ['文件夹视图能分组',
    `(() => {
       if (!state.tracks.length) return { skip: true }
       const prev = state.view
       switchView('folders')
       const cards = document.querySelectorAll('#tableBody .album-card').length
       const head = document.getElementById('vhTitle').textContent
       switchView(prev)
       return { cards, head, dirs: new Set(state.tracks.map((t) => t.dir).filter(Boolean)).size } })()`,
    (v) => v && (v.skip === true || (v.cards > 0 && v.cards === v.dirs && v.head === '文件夹'))]
]


function fmt(v) {
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

async function main() {
  let list
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    list = await res.json()
  } catch (err) {
    console.error(`[smoke] 连不上 CDP（127.0.0.1:${PORT}）：${err.message}`)
    console.error('        先按 §9.1 启动开发版，并带 --remote-debugging-port=' + PORT)
    process.exit(1)
  }

  const target = (list || []).find((t) => t.type === 'page' && /index\.html/.test(t.url))
  if (!target) {
    console.error('[smoke] 没找到主窗口 target（index.html）。当前 targets：')
    for (const t of list || []) console.error('        ' + t.type + '  ' + t.url)
    process.exit(1)
  }

  const cdp = await CDP.attach(target.webSocketDebuggerUrl)
  await cdp.call('Runtime.enable')

  let failed = 0
  console.log('冒烟测试 @ ' + target.url + '\n')
  for (const [name, expr, check] of CASES) {
    let value
    try {
      value = await cdp.eval(expr)
    } catch (err) {
      failed++
      console.log('FAIL  ' + name + '\n      异常：' + err.message)
      continue
    }
    let ok = false
    try { ok = !!check(value) } catch { ok = false }
    if (!ok) failed++
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '   → ' + fmt(value))
  }

  cdp.close()
  console.log('\n' + (failed ? failed + ' 项失败' : '全部通过'))
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('[smoke] 未预期的错误：', err)
  process.exit(1)
})
