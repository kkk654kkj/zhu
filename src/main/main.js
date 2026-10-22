'use strict'
/**
 * 主进程：窗口、自定义文件协议、音乐库、持久化、全局快捷键。
 */
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, globalShortcut, Tray, Menu, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { execFile, execFileSync } = require('child_process')
const { pathToFileURL } = require('url')
const { Readable } = require('stream')

const { Store } = require('./store')
const { Library, fileId, MIME_BY_EXT, resolveCoverPath } = require('./library')
const { MpvEngine } = require('./mpv')

const isDev = process.argv.includes('--dev')
const DEFAULT_MUSIC_DIR = 'D:\\音乐'
// 应用显示名（窗口标题 / 托盘提示 / 任务栏分组）
const APP_NAME = '猪专属播放器'
app.setName(APP_NAME)

// 数据目录（便携式）：放在应用目录下的 data\
// 不用系统默认 userData —— 部分 Windows 环境下 Chromium 在 %APPDATA% 里建不了
// 锁文件与缓存目录（Error code: 5），表现为双击后进程静默退出、没有窗口。
const DATA_DIR = process.env.LX_DATA
  ? path.resolve(process.env.LX_DATA)
  : app.isPackaged
    // 打包后 __dirname 在 app.asar 内（只读），必须落在 exe 同级目录
    ? path.join(path.dirname(process.execPath), 'data')
    : path.join(__dirname, '..', '..', 'data')
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
app.setPath('userData', DATA_DIR)
app.setPath('sessionData', DATA_DIR)

// 启动日志：无控制台时也能定位崩溃点
const LOG_FILE = process.env.LX_LOG || path.join(DATA_DIR, 'lx-player.log')
function logLine(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  try { fs.appendFileSync(LOG_FILE, line + '\n') } catch {}
  try { console.log(line) } catch {}
}
process.on('uncaughtException', (err) => {
  logLine('UNCAUGHT', err.stack || String(err))
})
process.on('unhandledRejection', (err) => {
  logLine('UNHANDLED_REJECTION', (err && err.stack) || String(err))
})

/**
 * 清掉 Chromium 在 data\ 下攒的纯缓存目录。
 *
 * 便携程序把 userData 指到了 data\，于是 Cache / Code Cache / GPUCache 全堆在
 * 用户眼皮底下，几个月能涨到几百 MB，而它们对播放没有任何用处。
 * 只删白名单里的纯缓存目录，绝不碰 settings.json / library.json / covers\ / Local Storage。
 */
const CACHE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache',
  'DawnWebGPUCache', 'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache',
  'Shared Dictionary', 'component_crx_cache'
]
function cleanChromiumCache() {
  let removed = 0
  for (const name of CACHE_DIRS) {
    const dir = path.join(DATA_DIR, name)
    try {
      if (!fs.existsSync(dir)) continue
      fs.rmSync(dir, { recursive: true, force: true })
      removed++
    } catch (err) {
      // 文件被占用（例如上一实例还在跑）就跳过，不影响启动
    }
  }
  if (removed) logLine('stage: cache-cleaned=' + removed + ' dirs')
}

/**
 * 结束上次被强杀留下的 mpv 进程。
 *
 * 主进程被任务管理器 / taskkill /F 干掉时，before-quit 不会执行，
 * 残留的 mpv 会一直霸占 WASAPI 独占 → 用户看到的是「播放器明明没开，
 * 别的程序全都没声音」。只杀命令行带我们命名管道前缀（lxmpv-）的 mpv，不误伤用户自己的。
 */
function killOrphanMpv() {
  if (process.platform !== 'win32') return
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'mpv.exe\'" | ' +
    'Where-Object { $_.CommandLine -like \'*lxmpv-*\' } | ' +
    'Select-Object -ExpandProperty ProcessId'
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 8000 },
    (err, stdout) => {
      if (err || !stdout) return
      const pids = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
      for (const pid of pids) {
        try {
          execFileSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true, timeout: 5000 })
          logLine('stage: killed-orphan-mpv=' + pid)
        } catch {}
      }
    })
}
logLine('=== boot ===', process.argv.join(' '), 'electron', process.versions.electron)
logLine('stage: require-ok app=' + typeof app + ' protocol=' + typeof protocol)

try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'lxfile',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
    }
  ])
  logLine('stage: schemes-ok')
} catch (err) {
  logLine('FATAL registerSchemesAsPrivileged', err.stack || String(err))
  throw err
}

let win = null
let tray = null
let store = null
let library = null
let userData = null
let quitting = false
/** 正在进行的扫描 Promise；lib:list 要等它结束，避免渲染进程读到半成品曲库 */
let activeScan = null

const AUDIO_MIME = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.ape': 'audio/x-ape',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff',
  '.mka': 'audio/x-matroska'
}

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase()
  return AUDIO_MIME[ext] || MIME_BY_EXT[ext] || 'application/octet-stream'
}

/* ---------------- 自定义协议：支持 Range 的本地文件读取 ---------------- */

