'use strict'
/**
 * 独占输出引擎：把 mpv 当成"位完美音频输出后端"。
 *
 * 为什么是 mpv：Electron/Chromium 没有 WASAPI 独占（exclusive）接口，只能靠外部进程。
 * mpv 的 wasapi AO 支持 `--audio-exclusive=yes`，实测可以把 96k/44.1k/48k 的 FLAC
 * 按文件原生采样率与位深直接送进声卡（AO 日志里没有 resampler），这是 bit-perfect 的前提。
 *
 * 约束（必须在 UI 里体现）：
 *  - 独占会独占声卡，其他程序这段时间没有声音；
 *  - 只要改音量/挂 EQ/淡入淡出，就不再是位完美 —— 音量由 mpv 的软件增益实现；
 *  - 设备或文件格式不被独占模式支持时要回退共享，并告知用户。
 *
 * 通信：`--input-ipc-server` 命名管道 + 逐行 JSON（mpv 的 JSON IPC 协议）。
 */
const { spawn } = require('child_process')
const net = require('net')
const fs = require('fs')
const path = require('path')

const PIPE_PREFIX = '\\\\.\\pipe\\lxmpv-'

class MpvEngine {
  /**
   * @param {object} opts
   * @param {string} opts.exePath   mpv.exe 绝对路径
   * @param {(evt:object)=>void} opts.onEvent 事件回调（转发给渲染层）
   */
  constructor({ exePath, onEvent }) {
    this.exePath = exePath
    this.onEvent = onEvent || (() => {})
    this.proc = null
    this.sock = null
    this.pipeName = null
    this.ready = false
    this.exclusive = true          // 当前进程是否用独占模式启动
    this.fellBack = false          // 已经回退过共享，不再反复重试
    this._buf = ''
    this._queue = []               // 拿到管道前的命令队列
    this._obsId = 0
    this._reqId = 0
    this._pending = new Map()      // request_id → {resolve, reject, timer}
    this._lastFile = null
    this._lastPos = 0
  }

  get running() {
    return !!(this.proc && !this.proc.killed)
  }

