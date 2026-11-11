'use strict'
/**
 * preload：渲染层与主进程之间唯一的通道白名单。
 *
 * 两个约定：
 *  - 所有请求/响应走 invoke（返回 Promise），只有「单向通知」才用 send；
 *  - 所有主进程推送统一用下面的 on() 收口，保证「注册」与「取消订阅」成对出现。
 */
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

/**
 * 订阅一个主进程推送通道。
 *
 * 以前每个订阅都手写一遍 `ipcRenderer.on` + `removeListener`，20 多处重复；
 * 漏写 removeListener 或把 handler 写成不同的函数引用都会导致监听泄漏
 * （渲染层重建界面后旧回调还在跑）。这里统一收口，语义与原来完全一致：
 * 回调签名是 `cb(payload)`，返回值是取消订阅函数。
 *
 * @param {string} channel IPC 通道名（必须在主进程的推送白名单内）
 * @param {(payload:any)=>void} cb 回调
 * @returns {() => void} 取消订阅
 */
const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('api', {
  // 音乐库
  listTracks: () => invoke('lib:list'),
  scan: (dirs) => invoke('lib:scan', dirs),
  onScanProgress: (cb) => on('lib:scan-progress', cb),
  /** 扫描结束（含主进程启动时的自动建库）通知 */
  onScanDone: (cb) => on('lib:scan-done', cb),

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
  /** v2.8.25 UI 美化：取本地内嵌封面主色（主题色=跟随封面）→ '#rrggbb' | null */
  accentForTrack: (trackId) => invoke('ui:accentForTrack', trackId),
  getSession: () => invoke('session:get'),
  setSession: (s) => invoke('session:set', s),

  // 歌词
  readLyric: (trackId) => invoke('lyric:read', trackId),
  onLyricChanged: (cb) => on('lyric:changed', cb),

  /* ---- 联网版（v3.0）：在线音乐 ---- */
  onlineSources: () => invoke('online:sources'),
  onlineProxyBase: () => invoke('online:proxyBase'),
  onlineSearch: (opts) => invoke('online:search', opts),
  /** 解析播放地址：{ ok, song, fallback, partial, lossless, level, bitrate, ext, error } */
  onlinePlayable: (song) => invoke('online:playable', song),
  /** v3.3.18（第四轮 P1 #7）：<audio> 报错时作废该曲直链缓存，返回 { ok, hit } */
  onlineInvalidate: (song) => invoke('online:invalidate', song),
  onlineProbe: (song) => invoke('online:probe', song),
  onlineLyric: (song) => invoke('online:lyric', song),
  onlineDownload: (song) => invoke('online:download', song),
  // 第四轮 §4.5.3 #16：onlineCancelDownload 是死接口（映射到 online:dlDelete，全项目无消费方），已移除
  onlineDlList: () => invoke('online:dlList'),
  onlineDlPause: (id) => invoke('online:dlPause', id),
  onlineDlResume: (id) => invoke('online:dlResume', id),
  onlineDlDelete: (id) => invoke('online:dlDelete', id),
  onlineDlClearDone: () => invoke('online:dlClearDone'),
  onlineDlReveal: (id) => invoke('online:dlReveal', id),
  onlinePickDownloadDir: () => invoke('online:pickDownloadDir'),
  onlineOpenDownloadDir: () => invoke('online:openDownloadDir'),
  onlineCacheInfo: () => invoke('online:cacheInfo'),
  onlineCacheClear: () => invoke('online:cacheClear'),
  onlinePickCacheDir: () => invoke('online:pickCacheDir'),
  onlineOpenCacheDir: () => invoke('online:openCacheDir'),
  onlineExtraKeyGet: () => invoke('online:extraKeyGet'),
  onlineExtraKeySet: (key) => invoke('online:extraKeySet', key),
  onlineOpenChksz: () => invoke('online:openChksz'),
  onlineQingGet: () => invoke('online:qingGet'),
  onlineQingSet: (enabled) => invoke('online:qingSet', enabled),
  onlineQingTest: () => invoke('online:qingTest'),
  onNowPlaying: (cb) => on('online:now-playing', cb),
  onDlUpdate: (cb) => on('online:dl-update', cb),
  // 第四轮 §6.4：onDownloadProgress / onDownloadDone 是死接线（主进程从不发这两个频道），已移除

  // 系统
  pickDirs: () => invoke('dialog:pickDirs'),
  showInFolder: (p) => invoke('shell:showItem', p),
  appInfo: () => invoke('app:info'),

  // 窗口
  minimize: () => invoke('win:minimize'),
  toggleMaximize: () => invoke('win:toggleMaximize'),
  closeWindow: () => invoke('win:close'),
  isMaximized: () => invoke('win:isMaximized'),
  /** v2.8.26/3.3.27：最大化状态被主进程事件更新（含外部贴边最大化）时推送 */
  onMaxState: (cb) => on('win:max-state', cb),
  /** 通知主进程播放状态，用于更新任务栏缩略图媒体按钮 */
  setPlayState: (playing) => ipcRenderer.send('win:play-state', !!playing),
  /** 迷你模式：true=进迷你，false=回完整模式；返回实际状态 */
  setMini: (enabled) => invoke('win:setMini', enabled),
  isMini: () => invoke('win:isMini'),
  /** 迷你状态被主进程改动（托盘/快捷键/启动恢复）时同步给界面 */
  onMiniState: (cb) => on('win:mini-state', cb),

  // 全局快捷键
  onShortcut: (cb) => on('shortcut', cb),

  /** 睡眠定时到点（v1.7），收到后淡出并暂停 */
  onSleepTimer: (cb) => on('sleep-timer', cb),
  /* ---- 睡眠定时（v2.2：入口从托盘移到 app 内播放条） ---- */
  /** minutes=0 表示关闭；返回 {minutes, endsAt} */
  setSleepTimer: (minutes) => invoke('sleep:set', minutes),
  getSleepState: () => invoke('sleep:get'),
  /** 定时被设置/到点/清除时，主进程推最新状态 */
  onSleepState: (cb) => on('sleep-state', cb),

  // 桌面歌词（主窗口 ↔ 主进程 ↔ 歌词窗口）
  dlyricOpen: () => invoke('dlyric:open'),
  dlyricClose: () => invoke('dlyric:close'),
  dlyricIsOpen: () => invoke('dlyric:isOpen'),
  dlyricUnlock: () => invoke('dlyric:unlock'),
  dlyricState: (payload) => invoke('dlyric:state', payload),
  dlyricCfg: (patch) => invoke('dlyric:cfg', patch),
  dlyricReady: () => invoke('dlyric:ready'),
  onDlyricData: (cb) => on('dlyric:data', cb),
  onDlyricCfg: (cb) => on('dlyric:cfg', cb),
  /** 桌面歌词开/关状态变化（含歌词窗口自行关闭） */
  onDlyricOpenState: (cb) => on('dlyric:open-state', cb),

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
  /** 完整释放独占：等进程退出 + 扫残留 + 实测声卡 → {ok, exited, leftover[], blocked, detail} */
  mpvRelease: () => invoke('mpv:release'),
  /** 只探测声卡现在能不能给别人用 → {blocked, detail} */
  mpvProbeDevice: () => invoke('mpv:probeDevice'),
  mpvConfirmEnable: () => invoke('mpv:confirmEnable'),
  /** 枚举 WASAPI 输出设备 → {ok, devices:[{name,description}], error?} */
  mpvDevices: () => invoke('mpv:devices'),
  /** 切换独占输出设备（'' = 跟随系统默认） */
  mpvSetDevice: (device) => invoke('mpv:setDevice', device),
  onMpvEvent: (cb) => on('mpv:event', cb),

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
  onPowerAction: (cb) => on('power-action', cb),
  // 第四轮 §6.4：onPowerAfterQueue 是死接线（主进程从不发 power-after-queue），已移除
  /** 独占输出设备被拔掉 / 插回来 */
  onDeviceLost: (cb) => on('device-lost', cb),
  /** 第二实例带来的关联文件路径 */
  onOpenFiles: (cb) => on('open-files', cb)
})