function registerFileProtocol() {
  protocol.handle('lxfile', async (request) => {
    try {
      const url = new URL(request.url)
      // lxfile://local/D:/music/a.flac  →  D:/music/a.flac
      let raw = decodeURIComponent(url.pathname)
      // 兜底：兼容旧式 lxfile:///D:/…（此时盘符会被当 host，需要拼回来）
      if (!/^\/?[A-Za-z]:\//.test(raw) && /^[A-Za-z]$/.test(url.hostname)) {
        raw = '/' + url.hostname + ':' + raw
      }
      let filePath = raw
      if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
      if (process.platform !== 'win32' && !filePath.startsWith('/')) filePath = '/' + filePath
      filePath = path.normalize(filePath)

      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) return new Response('not a file', { status: 404 })

      const type = mimeFor(filePath)
      const range = request.headers.get('range')
      const total = stat.size

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = m && m[1] ? parseInt(m[1], 10) : 0
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1
        if (Number.isNaN(start)) start = 0
        if (Number.isNaN(end) || end >= total) end = total - 1
        if (start > end) return new Response('bad range', { status: 416 })
        const stream = fs.createReadStream(filePath, { start, end })
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        })
      }

      const stream = fs.createReadStream(filePath)
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      })
    } catch (err) {
      return new Response('not found: ' + err.message, { status: 404 })
    }
  })
}

function toLxUrl(filePath) {
  if (!filePath) return null
  const norm = path.resolve(filePath).replace(/\\/g, '/')
  // 固定用 local 当 host，完整路径（含盘符）放在 path 里：
  // 若把盘符塞进 authority（lxfile:///D:/…），Chromium 会把它规范成 host，盘符就丢了。
  const body = norm.split('/').map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/')
  return 'lxfile://local/' + body.replace(/^\/+/, '')
}

/* ---------------- 默认配置 ---------------- */

