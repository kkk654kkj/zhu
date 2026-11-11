'use strict'
/**
 * v3.3.24 模块拆分：从 main.js 原样搬出（只做 G. 前缀注入，不改逻辑）。
 * init(G) 注入 main 的共享状态访问器（getter，见 main.js 的 G 定义）。
 */
const { BrowserWindow, screen } = require('electron')

let G = null
function init(g) { G = g }

/* ---------------- 桌面歌词浮窗 ---------------- */

let dlyricWin = null

/**
 * 最近一次推给歌词窗口的内容。
 * 歌词窗口是异步加载的，刚打开时那次推送必然早于页面就绪（webContents.send 会静默丢弃），
 * 渲染层又按内容去重、不会重发 → 表现为「打开后不显示歌词，暂停一下才出来」。
 * 所以主进程必须缓存一份，在页面就绪时补发。
 */
let lastDlyricData = null

function dlyricCfg() {
  return G.store.get().settings.desktopLyric || {}
}

function sendToDlyric(channel, payload) {
  if (dlyricWin && !dlyricWin.isDestroyed()) {
    dlyricWin.webContents.send(channel, payload)
  }
}

/** 歌词窗口就绪/重载后补发：配置 + 当前歌词行 */
function replayDlyricState() {
  sendToDlyric('dlyric:cfg', dlyricCfg())
  if (lastDlyricData) sendToDlyric('dlyric:data', lastDlyricData)
}

/** 锁定 = 鼠标穿透；同时把最新配置推给歌词窗口 */
function applyDlyricLock() {
  const cfg = dlyricCfg()
  if (dlyricWin && !dlyricWin.isDestroyed()) {
    dlyricWin.setIgnoreMouseEvents(!!cfg.locked)
    sendToDlyric('dlyric:cfg', cfg)
  }
}

/** 把 开/关 + 锁定 状态同步给主窗口（按钮图标/提示、点击语义都依赖它） */
function notifyDlyricState() {
  const cfg = dlyricCfg()
  G.sendToRenderer('dlyric:open-state', {
    open: !!(dlyricWin && !dlyricWin.isDestroyed()),
    locked: !!cfg.locked
  })
}

function createLyricWindow() {
  if (dlyricWin && !dlyricWin.isDestroyed()) return dlyricWin
  const cfg = dlyricCfg()
  const b = cfg.bounds || {}
  dlyricWin = new BrowserWindow({
    width: b.width || 900,
    height: b.height || 120,
    x: Number.isFinite(b.x) ? b.x : undefined,
    y: Number.isFinite(b.y) ? b.y : undefined,
    minWidth: 300,
    minHeight: 70,
    transparent: true,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: '桌面歌词',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  // screen-saver 层级：压在普通置顶窗口之上
  dlyricWin.setAlwaysOnTop(true, 'screen-saver')
  dlyricWin.loadFile(path.join(__dirname, '..', 'renderer', 'dlyric.html'))

  dlyricWin.once('ready-to-show', () => {
    dlyricWin.show()
    applyDlyricLock()
  })

  // 页面加载完就补发一次（dlyric:ready 的兜底，重载/刷新时同样能立刻出词）
  dlyricWin.webContents.on('did-finish-load', () => replayDlyricState())

  // 位置/尺寸持久化（去抖）
  let lastLyricBounds = null
  const saveBounds = G.debounce(() => {
    if (!dlyricWin || dlyricWin.isDestroyed()) return
    lastLyricBounds = dlyricWin.getNormalBounds ? dlyricWin.getNormalBounds() : dlyricWin.getBounds()
    G.store.patch({ settings: { desktopLyric: { bounds: lastLyricBounds } } })
  }, 400)
  dlyricWin.on('resize', saveBounds)
  dlyricWin.on('move', saveBounds)
  // 关闭前窗口还在，记下最后一次位置（去抖那次可能来不及触发）
  dlyricWin.on('close', () => {
    if (dlyricWin && !dlyricWin.isDestroyed()) {
      try { lastLyricBounds = dlyricWin.getNormalBounds ? dlyricWin.getNormalBounds() : dlyricWin.getBounds() } catch (e) { /* 忽略 */ }
    }
  })

  // 歌词窗口自行关闭（控制条 ✕ 或系统方式）→ 通知主窗口同步按钮状态。
  // 注意退出App时也会触发 closed，用 quitting 区分，避免把 enabled 改没。
  dlyricWin.on('closed', () => {
    // v3.3.13：去抖的那次落盘可能被进程退出吞掉，这里用最后一次位置同步兜一次
    if (lastLyricBounds) {
      try { G.store.patch({ settings: { desktopLyric: { bounds: lastLyricBounds } } }) } catch (e) { /* 忽略 */ }
    }
    dlyricWin = null
    if (!G.quitting) {
      G.store.patch({ settings: { desktopLyric: { enabled: false } } })
      notifyDlyricState()
    }
  })

  return dlyricWin
}

function closeLyricWindow() {
  if (dlyricWin && !dlyricWin.isDestroyed()) dlyricWin.close()
  else if (dlyricWin) dlyricWin = null
}

module.exports = {
  init,
  dlyricWin,
  lastDlyricData,
  dlyricCfg,
  sendToDlyric,
  replayDlyricState,
  applyDlyricLock,
  notifyDlyricState,
  createLyricWindow,
  closeLyricWindow,
}
