'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= A-B 循环（v2.1） ================= */

const AB_MIN_GAP = 1      // A/B 至少差 1 秒，否则就是原地打转
state.ab = { a: null, b: null }

/** 独占模式把循环交给 mpv（精确到采样）；普通输出由 enforceAbLoop 每帧比较后回跳 */
function applyAbLoop() {
  if (typeof audio.setAbLoop === 'function') audio.setAbLoop(state.ab.a, state.ab.b)
}

let _abSig = ''

function updateAbUi() {
  const btn = UI.els.btnAb
  if (!btn) return
  const { a, b } = state.ab
  const durNow = (audio && audio.duration) || 0
  // v3.3.17：time 事件 5~10Hz，每次都重算 title 字符串、toggle class、写两个 marker 的
  // style.left（触发样式重算）—— A-B 是长期开着的功能，这是纯浪费。
  // 只有 a / b / 时长变了才真正刷 DOM。
  const sig = a + '|' + b + '|' + Math.round(durNow)
  if (sig === _abSig) return
  _abSig = sig
  btn.classList.toggle('arm', a != null && b == null)
  btn.classList.toggle('on', a != null && b != null)
  btn.textContent = a != null && b == null ? 'A-' : 'A-B'
  btn.title = a == null ? 'A-B 循环：点一下设起点，再点一下设终点'
    : b == null ? 'A 点已设 ' + fmtTime(a) + '，播放到终点位置再点一下'
      : 'A-B 循环中 ' + fmtTime(a) + ' → ' + fmtTime(b) + '，再点一下取消'
  const dur = durNow
  const put = (el, t) => {
    if (!el) return
    if (t == null || !(dur > 0)) { el.hidden = true; return }
    el.hidden = false
    el.style.left = Math.max(0, Math.min(100, (t / dur) * 100)) + '%'
  }
  put(UI.els.abMarkA, a)
  put(UI.els.abMarkB, b)
}

function syncAb() {
  applyAbLoop()
  updateAbUi()
}

function resetAb(silent = true) {
  _abSig = ''   // 强制下次重绘
  if (state.ab.a == null && state.ab.b == null) return
  state.ab = { a: null, b: null }
  syncAb()
  if (!silent) toast('已取消 A-B 循环')
}

function onAbClick() {
  if (!player || !player.current) { toast('先播放一首歌再设 A-B'); return }
  const t = Math.max(0, audio.currentTime || 0)
  const { a, b } = state.ab
  if (a == null) {
    state.ab = { a: t, b: null }
    toast('A 点：' + fmtTime(t) + '（播放到终点再点一下）', 2200)
  } else if (b == null) {
    if (t - a < AB_MIN_GAP) { toast('B 点至少要在 A 点之后 1 秒'); return }
    state.ab = { a, b: t }
    toast('A-B 循环：' + fmtTime(a) + ' → ' + fmtTime(t), 2200)
  } else {
    resetAb(false)
    return
  }
  syncAb()
}

/** 普通输出下的循环判定；独占模式 mpv 自己循环，这里直接跳过 */
function enforceAbLoop(cur) {
  const { a, b } = state.ab
  if (a == null || b == null) return
  if (typeof audio.setAbLoop === 'function') return
  if (cur >= b - 0.06) player.seek(a)
}

