'use strict'
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('api', {
  // 音乐库
  listTracks: () => invoke('lib:list'),
  scan: (dirs) => invoke('lib:scan', dirs),
  onScanProgress: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('lib:scan-progress', h)
    return () => ipcRenderer.removeListener('lib:scan-progress', h)
  },
  /** 扫描结束（含主进程启动时的自动建库）通知 */
  onScanDone: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('lib:scan-done', h)
    return () => ipcRenderer.removeListener('lib:scan-done', h)
  },

  // 设置
  getSettings: () => invoke('settings:get'),
  patchSettings: (patch) => invoke('settings:patch', patch),

  // 歌单
  getPlaylists: () => invoke('playlists:get'),
  createPlaylist: (name) => invoke('playlists:create', name),
  updatePlaylist: (id, patch) => invoke('playlists:update', { id, patch }),
  removePlaylist: (id) => invoke('playlists:remove', id),
  addToPlaylist: (id, trackIds) => invoke('playlists:addTracks', { id, trackIds }),
  removeFromPlaylist: (id, trackIds) => invoke('playlists:removeTracks', { id, trackIds }),
  /** 导出为 m3u/m3u8（主进程按 id 反查真实路径并写文件） */
  exportM3u: (name, trackIds) => invoke('playlist:exportM3u', { name, trackIds }),
  /** 导入 m3u/m3u8 → {ok, name, trackIds, unmatched} */
  importM3u: () => invoke('playlist:importM3u'),

  // 收藏 / 历史 / 次数 / 会话
  getFavorites: () => invoke('favorites:get'),
  toggleFavorite: (trackId) => invoke('favorites:toggle', trackId),
  getHistory: () => invoke('history:get'),
  addHistory: (trackId) => invoke('history:add', trackId),
  getPlayCounts: () => invoke('playcount:get'),
  incPlayCount: (trackId) => invoke('playcount:inc', trackId),
  getSession: () => invoke('session:get'),
  setSession: (s) => invoke('session:set', s),

  // 歌词
  readLyric: (trackId) => invoke('lyric:read', trackId),

  /* ---- 联网版（v3.0）：在线音乐 ---- */
  onlineSources: () => invoke('online:sources'),
  onlineProxyBase: () => invoke('online:proxyBase'),
  onlineSearch: (opts) => invoke('online:search', opts),
  /** 解析播放地址：{ ok, streamUrl, song, fallback, partial, bitrate, error } */
  onlinePlayable: (song) => invoke('online:playable', song),
  onlineLyric: (song) => invoke('online:lyric', song),
  onlineDownload: (song) => invoke('online:download', song),
  onlineCancelDownload: (key) => invoke('online:cancelDownload', key),
  onlinePickDownloadDir: () => invoke('online:pickDownloadDir'),
  onlineOpenDownloadDir: () => invoke('online:openDownloadDir'),
  onlineCacheInfo: () => invoke('online:cacheInfo'),
  onlineCacheClear: () => invoke('online:cacheClear'),
  onlinePickCacheDir: () => invoke('online:pickCacheDir'),
  onlineOpenCacheDir: () => invoke('online:openCacheDir'),
  onNowPlaying: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('online:now-playing', h)
    return () => ipcRenderer.removeListener('online:now-playing', h)
  },
  onDownloadProgress: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('online:download-progress', h)
    return () => ipcRenderer.removeListener('online:download-progress', h)
  },
  onDownloadDone: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('online:download-done', h)
    return () => ipcRenderer.removeListener('online:download-done', h)
  },

  // 系统
  pickDirs: () => invoke('dialog:pickDirs'),
  showInFolder: (p) => invoke('shell:showItem', p),
  appInfo: () => invoke('app:info'),

  // 窗口
  minimize: () => invoke('win:minimize'),
  toggleMaximize: () => invoke('win:toggleMaximize'),
  closeWindow: () => invoke('win:close'),
  isMaximized: () => invoke('win:isMaximized'),
  /** 通知主进程播放状态，用于更新任务栏缩略图媒体按钮 */
  setPlayState: (playing) => ipcRenderer.send('win:play-state', !!playing),
  /** 迷你模式：true=进迷你，false=回完整模式；返回实际状态 */
  setMini: (on) => invoke('win:setMini', on),
  isMini: () => invoke('win:isMini'),
  /** 迷你状态被主进程改动（托盘/快捷键/启动恢复）时同步给界面 */
  onMiniState: (cb) => {
    const h = (_e, st) => cb(st)
    ipcRenderer.on('win:mini-state', h)
    return () => ipcRenderer.removeListener('win:mini-state', h)
  },

  // 全局快捷键
  onShortcut: (cb) => {
    const h = (_e, action) => cb(action)
    ipcRenderer.on('shortcut', h)
    return () => ipcRenderer.removeListener('shortcut', h)
  },

  /** 睡眠定时到点（v1.7），收到后淡出并暂停 */
  onSleepTimer: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('sleep-timer', h)
    return () => ipcRenderer.removeListener('sleep-timer', h)
  },
  /* ---- 睡眠定时（v2.2：入口从托盘移到 app 内播放条） ---- */
  /** minutes=0 表示关闭；返回 {minutes, endsAt} */
  setSleepTimer: (minutes) => invoke('sleep:set', minutes),
  getSleepState: () => invoke('sleep:get'),
  /** 定时被设置/到点/清除时，主进程推最新状态 */
  onSleepState: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('sleep-state', h)
    return () => ipcRenderer.removeListener('sleep-state', h)
  },

  // 桌面歌词（主窗口 ↔ 主进程 ↔ 歌词窗口）
  dlyricOpen: () => invoke('dlyric:open'),
  dlyricClose: () => invoke('dlyric:close'),
  dlyricIsOpen: () => invoke('dlyric:isOpen'),
  dlyricUnlock: () => invoke('dlyric:unlock'),
  dlyricState: (payload) => invoke('dlyric:state', payload),
  dlyricCfg: (patch) => invoke('dlyric:cfg', patch),
  dlyricReady: () => invoke('dlyric:ready'),
  onDlyricData: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('dlyric:data', h)
    return () => ipcRenderer.removeListener('dlyric:data', h)
  },
  onDlyricCfg: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('dlyric:cfg', h)
    return () => ipcRenderer.removeListener('dlyric:cfg', h)
  },
  /** 桌面歌词开/关状态变化（含歌词窗口自行关闭） */
  onDlyricOpenState: (cb) => {
    const h = (_e, open) => cb(open)
    ipcRenderer.on('dlyric:open-state', h)
    return () => ipcRenderer.removeListener('dlyric:open-state', h)
  },

  /* ---- 独占输出（mpv 后端，v1.5） ---- */
  mpvStart: (exclusive) => invoke('mpv:start', exclusive),
  mpvLoad: (filePath, opts) => invoke('mpv:load', filePath, opts),
  mpvPlay: () => invoke('mpv:play'),
  mpvPause: () => invoke('mpv:pause'),
  mpvStop: () => invoke('mpv:stop'),
  mpvSeek: (sec) => invoke('mpv:seek', sec),
  mpvVolume: (v) => invoke('mpv:volume', v),
  mpvMute: (m) => invoke('mpv:mute', m),
  mpvQuit: () => invoke('mpv:quit'),
  mpvConfirmEnable: () => invoke('mpv:confirmEnable'),
  /** 枚举 WASAPI 输出设备 → {ok, devices:[{name,description}], error?} */
  mpvDevices: () => invoke('mpv:devices'),
  /** 切换独占输出设备（'' = 跟随系统默认） */
  mpvSetDevice: (device) => invoke('mpv:setDevice', device),
  onMpvEvent: (cb) => {
    const h = (_e, evt) => cb(evt)
    ipcRenderer.on('mpv:event', h)
    return () => ipcRenderer.removeListener('mpv:event', h)
  },

  /* ---- 诊断面板（v1.8） ---- */
  /** 环境快照：版本 / 路径 / 引擎状态 / 曲库规模 */
  diagInfo: () => invoke('diag:info'),
  /** 解析失败清单 → {ok, failures:[{path,fileName,ext,stage,error,at,exists}], counts} */
  diagFailures: () => invoke('diag:failures'),
  /** mpv 实时日志（按 seq 增量） → {ok, seq, entries:[{seq,at,level,text}], running, exclusive} */
  diagMpvLog: (sinceSeq) => invoke('diag:mpvLog', sinceSeq),
  /** 日志文件尾部 → {ok, lines[], file, size, truncated} */
  diagLogTail: (maxLines) => invoke('diag:logTail', maxLines),
  diagOpenLog: () => invoke('diag:openLog'),
  diagClearFailures: () => invoke('diag:clearFailures'),
  /** 走主进程剪贴板（file:// 下 navigator.clipboard 不可用） */
  diagCopy: (text) => invoke('diag:copy', text),

  /* ---- A-B 循环 / 播放结束后动作（v2.1） ---- */
  /** 独占模式下交给 mpv 做 A-B 循环（a=null 清除） */
  mpvSetAbLoop: (a, b) => invoke('mpv:setAbLoop', a, b),
  /** 上报"整队播完"，主进程按设置决定是否关机/休眠 */
  notifyQueueEnd: () => ipcRenderer.send('player:queue-end'),
  powerGet: () => invoke('power:get'),
  powerSet: (kind) => invoke('power:set', kind),
  powerCancel: () => invoke('power:cancel'),
  /** 播放结束后动作被触发/取消（界面用它显示倒计时与取消按钮） */
  onPowerAction: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('power-action', h)
    return () => ipcRenderer.removeListener('power-action', h)
  },
  onPowerAfterQueue: (cb) => {
    const h = (_e, kind) => cb(kind)
    ipcRenderer.on('power-after-queue', h)
    return () => ipcRenderer.removeListener('power-after-queue', h)
  },
  /** 独占输出设备被拔掉 / 插回来 */
  onDeviceLost: (cb) => {
    const h = (_e, payload) => cb(payload)
    ipcRenderer.on('device-lost', h)
    return () => ipcRenderer.removeListener('device-lost', h)
  }
})
