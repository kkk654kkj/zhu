'use strict'
/* 桌面歌词浮窗逻辑：接收主进程转发来的歌词行，展示 + 控制条 */

const COLORS = ['#ffffff', '#31c27c', '#ffd54a', '#64b5f6', '#ff9e80', '#f48fb1']

const els = {
  wrap: document.getElementById('wrap'),
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
  els.next.style.color = cfg.color || COLORS[0]
}

window.api.onDlyricData((d) => {
  if (!d) return
  if (d.line) els.line.textContent = d.line
  else if (d.title) els.line.textContent = d.title + (d.artist ? ' — ' + d.artist : '')
  else els.line.textContent = '♪'
  document.body.classList.toggle('paused', d.playing === false)
  document.body.classList.toggle('nolyric', !d.next)
  els.next.textContent = d.next || ''
})

window.api.onDlyricCfg((c) => {
  if (c) cfg = { ...cfg, ...c }
  applyCfg()
})

els.btnLock.addEventListener('click', () => {
  window.api.dlyricCfg({ locked: true })
})
els.btnClose.addEventListener('click', () => {
  window.api.dlyricClose()
})
els.btnSmaller.addEventListener('click', () => {
  cfg.fontSize = Math.max(16, cfg.fontSize - 4)
  applyCfg()
  window.api.dlyricCfg({ fontSize: cfg.fontSize })
})
els.btnBigger.addEventListener('click', () => {
  cfg.fontSize = Math.min(80, cfg.fontSize + 4)
  applyCfg()
  window.api.dlyricCfg({ fontSize: cfg.fontSize })
})
els.btnColor.addEventListener('click', () => {
  cfg.colorIdx = (cfg.colorIdx + 1) % COLORS.length
  cfg.color = COLORS[cfg.colorIdx]
  applyCfg()
  window.api.dlyricCfg({ color: cfg.color, colorIdx: cfg.colorIdx })
})

// 通知主进程：窗口已就绪（主进程会立刻回推一次配置）
window.api.dlyricReady()
