'use strict'
/**
 * 统一虚拟滚动内核（v2.8.40 / v3.3.48「九条 UI」轮）
 *
 * 之前三套虚拟化各写一份：列表 tableBody、每日推荐 op-body、在线搜索 op-body，
 * 行高常量、占位块、滚动节流、高度缓存口径全都不一样，改一处必然漏两处。
 * 这里收成一份，列表 / 卡片网格 / 两个远程面板共用。
 *
 * 三条硬约束（对应交接文档不变量）：
 *   1. 行节点复用：滚动帧只增删首尾行，不整块 innerHTML 重建（不变量 #5，否则封面闪）
 *   2. 高度缓存只认滚动容器的 clientHeight，禁止 ResizeObserver 的内容矩形高度
 *      （不变量 #39，隐藏窗口下内容矩形 = 全部内容总高，虚拟窗口会退化成全量渲染）
 *   3. 同一帧只读一次 scrollTop / clientHeight，写占位高度只写不改布局读数
 *
 * 用法：
 *   const vl = createVList({
 *     scroller: 滚动容器（读 scrollTop / clientHeight）,
 *     host:     行容器（放占位块与行）,
 *     count:    number | () => number,
 *     rowH:     number | () => number,
 *     renderRow:(i) => htmlString,
 *     overscan: 6,
 *     offsetTop:() => 行区在滚动容器内容坐标里的起点（表头 sticky 后需要）
 *   })
 *   vl.update(true)        // 重建（切视图/排序/搜索）
 *   vl.update()            // 增量（滚动帧内部自动调用）
 *   vl.scrollToIndex(i)    // 定位到第 i 行（居中）
 */

/** 列表基准行高：必须与 css .tr 的 height 严格一致（不变量 #1，52px） */
const TABLE_ROW_H = 52

/** 可视区上下各多渲染的缓冲行数：滚动时不露白 */
const VLIST_OVERSCAN = 6

/** 网格卡片基准宽度与间距（列数由容器宽度算出来，不写死列数） */
const GRID_CARD_MIN = 168
const GRID_GAP = 18

