'use strict'
/* 桌面歌词浮窗逻辑：接收主进程转发来的歌词行，展示 + 控制条 */

const COLORS = ['#ffffff', '#31c27c', '#ffd54a', '#64b5f6', '#ff9e80', '#f48fb1']

const els = {
  wrap: document.getElementById('wrap'),
  prev: document.getElementById('prev'),
  line: document.getElementById('line'),
  next: document.getElementById('next'),
  btnLock: document.getElementById('btnLock'),
  btnSmaller: document.getElementById('btnSmaller'),
  btnBigger: document.getElementById('btnBigger'),
  btnColor: document.getElementById('btnColor'),
  btnClose: document.getElementById('btnClose')
}

let cfg = { locked: false, fontSize: 34, color: COLORS[0], colorIdx: 0 }

function applyCfg() {
  els.wrap.classList.toggle('locked', !!cfg.locked)
  els.line.style.fontSize = Math.max(16, Math.min(80, cfg.fontSize || 34)) + 'px'
  els.line.style.color = cfg.color || COLORS[0]
  els.prev.style.color = cfg.color || COLORS[0]
  els.next.style.color = cfg.color || COLORS[0]
}

window.api.onDlyricData((d) => {
  if (!d) return
  if (d.line) els.line.textContent = d.line
  else if (d.title) els.line.textContent = d.title + (d.artist ? ' — ' + d.artist : '')
  else els.line.textContent = '♪'
  document.body.classList.toggle('paused', d.playing === false)
  // 没有上/下一句时用 visibility 隐藏（占位仍在，三行不会上下跳）
  document.body.classList.toggle('noprev', !d.prev)
  document.body.classList.toggle('nolyric', !d.next)
  els.prev.textContent = d.prev || ''
  els.next.textContent = d.next || ''
})

window.api.onDlyricCfg((c) => {
  if (c) cfg = { ...cfg, ...c }
  applyCfg()
})

els.btnLock.addEventListener('click', () => {
  // 第四轮 §4.6：这些都是 async IPC，不补 catch 就是 unhandledRejection
  window.api.dlyricCfg({ locked: true }).catch(() => {})
})
els.btnClose.addEventListener('click', () => {
  window.api.dlyricClose().catch(() => {})
})
els.btnSmaller.addEventListener('click', () => {
  cfg.fontSize = Math.max(16, cfg.fontSize - 4)
  applyCfg()
  window.api.dlyricCfg({ fontSize: cfg.fontSize }).catch(() => {})
})
els.btnBigger.addEventListener('click', () => {
  cfg.fontSize = Math.min(80, cfg.fontSize + 4)
  applyCfg()
  window.api.dlyricCfg({ fontSize: cfg.fontSize }).catch(() => {})
})
els.btnColor.addEventListener('click', () => {
  cfg.colorIdx = (cfg.colorIdx + 1) % COLORS.length
  cfg.color = COLORS[cfg.colorIdx]
  applyCfg()
  window.api.dlyricCfg({ color: cfg.color, colorIdx: cfg.colorIdx }).catch(() => {})
})

// 通知主进程：窗口已就绪（主进程会立刻回推一次配置）
window.api.dlyricReady().catch(() => {})