  /** 启动引擎进程（幂等）。返回 {ok, exclusive, error} */
  async start({ exclusive = true, audioDevice = '', volume = 1 } = {}) {
    if (this.running) {
      return { ok: true, exclusive: this.exclusive }
    }
    if (!this.exePath || !fs.existsSync(this.exePath)) {
      return { ok: false, error: '找不到 mpv 引擎：' + (this.exePath || '(未配置)') }
    }
    this.exclusive = !!exclusive
    this._audioDevice = audioDevice || ''
    // v2.5：启动音量跟随上次设置（以前硬编码 100，每次重启引擎音量都被重置）
    const vol01 = Math.max(0, Math.min(1, Number(volume) || 0))
    this._volume01 = vol01
    this._buf = ''
    this._queue = []
    this.ready = false
    this.pipeName = PIPE_PREFIX + process.pid + '-' + Date.now().toString(36)

    const args = [
      '--no-config',
      '--no-video',
      '--idle=yes',
      '--no-terminal',
      '--no-input-terminal',
      '--no-osc',
      '--no-osd-bar',
      '--really-quiet',
      '--msg-level=all=warn',
      // v2.5：启动音量跟随设置（浮点，支持 0.1 精度）；1 = 100 = 位完美基准
      '--volume=' + (Math.round(vol01 * 1000) / 10),
      // 必须关掉无缝：gapless=yes 时 mpv 为了不断流，会把下一首重采样成上一首的
      // 采样率（实测 96k 的 FLAC 被按 44.1k 输出），位完美直接失效
      '--gapless-audio=no',
      '--audio-exclusive=' + (this.exclusive ? 'yes' : 'no'),
      '--ao=wasapi',
      '--input-ipc-server=' + this.pipeName
    ]
    // 指定输出设备（如 wasapi/{GUID}）。留空表示跟随系统默认设备。
    // 有独占需求的人通常接了 USB DAC，默认设备经常不是它。
    if (audioDevice) args.push('--audio-device=' + audioDevice)

    let proc = null
    try {
      proc = spawn(this.exePath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      this.proc = proc
    } catch (err) {
      this.proc = null
      return { ok: false, error: '启动 mpv 失败：' + err.message }
    }

    let stderrTail = ''
    this._stderr = ''
    if (proc.stderr) {
      proc.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-800)
        this._stderr = stderrTail
      })
    }
    proc.on('exit', (code) => {
      // v3.3.1 关键修复：切设备/回退共享时会 kill 旧进程再起新的，
      // 而旧进程的 exit 事件往往晚于新进程 spawn 才到。以前这里无条件 _teardown()，
      // 会把**新引擎**的 proc/ready 一起清空 —— 于是引擎还在放歌，主进程却以为它没运行：
      // 暂停/停止/关独占全部变成空操作，音乐停不下来；再切设备也因为 !running 直接跳过。
      if (this.proc !== proc) return
      const wasRunning = this.ready
      this._teardown()
      this.onEvent({ type: 'engine-exit', code, stderr: stderrTail.trim() })
      if (wasRunning) this.onEvent({ type: 'error', message: 'mpv 引擎已退出（code ' + code + '）' })
    })
    proc.on('error', (err) => {
      if (this.proc !== proc) return
      this.onEvent({ type: 'error', message: 'mpv 进程错误：' + err.message })
    })

    const connected = await this._connectWithRetry(20, 120)
    if (!connected) {
      this.kill()
      return { ok: false, error: 'mpv IPC 连接失败（可能是引擎启动异常）' + (stderrTail ? '：' + stderrTail.trim().slice(-200) : '') }
    }
    this.ready = true
    this._observe()
    this._flush()
    // 拿不到音频参数就当没起来（设备被占用等）
    return { ok: true, exclusive: this.exclusive }
  }

  _connectWithRetry(times, delayMs) {
    return new Promise((resolve) => {
      let n = 0
      const tryOnce = () => {
        n++
        const sock = net.connect(this.pipeName)
        let settled = false
        sock.once('connect', () => {
          settled = true
          this.sock = sock
          sock.setEncoding('utf8')
          sock.on('data', (chunk) => this._onData(chunk))
          sock.on('error', () => {})
          sock.on('close', () => { this.ready = false })
          resolve(true)
        })
        sock.once('error', () => {
          if (settled) return
          try { sock.destroy() } catch {}
          if (n >= times) resolve(false)
          else setTimeout(tryOnce, delayMs)
        })
      }
      tryOnce()
    })
  }

  _observe() {
    const props = ['time-pos', 'duration', 'pause', 'eof-reached', 'audio-out-params', 'volume', 'mute', 'idle-active']
    for (const p of props) this._send(['observe_property', ++this._obsId, p])
    // 让 mpv 把 warn 级日志通过 IPC 发过来：独占失败的具体原因只能从这里看到
    this._send(['request_log_messages', 'warn'])
  }

  _write(line) {
    if (!this.sock || !this.ready) { this._queue.push(line); return }
    try { this.sock.write(line) } catch { this._queue.push(line) }
  }

  _send(command) {
    this._write(JSON.stringify({ command }) + '\n')
  }

  /** 发一条带 request_id 的命令并等回执（用于 get_property 这类需要返回值的调用） */
  request(command, timeout = 3000) {
    if (!this.sock || !this.ready) return Promise.reject(new Error('mpv 引擎未就绪'))
    const id = ++this._reqId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error('mpv 请求超时：' + command[1]))
      }, timeout)
      this._pending.set(id, { resolve, reject, timer })
      this._write(JSON.stringify({ command, request_id: id }) + '\n')
    })
  }

  /** 枚举 WASAPI 输出设备：{name, description}。name 可直接喂给 --audio-device */
  async listDevices() {
    const list = await this.request(['get_property', 'audio-device-list'], 4000)
    const arr = Array.isArray(list) ? list : []
    return arr
      .map((d) => ({ name: d && d.name ? String(d.name) : '', description: d && d.description ? String(d.description) : '' }))
      .filter((d) => d.name)
  }

  _flush() {
    if (!this.sock) return
    const q = this._queue
    this._queue = []
    for (const line of q) { try { this.sock.write(line) } catch {} }
  }

  _onData(chunk) {
    this._buf += chunk
    let idx
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim()
      this._buf = this._buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this._handle(msg)
    }
  }

  _handle(msg) {
    // 命令回执（request_id 关联）：先于事件处理，避免 data 为 null 时被当成事件
    if (msg.request_id !== undefined && this._pending.has(msg.request_id)) {
      const p = this._pending.get(msg.request_id)
      clearTimeout(p.timer)
      this._pending.delete(msg.request_id)
      if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error))
      else p.resolve(msg.data)
      return
    }
    if (msg.event === 'property-change') {
      const { name, data } = msg
      switch (name) {
        case 'time-pos':
          this._lastPos = typeof data === 'number' ? data : 0
          this.onEvent({ type: 'time', pos: this._lastPos })
          break
        case 'duration':
          this.onEvent({ type: 'duration', duration: typeof data === 'number' ? data : 0 })
          break
        case 'pause':
          this.onEvent({ type: 'pause', paused: data !== false })
          break
        case 'eof-reached':
          if (data === true) this.onEvent({ type: 'eof' })
          break
        case 'audio-out-params':
          this.onEvent({ type: 'format', params: data || null })
          break
        case 'volume':
          this.onEvent({ type: 'volume', volume: typeof data === 'number' ? data : 100 })
          break
        case 'mute':
          this.onEvent({ type: 'mute', muted: data === true })
          break
        case 'idle-active':
          this.onEvent({ type: 'idle', idle: data === true })
          break
      }
      return
    }
    if (msg.event === 'file-loaded') {
      this.onEvent({ type: 'loaded' })
      return
    }
    if (msg.event === 'end-file') {
      const reason = msg.reason || ''
      // mpv 在 AO 初始化失败时也会走 end-file/error，这里上报给上层决定是否回退共享
      if (reason === 'error') {
        const detail = msg.error || this._lastLog || (this._stderr || '').trim().slice(-300) || 'mpv 无法播放该文件'
        this.onEvent({ type: 'file-error', message: detail })
      } else if (reason === 'eof') this.onEvent({ type: 'file-eof' })
      return
    }
    if (msg.event === 'log-message') {
      const text = (msg.text || '').trim()
      if (text) {
        // 保留最近一条 warn/error：AO 初始化失败时 end-file 的 error 字段是空的，
        // 真正的原因（如 AUDCLNT_E_DEVICE_IN_USE）只能从这里拿到
        if (msg.level === 'error' || msg.level === 'fatal' || msg.level === 'warn') {
          this._lastLog = text.slice(0, 300)
        }
        this.onEvent({ type: 'log', level: msg.level, text })
      }
      return
    }
    if (msg.event === 'start-file') {
      this.onEvent({ type: 'start-file' })
      return
    }
  }

  /* ---------------- 播放控制 ---------------- */

  load(filePath, { paused = false } = {}) {
    this._lastFile = filePath
    this._lastPos = 0
    if (paused) this._send(['set_property', 'pause', true])
    this._send(['loadfile', filePath, 'replace'])
  }

  play() { this._send(['set_property', 'pause', false]) }
  pause() { this._send(['set_property', 'pause', true]) }
  stop() { this._send(['stop']) }
  seek(sec) { this._send(['seek', Math.max(0, sec), 'absolute']) }
  setVolume(v01) {
    const v = Math.max(0, Math.min(1, Number(v01) || 0)) * 100
    this._send(['set_property', 'volume', v])
  }
  setMute(m) { this._send(['set_property', 'mute', !!m]) }

  /**
   * A-B 循环（v2.1）：交给 mpv 自己做，比渲染层每 250ms 比较时间再 seek 精确得多，
   * 也不会有循环点的"卡顿感"。a/b 传 null 表示清除（mpv 用字面量 "no"）。
   */
  setAbLoop(a, b) {
    this._send(['set_property', 'ab-loop-a', a == null ? 'no' : Math.max(0, Number(a) || 0)])
    this._send(['set_property', 'ab-loop-b', b == null ? 'no' : Math.max(0, Number(b) || 0)])
  }

  /**
   * 以另一套 exclusive / 设备设置重启（用于独占失败后回退共享、或切换输出设备）。
   * v2.5 修复：以前重启后固定 paused 加载且无人恢复——独占播放中切设备，音乐会停在
   * 原地不再出声（用户看起来就是"切换设备无效"）。现在先记下播放状态，重启后接着播。
   */
  async restart({ exclusive, audioDevice = this._audioDevice || '', volume = null } = {}) {
    let wasPlaying = false
    try { wasPlaying = (await this.request(['get_property', 'pause'], 800)) === false } catch {}
    const file = this._lastFile
    const pos = this._lastPos
    const prevDevice = this._audioDevice || ''
    const vol = volume != null ? volume : (this._volume01 != null ? this._volume01 : 1)
    this.kill()
    let r = await this.start({ exclusive, audioDevice, volume: vol })
    // 新设备被别的程序独占 / 拔掉了：退回上一次能用的设备，至少别变成哑巴
    if (!r.ok && audioDevice && audioDevice !== prevDevice) {
      this.onEvent({ type: 'error', message: '切换到该设备失败，已退回原设备：' + (r.error || '') })
      r = await this.start({ exclusive, audioDevice: prevDevice, volume: vol })
      if (r.ok) r.audioDevice = prevDevice
    }
    if (r.ok && file) {
      this.load(file, { paused: true })
      if (pos > 0.3) {
        setTimeout(() => {
          this.seek(pos)
          if (wasPlaying) setTimeout(() => this.play(), 80)
        }, 120)
      } else if (wasPlaying) {
        setTimeout(() => this.play(), 120)
      }
    }
    return r
  }

  _rejectPending(reason) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      try { p.reject(new Error(reason)) } catch {}
    }
    this._pending.clear()
  }

  kill() {
    this.ready = false
    this._rejectPending('mpv 已关闭')
    if (this.sock) { try { this.sock.destroy() } catch {} }
    this.sock = null
    const p = this.proc
    this.proc = null
    if (!p) return
    try { p.kill() } catch (err) { /* 忽略 */ }
    // Windows 上 TerminateProcess 一般立刻生效；万一卡在 WASAPI 里，800ms 后再补一刀，
    // 免得留下一个还在出声的孤儿进程（独占时它会把设备一直占着）
    setTimeout(() => {
      try { if (p.exitCode === null && !p.killed) p.kill('SIGKILL') } catch (err) { /* 忽略 */ }
    }, 800)
  }

  _teardown() {
    this.ready = false
    this._rejectPending('mpv 进程退出')
    this.sock = null
    this.proc = null
  }
}

module.exports = { MpvEngine }