function createVList(opts) {
  const scroller = opts.scroller
  const host = opts.host
  if (!scroller || !host) throw new Error('createVList: scroller / host 必填')

  const num = (v) => (typeof v === 'function' ? v() : v)
  const overscan = opts.overscan == null ? VLIST_OVERSCAN : opts.overscan
  const rowHOf = () => Math.max(1, num(opts.rowH) || TABLE_ROW_H)
  const countOf = () => Math.max(0, num(opts.count) || 0)
  const offsetTopOf = opts.offsetTop ? () => num(opts.offsetTop) || 0 : () => 0

  let start = -1
  let end = -1
  let viewH = 0
  let y0 = 0
  let bound = false
  let rafId = 0
  let ro = null

  /** 行区原点 + 可视高度：只在 resize / 结构变化时读布局，滚动帧用缓存 */
  function measure() {
    viewH = Math.max(1, scroller.clientHeight || 600)
    const base = offsetTopOf()
    if (base) {
      y0 = base
    } else {
      // host 在 scroller 内容坐标里的起点（含 viewHeader 高度）
      const hostTop = host.getBoundingClientRect().top
      const scrTop = scroller.getBoundingClientRect().top
      // rect 差值已含当前 scrollTop 的影响，换算回内容坐标
      y0 = Math.max(0, hostTop - scrTop + scroller.scrollTop)
    }
  }

  function computeWindow() {
    const n = countOf()
    if (!n) return null
    const rh = rowHOf()
    const st = scroller.scrollTop
    const localTop = st - y0
    const localBot = st + viewH - y0
    let s = Math.floor(localTop / rh) - overscan
    let e = Math.ceil(localBot / rh) + overscan
    if (s < 0) s = 0
    if (e > n) e = n
    if (e < s) e = s
    return { s, e, n, rh }
  }

  function topSpacer() { return host.firstElementChild }
  function botSpacer() { return host.lastElementChild }

  function spacersOk(t, b) {
    return !!(t && b && t.dataset.sp === 'top' && b.dataset.sp === 'bottom')
  }

  function buildRows(s, e) {
    let html = ''
    for (let i = s; i < e; i++) html += opts.renderRow(i)
    return html
  }

  function update(force) {
    const w = computeWindow()
    const n = countOf()
    if (!w) {
      if (force) host.innerHTML = ''
      start = -1
      end = -1
      return
    }
    const { s, e, rh } = w
    const oldS = start
    const oldE = end

    if (force || oldS < 0 || oldE <= oldS) {
      start = s
      end = e
      host.innerHTML =
        `<div data-sp="top" style="height:${s * rh}px"></div>` +
        buildRows(s, e) +
        `<div data-sp="bottom" style="height:${(n - e) * rh}px"></div>`
      if (opts.onWindow) opts.onWindow(s, e)
      return
    }
    if (s === oldS && e === oldE) return

    // 大幅跳跃：新旧窗口不重叠。仍然是「删旧行 + 补新行」，不回退整块重建
    if (s >= oldE || e <= oldS) {
      const t = topSpacer()
      const b = botSpacer()
      if (!spacersOk(t, b)) { start = -1; update(true); return }
      let row = t.nextElementSibling
      while (row && row !== b) {
        const next = row.nextElementSibling
        row.remove()
        row = next
      }
      b.insertAdjacentHTML('beforebegin', buildRows(s, e))
      t.style.height = `${s * rh}px`
      b.style.height = `${(n - e) * rh}px`
      start = s
      end = e
      if (opts.onWindow) opts.onWindow(s, e)
      return
    }

    const t = topSpacer()
    const b = botSpacer()
    if (!spacersOk(t, b)) { start = -1; update(true); return }

    // 先删多余行，再补新行：留在视口里的行连节点都不动（封面不闪）
    const delTop = s - oldS
    for (let i = 0; i < delTop; i++) {
      if (host.children[1]) host.children[1].remove()
    }
    const delBot = oldE - e
    for (let i = 0; i < delBot; i++) {
      const prev = b.previousElementSibling
      if (!prev || prev === t) break
      prev.remove()
    }
    if (s < oldS) t.insertAdjacentHTML('afterend', buildRows(s, oldS))
    if (e > oldE) b.insertAdjacentHTML('beforebegin', buildRows(oldE, e))
    t.style.height = `${s * rh}px`
    b.style.height = `${(n - e) * rh}px`
    start = s
    end = e
    if (opts.onWindow) opts.onWindow(s, e)
  }

  function onScroll() {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      update(false)
    })
  }

  function bind() {
    if (bound) return
    bound = true
    scroller.addEventListener('scroll', onScroll, { passive: true })
    if (typeof ResizeObserver === 'function') {
      // 只观察滚动容器自身尺寸；不读 RO 的内容矩形高度（不变量 #39）
      ro = new ResizeObserver(() => {
        measure()
        if (rafId) return
        rafId = requestAnimationFrame(() => {
          rafId = 0
          update(false)
        })
      })
      ro.observe(scroller)
    }
    measure()
  }

  /** 结构变化（切视图 / 换行高 / 网格列数变了）→ 重测原点并重建 */
  function reset() {
    measure()
    start = -1
    end = -1
    update(true)
  }

  function scrollToIndex(i, center) {
    const n = countOf()
    if (!n) return
    const rh = rowHOf()
    const idx = Math.max(0, Math.min(n - 1, i))
    const want = y0 + idx * rh - (center === false ? 0 : Math.max(0, (viewH - rh) / 2))
    scroller.scrollTop = Math.max(0, want)
    update(false)
  }

  function destroy() {
    scroller.removeEventListener('scroll', onScroll)
    if (ro) { ro.disconnect(); ro = null }
    bound = false
    start = -1
    end = -1
  }

  bind()

  return {
    update,
    reset,
    scrollToIndex,
    destroy,
    measure,
    get start() { return start },
    get end() { return end },
    get viewH() { return viewH }
  }
}

/** 网格列数：按容器宽度算，不写死列数（窗口一拉宽列数自动变） */
function gridCols(width) {
  const w = Math.max(1, width || 0)
  return Math.max(1, Math.floor((w + GRID_GAP) / (GRID_CARD_MIN + GRID_GAP)))
}

/** 网格单行高度：卡片宽度（1:1 封面）+ 标题两行 + 余量。与 css .grid-row 的 --growh 同源 */
function gridRowHeight(width) {
  const cols = gridCols(width)
  const cardW = Math.max(80, (Math.max(1, width) - GRID_GAP * (cols - 1)) / cols)
  return Math.round(cardW + 60)
}
