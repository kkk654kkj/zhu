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
    this._lastFile = null
    this._lastPos = 0
  }

  get running() {
    return !!(this.proc && !this.proc.killed)
  }

  /** 启动引擎进程（幂等）。返回 {ok, exclusive, error} */
  async start({ exclusive = true } = {}) {
    if (this.running) {
      return { ok: true, exclusive: this.exclusive }
    }
    if (!this.exePath || !fs.existsSync(this.exePath)) {
      return { ok: false, error: '找不到 mpv 引擎：' + (this.exePath || '(未配置)') }
    }
    this.exclusive = !!exclusive
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
      '--volume=100',                 // 100 = 单位增益，位完美的基准
      // 必须关掉无缝：gapless=yes 时 mpv 为了不断流，会把下一首重采样成上一首的
      // 采样率（实测 96k 的 FLAC 被按 44.1k 输出），位完美直接失效
      '--gapless-audio=no',
      '--audio-exclusive=' + (this.exclusive ? 'yes' : 'no'),
      '--ao=wasapi',
      '--input-ipc-server=' + this.pipeName
    ]

    try {
      this.proc = spawn(this.exePath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch (err) {
      this.proc = null
      return { ok: false, error: '启动 mpv 失败：' + err.message }
    }

    let stderrTail = ''
    this._stderr = ''
    if (this.proc.stderr) {
      this.proc.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-800)
        this._stderr = stderrTail
      })
    }
    this.proc.on('exit', (code) => {
      const wasRunning = this.ready
      this._teardown()
      this.onEvent({ type: 'engine-exit', code, stderr: stderrTail.trim() })
      if (wasRunning) this.onEvent({ type: 'error', message: 'mpv 引擎已退出（code ' + code + '）' })
    })
    this.proc.on('error', (err) => {
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

  _send(command) {
    const line = JSON.stringify({ command }) + '\n'
    if (!this.sock || !this.ready) { this._queue.push(line); return }
    try { this.sock.write(line) } catch { this._queue.push(line) }
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

  /** 以另一套 exclusive 设置重启（用于独占失败后回退共享） */
  async restart({ exclusive }) {
    const file = this._lastFile
    const pos = this._lastPos
    this.kill()
    const r = await this.start({ exclusive })
    if (r.ok && file) {
      this.load(file, { paused: true })
      if (pos > 0.3) setTimeout(() => this.seek(pos), 120)
    }
    return r
  }

  kill() {
    this.ready = false
    if (this.sock) { try { this.sock.destroy() } catch {} }
    this.sock = null
    if (this.proc) {
      const p = this.proc
      this.proc = null
      try { p.kill() } catch {}
    }
  }

  _teardown() {
    this.ready = false
    this.sock = null
    this.proc = null
  }
}

module.exports = { MpvEngine }
