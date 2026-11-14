'use strict'
/**
 * 主进程：窗口、自定义文件协议、音乐库、持久化、全局快捷键。
 */
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, globalShortcut, Tray, Menu, nativeImage, screen, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { execFile } = require('child_process')
const { pathToFileURL } = require('url')
const { Readable } = require('stream')

const { Store } = require('./store')
const { Library, fileId, MIME_BY_EXT, resolveCoverPath, COVER_EMBEDDED, readEmbeddedLyric } = require('./library')
const { MpvEngine } = require('./mpv')

// ---------- v3.3.24 模块拆分：子模块引入与共享状态注入 ----------
const PROTO = require('./protocols')
const SCHEMA = require('./settings-schema')
const DLYW = require('./dlyric-window')
const MPVM = require('./mpv-manager')

const isDev = process.argv.includes('--dev')
/** v3.3.29 后台守卫：测试/成品实测实例绝不显示窗口、绝不抢前台焦点。
 *  所有 show / focus / restore 路径统一走这个判据（ready-to-show、showMainWindow、
 *  second-instance、activate；桌面歌词浮窗在 dlyric-window.js 里单独判同名变量）。 */
const TEST_HIDDEN = () => process.env.LX_TEST_HIDDEN === '1'
/** v2.8.42：测试静音必须覆盖**整条链路**。
 *  以前 LX_TEST_MUTE=1 只让 mpv 走 --ao=null，普通播放走 HTML5 <audio> 照样出声 ——
 *  自动化实测/成品实测会真的放音乐。这里补一个 Chromium 层面的 mute-audio，
 *  对 <audio>、WebAudio、mpv 三路一起静音，且只在测试实例上生效。 */
if (process.env.LX_TEST_MUTE === '1') {
  try { app.commandLine.appendSwitch('mute-audio') } catch { /* 拿不到 app 就退化成只静音 mpv */ }
}
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
// v2.8.8：日志超 5MB 就轮转成 .old.log —— 以前无限增长且每条都是同步追加
try {
  const _st = fs.statSync(LOG_FILE)
  if (_st.size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.old.log'))
} catch (err) { /* 首次运行没有日志 */ }
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
async function cleanChromiumCache() {
  // 第四轮 §4.2 #3：启动路径上的同步递归删除会阻塞首帧（11 个目录 × 上千文件），
  // 改成异步并限流，删不掉（上一实例还占着）就跳过，不影响启动
  let removed = 0
  await Promise.all(CACHE_DIRS.map(async (name) => {
    const dir = path.join(DATA_DIR, name)
    try {
      if (!fs.existsSync(dir)) return
      await fsp.rm(dir, { recursive: true, force: true })
      removed++
    } catch (err) {
      // 文件被占用 → 跳过
    }
  }))
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
  // 命名管道是 lxmpv-<主进程PID>-<时间戳>，所以只杀「管道名里不是当前 PID」的那些。
  // 不能无条件扫所有 lxmpv-*：启动后渲染层会在 1~2 秒内拉起自己的 mpv，
  // 而这一步恰好也是异步的，会把刚起的引擎当孤儿杀掉。
  // （v1.6.0 实测踩到：日志里 killed-orphan-mpv 之后紧跟 mpv IPC 连接失败）
  // v2.8.2 关键修复：以前只排除「本进程」的管道名，于是两个实例同时开着时，
  // 后启动的那个会把前一个正在用的 mpv 当孤儿杀掉 —— 前一个立刻失声，
  // 而进度条还在按插值往前走（用户看到「没声音但还在放」）。
  // 现在从管道名 lxmpv-<归属PID>- 里解析出主进程 PID：
  // 归属进程还活着（且是播放器自己）就绝不动它，只有 owner 已经死了才算孤儿。
  const selfPid = process.pid
  const script = [
    'Get-CimInstance Win32_Process -Filter "Name=\'mpv.exe\'" | ForEach-Object {',
    '  $m = [regex]::Match($_.CommandLine, \'lxmpv-(\\d+)-\')',
    '  if (-not $m.Success) { return }',
    '  $owner = [int]$m.Groups[1].Value',
    '  if ($owner -eq ' + selfPid + ') { return }',
    '  $p = Get-Process -Id $owner -ErrorAction SilentlyContinue',
    "  if ($p -and ($p.ProcessName -like '猪专属播放器*' -or $p.Path -like '*lx-dev*')) { return }",
    // 开发模式主进程是 electron.exe（进程名匹配不到），按路径放行开发镜像
    '  $_.ProcessId',
    '}'
  ].join("\n")
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 8000 },
    (err, stdout) => {
      if (err || !stdout) return
      const pids = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
      // 第四轮 §4.2 #3：同步 taskkill 每个最长 5 秒，N 个孤儿就是 N×5s 的主进程卡死。
      // 改并发异步，全部结束再记一条日志。
      Promise.all(pids.map((pid) => new Promise((resolve) => {
        execFile('taskkill', ['/PID', pid, '/F'], { windowsHide: true, timeout: 5000 }, (e) => {
          if (!e) logLine('stage: killed-orphan-mpv=' + pid)
          resolve()
        })
      }))).catch(() => {})
    })
}
logLine('=== boot ===', process.argv.join(' '), 'electron', process.versions.electron)
logLine('stage: require-ok app=' + typeof app + ' protocol=' + typeof protocol)

try {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'lxfile',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
    },
    {
      // v2.0：内嵌封面按需从音频文件里解出来，不再往 data\covers 写文件
      scheme: 'lxcover',
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true }
    }
  ])
  logLine('stage: schemes-ok')
} catch (err) {
  logLine('FATAL registerSchemesAsPrivileged', err.stack || String(err))
  throw err
}

let win = null
let tray = null
// v2.8.26 修复「放大后按钮无法还原」：Windows 无边框窗口下 isMaximized() 有滞后
// （快速连点/贴边最大化时返回旧值），用它做分支会走错（已最大化却再 maximize → 空操作）。
// maximize/unmaximize 事件维护这个权威状态，分支判断与推送都用它。
let winMaxState = false
let store = null
let library = null
let userData = null
let quitting = false
/** 正在进行的扫描 Promise；lib:list 要等它结束，避免渲染进程读到半成品曲库 */
let activeScan = null











/* ---------------- 默认配置 ---------------- */

const DEFAULT_SETTINGS = {
  musicDirs: [DEFAULT_MUSIC_DIR],
  volume: 0.8,
  muted: false,
  playMode: 'list', // list | single | shuffle | order
  fadeMs: 350,
  lyricFontSize: 20,
  lyricOffset: 0,
  lyricOffsetById: {},         // 每曲歌词偏移（v1.7）：{ trackId: 秒 }，优先于 lyricOffset
  theme: 'dark',
  // v2.8.40：主题色默认改成「跟随封面」（tonal palette 默认开，可关回固定色）
  accent: 'auto',
  accentAutoMigrated: false,   // 一次性迁移标记：老的裸色值 #31c27c → auto
  viewMode: 'list',            // v2.8.40：主列表形态 list | grid
  showLyricPanel: true,
  autoScanOnStart: false,
  watchFolders: true,          // 监视音乐文件夹变化并自动增量扫描（v1.7）
  closeToTray: false,
  closeAsk: true,              // v2.4：点 × 时弹窗询问（最小化到托盘 / 直接退出），勾「不再提示」后关闭
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
  powerAfterQueue: 'off',      // v2.1：整队播完后 off|shutdown|hibernate|quit
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
    const hasPos = Number.isFinite(b.x) && Number.isFinite(b.y)
    // v3.3.17：没有坐标时不能拿 (0,0) 去匹配显示器 —— 副屏在主屏左侧/上方
    // 或任务栏在左/上时，(0,0) 不在主屏工作区，夹出来的位置会跑到错误的屏幕上。
    area = hasPos
      ? screen.getDisplayMatching({ x: b.x, y: b.y, width, height }).workArea
      : screen.getPrimaryDisplay().workArea
  } catch { /* screen 不可用时用默认值 */ }
  if (!area) {
    // 不能把 undefined 原样带回去：win.setBounds({x: undefined}) 会抛 TypeError
    return { x: 0, y: 0, width, height }
  }
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
    let timer = null
    const fin = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { win.removeListener(ev, fin) } catch {}
      resolve()
    }
    win.on(ev, fin)
    timer = setTimeout(fin, timeout)
  })
}

/**
 * 切换迷你模式：同一个窗口缩放，不做第二个窗口（播放状态天然连续）。
 * 进迷你前把完整窗口的尺寸位置存进 settings.mini.fullBounds，退出时原样还原。
 */
let miniBusy = false
let miniDesired = null

async function applyMini(on) {
  if (!win || win.isDestroyed()) return miniActive
  on = !!on
  // v3.3.17：进迷你时若窗口是最大化状态，会 await 一次 unmaximize（最长 500ms）。
  // 这段窗口里 miniActive 还是旧值，「on === miniActive」的早退会把**后来的**那次
  // 切换当成重复请求丢掉 —— 快速连按两次（托盘 + 全局快捷键）最终会停在你不想去的状态。
  if (miniBusy) { miniDesired = on; return miniActive }
  if (on === miniActive) return miniActive
  miniBusy = true
  try {
    return await applyMiniOnce(on)
  } finally {
    miniBusy = false
    const want = miniDesired
    miniDesired = null
    if (want != null && want !== miniActive) {
      applyMini(want).catch(() => {})
    }
  }
}