const DEFAULT_SETTINGS = {
  musicDirs: [DEFAULT_MUSIC_DIR],
  volume: 0.8,
  muted: false,
  playMode: 'list', // list | single | shuffle | order
  fadeMs: 350,
  lyricFontSize: 20,
  lyricOffset: 0,
  theme: 'dark',
  accent: '#31c27c',
  showLyricPanel: true,
  autoScanOnStart: false,
  closeToTray: false,
  // 音量均衡
  normalizeVolume: false,
  targetLufs: -16,
  trackGains: {},   // { trackId: dB } 响度分析自动计算
  manualGains: {},  // { trackId: dB } 用户手动指定（优先于自动）
  // 桌面歌词
  desktopLyric: { enabled: false, locked: false, fontSize: 34, color: '#ffffff', colorIdx: 0, bounds: null },
  // 均衡器（10 段：31/62/125/250/500/1k/2k/4k/8k/16k）
  eq: { enabled: false, preset: 'flat', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  // 迷你模式：enabled=当前是否迷你；bounds=迷你窗口尺寸位置；fullBounds=进迷你前的完整窗口
  mini: { enabled: false, bounds: null, fullBounds: null },
  // 独占输出（v1.5）：真实 bit-perfect 走 mpv + WASAPI 独占；关闭时用原本的 HTML5/WebAudio 链路
  exclusiveOutput: false,      // 独占输出（v1.5）：true 时用 mpv + WASAPI exclusive
  audioDevice: '',             // 独占输出设备（v1.6）：mpv 的 --audio-device，'' = 系统默认
  resumePos: {}                // 长音轨断点位置（v1.6）：{ trackId: 秒 }
}

// 迷你卡片默认尺寸 / 尺寸下限
const MINI_DEFAULT_W = 320
const MINI_DEFAULT_H = 420
const MINI_MIN_W = 300
const MINI_MIN_H = 360
const FULL_MIN_W = 1000
const FULL_MIN_H = 640

/* ---------------- 窗口 ---------------- */

/** 当前是否处于迷你模式（唯一真理，渲染层靠事件同步） */
let miniActive = false

function miniCfg() {
  const s = store && store.get().settings
  return (s && s.mini) || {}
}

/** 把尺寸/位置夹到屏幕工作区内，避免换分辨率后窗口跑到看不见的地方 */
function clampToWorkArea(b) {
  const width = Math.max(200, Math.round(b.width || MINI_DEFAULT_W))
  const height = Math.max(200, Math.round(b.height || MINI_DEFAULT_H))
  let area = null
  try {
    const x = Number.isFinite(b.x) ? b.x : 0
    const y = Number.isFinite(b.y) ? b.y : 0
    area = screen.getDisplayMatching({ x, y, width, height }).workArea
  } catch { /* screen 不可用时直接返回原值 */ }
  if (!area) return { ...b, width, height }
  const w = Math.min(width, area.width)
  const h = Math.min(height, area.height)
  const x = Math.min(Math.max(Number.isFinite(b.x) ? b.x : area.x + area.width - w - 24, area.x), area.x + area.width - w)
  const y = Math.min(Math.max(Number.isFinite(b.y) ? b.y : area.y + 80, area.y), area.y + area.height - h)
  return { x, y, width: w, height: h }
}

/** 等一次窗口事件（带超时兜底），用于 unmaximize 这类异步状态切换 */
function waitWindowEvent(win, ev, timeout = 500) {
  return new Promise((resolve) => {
    let done = false
    const fin = () => {
      if (done) return
      done = true
      try { win.removeListener(ev, fin) } catch {}
      resolve()
    }
    win.once(ev, fin)
    setTimeout(fin, timeout)
  })
}

/**
 * 切换迷你模式：同一个窗口缩放，不做第二个窗口（播放状态天然连续）。
 * 进迷你前把完整窗口的尺寸位置存进 settings.mini.fullBounds，退出时原样还原。
 */
async function applyMini(on) {
  if (!win || win.isDestroyed()) return miniActive
  on = !!on
  if (on === miniActive) return miniActive
  const cfg = miniCfg()

  if (on) {
    // 记下"进迷你前是不是最大化"，回来时要还原成同样的形态
    const wasMax = win.isMaximized()
    if (wasMax) {
      win.unmaximize()
      // Windows 上 unmaximize 是异步的，不等它落地就 setBounds 会被忽略（实测尺寸纹丝不动）
      await waitWindowEvent(win, 'unmaximize')
    }
    const prev = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    // 只有"像完整窗口"的尺寸才写进 fullBounds：万一 prev 本身是卡片尺寸
    // （例如启动时就在迷你态、或外部调用顺序异常），存进去会让退出迷你时还原成小窗
    const prevUsable = Number.isFinite(prev.width) && Number.isFinite(prev.height) &&
      prev.width >= FULL_MIN_W && prev.height >= FULL_MIN_H
    store.patch({
      settings: {
        mini: {
          enabled: true,
          fullBounds: prevUsable ? { ...prev, maximized: wasMax } : cfg.fullBounds || null,
          bounds: cfg.bounds || { width: MINI_DEFAULT_W, height: MINI_DEFAULT_H, x: prev.x, y: prev.y }
        }
      }
    })
    // 必须先放开最小尺寸，否则 setBounds 会被 1000×640 卡住
    win.setMinimumSize(MINI_MIN_W, MINI_MIN_H)
    win.setMaximizable(false)
    const b = cfg.bounds && Number.isFinite(cfg.bounds.width) ? cfg.bounds : { width: MINI_DEFAULT_W, height: MINI_DEFAULT_H }
    win.setBounds(clampToWorkArea({
      width: Math.max(MINI_MIN_W, b.width),
      height: Math.max(MINI_MIN_H, b.height),
      x: Number.isFinite(b.x) ? b.x : prev.x,
      y: Number.isFinite(b.y) ? b.y : prev.y
    }))
    miniActive = true
  } else {
    const fb = cfg.fullBounds || {}
    // fullBounds 可能是脏数据（早期版本在迷你态里存过卡片尺寸）→ 不可信就回到默认大小
    const usable = Number.isFinite(fb.width) && Number.isFinite(fb.height) &&
      fb.width >= FULL_MIN_W && fb.height >= FULL_MIN_H
    win.setMinimumSize(FULL_MIN_W, FULL_MIN_H)
    win.setMaximizable(true)
    win.setBounds(clampToWorkArea({
      width: usable ? fb.width : 1280,
      height: usable ? fb.height : 800,
      x: usable ? fb.x : undefined,
      y: usable ? fb.y : undefined
    }))
    if (fb.maximized) win.maximize()
    miniActive = false
    store.patch({ settings: { mini: { enabled: false } } })
  }

  refreshTrayMenu()
  sendToRenderer('win:mini-state', { mini: miniActive })
  return miniActive
}

function createWindow() {
  const bounds = store.get().window || {}
  const mc = miniCfg()
  miniActive = !!(mc && mc.enabled)
  const mb = (mc && mc.bounds) || {}

  const width = miniActive ? Math.max(MINI_MIN_W, mb.width || MINI_DEFAULT_W) : (bounds.width || 1280)
  const height = miniActive ? Math.max(MINI_MIN_H, mb.height || MINI_DEFAULT_H) : (bounds.height || 800)
  const x = miniActive ? (Number.isFinite(mb.x) ? mb.x : bounds.x) : bounds.x
  const y = miniActive ? (Number.isFinite(mb.y) ? mb.y : bounds.y) : bounds.y

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: miniActive ? MINI_MIN_W : FULL_MIN_W,
    minHeight: miniActive ? MINI_MIN_H : FULL_MIN_H,
    maximizable: !miniActive,
    show: false,
    frame: false,
    backgroundColor: '#0f1115',
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  win.once('ready-to-show', () => {
    if (bounds.maximized && !miniActive) win.maximize()
    win.show()
  })

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    // 迷你模式只记迷你尺寸，别把 320×420 写进完整窗口的位置里
    if (miniActive) {
      store.patch({ settings: { mini: { bounds: b } } })
    } else {
      store.patch({ window: { ...b, maximized: win.isMaximized() } })
    }
  }
  win.on('resize', debounce(saveBounds, 400))
  win.on('move', debounce(saveBounds, 400))

  win.on('close', (e) => {
    if (store.get().settings.closeToTray && !quitting) {
      e.preventDefault()
      win.hide()
      return
    }
    saveBounds()
    // 主窗口真要关掉 → 桌面歌词一起收（否则只剩一个歌词窗悬空，进程也不会退出）。
    // 这里的 quitting 只用来阻止歌词窗口把 enabled 改成 false，下次启动仍能恢复。
    quitting = true
    closeLyricWindow()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  // 任务栏悬停时的那排媒体按钮（初始为"播放"态）
  updateThumbar(false)
}

function debounce(fn, ms) {
  let t = null
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

/* ---------------- 托盘 ---------------- */

/** 托盘菜单重建（迷你开关的勾选态会变，不能只建一次） */
function refreshTrayMenu() {
  if (!tray) return
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus() } } },
      {
        label: '迷你模式',
        type: 'checkbox',
        checked: miniActive,
        click: () => applyMini(!miniActive)
      },
      { label: '桌面歌词', click: () => sendToRenderer('shortcut', 'dlyric') },
      {
        label: '关闭时最小化到托盘',
        type: 'checkbox',
        checked: store.get().settings.closeToTray === true,
        click: (item) => store.patch({ settings: { closeToTray: item.checked } })
      },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit() } }
    ]))
  } catch (err) {
    console.error('[tray] 菜单更新失败:', err.message)
  }
}

