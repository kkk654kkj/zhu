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
const { spawn, execFileSync } = require('child_process')
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
    // v2.8.6 / v3.3.6：启动代次。kill() 会把代次 +1，
    // 于是「正在连接 IPC 的 start()」会发现自己已经过期 → 立刻把刚起的进程收掉。
    // 以前没有这道闸：kill() 之后若还有一个 start() 在途，它会在 kill 之后**再 spawn 一个**，
    // 而那个进程已经没人管了 —— 变成孤儿独占进程：声卡一直被占，别人全都没声音，
    // 而播放器自己还在放（用户看到的正是「关了独占，别人还是没声音，播放器还能继续播放」）。
    this._gen = 0
    // v3.3.11：独占输出看门狗状态。
    // _aoLostAt：audio-out-params 变 null 的时刻（独占流被系统踢掉的直接证据）；
    // _paused/_idle：暂停/空闲时 AO 释放是正常的，不看门狗；
    // _recoverAttempts/_lastRecoverAt：自动夺回的退避与冷却。
    this._aoLostAt = 0
    this._aoParams = null      // 最近一次 audio-out-params（看门狗按状态判定，不靠事件跳变）
    this._paused = true
    this._idle = true
    this._recoverAttempts = 0
    this._lastRecoverAt = 0
    this._recovering = false
    this._restarting = false
    this._restartChain = Promise.resolve()   // restart 串行化
    this._wdTimer = null
    // v2.8.6 / v3.3.6：「已释放」标记。
    // stop()（= 关独占 / 退出）之后，这个引擎对象就不要再起来了 ——
    // 否则正在进行的 restart() 会在释放之后又起一个新的独占 mpv，
    // 那个进程没人管，于是变成一个霸着声卡、还在放歌的孤儿。
    this._disposed = false
  }

  get running() {
    return !!(this.proc && !this.proc.killed)
  }

  /** 启动引擎进程（幂等）。返回 {ok, exclusive, error} */
  async start({ exclusive = true, audioDevice = '', volume = 1 } = {}) {
    if (this._disposed) {
      // 已经释放过了（关独占/退出）——不能再起进程，否则会留下没人管的孤儿独占进程
      return { ok: false, error: '引擎已释放' }
    }
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
    // 代次闸门：kill() 会 +1，在途的 start() 发现自己过期就自我作废（见构造函数注释）
    const gen = ++this._gen

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
      // 自动化测试时（LX_TEST_MUTE=1）走空输出：进度照走、参数照报，但一点声音都不出。
      // 独占输出是独立进程，Chromium 的 --mute-audio 管不到它，只能在这里拦。
      process.env.LX_TEST_MUTE === '1' ? '--ao=null' : '--ao=wasapi',
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
    // v2.8.6 / v3.3.6：连接期间可能已经被 kill()（关独占、切设备、退出）了。
    // 这时不能再往下走 —— 必须把**自己刚起的这个进程**收掉，
    // 否则它会变成没人管的孤儿独占进程，一直霸着声卡。
    if (gen !== this._gen) {
      try { proc.kill() } catch (err) { /* 忽略 */ }
      try { if (proc.exitCode === null) proc.kill('SIGKILL') } catch (err) { /* 忽略 */ }
      return { ok: false, error: '引擎启动已被取消' }
    }
    if (!connected) {
      this.kill()
      return { ok: false, error: 'mpv IPC 连接失败（可能是引擎启动异常）' + (stderrTail ? '：' + stderrTail.trim().slice(-200) : '') }
    }
    this.ready = true
    this._observe()
    this._flush()
    // v3.3.13：看门狗（每秒检查一次）。注意不要把 _recoverAttempts/_lastRecoverAt
    // 清零——restart() 必经 start()，清零会让「连续 3 次失败停手」永远失效，
    // 设备真被别的程序占着时会无限重启 + 反复弹「已恢复」
    this._aoLostAt = 0
    this._aoParams = null
    this._paused = true
    this._idle = true
    if (this._wdTimer) clearInterval(this._wdTimer)
    this._wdTimer = setInterval(() => this._wdTick(), 1000)
    if (this._wdTimer.unref) this._wdTimer.unref()
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
          this._paused = data !== false
          this.onEvent({ type: 'pause', paused: data !== false })
          break
        case 'eof-reached':
          if (data === true) this.onEvent({ type: 'eof' })
          break
        case 'audio-out-params':
          // v3.3.13：只缓存最近状态。mpv 的 observe_property 只在值变化时推送，
          // 若「重启后 AO 从头就打不开」则不会再有 null 跳变事件——
          // 所以判定必须由 _wdTick 主动轮询这个缓存，不能靠事件跳变
          this._aoParams = data || null
          this.onEvent({ type: 'format', params: data || null })
          break
        case 'volume':
          this.onEvent({ type: 'volume', volume: typeof data === 'number' ? data : 100 })
          break
        case 'mute':
          this.onEvent({ type: 'mute', muted: data === true })
          break
        case 'idle-active':
          this._idle = data === true
          this.onEvent({ type: 'idle', idle: data === true })
          break
      }
      return
    }
    if (msg.event === 'file-loaded') {
      this._idle = false
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
    this._idle = false
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
  /** 串行化：设备热插拔 / file-error 回退 / 看门狗可能同时要求重启 */
  restart(opts = {}) {
    const run = this._restartChain.catch(() => {}).then(() => this._doRestart(opts))
    this._restartChain = run.catch(() => {})
    return run
  }

  async _doRestart({ exclusive, audioDevice = this._audioDevice || '', volume = null } = {}) {
    this._restarting = true
    try {
      return await this._restartBody({ exclusive, audioDevice, volume })
    } finally {
      this._restarting = false
    }
  }

  async _restartBody({ exclusive, audioDevice = this._audioDevice || '', volume = null } = {}) {
    let wasPlaying = false
    try { wasPlaying = (await this.request(['get_property', 'pause'], 800)) === false } catch {}
    const file = this._lastFile
    const pos = this._lastPos
    const prevDevice = this._audioDevice || ''
    const vol = volume != null ? volume : (this._volume01 != null ? this._volume01 : 1)
    // v2.8.6 / v3.3.6：重启前要**等旧进程真的退出**再起新的。
    // 以前是 kill() 完就立刻 spawn：旧的还占着声卡（独占），新的又去抢同一个设备，
    // 于是新进程起不来（独占模式尤其明显），表现就是「切设备/切模式没反应」。
    await this._stopProcess()
    let r = await this.start({ exclusive, audioDevice, volume: vol })
    // 新设备被别的程序独占 / 拔掉了：退回上一次能用的设备，至少别变成哑巴
    if (!r.ok && audioDevice && audioDevice !== prevDevice) {
      this.onEvent({ type: 'error', message: '切换到该设备失败，已退回原设备：' + (r.error || '') })
      r = await this.start({ exclusive, audioDevice: prevDevice, volume: vol })
      if (r.ok) r.audioDevice = prevDevice
    }
    if (r.ok && file) {
      this.load(file, { paused: true })
      // v2.8.7 / v3.3.7：等 file-loaded 再 seek/play。以前固定 120ms 后就发 seek，
      // 文件加载慢（在线直链、网络盘）时 mpv 还在 idle，seek 直接失败，续播位置就丢了。
      this._waitLoaded(2500).then((loaded) => {
        if (pos > 0.3 && loaded) {
          this.seek(pos)
          if (wasPlaying) setTimeout(() => this.play(), 80)
        } else if (wasPlaying) {
          this.play()
        }
      })
    }
    return r
  }

  /**
   * 等 file-loaded 事件（restart 续播用）。超时返回 false，Promise 一定 resolve。
   * 临时包一层 onEvent 来等事件，原回调照常执行，不影响日志/上报。
   */
  _waitLoaded(timeout = 2500) {
    return new Promise((resolve) => {
      if (!this.ready) return resolve(false)
      const orig = this.onEvent
      let done = false
      const timer = setTimeout(() => finish(false), timeout)
      const finish = (v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        // v3.3.13：并发 restart 时别把后注册的那个 wrapper 覆盖掉
        if (this.onEvent === wrapped) this.onEvent = orig
        resolve(v)
      }
      const wrapped = (evt) => {
        if (evt && evt.type === 'loaded') finish(true)
        try { orig(evt) } catch (err) { /* 原回调自己兜 */ }
      }
      this.onEvent = wrapped
    })
  }

  _rejectPending(reason) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      try { p.reject(new Error(reason)) } catch {}
    }
    this._pending.clear()
  }

  kill() {
    // v3.3.11：清掉看门狗
    if (this._wdTimer) { clearInterval(this._wdTimer); this._wdTimer = null }
    // 代次 +1：让所有「在途的 start()」知道自己过期了（见构造函数注释）。
    // 没有这一步，kill 之后仍可能有 start() 接着 spawn 出没人管的孤儿独占进程。
    this._gen++
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

  /**
   * 停止引擎并**等进程真正退出**。
   *
   * v2.8.6 / v3.3.6 新增：以前只有 kill()（发信号就返回），调用方根本不知道
   * 声卡什么时候被还回来。独占模式下这个时间差很要命：紧接着起一个新引擎，
   * 新进程会撞上「设备还被旧进程占着」，于是切设备/切模式失败；
   * 而「关独占」后如果立刻让别人来用，别的程序可能还打不开设备。
   * 这里等到 exit 事件真的来了再返回，超时则用 taskkill 强杀兜底。
   *
   * 这一步同时把引擎标记为「已释放」：之后任何迟到的 start() 都会自我作废，
   * 不会再造出一个没人管的孤儿独占进程。
   */
  async stop({ timeout = 3000 } = {}) {
    this._disposed = true
    return this._stopProcess({ timeout })
  }

  /** 内部：停掉进程并等它真的退出（不改变「已释放」状态，restart 用） */
  async _stopProcess({ timeout = 3000 } = {}) {
    const p = this.proc
    if (!p) {
      this.kill()
      return { ok: true, exited: true, pid: null }
    }
    const exited = new Promise((resolve) => {
      let done = false
      const onExit = () => { if (!done) { done = true; resolve(true) } }
      p.once('exit', onExit)
      // 进程可能在我们挂监听之前就退出了
      if (p.exitCode !== null) onExit()
    })
    this.kill()
    const ok = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(false), timeout))
    ])
    if (ok) return { ok: true, exited: true, pid: p.pid }
    // 最后一刀：任务管理器式的强杀，保证不留占着声卡的孤儿
    try {
      execFileSync('taskkill', ['/PID', String(p.pid), '/F'], { windowsHide: true, timeout: 5000 })
    } catch (err) { /* 忽略 */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
    return { ok: false, exited: false, pid: p.pid }
  }

  _teardown() {
    this.ready = false
    if (this._wdTimer) { clearInterval(this._wdTimer); this._wdTimer = null }
    this._rejectPending('mpv 进程退出')
    this.sock = null
    this.proc = null
  }

  /**
   * v3.3.11：独占输出看门狗。
   *
   * 场景：独占播放中用户启动大型游戏（如极限竞速：地平线4），游戏初始化音频时
   * 改动设备配置/默认设备，WASAPI 独占流被系统作废（AUDCLNT_E_DEVICE_INVALIDATED）。
   * 此时 mpv 还在解码、进度照走，但一点声音都没有；切歌时 AO 重新初始化又会
   * 撞上被游戏占用的设备，于是「关掉再开独占」才能恢复——而且下一首又哑。
   *
   * 判据：非暂停、非空闲、有文件，但 audio-out-params 持续 null ≥ 2.5 秒。
   * 动作：自动重启引擎夺回独占（restart 自带续播：等旧进程真退出 + file-loaded 再 seek）。
   * 防打地鼠：两次恢复至少间隔 12 秒；连续 3 次失败就停手并上报 exclusive-lost
   * （说明设备真被别的程序长期占用，比如游戏也开了独占——这时该用户自己决定）。
   * 参数恢复非 null（或暂停/空闲）会清零计数。
   */
  _wdTick() {
    if (!this.ready || !this.exclusive || this._disposed) return
    // v3.3.13：测试静音（--ao=null）不参与独占判定
    if (process.env.LX_TEST_MUTE === '1') return
    if (this._idle || this._paused || !this._lastFile) { this._aoLostAt = 0; return }
    // 主动状态判定：AO 参数回来就清零计数（H2 的关键）
    if (this._aoParams) {
      this._aoLostAt = 0
      this._recoverAttempts = 0
      return
    }
    if (!this._aoLostAt) { this._aoLostAt = Date.now(); return }
    const lostFor = Date.now() - this._aoLostAt
    if (lostFor < 2500) return
    if (this._recovering || this._restarting) return
    if (Date.now() - this._lastRecoverAt < 12000) return
    if (this._recoverAttempts >= 3) return
    this._recovering = true
    this._lastRecoverAt = Date.now()
    this._recoverAttempts++
    this.onEvent({ type: 'ao-lost', attempt: this._recoverAttempts,
      message: '独占输出已中断 ' + Math.round(lostFor / 1000) + ' 秒，正在自动重启引擎夺回…' })
    // v3.3.13：start() 返回 ok 只代表进程起来了，不代表拿到声卡。
    // 重启后必须实测 audio-out-params 非 null 才算夺回成功（H1）
    this.restart({ exclusive: true })
      .catch(() => {})
      .then(() => this._verifyRecover())
      .finally(() => { this._recovering = false })
  }

  /** 重启后等最多 6 秒，确认音频输出真的回来了 */
  async _verifyRecover() {
    const deadline = Date.now() + 6000
    while (Date.now() < deadline && !this._disposed) {
      if (this._aoParams) {
        this._recoverAttempts = 0
        this.onEvent({ type: 'ao-recovered' })
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    // 连续 3 次夺回失败：设备被别的程序长期占用，停手并告知用户
    if (this._recoverAttempts >= 3 && !this._aoParams) {
      this.onEvent({ type: 'exclusive-lost',
        message: '自动夺回独占失败：声卡被其他程序占用（比如游戏也开了独占）。请关闭占用程序或手动切共享' })
    }
  }
}

module.exports = { MpvEngine }