async function applyMiniOnce(on) {
  const cfg = miniCfg()

  if (on) {
    // 记下"进迷你前是不是最大化"，回来时要还原成同样的形态
    const wasMax = win.isMaximized()
    if (wasMax) {
      // Windows 上 unmaximize 是异步的，必须先挂监听再触发，否则会漏掉事件（只剩超时兜底）
      const wait = waitWindowEvent(win, 'unmaximize')
      win.unmaximize()
      // unmaximize 在隐藏窗口上会隐式 show 且不触发 show 事件，
      // 与 win:toggleMaximize 同口径：操作后立刻压回隐藏（守 §2 不变量 #9）
      if (TEST_HIDDEN()) win.hide()
      await wait
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
    if (fb.maximized) {
      win.maximize()
      if (TEST_HIDDEN()) win.hide()
    }
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

  const placed = clampToWorkArea({ width, height, x, y })
  win = new BrowserWindow({
    width: placed.width,
    height: placed.height,
    x: placed.x,
    y: placed.y,
    minWidth: miniActive ? MINI_MIN_W : FULL_MIN_W,
    minHeight: miniActive ? MINI_MIN_H : FULL_MIN_H,
    maximizable: !miniActive,
    show: false,
    // v3.3.29：后台实例不进任务栏，避免 maximize() 隐式 show 时任务栏闪烁
    skipTaskbar: TEST_HIDDEN(),
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

  // v3.3.29 最终兜底：Electron 的 maximize() / restore() 会隐式 show 窗口
  // （放大键两连击实测必触发），这是「窗口弹出」的真正来源。测试态下任何
  // show 事件立刻压回隐藏，且不进任务栏；isMaximized() 等状态不受影响。
  if (TEST_HIDDEN()) {
    win.hide()
    win.on('show', () => { if (!win.isDestroyed()) win.hide() })
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  // 第四轮 §4.1 #1：第二实例可能在页面加载完成前就发来 open-files，这里补发一次
  win.webContents.on('did-finish-load', () => {
    if (lastOpenFiles) {
      const payload = lastOpenFiles
      lastOpenFiles = null
      sendToRenderer('open-files', payload)
    }
  })

  win.once('ready-to-show', () => {
    // v3.3.22 / v3.3.29：LX_TEST_HIDDEN=1 时窗口不显示（后台冒烟/成品实测），绝不抢前台焦点。
    // maximize() 在 Windows 上会隐式把窗口 show 出来，必须放在守卫之后；
    // 再显式 hide() 兜底，防止其它路径提前置了 WS_VISIBLE。
    if (TEST_HIDDEN()) { win.hide(); return }
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

  // v2.8.26：最大化权威状态 = 事件驱动，变化即推渲染层（外部贴边最大化图标也能跟上）
  win.on('maximize', () => {
    winMaxState = true
    sendToRenderer('win:max-state', true)
  })
  win.on('unmaximize', () => {
    winMaxState = false
    sendToRenderer('win:max-state', false)
  })

  win.on('close', (e) => {
    if (!quitting) {
      const st = store.get().settings
      // v2.4：默认每次点 × 都问一次（最小化到托盘 / 直接退出），勾了「不再提示」后按记住的选择执行
      if (st.closeAsk) {
        e.preventDefault()
        // 第四轮 §4.2 #7：既不 await 也不 catch，抛错就是 unhandledRejection
        handleCloseAsk().catch((err) => logLine('[win] 关闭询问失败 ' + ((err && err.message) || err)))
        return
      }
      if (st.closeToTray) {
        e.preventDefault()
        win.hide()
        return
      }
    }
    saveBounds()
    // 主窗口真要关掉 → 桌面歌词一起收（否则只剩一个歌词窗悬空，进程也不会退出）。
    // 这里的 quitting 只用来阻止歌词窗口把 enabled 改成 false，下次启动仍能恢复。
    quitting = true
    DLYW.closeLyricWindow()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    // v2.8.7：只放行网页链接。file:// 等任何协议都交给系统打开是不必要的攻击面
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // 第四轮 §4.6：只有 setWindowOpenHandler 不够 —— 把外部文件/目录拖到非拖拽区时，
  // Chromium 会当成「导航到 file://」，整个渲染层被替换成文件内容、状态全丢。
  // 这里挡住一切非本应用页面（devtools 与内置页面除外），与渲染层的全局 preventDefault 纵深配合。
  win.webContents.on('will-navigate', (event, targetUrl) => {
    const cur = win.webContents.getURL() || ''
    const isSelf = targetUrl === cur || targetUrl.startsWith('file://' + __dirname.replace(/\\/g, '/'))
    if (!isSelf) {
      event.preventDefault()
      logLine('[win] 已拦截页面导航：' + String(targetUrl).slice(0, 120))
    }
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
/* ---------------- 睡眠定时（v1.7 托盘入口，v2.2 移到 app 内播放条） ---------------- */

let sleepTimerId = null
let sleepMinutes = 0
let sleepEndsAt = 0   // 到点时刻的 Date.now()，渲染层用它显示倒计时

/** 广播当前定时状态给渲染层（minutes=0 表示无定时） */
function pushSleepState() {
  sendToRenderer('sleep-state', { minutes: sleepMinutes, endsAt: sleepEndsAt || null })
}

/** minutes=0 表示关闭。到点只做一件事：让渲染层淡出并暂停。 */
function setSleepTimer(minutes) {
  if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null }
  sleepMinutes = Math.min(24 * 60, Math.max(0, Math.floor(Number(minutes) || 0)))
  sleepEndsAt = 0
  if (sleepMinutes > 0) {
    logLine('[sleep] 定时 ' + sleepMinutes + ' 分钟')
    sleepEndsAt = Date.now() + sleepMinutes * 60 * 1000
    sleepTimerId = setTimeout(() => {
      sleepTimerId = null
      sleepMinutes = 0
      sleepEndsAt = 0
      sendToRenderer('sleep-timer', { fired: true })
      pushSleepState()
    }, sleepMinutes * 60 * 1000)
  } else {
    logLine('[sleep] 已关闭')
  }
  pushSleepState()
}

/* ---------------- 播放结束后动作（v2.1） ---------------- */

const POWER_LABEL = { off: '不处理', shutdown: '关机', hibernate: '休眠', quit: '关闭播放器' }
/** 'off' | 'shutdown' | 'hibernate' | 'quit' */
let powerAfterQueue = 'off'

function setPowerAfterQueue(kind) {
  powerAfterQueue = POWER_LABEL[kind] ? kind : 'off'
  logLine('[power] 播放结束后：' + powerAfterQueue)
  store.patch({ settings: { powerAfterQueue } })
  refreshTrayMenu()
  sendToRenderer('power-after-queue', powerAfterQueue)
}

/**
 * 队列播完（渲染层上报）。只在真的"外面还有歌"时才动手：
 * 循环模式列表回卷也算一次播完，用户要的就是那个时刻关机。
 */
function runPowerAction() {
  if (powerAfterQueue === 'off') return
  const kind = powerAfterQueue
  powerAfterQueue = 'off'
  store.patch({ settings: { powerAfterQueue: 'off' } })
  sendToRenderer('power-after-queue', 'off')
  sendToRenderer('power-action', { kind, delay: 15 })
  logLine('[power] 队列结束，执行 ' + kind + '（15 秒内可在托盘取消）')

  // 给用户 15 秒反悔时间：误触关机比少关一次机难受得多
  // v3.3.7：先清掉可能还挂着的旧定时器 —— 反悔窗口内重新设置、队列又播完一次时，
  // 直接覆盖会让第一个定时器到点照常执行（届时「取消」只能取消第二个）
  if (powerPending) { clearTimeout(powerPending); powerPending = null }
  powerPending = setTimeout(() => {
    powerPending = null
    refreshTrayMenu()
    if (kind === 'quit') { quitting = true; app.quit(); return }
    try {
      if (kind === 'shutdown') {
        // v3.3.17：标志必须**先于** execFile 立起来，并立刻重建托盘。
        // 以前它在 execFile 之后赋值，而托盘重建发生在这之前 —— 结果是
        // 「15 秒反悔窗口到点 → 30 秒系统关机窗口」这段时间里，
        // 托盘菜单上根本没有「取消关机」，用户错过 toast 就只能等关机。
        systemShutdownPending = true
        if (systemShutdownTimer) clearTimeout(systemShutdownTimer)
        systemShutdownTimer = setTimeout(() => {
          systemShutdownTimer = null
          systemShutdownPending = false
          refreshTrayMenu()
        }, 30000)
        if (systemShutdownTimer.unref) systemShutdownTimer.unref()
        refreshTrayMenu()
        execFile('shutdown', ['/s', '/t', '30'], (err) => onShutdownDone(err, 'shutdown'))
      } else if (kind === 'hibernate') {
        execFile('shutdown', ['/h'], (err) => onShutdownDone(err, 'hibernate'))
      }
    } catch (err) {
      logLine('[power] 执行失败 ' + err.message)
    }
  }, 15000)
  refreshTrayMenu()   // v3.3.13：赋值之后重建，「取消关机」菜单项才真的出现
}

let powerPending = null
// 第四轮 P1 #2：这两个标志以前只被读写、从未声明 —— 'use strict' 下赋值先抛错，
// 被本函数的 catch 静默吞掉，「播放结束后关机」100% 失效；取消路径必抛。
let systemShutdownPending = false
let systemShutdownTimer = null
/**
 * shutdown.exe 的回调。
 * 本地版此前**从未定义过这个函数**（v2.8.13 起只有调用），关机/休眠一触发就
 * 抛 ReferenceError —— 命令根本没发出去，用户看到「即将关机」后什么都没发生。
 */
function onShutdownDone(err, kind) {
  if (!err) return
  // v3.3.20：取消命令失败 ≠ 关机命令失败。以前两者共用这个回调，
  // `shutdown /a` 在「本来就没有排队关机」时报错，界面就拿走一条
  // 「系统拒绝执行关机命令」—— 用户刚点了取消，1 秒后看到红字报错。
  if (kind === 'cancel') {
    logLine('[power] 取消关机命令未生效（多半是没有排队中的关机）: ' + (err.message || String(err)))
    return
  }
  logLine('[power] shutdown 命令失败 ' + (err.message || String(err)))
  systemShutdownPending = false
  if (systemShutdownTimer) { clearTimeout(systemShutdownTimer); systemShutdownTimer = null }
  refreshTrayMenu()
  if (kind) {
    const what = kind === 'hibernate' ? '休眠' : '关机'
    sendToRenderer('power-action', { kind: null, error: '系统拒绝执行' + what + '命令（可能被组策略禁用）' })
  }
}

function cancelPowerAction() {
  // v3.3.13：15 秒反悔窗口结束后系统关机还有 30 秒可取消，两种状态都要能取消
  if (!powerPending && !systemShutdownPending) return false
  // v3.3.20：只有真的发出过 shutdown /s /t 才需要 /a。
  // 以前无条件调 `shutdown /a`，没有排队中的关机时它必然失败，失败回调
  // 又走 onShutdownDone → 给界面推一条「系统拒绝执行关机命令」——
  // 用户明明取消成功了，1 秒后又看到一条红色报错（本轮 P2）。
  const needAbort = systemShutdownPending
  if (powerPending) { clearTimeout(powerPending); powerPending = null }
  if (systemShutdownTimer) { clearTimeout(systemShutdownTimer); systemShutdownTimer = null }
  systemShutdownPending = false
  // 第四轮 §4.2 #5：直接传 onShutdownDone 会把 (err, stdout, stderr) 里的 stdout 当 kind
  if (needAbort) {
    try { execFile('shutdown', ['/a'], (err) => onShutdownDone(err, 'cancel')) } catch (err) { logLine('[power] 取消执行失败 ' + err.message) }
  }
  logLine('[power] 已取消')
  refreshTrayMenu()   // v3.3.9：不然「⚠ 取消关机」菜单项一直残留
  sendToRenderer('power-action', { kind: null })
  return true
}

/**
 * v2.4：点 × 弹窗问「最小化到托盘还是直接退出」。
 * 勾选「不再提示」后记住这次的选择（可在托盘菜单改回来）；
 * 不勾则只对本次生效，设置不变。弹窗失败时退回旧行为（按 closeToTray 设置执行）。
 */
/** 关窗询问是否已经在弹（连点 × / 托盘退出同时触发时只能有一个对话框） */
let closeAskBusy = false

async function handleCloseAsk() {
  if (closeAskBusy) return
  closeAskBusy = true
  try {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: '关闭播放器',
      message: '点击 × 时想做什么？',
      detail: '勾选「不再提示」后将按这次的选择执行，之后可在托盘菜单里改回来。',
      buttons: ['最小化到托盘', '直接退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '不再提示',
      checkboxChecked: false,
      noLink: true
    })
    // v3.3.17：弹窗是异步模态，期间窗口可能已经被销毁（托盘退出 / 上一次 quit）。
    // 对已销毁的 BrowserWindow 调 hide()/close() 会抛 "Object has been destroyed"。
    if (r.response === 2) return
    if (!win || win.isDestroyed()) return
    const toTray = r.response === 0
    if (r.checkboxChecked) {
      store.patch({ settings: { closeToTray: toTray, closeAsk: false } })
      refreshTrayMenu()
      logLine('[close] 记住选择：' + (toTray ? '最小化到托盘' : '直接退出') + '（不再提示）')
    } else {
      logLine('[close] 本次：' + (toTray ? '最小化到托盘' : '直接退出'))
    }
    if (toTray) { win.hide(); return }
    quitting = true
    win.close()
  } catch (err) {
    logLine('[close] 询问弹窗失败 ' + err.message + '，按托盘设置执行')
    // catch 里同样要判窗口存活，且异常不能再从 catch 逸出
    if (win && !win.isDestroyed()) {
      if (store.get().settings.closeToTray) win.hide()
      else { quitting = true; win.close() }
    }
  } finally {
    closeAskBusy = false
  }
}

/**
 * 显示主窗口。窗口已被销毁（退出清理的 20 秒窗口期内 window-all-closed 已触发）
 * 时重建一个 —— 以前只判 `if (win)`，销毁后点托盘会在原生回调里抛
 * "Object has been destroyed"，之后菜单就再也没反应了。
 */
function showMainWindow() {
  // v3.3.29：后台实例不把窗口拉到前台（托盘点击 / second-instance 都会走到这里）
  if (TEST_HIDDEN()) return
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  try { createWindow() } catch (e) { logLine('[win] 重建主窗口失败 ' + e.message) }
}

function refreshTrayMenu() {
  if (!tray) return
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      {
        label: '迷你模式',
        type: 'checkbox',
        checked: miniActive,
        click: () => applyMini(!miniActive)
      },
      { label: '桌面歌词', click: () => sendToRenderer('shortcut', 'dlyric') },
      {
        // v2.1：整队播完之后做什么。和「睡眠定时」是两件事——那个是到点暂停，这个看进度
        label: '播放结束后' + (POWER_LABEL[powerAfterQueue] ? '（' + POWER_LABEL[powerAfterQueue] + '）' : ''),
        submenu: ['off', 'shutdown', 'hibernate', 'quit'].map((k) => ({
          label: POWER_LABEL[k],
          type: 'radio',
          checked: powerAfterQueue === k,
          click: () => setPowerAfterQueue(k)
        }))
      },
      {
        label: '关闭时询问（点 × 弹窗选择）',
        type: 'checkbox',
        checked: store.get().settings.closeAsk !== false,
        click: (item) => store.patch({ settings: { closeAsk: item.checked } })
      },
      {
        label: '关闭时最小化到托盘',
        type: 'checkbox',
        checked: store.get().settings.closeToTray === true,
        click: (item) => store.patch({ settings: { closeToTray: item.checked } })
      },
      { type: 'separator' },
      // 第四轮 P1 #2：系统关机已下发（30 秒窗口）时同样要给「取消」入口
      ...((powerPending || systemShutdownPending) ? [{ label: '⚠ 取消关机 / 休眠', click: () => cancelPowerAction() }] : []),
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

/* ---------------- 音乐文件夹监视（v1.7） ---------------- */

/** 只关心这些扩展名：音源、歌词、同级封面。其他文件变动忽略，避免无意义的重扫。 */
const WATCH_EXTS = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.ape', '.wma',
  '.aiff', '.aif', '.dsf', '.dff', '.mka', '.lrc', '.jpg', '.jpeg', '.png', '.webp', '.bmp'
])
let watchers = []
let watchTimer = null

/** watcher 失效后的重挂定时器（见 startWatching 的 error 回调） */
let watchRebuildTimer = null
let watchRebuildCount = 0   // 连续重挂次数（成功挂上就归零）

function stopWatching() {
  for (const w of watchers) { try { w.close() } catch (e) { /* 已关 */ } }
  watchers = []
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null }
  if (watchRebuildTimer) { clearTimeout(watchRebuildTimer); watchRebuildTimer = null }
}

/**
 * 监听音乐目录（递归）。Windows 支持 recursive，大目录也没问题。
 * 变化后等 8 秒再扫：拷一张专辑会触发几十个事件，防抖能合成一次
 * （增量扫描本来只解析变了的文件，所以这一次很便宜）。
 */
/**
 * 排一次「整体重挂」：目录被删/改名、网络盘掉线、句柄耗尽、启动期不可达都走这里。
 * 退避上限 5 分钟，避免目录长期不可用时每 30 秒狂刷一轮 fs.watch。
 */
function scheduleWatchRebuild() {
  if (watchRebuildTimer) return
  watchRebuildCount = Math.min(watchRebuildCount + 1, 4)
  const delay = Math.min(30000 * Math.pow(2, watchRebuildCount - 1), 300000)
  watchRebuildTimer = setTimeout(() => {
    watchRebuildTimer = null
    try { startWatching() } catch (e) { /* 忽略 */ }
  }, delay)
  if (watchRebuildTimer.unref) watchRebuildTimer.unref()
}

function startWatching() {
  stopWatching()
  const s = store.get().settings
  if (s.watchFolders === false) { logLine('[watch] 已关闭'); return }
  const dirs = Array.isArray(s.musicDirs) ? s.musicDirs.filter(Boolean) : []
  for (const dir of dirs) {
    try {
      const w = fs.watch(dir, { recursive: true }, (evt, filename) => {
        if (!filename) return
        if (!WATCH_EXTS.has(path.extname(String(filename)).toLowerCase())) return
        scheduleWatchScan()
      })
      // v3.3.17：FSWatcher 收到 error（目录被删/改名、网络盘掉线、句柄耗尽）后就永久失效，
      // 但以前它仍留在 watchers 里、也没有任何重建路径 —— 用户拔插移动硬盘或改名再改回，
      // 之后所有新增曲目都不再自动入库，只剩手点扫描。
      w.on('error', (err) => {
        logLine('WARN watch 错误', dir, err.message)
        try { w.close() } catch (e) { /* 已关 */ }
        const i = watchers.indexOf(w)
        if (i >= 0) watchers.splice(i, 1)
        scheduleWatchRebuild()
      })
      watchers.push(w)
    } catch (err) {
      logLine('WARN watch 启动失败（目录不存在或无权限）', dir, err.message)
      // 第四轮 §4.1 #6：fs.watch 对「启动期不可达」的目录是**同步抛错**，
      // 走这里既不会产生 watcher，也就永远不会触发 error 事件 —— 自动增量入库
      // 在整个会话里彻底失效。catch 里同样排一次重挂（30 秒后，带退避上限）。
      scheduleWatchRebuild()
    }
  }
  if (watchers.length) watchRebuildCount = 0
  logLine('[watch] 监视 ' + watchers.length + ' 个目录')
}

function scheduleWatchScan() {
  if (watchTimer) clearTimeout(watchTimer)
  watchTimer = setTimeout(runWatchScan, 8000)
}

async function runWatchScan() {
  watchTimer = null
  if (library.scanning || activeScan) {
    // 正在扫（可能用户手动点了），等它结束再来
    scheduleWatchScan()
    return
  }
  const s = store.get().settings
  if (s.watchFolders === false) return
  logLine('[watch] 检测到文件变化，开始增量扫描')
  // v3.3.10：run 必须声明在 try 外 —— 上一版 const run 在 try 块内，
  // finally 里引用必然 ReferenceError → activeScan 永远清不掉，
  // 后续 watch 扫描全部失效（每 8 秒空转重试）+ 每次一个 unhandledRejection
  let run = null
  try {
    run = library.scan(s.musicDirs, (p) => {
      sendToRenderer('lib:scan-progress', {
        phase: p.phase, done: p.done, total: p.total,
        track: p.track ? toClientTrack(p.track) : null
      })
    })
    activeScan = run
    const res = await run
    if (res && res.skipped) return   // 别把 skipped 当成「扫描完成」广播出去
    logLine('[watch] 完成 ' + JSON.stringify({
      added: res.added, updated: res.updated, removed: res.removed, total: res.total, failed: res.failed
    }))
    sendToRenderer('lib:scan-done', res)
  } catch (err) {
    logLine('[watch] 扫描失败 ' + err.message)
  } finally {
    // v3.3.7：必须条件清空 —— watch 扫描运行中用户手动扫了库，activeScan 已被
    // 换成手动任务的 promise，这里无条件置 null 会让 lib:list 不再等手动扫描。
    // 注意不能再 scheduleWatchScan()：它是文件事件驱动的，这里无条件排一次
    // 会变成「每 16 秒空扫一遍全库」的死循环；扫描期间来的文件事件本来就有挂起的定时器兜底
    if (activeScan === run) activeScan = null
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
      // 第四轮 §4.1 #7：窗口被销毁后模块级 win 不会置 null，win.isVisible() 直接抛
      // "Object has been destroyed"。统一走 showMainWindow()，它已处理销毁/最小化/隐藏
      if (!win || win.isDestroyed()) { showMainWindow(); return }
      if (win.isVisible()) win.hide()
      else showMainWindow()
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

// 第四轮 §4.1 #1：第二实例带来的文件，窗口就绪后补发
let lastOpenFiles = null

// 共享状态访问器：全部走 getter（各子模块 init 注入后即时求值，无视声明顺序）
const G = {
  get logLine() { return logLine },
  get sendToRenderer() { return sendToRenderer },
  get toClientTrack() { return toClientTrack },
  get win() { return win },
  get tray() { return tray },
  get store() { return store },
  get library() { return library },
  get userData() { return userData },
  get quitting() { return quitting },
  get activeScan() { return activeScan },
  get lastOpenFiles() { return lastOpenFiles },
  get APP_NAME() { return APP_NAME },
  get DATA_DIR() { return DATA_DIR },
  get DEFAULT_SETTINGS() { return DEFAULT_SETTINGS },
  // v2.8.31：本地版没有在线直链缓存，但共享的 mpv-manager.js 在 mpv 报 file-error
  // 时会调 G.invalidateCurrentStream()（online 侧用于作废过期签名直链）。拆分时
  // 这个 getter 只加在 online 的 G 里，master 走到这条冷路径就抛 TypeError。
  // 本地版无需作废任何东西，给幂等 noop；不改共享文件以免扩大两侧差异。
  get invalidateCurrentStream() { return () => {} },
  get miniActive() { return miniActive },
  get isDev() { return isDev },
  get fsp() { return fsp },
  get Readable() { return Readable },
  get execFile() { return execFile },
  get MpvEngine() { return MpvEngine },
  get MIME_BY_EXT() { return MIME_BY_EXT },
}

const _MODS = [PROTO, SCHEMA, DLYW, MPVM].filter(Boolean)
for (const M of _MODS) M.init(G)


function sendToRenderer(channel, payload) {
  // v3.3.20：isDestroyed() 为 false 时 webContents 仍可能已经被销毁（窗口正在关，
  // 两个状态不同步），那时 .send() 会抛 "Object has been destroyed" —— 调用点大多在
  // 异步回调里，抛出去就是一次 uncaughtException。两道都判。
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return
  wc.send(channel, payload)
}

/** 只盯当前这首的 lrc：外面改了立刻通知渲染层重读，切歌时自动换监听 */
let lyricWatch = []
/** 当前在看的歌词文件（rename 后用它重建监视） */
let currentLyricFiles = []

function watchLyricFile(files, trackId) {
  for (const w of lyricWatch) { try { w.close() } catch (err) { /* 忽略 */ } }
  lyricWatch = []
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
  currentLyricFiles = list.slice()
  if (!list.length) return
  for (const f of list) {
    try {
      let closed = false
      const w = fs.watch(f, { persistent: false }, (evt) => {
        sendToRenderer('lyric:changed', trackId)
        // v3.3.17：多数编辑器保存 .lrc 是「写临时文件 + rename 覆盖」。
        // Windows 上旧 watcher 钉的是 inode，rename 后最多收到一次事件就永久静默 ——
        // 以前没有任何重建路径，用户在外面改完歌词界面就不再刷新。
        if (evt === 'rename' && !closed) {
          closed = true
          try { w.close() } catch (e) { /* 已关 */ }
          const i = lyricWatch.indexOf(w)
          if (i >= 0) lyricWatch.splice(i, 1)
          setTimeout(() => {
            if (currentLyricFiles.includes(f)) watchLyricFile(currentLyricFiles, trackId)
          }, 800).unref?.()
        }
      })
      // 第四轮 §4.2 #6：error 分支以前只吞错，watcher 永久失效 —— 用户在外面改 .lrc
      // 就再也不刷新。与 rename 分支一致地 close + 摘链 + 重建。
      w.on('error', () => {
        if (closed) return
        closed = true
        try { w.close() } catch (e) { /* 已关 */ }
        const i = lyricWatch.indexOf(w)
        if (i >= 0) lyricWatch.splice(i, 1)
        setTimeout(() => {
          if (currentLyricFiles.includes(f)) watchLyricFile(currentLyricFiles, trackId)
        }, 800).unref?.()
      })
      lyricWatch.push(w)
    } catch (err) { /* 监视不了就算了，mtime 兜底 */ }
  }
}

/* ---------------- 内嵌歌词（按音频 mtime 缓存） ---------------- */

/** trackId → { audioMtime, text }：同一份文件没被改过就不重复解析标签 */
const embLyricCache = new Map()
async function readEmbeddedCached(trackId, audioPath, audioMtime) {
  if (!audioPath || !audioMtime) return null
  const hit = embLyricCache.get(trackId)
  if (hit && hit.audioMtime === audioMtime) {
    // 第四轮 §4.2 #6：命中不刷新顺序 → 上限实际是 FIFO，热门曲目被反复淘汰后
    // 每次都要重新解析整首音频的标签
    embLyricCache.delete(trackId)
    embLyricCache.set(trackId, hit)
    return hit.text
  }
  const text = await readEmbeddedLyric(audioPath)
  embLyricCache.delete(trackId)   // v2.8.8：先删再插，淘汰才真的是「最久未用」
  embLyricCache.set(trackId, { audioMtime, text })
  // v2.8.7：加上限 —— 几千首全听一遍会攒几十 MB 歌词全文，不能无限涨
  if (embLyricCache.size > 500) embLyricCache.delete(embLyricCache.keys().next().value)
  return text
}



























/**
 * 注册全部 IPC 通道。
 *
 * 这里只做分发，具体通道按业务域拆到下面的 registerXxxIpc()：
 * 库 / 设置 / 歌单 / 用户数据 / 歌词 / 系统 / 窗口 / 桌面歌词 / mpv / 诊断 / 电源。
 * 拆分前是一个 500+ 行的巨型函数，改任意一个通道都要在整段里翻找；
 * 现在按域定位，通道名的先后顺序与原来完全一致（不影响行为）。
 */
function registerIpc() {
  registerLibraryIpc()
  registerSettingsIpc()
  registerPlaylistIpc()
  registerUserDataIpc()
  registerLyricIpc()
  registerSystemIpc()
  registerWindowIpc()
  registerDlyricIpc()
  registerMpvIpc()
  registerDiagIpc()
  registerPowerIpc()
}

/** 音乐库：列表与扫描 */
function registerLibraryIpc() {
  // —— 音乐库 ——
  // 扫库期间 lib:list 必须等待扫描结束，否则渲染进程会读到半成品列表
  ipcMain.handle('lib:list', async () => {
    if (activeScan) {
      try { await activeScan } catch { /* 扫描失败也用现有数据 */ }
    }
    return library.list().map(toClientTrack)
  })

  ipcMain.handle('lib:scan', async (event, dirs) => {
    // v3.3.13：已有扫描在跑时 library.scan() 会立刻返回 { skipped: true }。
    // 绝不能把这个 skipped 的 run 赋给 activeScan（会覆盖真扫描引用，
    // lib:list 的 await activeScan 便不再等待 → 渲染层读到半成品曲库），
    // 也不能广播「扫描完成」让界面提前收起进度。
    if (library.scanning || activeScan) {
      return { skipped: true, added: 0, updated: 0, removed: 0, failed: 0, total: library.list().length }
    }
    // v3.3.20：入参必须与 settings:patch 走同一把尺子。以前直接把渲染层传来的
    // dirs 交给 library.scan，任何目录都能被索引（越权读到文件名），
    // 而不在白名单里的根扫出来的曲目又播不了 —— 用户只看到「有歌名但放不出来」。
    // 全部被拒时不能退化成空扫描（空扫描会走清理阶段把曲目删光），直接报错。
    // 而且必须与 settings.musicDirs **求交集**：只做形状校验的话，路径照样能被索引，
    // 但扫出来的曲目过不了 isAllowedMediaPath —— 用户看到「有歌名、点了放不出来」。
    const fallbackDirs = store.get().settings.musicDirs
    const allowed = new Set((Array.isArray(fallbackDirs) ? fallbackDirs : [])
      .filter((d) => typeof d === 'string' && PROTO.isSafeMediaRoot(d))
      .map((d) => path.resolve(PROTO.fixDriveRoot(d)).toLowerCase()))
    const rawDirs = Array.isArray(dirs) && dirs.length ? dirs : fallbackDirs
    const targetDirs = (Array.isArray(rawDirs) ? rawDirs : [])
      .filter((d) => typeof d === 'string' && PROTO.isSafeMediaRoot(d)
        && allowed.has(path.resolve(PROTO.fixDriveRoot(d)).toLowerCase()))
    if (!targetDirs.length) {
      return { ok: false, error: '没有可用的音乐目录（路径不在允许范围内）', added: 0, updated: 0, removed: 0, failed: 0, total: library.list().length }
    }
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
      if (res && res.skipped) return res   // 竞态兜底：不要广播 skipped
      if (!sender.isDestroyed()) sender.send('lib:scan-done', res)
      // v3.3.23：扫描完成后后台预热内嵌封面（重启预热循环，自动停掉旧循环）
      try { library.startCoverWarmup() } catch (err) { /* 忽略 */ }
      return res
    } finally {
      if (activeScan === run) activeScan = null
    }
  })

}

/** 设置读写：patch 走键白名单 + 形状校验；目录/监视开关变化后重挂 watcher */
function registerSettingsIpc() {
  // —— 设置 ——
  ipcMain.handle('settings:get', () => store.get().settings)
  ipcMain.handle('settings:patch', (e, patch) => {
    const before = store.get().settings || {}
    // 第四轮 P1 #4：以前只做键白名单，**值完全不校验** —— volume:5 直接落盘后
    // audio.volume 赋值抛 IndexSizeError、fadeMs:-1000 让淡入淡出反向、
    // musicDirs 写入任意类型。改成按 DEFAULT_SETTINGS 形状做值校验 + 递归防原型污染。
    const filtered = SCHEMA.sanitizeSettingsPatch(patch, DEFAULT_SETTINGS)
    const blocked = []
    for (const k of Object.keys(patch && typeof patch === 'object' ? patch : {})) {
      if (!Object.prototype.hasOwnProperty.call(filtered, k)) blocked.push(k)
    }
    if (blocked.length) logLine('[settings] 拒绝非法/未知设置键:', blocked.join(', '))
    const prevDirs = JSON.stringify(before.musicDirs || [])
    const prevWatch = before.watchFolders
    const next = store.patch({ settings: filtered }).settings
    // 目录列表或监视开关变了 → 重新挂 watcher（v1.7）
    if (JSON.stringify(next.musicDirs || []) !== prevDirs || next.watchFolders !== prevWatch) {
      startWatching()
    }
    return next
  })

}

/** 歌单：增删改 + m3u/m3u8 导入导出 */
function registerPlaylistIpc() {
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
      entries = PROTO.decodeText(fs.readFileSync(file)).split(/\r?\n/)
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

}

/** 收藏 / 历史 / 播放次数 / 上次会话 */
function registerUserDataIpc() {
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
    // v2.8.9：改整体替换（Store.setKey）—— deepMerge 会让旧 session 的键永久残留
    store.setKey('session', session && typeof session === 'object' ? session : {})
    return true
  })

}

/** 歌词读取：返回 { text, mtimeMs }，并顺手监听对应 .lrc 的改动 */
function registerLyricIpc() {
  // —— 歌词 ——
  /**
   * v2.8.3：返回值从纯文本改成 { text, mtimeMs }，并顺手监听这个 lrc 文件。
   * 之前渲染层按 trackId 永久缓存解析结果，外面改完 .lrc 不重启就一直是旧词。
   */
  ipcMain.handle('lyric:read', async (e, trackId) => {
    const track = library.get(trackId)
    if (!track) {
      watchLyricFile(null)
      return null
    }

    const lrc = track.lyric || null
    const audio = track.path || null
    // 切歌热路径：两次 stat 改异步，避免网络盘/冷盘时同步阻塞主进程事件循环
    const mtimeOf = async (p) => { try { return p ? (await fsp.stat(p)).mtimeMs : 0 } catch (err) { return 0 } }
    const lrcMtime = await mtimeOf(lrc)
    const audioMtime = await mtimeOf(audio)

    // v2.8.4：外置 .lrc 与内嵌 LYRICS 谁改得新用谁。
    // 只比文件修改时间：改 .lrc 会让 lrc 变新，改标签（Mp3tag 等）会让音频变新，两边都不用手动选。
    // 之前固定外置优先，才出现「标签改了但界面还是旧词」。
    if (lrc && lrcMtime && lrcMtime >= audioMtime) {
      try {
        const buf = await fsp.readFile(lrc)
        watchLyricFile([lrc, audio], trackId)
        return { text: PROTO.decodeText(buf), mtimeMs: lrcMtime, source: 'lrc' }
      } catch (err) { /* 读不到就往下试内嵌 */ }
    }

    const emb = await readEmbeddedCached(trackId, audio, audioMtime)
    if (emb) {
      watchLyricFile([audio], trackId)
      return { text: emb, mtimeMs: audioMtime, source: 'embedded' }
    }

    if (lrc) {
      try {
        const buf = await fsp.readFile(lrc)
        watchLyricFile([lrc], trackId)
        return { text: PROTO.decodeText(buf), mtimeMs: lrcMtime, source: 'lrc' }
      } catch (err) { /* 忽略 */ }
    }
    watchLyricFile(null)
    return null
  })

}

/** 对话框与系统集成（选目录、资源管理器定位、版本信息） */
function registerSystemIpc() {
  // —— 对话框 / 系统集成 ——
  ipcMain.handle('dialog:pickDirs', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle('shell:showItem', (e, filePath) => {
    if (filePath && fs.existsSync(filePath) && PROTO.isAllowedMediaPath(filePath)) shell.showItemInFolder(filePath)
  })

  // —— v2.8.25 UI 美化：封面主色提取（渲染层主题色 =「跟随封面」时用） ——
  // 渲染层 canvas 取色会被 CSP / 跨域污染卡住，这里用 nativeImage 在主进程做：
  // 封面缓冲本来就按专辑缓存在 library 里（getCover），命中时零磁盘 IO。
  const accentCache = new Map()   // trackId -> '#rrggbb'
  ipcMain.handle('ui:accentForTrack', async (e, trackId) => {
    try {
      if (!trackId || typeof trackId !== 'string') return null
      if (accentCache.has(trackId)) return accentCache.get(trackId)
      const cov = G.library ? await G.library.getCover(trackId) : null
      if (!cov || !cov.buf || !cov.buf.length) return null
      const img = nativeImage.createFromBuffer(cov.buf)
      if (img.isEmpty()) return null
      const hex = accentFromImage(img)
      if (hex) {
        if (accentCache.size > 500) accentCache.clear()
        accentCache.set(trackId, hex)
      }
      return hex
    } catch {
      return null
    }
  })

}

/**
 * v2.8.25 UI 美化：从封面取一个可做主题色的主色。
 * 缩到 24x24 逐像素打分：饱和度高、亮度居中的像素入选，求平均后做
 * 亮度 / 饱和度规整（太暗提亮、太亮压暗、太灰拉开），保证做高亮色可读。
 * 失败一律返回 null，渲染层保持现有主题色（纯装饰，不能影响播放）。
 */
function accentFromImage(img) {
  try {
    const small = img.resize({ width: 24, height: 24 })
    const buf = small.toBitmap()   // BGRA
    let rs = 0, gs = 0, bs = 0, n = 0      // 入选像素
    let fr = 0, fg = 0, fb = 0, fn = 0     // 全图平均（兜底）
    for (let i = 0; i + 3 < buf.length; i += 4) {
      const b = buf[i], g = buf[i + 1], r = buf[i + 2]
      if (buf[i + 3] < 40) continue
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      const l = (max + min) / 510
      const sat = max === 0 ? 0 : (max - min) / max
      fr += r; fg += g; fb += b; fn++
      if (sat > 0.28 && l > 0.2 && l < 0.78) { rs += r; gs += g; bs += b; n++ }
    }
    if (!fn) return null
    let r, g, b
    if (n >= 8) { r = rs / n; g = gs / n; b = bs / n }
    else { r = fr / fn; g = fg / fn; b = fb / fn }
    const max0 = Math.max(r, g, b), min0 = Math.min(r, g, b)
    const l0 = (max0 + min0) / 510
    const sat0 = max0 === 0 ? 0 : (max0 - min0) / max0
    if (l0 < 0.32) { const k = 0.32 / Math.max(l0, 0.01); r *= k; g *= k; b *= k }
    if (l0 > 0.72) { const k = 0.72 / l0; r *= k; g *= k; b *= k }
    if (sat0 < 0.45) {
      const avg = (r + g + b) / 3
      const k = 1 + (0.45 - sat0)
      r = avg + (r - avg) * k
      g = avg + (g - avg) * k
      b = avg + (b - avg) * k
    }
    const cl = (v) => Math.max(0, Math.min(255, Math.round(v)))
    return '#' + [r, g, b].map((v) => cl(v).toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/** v2.8.32：窗口拖动状态（事件驱动，见 registerWindowIpc 里 win:drag-move 的注释） */
let windowDragOrigin = null
let windowDragBase = null
let windowDragLast = null
function stopWindowDrag() {
  windowDragBase = null
  windowDragLast = null
}

/** 窗口控制：最小化 / 最大化 / 关闭 / 迷你模式 */
function registerWindowIpc() {
  // —— 窗口控制 ——
  ipcMain.handle('win:minimize', () => win && win.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win) return false
    // v2.8.26：分支判断改用事件维护的 winMaxState（isMaximized() 只做兜底，
    // 覆盖「启动早期事件还没来得及触发」的边缘情况），返回值 = 切换意图。
    // v2.8.7 已知问题：isMaximized() 在无边框窗口上有滞后，快速连点时分支走错。
    const wasMax = winMaxState || win.isMaximized()
    if (wasMax) win.unmaximize()
    else win.maximize()
    // v3.3.29：maximize()/unmaximize() 在隐藏窗口上会隐式 show（放大键两连击
    // 实测必弹窗，且不触发 Electron 的 show 事件）。操作后立刻压回隐藏；
    // isMaximized() 状态不受 hide 影响，功能断言仍成立。
    if (TEST_HIDDEN()) win.hide()
    return !wasMax
  })
  ipcMain.handle('win:close', () => win && win.close())
  ipcMain.handle('win:isMaximized', () => (win ? win.isMaximized() : false))
  /* v2.8.27：标题栏拖动改主进程实现（渲染层 mousedown → 这里跟随光标 setBounds）。
     为什么弃用 -webkit-app-region: drag —— 实测（WM_NCHITTEST，125% 缩放）：
     drag 区域的系统命中矩形整体下移约 19px（恰等于系统标题栏高度 SM_CYCAPTION），
     y<19 返回 HTCLIENT、y>=19 全变 HTCAPTION，与 CSS 怎么改都无关。
     结果就是右上角按钮的下半截被当成标题栏，点击被系统吞掉（「按钮点不动，
     只能从窗口顶边往下点」）。改主进程拖动后窗口不再有 drag 矩形，整条标题栏
     都是 HTCLIENT，按钮怎么点都生效。 */
  ipcMain.on('win:drag-start', (e) => {
    if (!win || win.isDestroyed() || winMaxState || win.isFullScreen()) return
    if (BrowserWindow.fromWebContents(e.sender) !== win) return
    const b0 = win.getBounds()
    windowDragOrigin = { width: b0.width, height: b0.height }
    windowDragBase = { x: b0.x, y: b0.y }
    windowDragLast = null
  })
  /* v2.8.32：改事件驱动。v2.8.27 的 16ms 定时器轮询 cursor 实测只有
     34.6fps（60 次光标移动仅 34 次窗口更新），且每帧 screen.getCursorScreenPoint()
     + 同步 setBounds 双重开销。渲染层 pointermove（rAF 节流）送相对按下点的
     累计位移，这里只按位移落一次 setBounds，与合成器节奏对齐。 */
  ipcMain.on('win:drag-move', (e, dx, dy) => {
    if (!win || win.isDestroyed() || !windowDragBase || !windowDragOrigin) return
    if (BrowserWindow.fromWebContents(e.sender) !== win) return
    const x = windowDragBase.x + dx
    const y = windowDragBase.y + dy
    // 位移没变就不调 setBounds —— 每次调用都要过一遍 DIP↔物理换算
    if (windowDragLast && x === windowDragLast.x && y === windowDragLast.y) return
    windowDragLast = { x, y }
    // 必须显式带 width/height：125% 缩放下只传 x/y 会累积尺寸漂移（v2.8.27）
    win.setBounds({ x, y, width: windowDragOrigin.width, height: windowDragOrigin.height })
  })
  ipcMain.on('win:drag-end', () => {
    stopWindowDrag()
    // 拖动过程中难免累积一两个像素的舍入误差，松手后把尺寸拨回起始值
    if (!win || win.isDestroyed() || !windowDragOrigin) return
    const b = win.getBounds()
    if (b.width !== windowDragOrigin.width || b.height !== windowDragOrigin.height) {
      win.setBounds({ x: b.x, y: b.y, width: windowDragOrigin.width, height: windowDragOrigin.height })
    }
  })
  // 迷你模式：渲染层只表达意图，缩放/持久化都在主进程做
  ipcMain.handle('win:setMini', (e, on) => applyMini(!!on))
  ipcMain.handle('win:isMini', () => miniActive)
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    userData,
    // v2.8.42：渲染层据此把 <audio> 直接压静音（测试实例双保险，正常启动恒 false）
    testMute: process.env.LX_TEST_MUTE === '1'
  }))

}

/** 桌面歌词窗口：开关 / 解锁 / 数据与配置同步 */
function registerDlyricIpc() {
  // —— 桌面歌词 ——
  ipcMain.handle('dlyric:open', () => {
    store.patch({ settings: { desktopLyric: { enabled: true } } })
    DLYW.createLyricWindow()
    DLYW.notifyDlyricState()
    return DLYW.dlyricCfg()
  })
  ipcMain.handle('dlyric:close', () => {
    DLYW.closeLyricWindow()
    DLYW.notifyDlyricState()
    return true
  })
  ipcMain.handle('dlyric:isOpen', () => !!(DLYW.dlyricWin && !DLYW.dlyricWin.isDestroyed()))
  ipcMain.handle('dlyric:unlock', () => {
    store.patch({ settings: { desktopLyric: { locked: false } } })
    DLYW.applyDlyricLock()
    DLYW.notifyDlyricState()
    return DLYW.dlyricCfg()
  })
  // 主窗口 → 歌词窗口：当前歌词行（同时缓存，供窗口就绪时补发）
  ipcMain.handle('dlyric:state', (e, payload) => {
    DLYW.lastDlyricData = payload || null
    DLYW.sendToDlyric('dlyric:data', payload)
    return true
  })
  // 歌词窗口 → 主进程：配置修改（锁定/字号/颜色）→ 同步主窗口按钮
  ipcMain.handle('dlyric:cfg', (e, patch) => {
    // v3.3.13：复用 settings patch 过滤（只允许 desktopLyric 已有键 + 值校验 + 防原型污染）
    const clean = SCHEMA.sanitizeSettingsPatch(patch, DEFAULT_SETTINGS.desktopLyric)
    store.patch({ settings: { desktopLyric: clean } })
    DLYW.applyDlyricLock()
    DLYW.notifyDlyricState()
    return DLYW.dlyricCfg()
  })
  // 歌词窗口加载完成：立即回推一次完整配置 + 当前歌词行（否则要等下一句才出词）
  ipcMain.handle('dlyric:ready', (e) => {
    DLYW.replayDlyricState()
    return true
  })

}

/** 独占输出（mpv 后端）：启停 / 加载 / 传输控制 / 设备枚举与切换 / 释放 */
function registerMpvIpc() {
  // —— 独占输出（mpv 后端） ——
  ipcMain.handle('mpv:start', (e, exclusive) => MPVM.ensureMpv(exclusive !== false, { forceMode: true }))
  ipcMain.handle('mpv:load', (e, filePath, opts) => {
    // v2.8.7：引擎没跑起来还返回 true，渲染层会以为加载成功，界面假「播放中」
    if (!MPVM.mpvEngine || !MPVM.mpvEngine.running) return false
    // v2.8.8：本地文件只放行曲库/数据目录之内
    if (!/^https?:\/\//i.test(filePath) && !PROTO.isAllowedMediaPath(filePath)) {
      logLine('[mpv] 拒绝加载曲库目录之外的文件:', filePath)
      return false
    }
    MPVM.mpvEngine.load(filePath, opts || {})
    return true
  })
  ipcMain.handle('mpv:play', () => { if (MPVM.mpvEngine) MPVM.mpvEngine.play(); return true })
  ipcMain.handle('mpv:pause', () => { if (MPVM.mpvEngine) MPVM.mpvEngine.pause(); return true })
  ipcMain.handle('mpv:stop', () => { if (MPVM.mpvEngine) MPVM.mpvEngine.reset(); return true })
  ipcMain.handle('mpv:seek', (e, sec) => { if (MPVM.mpvEngine) MPVM.mpvEngine.seek(Number(sec) || 0); return true })
  ipcMain.handle('mpv:volume', (e, v) => { if (MPVM.mpvEngine) MPVM.mpvEngine.setVolume(Number(v) || 0); return true })
  ipcMain.handle('mpv:mute', (e, m) => { if (MPVM.mpvEngine) MPVM.mpvEngine.setMute(!!m); return true })
  // A-B 循环（v2.1）：a=null 清除
  ipcMain.handle('mpv:setAbLoop', (e, a, b) => {
    if (MPVM.mpvEngine) MPVM.mpvEngine.setAbLoop(a, b)
    return true
  })
  // v3.3.17：必须等进程真的退出，否则渲染层紧接着的 mpv:start 会与旧进程抢设备
  ipcMain.handle('mpv:quit', async () => { await MPVM.stopMpv().catch(() => {}); return true })
  // v2.8.6：完整的「释放独占」流程 —— 等进程真退出 + 扫残留孤儿 + 实测声卡
  ipcMain.handle('mpv:release', async () => {
    try {
      return await MPVM.releaseMpv({ probe: true })
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })
  // 只探测「声卡现在能不能给别人用」，不动引擎（诊断面板用）
  ipcMain.handle('mpv:probeDevice', async () => {
    try {
      return await MPVM.probeDeviceFree()
    } catch (err) {
      return { blocked: false, detail: err.message }
    }
  })
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
    let eng = null
    try {
      if (!MPVM.mpvEngine || !MPVM.mpvEngine.running) {
        const r = await MPVM.ensureMpv(false)
        if (!r.ok) return { ok: false, devices: [], error: r.error || '引擎未启动' }
        startedHere = true
      }
      eng = MPVM.mpvEngine
      const devices = await eng.listDevices()
      return { ok: true, devices }
    } catch (err) {
      return { ok: false, devices: [], error: err.message }
    } finally {
      // 只为枚举而临时拉起的引擎用完即关，不留空闲进程。
      // v3.3.9：但枚举的几百毫秒里用户可能点了播放（引擎被复用加载了文件），
      // 这时不能杀 —— 用「引擎还是同一个且从未加载过文件」作判据。
      // v3.3.13：枚举期间被切成独占的引擎（restart 不换实例也不改 _lastFile）不能误杀
      if (startedHere && MPVM.mpvEngine === eng && !eng._lastFile && eng.exclusive === false) MPVM.stopMpv().catch(() => {})
    }
  })

  /** 切换输出设备：存设置；正在独占播放时重启引擎并回到原位置 */
  ipcMain.handle('mpv:setDevice', async (e, device) => {
    const name = String(device || '')
    const prevDevice = String(store.get().settings.audioDevice || '')
    store.patch({ settings: { audioDevice: name } })
    if (!MPVM.mpvEngine || !MPVM.mpvEngine.running) return { ok: true, applied: false }
    if (!store.get().settings.exclusiveOutput) return { ok: true, applied: false }
    // v2.5：重启时带上当前音量（重启后不再被重置成 100；播放状态由 restart 内部恢复）
    const startVolume = Math.max(0, Math.min(1, Number(store.get().settings.volume ?? 1)))
    const r = await MPVM.mpvEngine.restart({ exclusive: true, audioDevice: name, volume: startVolume })
    // v3.3.13：重启彻底失败 → 设置回退到调用前的值，避免界面显示的设备与实际不符
    if (!r.ok) {
      store.patch({ settings: { ...store.get().settings, audioDevice: prevDevice } })
      return { ok: false, applied: true, error: r.error }
    }
    // 新设备起不来时 mpv.js 会退回原设备；这时设置也得跟着回退，否则界面显示的和实际用的不一致
    if (r.audioDevice && r.audioDevice !== name) {
      store.patch({ settings: { ...store.get().settings, audioDevice: r.audioDevice } })
      return { ok: true, applied: true, reverted: true, device: r.audioDevice, error: '该设备不可用，已退回原设备' }
    }
    return { ok: true, applied: true, error: r.error }
  })

}

/** 诊断面板：环境快照 / 失败清单 / mpv 日志 / 日志文件 */
function registerDiagIpc() {
  /* ---------------- 诊断面板（v1.8） ---------------- */

  // 环境快照：版本、路径、引擎状态、曲库规模
  ipcMain.handle('diag:info', () => {
    const s = store.get().settings || {}
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
      dataDir: DATA_DIR,
      logFile: LOG_FILE,
      musicDirs: s.musicDirs || [],
      exclusiveOutput: s.exclusiveOutput === true,
      audioDevice: s.audioDevice || '',
      watchFolders: s.watchFolders !== false,
      mpvExe: MPVM.mpvExePath(),
      mpvExeExists: (() => { try { return fs.existsSync(MPVM.mpvExePath()) } catch { return false } })(),
      mpvRunning: !!(MPVM.mpvEngine && MPVM.mpvEngine.running),
      mpvExclusive: MPVM.mpvEngine ? !!MPVM.mpvEngine.exclusive : null,
      mpvFellBack: MPVM.mpvEngine ? !!MPVM.mpvEngine.fellBack : false,
      trackCount: library.list().length,
      failureCount: library.listFailures().length,
      scanning: !!activeScan || library.scanning
    }
  })

  // 解析失败清单（完整路径 + 原因；文件是否还在另行核对）
  ipcMain.handle('diag:failures', async () => {
    const raw = library.listFailures()
    // v3.3.17：改异步 + 限流并发。以前逐条同步 existsSync，几千条失败记录
    // 里混着已掉线的网络盘路径时，单次调用能阻塞主进程数秒
    const limit = 16
    const out = new Array(raw.length)
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const i = cursor++
        if (i >= raw.length) return
        let exists = false
        try { exists = !!(await fsp.stat(raw[i].path)) } catch (e) { exists = false }
        out[i] = { ...raw[i], exists }
      }
    }
    await Promise.all(new Array(Math.min(limit, raw.length)).fill(0).map(worker))
    const counts = { parse: 0, metadata: 0, stat: 0, duration: 0 }
    for (const f of out) counts[f.stage] = (counts[f.stage] || 0) + 1
    return { ok: true, failures: out, counts }
  })

  // mpv 实时日志：按 seq 增量取，避免每次重画整个列表
  ipcMain.handle('diag:mpvLog', (e, sinceSeq) => {
    const since = Number(sinceSeq) || 0
    return {
      ok: true,
      seq: MPVM.mpvLogSeq,
      entries: MPVM.mpvLogs.filter((x) => x.seq > since),
      running: !!(MPVM.mpvEngine && MPVM.mpvEngine.running),
      exclusive: MPVM.mpvEngine ? !!MPVM.mpvEngine.exclusive : null
    }
  })

  // 日志文件尾部（含启动阶段 stage:* 与外挂进程相关行）
  ipcMain.handle('diag:logTail', async (e, maxLines) => {
    const n = Math.max(50, Math.min(4000, Number(maxLines) || 400))
    try {
      const st = await fsp.stat(LOG_FILE)
      const readBytes = Math.min(st.size, 256 * 1024)   // 只读尾部 256 KB，日志再大也不卡
      const fd = await fsp.open(LOG_FILE, 'r')
      let text = ''
      try {
        const buf = Buffer.alloc(readBytes)
        await fd.read(buf, 0, readBytes, st.size - readBytes)
        text = buf.toString('utf8')
      } finally {
        await fd.close()
      }
      // v3.3.17：从文件中间切会切在多字节字符上，丢掉首个换行之前的残行
      if (readBytes < st.size) {
        const nl = text.indexOf('\n')
        text = nl >= 0 ? text.slice(nl + 1) : text
      }
      const lines = text.split(/\r?\n/).filter((l) => l.length)
      // truncated 必须同时看「文件还有更多内容」，否则大日志会被当成完整内容
      const fileHasMore = readBytes < st.size
      return {
        ok: true,
        lines: lines.slice(-n),
        file: LOG_FILE,
        size: st.size,
        readBytes,
        truncated: fileHasMore || lines.length > n
      }
    } catch (err) {
      return { ok: false, error: err.message, lines: [], file: LOG_FILE }
    }
  })

  ipcMain.handle('diag:openLog', () => {
    try {
      if (fs.existsSync(LOG_FILE)) shell.showItemInFolder(LOG_FILE)
      else shell.openPath(DATA_DIR)
    } catch {}
    return true
  })

  ipcMain.handle('diag:clearFailures', async () => {
    const n = library.clearAllFailures()
    await library.persistFailures()
    logLine('[diag] 已清空失败清单 ' + n + ' 条')
    return { ok: true, cleared: n }
  })

  // 剪贴板：file:// 页面里 navigator.clipboard 与 execCommand('copy') 都不可靠，
  // 必须走主进程的 clipboard 模块（诊断面板要能一键复制给下一个人看）
  ipcMain.handle('diag:copy', (e, text) => {
    try {
      clipboard.writeText(String(text == null ? '' : text))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

}

/** 播放结束后动作（关机/休眠）+ 睡眠定时 */
function registerPowerIpc() {
  /* ---------------- 播放结束后动作 / A-B（v2.1） ---------------- */

  // 渲染层上报"整队播完"（列表回卷 / 顺序模式最后一首结束）
  ipcMain.on('player:queue-end', (e) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return
    runPowerAction()
  })
  ipcMain.handle('power:get', () => powerAfterQueue)
  ipcMain.handle('power:set', (e, kind) => { setPowerAfterQueue(kind); return powerAfterQueue })
  ipcMain.handle('power:cancel', () => cancelPowerAction())

  // 睡眠定时（v2.2：入口从托盘移到 app 内播放条）
  ipcMain.handle('sleep:set', (e, minutes) => { setSleepTimer(minutes); return { minutes: sleepMinutes, endsAt: sleepEndsAt || null } })
  ipcMain.handle('sleep:get', () => ({ minutes: sleepMinutes, endsAt: sleepEndsAt || null }))
}


/** 转成渲染层用的精简结构（路径换成自定义协议 URL） */
function toClientTrack(t) {
  return {
    id: t.id,
    path: t.path,
    // 所属目录（v1.7）：文件夹视图按它分组，渲染层不好自己切路径
    dir: t.path ? path.dirname(t.path) : '',
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
    // 入库时间（v1.9）：「最近添加」视图与 addedAt 排序用
    addedAt: t.addedAt || t.mtime || 0,
    // v2.0：DSD 标记（普通输出放不了，界面要标注）与 ReplayGain 标签
    isDsd: !!t.isDsd,
    rgTrackDb: t.rgTrackDb == null ? null : t.rgTrackDb,
    rgAlbumDb: t.rgAlbumDb == null ? null : t.rgAlbumDb,
    hasLyric: !!t.lyric,
    // 拼音检索字段（v1.6）：主进程预先算好，渲染层只做 includes
    py: t.py || '',
    pyf: t.pyf || '',
    // 内嵌封面走 lxcover://（内存 LRU），同目录的封面图仍走 lxfile://
    cover: t.cover === COVER_EMBEDDED
      ? 'lxcover://local/' + encodeURIComponent(t.id)
      : PROTO.toLxUrl(resolveCoverPath(t.cover, library.coverDir)),
    audio: PROTO.toLxUrl(t.path)
  }
}

/* ---------------- 启动 ---------------- */

logLine('stage: dataDir=' + DATA_DIR)
// v3.3.29：后台模式自检日志。排查「窗口弹出」时先看这一行的 testHidden 值。
logLine('stage: testHidden=' + TEST_HIDDEN() + ' raw=' + String(process.env.LX_TEST_HIDDEN))

// 单实例锁：拿不到锁 = 已有实例在运行（Electron 会向其发送 second-instance 事件，
// 由那边弹出/聚焦窗口）。此时本进程必须直接退出，否则会开双实例（抢 mpv、抢缓存）。
let gotLock = false
try {
  gotLock = app.requestSingleInstanceLock()
} catch (err) {
  // v2.8.9：锁 API 抛异常 ≠ 已有实例在跑。以前 gotLock 保持 false 直接退出，
  // 变成「永远启动不了」（data 目录被杀软锁定等便携环境常见）。fail-open 更安全
  logLine('WARN 单实例锁异常，按拿到锁处理', err.message)
  gotLock = true
}
logLine('stage: lock=' + gotLock)
if (!gotLock) {
  logLine('已有实例在运行，本进程退出')
  app.exit(0)
}

// 只在确认是唯一实例时清缓存：多实例情况下删的是正在运行实例的文件（多半删不掉）
if (gotLock) cleanChromiumCache().catch(() => {})
{
  app.on('second-instance', async (event, argv) => {
    // v3.3.29：第二实例启动绝不把已有窗口 show/restore/focus —— 这是「窗口弹出 +
    // 抢前台焦点」的直接来源。argv 文件参数处理保持原样，不因后台模式丢失。
    if (!TEST_HIDDEN()) {
      if (win && !win.isDestroyed()) {
        if (!win.isVisible()) win.show()
        if (win.isMinimized()) win.restore()
        win.focus()
      } else {
        showMainWindow()
      }
    }
    // v3.3.10：第二实例带的文件参数以前被完全忽略（双击关联文件/拖到 exe 上毫无反应）。
    // 应用按「文件夹」组织曲库、单文件导入尚未实现，先把路径转给渲染层给出可见反馈
    // v3.3.13：路径统一 resolve 成绝对路径；stat 改异步；缓存 payload 供窗口就绪后补发
    const media = []
    for (const raw of (argv || [])) {
      const a = String(raw)
      if (a.length > 240 || a.startsWith('\\\\') ||
          !/\.(mp3|flac|m4a|wav|ogg|opus|dsf|dff|aac|wma|ape|alac|m3u|m3u8)$/i.test(a)) continue
      const abs = path.resolve(a)
      try {
        const st = await fsp.stat(abs)
        if (st.isFile()) media.push(abs)
      } catch (e) { /* 排除目录/不存在/UNC 阻塞 */ }
    }
    if (media.length) {
      const payload = { paths: media }
      const wc = win && !win.isDestroyed() ? win.webContents : null
      const ready = wc && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed()) && !wc.isLoading()
      // 页面已就绪就直接送达并清空缓存；否则留给 did-finish-load 补发。
      // 以前送达后不清空，页面重载时会重复补发一批旧文件
      if (ready) {
        sendToRenderer('open-files', payload)
        lastOpenFiles = null
      } else {
        lastOpenFiles = payload
      }
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
    // v2.1：恢复「播放结束后」的设定（关机这类动作要跨重启记住）
    powerAfterQueue = store.get().settings.powerAfterQueue || 'off'

    // 异步清上次残留的 mpv，不阻塞启动
    // v2.8.40：主题色一次性迁到「跟随封面」。
    // 老版本默认是裸色值 #31c27c，用户从没改过的话应跟着新默认走；
    // 自己选过预设（green/cyan/purple/orange/ocean）的保持原样，不硬改。
    {
      const st0 = store.get().settings
      if (!st0.accentAutoMigrated) {
        const legacy = String(st0.accent || '').toLowerCase()
        const patch = { accentAutoMigrated: true }
        if (!legacy || legacy === '#31c27c') patch.accent = 'auto'
        store.patch({ settings: { ...st0, ...patch } })
        logLine('[settings] 主题色迁移 →', patch.accent || st0.accent)
      }
    }

    killOrphanMpv()

    library = new Library({
      cacheFile: path.join(userData, 'library.json'),
      coverDir: path.join(userData, 'covers'),
      lyricDir: path.join(userData, 'lyrics')
    })

    PROTO.registerFileProtocol()
    PROTO.registerCoverProtocol()
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
        .then((res) => {
          if (res && res.skipped) return
          sendToRenderer('lib:scan-done', res)
          // v3.3.23：扫描完成后后台预热内嵌封面（串行节流，不抢 IO）
          try { library.startCoverWarmup() } catch (err) { /* 忽略 */ }
        })
        .catch((err) => console.error('[library] 首次扫描失败:', err))
        .finally(() => { if (activeScan === run) activeScan = null })
    } else {
      // v3.3.23：缓存直接加载（无扫描）——避开启动高峰 5 秒后开始预热
      setTimeout(() => { try { if (library) library.startCoverWarmup() } catch (err) { /* 忽略 */ } }, 5000).unref?.()
    }

    createWindow()
    createTray()
    startWatching()
    const failed = registerShortcuts()
    if (failed.length) console.warn('[shortcut] 注册失败:', failed.join(', '))

    // 上次开着桌面歌词 → 启动时恢复
    if (store.get().settings.desktopLyric && store.get().settings.desktopLyric.enabled) {
      DLYW.createLyricWindow()
    }

    app.on('activate', () => {
      if (TEST_HIDDEN()) return
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else if (win) win.show()
    })
  }).catch((err) => {
    // v3.3.20：启动链任何一步抛错（store/library 初始化、registerIpc、createWindow）
    // 以前都是一个没人接的 rejection —— 界面永远不出现，用户只看到「双击没反应」，
    // 连日志都不知道去哪找。这里至少给出可见提示再退出。
    try { logLine('FATAL 启动失败: ' + ((err && err.stack) || err)) } catch (e) { /* 忽略 */ }
    try {
      const { dialog } = require('electron')
      dialog.showErrorBox('启动失败', '播放器初始化出错，无法打开窗口。\n\n' + String((err && err.message) || err))
    } catch (e) { /* 无 GUI 环境 */ }
    app.exit(1)
  })

  // v2.8.9：托盘「退出」的最后一次窗口 bounds patch 发生在窗口 close 事件里
  // （晚于 before-quit 里的 flush），这里再兜一次，不然去抖定时器会被进程退出吞掉
  app.on('will-quit', () => { try { if (store) store.flush() } catch (err) { /* 忽略 */ } })

  // v2.8.7：退出前必须等清理真正做完再退 ——
  // 以前 stopMpv 的 Promise 没 await，后面的同步清扫还会阻塞事件循环，
  // 让「等 mpv 进程退出」形同虚设；进程万一没死透就退出，声卡就被孤儿占着。
  let quitCleanupDone = false
  // 第四轮 P1 #1：before-quit 第一行就读 cleanupStarted，本地版从未声明 ——
  // 严格模式下立即抛错，而且发生在 event.preventDefault() 之前，整条退出收敛链
  // （stopMpv / sweepOurMpv / store.flush / tray.destroy）根本没跑，留下霸占声卡的孤儿 mpv
  let cleanupStarted = false
  app.on('before-quit', (event) => {
    // v3.3.13：一进入就置位，清理窗口内重复 app.quit() 不再重复跑整条链；
    // 未清理完前顺手 preventDefault，避免重复退出请求把进程提前带走、腰斩清理
    if (cleanupStarted) {
      if (!quitCleanupDone) event.preventDefault()
      return
    }
    cleanupStarted = true
    event.preventDefault()
    quitting = true
    stopWatching()
    // v3.3.23：中止封面后台预热，退出链不再被 setTimeout 拖着
    try { if (library) library.stopCoverWarmup() } catch (err) { /* 忽略 */ }
    const hadEngine = !!MPVM.mpvEngine
    // v3.3.13：清理链必须能收敛 —— stopMpv 的 Promise 万一永不 settle，
    // 也不能让用户只能 taskkill。20 秒后无条件退出（> _stopProcess 最坏 8.2s + sweep 8s）。
    const finishQuit = () => {
      if (quitCleanupDone) return
      quitCleanupDone = true
      try { if (store) store.flush() } catch (err) { /* 忽略 */ }
      try { if (tray) tray.destroy() } catch (err) { /* 忽略 */ }
      app.quit()
    }
    const quitGuard = setTimeout(() => {
      // 兜底：清理链没收敛也要退。best-effort 短超时清一次孤儿 mpv，
      // 用硬超时保证 finishQuit 一定执行，绝不长时间阻塞事件循环
      const hard = setTimeout(finishQuit, 3500)
      try {
        MPVM.sweepOurMpv(2000, 1500).catch(() => {}).finally(() => {
          clearTimeout(hard)
          finishQuit()
        })
      } catch (e) { clearTimeout(hard); finishQuit() }
    }, 20000)
    try {
      MPVM.stopMpv().catch(() => {}).finally(() => {
        (async () => {
          if (hadEngine) { try { await MPVM.sweepOurMpv() } catch (err) { /* 忽略 */ } }
          clearTimeout(quitGuard)
          finishQuit()
        })()
      })
    } catch (err) {
      clearTimeout(quitGuard)
      finishQuit()
    }
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