/**
 * 任务栏缩略图工具栏（悬停任务栏图标时出现的那排媒体按钮）。
 * Electron 没有暴露 Windows SMTC 接口，这是纯 JS 能做到的最接近的一层。
 * 图标是 make-thumbar-icons.py 生成的 16x16 单色 PNG。
 */
let thumbarPlaying = false
function updateThumbar(playing) {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return
  thumbarPlaying = !!playing
  const dir = path.join(__dirname, '..', 'assets')
  const ic = (name) => nativeImage.createFromPath(path.join(dir, name))
  try {
    win.setThumbarButtons([
      {
        tooltip: '上一首',
        icon: ic('thumb-prev.png'),
        click: () => sendToRenderer('shortcut', 'prev')
      },
      {
        tooltip: thumbarPlaying ? '暂停' : '播放',
        icon: ic(thumbarPlaying ? 'thumb-pause.png' : 'thumb-play.png'),
        click: () => sendToRenderer('shortcut', 'play-pause')
      },
      {
        tooltip: '下一首',
        icon: ic('thumb-next.png'),
        click: () => sendToRenderer('shortcut', 'next')
      }
    ])
  } catch (err) {
    logLine('WARN thumbar 设置失败', err.message)
  }
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray.png')
    let img = nativeImage.createFromPath(iconPath)
    if (img.isEmpty()) {
      img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'))
    }
    if (img.isEmpty()) return
    tray = new Tray(img.resize({ width: 16, height: 16 }))
    tray.setToolTip(APP_NAME)
    refreshTrayMenu()
    tray.on('click', () => {
      if (!win) return
      if (win.isVisible()) win.hide()
      else { win.show(); win.focus() }
    })
  } catch (err) {
    console.error('[tray] 创建失败:', err.message)
  }
}

/* ---------------- 全局快捷键 ---------------- */

const SHORTCUTS = {
  'MediaPlayPause': 'play-pause',
  'MediaNextTrack': 'next',
  'MediaPreviousTrack': 'prev',
  'MediaStop': 'stop',
  'CommandOrControl+Alt+Space': 'play-pause',
  'CommandOrControl+Alt+Right': 'next',
  'CommandOrControl+Alt+Left': 'prev',
  'CommandOrControl+Alt+Up': 'volume-up',
  'CommandOrControl+Alt+Down': 'volume-down',
  'CommandOrControl+Alt+D': 'dlyric',
  'CommandOrControl+Alt+M': 'mini-toggle'
}

function registerShortcuts() {
  const failed = []
  for (const [accel, action] of Object.entries(SHORTCUTS)) {
    try {
      const ok = globalShortcut.register(accel, () => sendToRenderer('shortcut', action))
      if (!ok) failed.push(accel)
    } catch {
      failed.push(accel)
    }
  }
  return failed
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

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
  return store.get().settings.desktopLyric || {}
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
  sendToRenderer('dlyric:open-state', {
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
  const saveBounds = debounce(() => {
    if (!dlyricWin || dlyricWin.isDestroyed()) return
    const nb = dlyricWin.getNormalBounds ? dlyricWin.getNormalBounds() : dlyricWin.getBounds()
    store.patch({ settings: { desktopLyric: { bounds: nb } } })
  }, 400)
  dlyricWin.on('resize', saveBounds)
  dlyricWin.on('move', saveBounds)

  // 歌词窗口自行关闭（控制条 ✕ 或系统方式）→ 通知主窗口同步按钮状态。
  // 注意退出App时也会触发 closed，用 quitting 区分，避免把 enabled 改没。
  dlyricWin.on('closed', () => {
    dlyricWin = null
    if (!quitting) {
      store.patch({ settings: { desktopLyric: { enabled: false } } })
      notifyDlyricState()
    }
  })

  return dlyricWin
}

function closeLyricWindow() {
  if (dlyricWin && !dlyricWin.isDestroyed()) dlyricWin.close()
  else if (dlyricWin) dlyricWin = null
}

/* ---------------- 独占输出（mpv + WASAPI exclusive） ---------------- */

let mpvEngine = null

/**
 * 引擎路径查找顺序：LX_MPV 环境变量（调试） → exe 同级 engine\mpv.exe（成品）
 * → 项目根 engine\mpv.exe（开发）。
 */
function mpvExePath() {
  const candidates = []
  if (process.env.LX_MPV) candidates.push(process.env.LX_MPV)
  candidates.push(
    app.isPackaged
      ? path.join(path.dirname(process.execPath), 'engine', 'mpv.exe')
      : path.join(__dirname, '..', '..', 'engine', 'mpv.exe')
  )
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p } catch {}
  }
  return candidates[candidates.length - 1]
}

function onMpvEvent(evt) {
  // 独占打不开（设备不支持该格式/被别的程序独占）→ 自动回退共享一次并告知界面
  if (evt.type === 'file-error' && mpvEngine && mpvEngine.exclusive && !mpvEngine.fellBack) {
    mpvEngine.fellBack = true
    logLine('[mpv] 独占输出失败，回退共享：' + (evt.message || ''))
    mpvEngine.restart({ exclusive: false }).then((r) => {
      sendToRenderer('mpv:event', r.ok
        ? { type: 'fallback', message: (evt.message || '') }
        : { type: 'error', message: r.error || '独占失败且回退共享也失败' })
    })
    return
  }
  // 输出参数是"是否位完美"的第一手证据，落日志便于事后核对
  if (evt.type === 'format') logLine('[mpv] audio-out-params=' + JSON.stringify(evt.params))
  if (evt.type === 'file-error') logLine('[mpv] file-error: ' + (evt.message || ''))
  if (evt.type === 'log' && (evt.level === 'error' || evt.level === 'fatal')) logLine('[mpv][log] ' + evt.text)
  sendToRenderer('mpv:event', evt)
}

async function ensureMpv(exclusive) {
  if (!mpvEngine) {
    mpvEngine = new MpvEngine({ exePath: mpvExePath(), onEvent: onMpvEvent })
  }
  if (mpvEngine.running) return { ok: true, exclusive: mpvEngine.exclusive }
  const wantExclusive = exclusive !== false
  // 输出设备来自设置；空字符串 = 跟随系统默认
  const audioDevice = String(store.get().settings.audioDevice || '').trim()
  const r = await mpvEngine.start({ exclusive: wantExclusive, audioDevice })
  logLine('[mpv] start exclusive=' + wantExclusive + ' ' + JSON.stringify(r) + ' exe=' + mpvExePath())
  return r
}

function stopMpv() {
  if (mpvEngine) {
    mpvEngine.kill()
    mpvEngine = null
  }
}

/* ---------------- IPC ---------------- */

function registerIpc() {
  // —— 音乐库 ——
  // 扫库期间 lib:list 必须等待扫描结束，否则渲染进程会读到半成品列表
  ipcMain.handle('lib:list', async () => {
    if (activeScan) {
      try { await activeScan } catch { /* 扫描失败也用现有数据 */ }
    }
    return library.list().map(toClientTrack)
  })

  ipcMain.handle('lib:scan', async (event, dirs) => {
    const targetDirs = Array.isArray(dirs) && dirs.length ? dirs : store.get().settings.musicDirs
    const sender = event.sender
    const run = library.scan(targetDirs, (p) => {
      if (!sender.isDestroyed()) {
        sender.send('lib:scan-progress', {
          phase: p.phase,
          done: p.done,
          total: p.total,
          track: p.track ? toClientTrack(p.track) : null
        })
      }
    })
    activeScan = run
    try {
      const res = await run
      if (!sender.isDestroyed()) sender.send('lib:scan-done', res)
      return res
    } finally {
      if (activeScan === run) activeScan = null
    }
  })

  // —— 设置 ——
  ipcMain.handle('settings:get', () => store.get().settings)
  ipcMain.handle('settings:patch', (e, patch) => store.patch({ settings: patch }).settings)

  // —— 歌单 ——
  ipcMain.handle('playlists:get', () => store.get().playlists || [])
  ipcMain.handle('playlists:create', (e, name) => {
    const list = store.get().playlists || []
    const item = {
      id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || '新建歌单',
      trackIds: [],
      createdAt: Date.now()
    }
    list.push(item)
    store.patch({ playlists: list })
    return item
  })
  ipcMain.handle('playlists:update', (e, { id, patch }) => {
    const list = store.get().playlists || []
    const idx = list.findIndex((p) => p.id === id)
    if (idx < 0) return null
    list[idx] = { ...list[idx], ...patch }
    store.patch({ playlists: list })
    return list[idx]
  })
  ipcMain.handle('playlists:remove', (e, id) => {
    store.patch({ playlists: (store.get().playlists || []).filter((p) => p.id !== id) })
    return true
  })
  ipcMain.handle('playlists:addTracks', (e, { id, trackIds }) => {
    const list = store.get().playlists || []
    const pl = list.find((p) => p.id === id)
    if (!pl) return null
    for (const t of trackIds) if (!pl.trackIds.includes(t)) pl.trackIds.push(t)
    store.patch({ playlists: list })
    return pl
  })
  ipcMain.handle('playlists:removeTracks', (e, { id, trackIds }) => {
    const list = store.get().playlists || []
    const pl = list.find((p) => p.id === id)
    if (!pl) return null
    const set = new Set(trackIds)
    pl.trackIds = pl.trackIds.filter((t) => !set.has(t))
    store.patch({ playlists: list })
    return pl
  })

  /**
   * 导出 m3u 歌单。渲染层只有曲目 id，路径由主进程按 library 反查（渲染层拿不到真实路径）。
   * 优先写相对路径（m3u 与音乐在同一棵树里时更耐搬动），跨盘时自动退化为绝对路径。
   */
  ipcMain.handle('playlist:exportM3u', async (e, { name, trackIds } = {}) => {
    if (!win) return { ok: false, error: '窗口未就绪' }
    const tracks = (trackIds || []).map((id) => library.get(id)).filter(Boolean)
    if (!tracks.length) return { ok: false, error: '歌单是空的' }
    const safe = String(name || '播放列表').replace(/[\\/:*?"<>|]/g, '_')
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出 m3u 歌单',
      defaultPath: safe + '.m3u8',
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u8', 'm3u'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const base = path.dirname(filePath)
    const lines = ['#EXTM3U']
    for (const t of tracks) {
      const rel = path.relative(base, t.path)
      const useRel = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
      lines.push(useRel ? rel : t.path)
    }
    try {
      fs.writeFileSync(filePath, lines.join('\r\n') + '\r\n', 'utf8')
      return { ok: true, filePath, count: tracks.length }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  /** 导入 m3u：路径就地映射成 trackId，未在曲库里的条目单独计数（不报错） */
  ipcMain.handle('playlist:importM3u', async () => {
    if (!win) return { ok: false, error: '窗口未就绪' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入 m3u 歌单',
      filters: [{ name: 'M3U 播放列表', extensions: ['m3u8', 'm3u'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths.length) return { ok: false, canceled: true }
    const file = filePaths[0]
    let entries = []
    try {
      entries = decodeText(fs.readFileSync(file)).split(/\r?\n/)
    } catch (err) {
      return { ok: false, error: err.message }
    }
    const base = path.dirname(file)
    const trackIds = []
    const seen = new Set()
    let unmatched = 0
    for (const raw of entries) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const abs = path.isAbsolute(line) ? line : path.resolve(base, line)
      const id = fileId(abs)
      if (!library.get(id)) { unmatched++; continue }
      if (seen.has(id)) continue
      seen.add(id)
      trackIds.push(id)
    }
    return {
      ok: true,
      name: path.basename(file, path.extname(file)),
      trackIds,
      unmatched
    }
  })

  // —— 收藏 / 历史 / 播放次数 ——
  ipcMain.handle('favorites:get', () => store.get().favorites || [])
  ipcMain.handle('favorites:toggle', (e, trackId) => {
    const favs = store.get().favorites || []
    const i = favs.indexOf(trackId)
    if (i >= 0) favs.splice(i, 1)
    else favs.unshift(trackId)
    store.patch({ favorites: favs })
    return favs
  })

  ipcMain.handle('history:get', () => store.get().history || [])
  ipcMain.handle('history:add', (e, trackId) => {
    const hist = (store.get().history || []).filter((h) => h.id !== trackId)
    hist.unshift({ id: trackId, at: Date.now() })
    store.patch({ history: hist.slice(0, 300) })
    return true
  })

  ipcMain.handle('playcount:get', () => store.get().playCounts || {})
  ipcMain.handle('playcount:inc', (e, trackId) => {
    const pc = store.get().playCounts || {}
    pc[trackId] = (pc[trackId] || 0) + 1
    store.patch({ playCounts: pc })
    return pc[trackId]
  })

  ipcMain.handle('session:get', () => store.get().session || null)
  ipcMain.handle('session:set', (e, session) => {
    store.patch({ session })
    return true
  })

  // —— 歌词 ——
  ipcMain.handle('lyric:read', async (e, trackId) => {
    const track = library.get(trackId)
    if (!track || !track.lyric) return null
    try {
      const buf = await fsp.readFile(track.lyric)
      return decodeText(buf)
    } catch (err) {
      return null
    }
  })

  // —— 对话框 / 系统集成 ——
  ipcMain.handle('dialog:pickDirs', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle('shell:showItem', (e, filePath) => {
    if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath)
  })

  // —— 窗口控制 ——
  ipcMain.handle('win:minimize', () => win && win.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('win:close', () => win && win.close())
  ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false))
  // 迷你模式：渲染层只表达意图，缩放/持久化都在主进程做
  ipcMain.handle('win:setMini', (e, on) => applyMini(!!on))
  ipcMain.handle('win:isMini', () => miniActive)
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData
  }))

  // —— 桌面歌词 ——
  ipcMain.handle('dlyric:open', () => {
    store.patch({ settings: { desktopLyric: { enabled: true } } })
    createLyricWindow()
    notifyDlyricState()
    return dlyricCfg()
  })
  ipcMain.handle('dlyric:close', () => {
    closeLyricWindow()
    notifyDlyricState()
    return true
  })
  ipcMain.handle('dlyric:isOpen', () => !!(dlyricWin && !dlyricWin.isDestroyed()))
  ipcMain.handle('dlyric:unlock', () => {
    store.patch({ settings: { desktopLyric: { locked: false } } })
    applyDlyricLock()
    notifyDlyricState()
    return dlyricCfg()
  })
  // 主窗口 → 歌词窗口：当前歌词行（同时缓存，供窗口就绪时补发）
  ipcMain.handle('dlyric:state', (e, payload) => {
    lastDlyricData = payload || null
    sendToDlyric('dlyric:data', payload)
    return true
  })
  // 歌词窗口 → 主进程：配置修改（锁定/字号/颜色）→ 同步主窗口按钮
  ipcMain.handle('dlyric:cfg', (e, patch) => {
    store.patch({ settings: { desktopLyric: patch } })
    applyDlyricLock()
    notifyDlyricState()
    return dlyricCfg()
  })
  // 歌词窗口加载完成：立即回推一次完整配置 + 当前歌词行（否则要等下一句才出词）
  ipcMain.handle('dlyric:ready', (e) => {
    replayDlyricState()
    return true
  })

  // —— 独占输出（mpv 后端） ——
  ipcMain.handle('mpv:start', (e, exclusive) => ensureMpv(exclusive !== false))
  ipcMain.handle('mpv:load', (e, filePath, opts) => {
    if (mpvEngine) mpvEngine.load(filePath, opts || {})
    return true
  })
  ipcMain.handle('mpv:play', () => { if (mpvEngine) mpvEngine.play(); return true })
  ipcMain.handle('mpv:pause', () => { if (mpvEngine) mpvEngine.pause(); return true })
  ipcMain.handle('mpv:stop', () => { if (mpvEngine) mpvEngine.stop(); return true })
  ipcMain.handle('mpv:seek', (e, sec) => { if (mpvEngine) mpvEngine.seek(Number(sec) || 0); return true })
  ipcMain.handle('mpv:volume', (e, v) => { if (mpvEngine) mpvEngine.setVolume(Number(v) || 0); return true })
  ipcMain.handle('mpv:mute', (e, m) => { if (mpvEngine) mpvEngine.setMute(!!m); return true })
  ipcMain.handle('mpv:quit', () => { stopMpv(); return true })
  // 开启独占前的确认框（把不可逆的副作用说清楚，避免误触）
  ipcMain.on('win:play-state', (e, playing) => updateThumbar(!!playing))

  ipcMain.handle('mpv:confirmEnable', async () => {
    if (!win) return false
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['开启独占输出', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: '开启独占输出（位完美）',
      message: '改用 mpv + WASAPI 独占输出',
      detail: [
        '· 独占期间声卡被本程序占用，浏览器、微信、视频等其他程序没有声音；',
        '· 均衡器、音量均衡、实时频谱会自动禁用（任何软件处理都会破坏位完美）；',
        '· 音量 100% 时是位完美，拖低音量即为软件增益，界面会标注状态；',
        '· 开启后界面会重新加载，播放中断一次（队列与进度会保留）。',
        '',
        '如果声卡驱动不支持独占或已被占用，会自动回退共享输出。'
      ].join('\n')
    })
    return response === 0
  })

  /**
   * 枚举 WASAPI 输出设备。独占需求的人基本都接了 USB DAC，
   * 而系统默认设备经常不是它 —— 没有这个就无法把独占输出指到指定设备。
   */
  ipcMain.handle('mpv:devices', async () => {
    let startedHere = false
    try {
      if (!mpvEngine || !mpvEngine.running) {
        const r = await ensureMpv(false)
        if (!r.ok) return { ok: false, devices: [], error: r.error || '引擎未启动' }
        startedHere = true
      }
      const devices = await mpvEngine.listDevices()
      return { ok: true, devices }
    } catch (err) {
      return { ok: false, devices: [], error: err.message }
    } finally {
      // 只为枚举而临时拉起的引擎（当前并非独占输出）用完即关，不留空闲进程
      if (startedHere && !store.get().settings.exclusiveOutput) stopMpv()
    }
  })

  /** 切换输出设备：存设置；正在独占播放时重启引擎并回到原位置 */
  ipcMain.handle('mpv:setDevice', async (e, device) => {
    const name = String(device || '')
    store.patch({ settings: { audioDevice: name } })
    if (!mpvEngine || !mpvEngine.running) return { ok: true, applied: false }
    if (!store.get().settings.exclusiveOutput) return { ok: true, applied: false }
    const r = await mpvEngine.restart({ exclusive: true, audioDevice: name })
    return { ok: !!r.ok, applied: true, error: r.error }
  })
}

/** 文本解码：优先 UTF-8，失败回退 GBK（Windows 中文 lrc 常见） */
function decodeText(buf) {
  let text = buf.toString('utf8')
  const bad = (text.match(/\uFFFD/g) || []).length
  if (bad > 0) {
    try {
      const decoder = new TextDecoder('gbk')
      const alt = decoder.decode(buf)
      if ((alt.match(/\uFFFD/g) || []).length < bad) text = alt
    } catch {}
  }
  return text.replace(/^\uFEFF/, '')
}

/** 转成渲染层用的精简结构（路径换成自定义协议 URL） */
function toClientTrack(t) {
  return {
    id: t.id,
    path: t.path,
    fileName: t.fileName,
    title: t.title,
    artist: t.artist,
    artists: t.artists,
    album: t.album,
    albumArtist: t.albumArtist,
    year: t.year,
    trackNo: t.trackNo,
    genre: t.genre,
    duration: t.duration,
    bitrate: t.bitrate,
    sampleRate: t.sampleRate,
    bitsPerSample: t.bitsPerSample,
    codec: t.codec,
    lossless: t.lossless,
    ext: t.ext,
    size: t.size,
    hasLyric: !!t.lyric,
    // 拼音检索字段（v1.6）：主进程预先算好，渲染层只做 includes
    py: t.py || '',
    pyf: t.pyf || '',
    cover: toLxUrl(resolveCoverPath(t.cover, library.coverDir)),
    audio: toLxUrl(t.path)
  }
}

/* ---------------- 启动 ---------------- */

logLine('stage: dataDir=' + DATA_DIR)

// 单实例锁：部分环境建锁文件会失败（返回 false 甚至直接 abort），
// 不能让它挡住启动——拿不到锁就当作单实例降级处理。
let gotLock = false
try {
  gotLock = app.requestSingleInstanceLock()
} catch (err) {
  logLine('WARN 单实例锁异常，忽略', err.message)
}
logLine('stage: lock=' + gotLock)
if (!gotLock) {
  logLine('WARN 未获取单实例锁，继续启动')
}

// 只在确认是唯一实例时清缓存：多实例情况下删的是正在运行实例的文件（多半删不掉）
if (gotLock) cleanChromiumCache()
{
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    logLine('stage: ready')
    userData = app.getPath('userData')
    logLine('stage: userData=' + userData)
    store = new Store(path.join(userData, 'settings.json'), {
      settings: DEFAULT_SETTINGS,
      playlists: [],
      favorites: [],
      history: [],
      playCounts: {},
      session: null,
      window: {}
    }, { onError: (msg) => logLine('STORE_ERROR', msg) })

    // 异步清上次残留的 mpv，不阻塞启动
    killOrphanMpv()

    library = new Library({
      cacheFile: path.join(userData, 'library.json'),
      coverDir: path.join(userData, 'covers')
    })

    registerFileProtocol()
    await library.init()
    registerIpc()

    // 首次启动（或解析器升级导致缓存作废）时自动建库。
    // 必须在 createWindow 之前启动，好让渲染进程的首次 lib:list 能与它串行。
    // 设置里开了「启动时扫描音乐文件夹」也会自动扫一次（增量、很快）。
    const needScan = library.list().length === 0 || store.get().settings.autoScanOnStart === true
    if (needScan) {
      const run = library.scan(store.get().settings.musicDirs, (p) => {
        sendToRenderer('lib:scan-progress', {
          phase: p.phase, done: p.done, total: p.total,
          track: p.track ? toClientTrack(p.track) : null
        })
      })
      activeScan = run
      run
        .then((res) => sendToRenderer('lib:scan-done', res))
        .catch((err) => console.error('[library] 首次扫描失败:', err))
        .finally(() => { if (activeScan === run) activeScan = null })
    }

    createWindow()
    createTray()
    const failed = registerShortcuts()
    if (failed.length) console.warn('[shortcut] 注册失败:', failed.join(', '))

    // 上次开着桌面歌词 → 启动时恢复
    if (store.get().settings.desktopLyric && store.get().settings.desktopLyric.enabled) {
      createLyricWindow()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else if (win) win.show()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    stopMpv()
    if (store) store.flush()
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
