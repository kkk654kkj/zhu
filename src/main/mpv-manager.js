'use strict'
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
/**
 * v3.3.24 模块拆分：从 main.js 原样搬出（只做 G. 前缀注入，不改逻辑）。
 * init(G) 注入 main 的共享状态访问器（getter，见 main.js 的 G 定义）。
 */
const { app } = require('electron')

let G = null
function init(g) { G = g }

/* ---------------- 独占输出（mpv + WASAPI exclusive） ---------------- */

let mpvEngine = null

/**
 * mpv 诊断日志环形缓冲（v1.8）。
 * 渲染层收到 mpv:event 时只关心"要不要更新界面"，排查问题需要的上下文
 * （启动参数、audio-out-params、回退共享、引擎退出码）散在各处，面板统一从这里取。
 * 只收低频、有信息量的事件：time/volume/pause 这类 1~2Hz 的不要，会瞬间冲满。
 */
const MPV_LOG_MAX = 800

const mpvLogs = []

let mpvLogSeq = 0

function pushMpvLog(level, text) {
  const s = String(text == null ? '' : text)
  if (!s) return
  mpvLogs.push({ seq: ++mpvLogSeq, at: Date.now(), level: level || 'info', text: s.slice(0, 2000) })
  if (mpvLogs.length > MPV_LOG_MAX) mpvLogs.splice(0, mpvLogs.length - MPV_LOG_MAX)
}

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
  // v3.3.20：只有 mpv 判定为「AO 打不开」时才回退共享。
  // 以前只要有 fellBack=false 就回退 —— 一个坏文件（404 / 不支持的编码）就能让整个
  // 会话永久降到共享输出，后面所有歌都不再位完美，用户只能重启。
  // 判定交给 mpv.js：本引擎从没成功开出过 AO，且错误详情里有设备类关键词。
  if (evt.type === 'file-error' && evt.aoFailed && mpvEngine && mpvEngine.exclusive && !mpvEngine.fellBack) {
    mpvEngine.fellBack = true
    G.logLine('[mpv] 独占输出失败，回退共享：' + (evt.message || ''))
    pushMpvLog('warn', '独占输出失败，回退共享：' + (evt.message || ''))
    // 第四轮 §4.2 #2：没有 catch 就是一次 unhandledRejection，界面还会停在「独占中」
    mpvEngine.restart({ exclusive: false }).then((r) => {
      pushMpvLog(r.ok ? 'warn' : 'error', r.ok ? '已重启引擎为共享输出' : '回退共享也失败：' + (r.error || ''))
      G.sendToRenderer('mpv:event', r.ok
        ? { type: 'fallback', message: (evt.message || ''), exclusive: false }
        : { type: 'error', message: r.error || '独占失败且回退共享也失败' })
    }).catch((err) => {
      pushMpvLog('error', '回退共享异常：' + ((err && err.message) || err))
      G.sendToRenderer('mpv:event', { type: 'error', message: '独占失败且回退共享也失败' })
    })
    return
  }
  // 输出参数是"是否位完美"的第一手证据，落日志便于事后核对
  if (evt.type === 'format') {
    G.logLine('[mpv] audio-out-params=' + JSON.stringify(evt.params))
    pushMpvLog('info', 'audio-out-params=' + JSON.stringify(evt.params))
  }
  if (evt.type === 'file-error') {
    G.logLine('[mpv] file-error: ' + (evt.message || ''))
    pushMpvLog('error', 'file-error: ' + (evt.message || ''))
    // v3.3.17：播不出来就把这条直链的缓存作废。
    // 平台签名直链会提前失效，而缓存 TTL 是 20 分钟 —— 不作废的话，
    // 用户在这段时间里每次点这首歌都会命中同一条死链，换源逻辑压根不触发。
    G.invalidateCurrentStream()
  }
  if (evt.type === 'log' && (evt.level === 'error' || evt.level === 'fatal')) {
    G.logLine('[mpv][log] ' + evt.text)
    pushMpvLog(evt.level === 'fatal' ? 'error' : 'warn', '[' + evt.level + '] ' + evt.text)
  }
  if (evt.type === 'engine-exit') {
    pushMpvLog('error', '引擎退出 code=' + evt.code + (evt.stderr ? ' stderr=' + evt.stderr : ''))
  }
  if (evt.type === 'ao-lost') {
    G.logLine('[mpv] ' + (evt.message || '独占输出中断'))
    pushMpvLog('warn', evt.message || '独占输出中断')
  }
  if (evt.type === 'ao-recovered') {
    G.logLine('[mpv] 独占输出已自动恢复')
    pushMpvLog('info', '独占输出已自动恢复')
  }
  if (evt.type === 'exclusive-lost') {
    G.logLine('[mpv] ' + (evt.message || '自动夺回独占失败'))
    pushMpvLog('error', evt.message || '自动夺回独占失败')
  }
  if (evt.type === 'error') pushMpvLog('error', evt.message || '引擎错误')
  if (evt.type === 'loaded') pushMpvLog('info', 'file-loaded')
  G.sendToRenderer('mpv:event', evt)
}

/** 进行中的释放流程（见 releaseMpv 的说明） */
let mpvReleasing = null

async function ensureMpv(exclusive, opts = {}) {
  // 释放流程还在跑（stop + sweep 最长约 11 秒）就先等它结束，
  // 否则新起的引擎会被 release 的 sweep 当成孤儿杀掉
  if (mpvReleasing) await mpvReleasing.catch(() => {})
  if (!mpvEngine) {
    mpvEngine = new G.MpvEngine({ exePath: mpvExePath(), onEvent: onMpvEvent })
  }
  const wantExclusive = exclusive !== false
  const audioDevice = String(G.store.get().settings.audioDevice || '').trim()
  const startVolume = Math.max(0, Math.min(1, Number(G.store.get().settings.volume ?? 1)))
  if (mpvEngine.running) {
    // v3.3.6 / v2.8.6：以前只要引擎在跑就直接返回，不管它现在是独占还是共享 ——
    // 于是「要独占但引擎是共享」时独占根本开不起来（用户看到：开了独占却没位完美），
    // 「要共享但引擎是独占」时则一直霸着声卡。模式对不上就重启到目标模式。
    if (opts.forceMode && mpvEngine.exclusive !== wantExclusive) {
      pushMpvLog('info', '引擎模式与请求不一致（当前 ' + (mpvEngine.exclusive ? '独占' : '共享') + '），重启为' + (wantExclusive ? '独占' : '共享'))
      const r = await mpvEngine.restart({ exclusive: wantExclusive, audioDevice, volume: startVolume })
      if (r.ok) {
        // v3.3.20：重启成功就是一次全新的独占尝试，回退标记必须清掉，
        // 否则用户「关掉再打开独占」也换不回可回退状态（标记永不复位）
        if (wantExclusive) mpvEngine.fellBack = false
        startDeviceWatch()
      }
      return r
    }
    return { ok: true, exclusive: mpvEngine.exclusive }
  }
  // 输出设备来自设置；空字符串 = 跟随系统默认
  // v2.5：启动音量跟随设置（以前 mpv 固定 --volume=100，重启引擎音量就被重置）
  pushMpvLog('info', '启动引擎：exclusive=' + wantExclusive + ' ao=' + (process.env.LX_TEST_MUTE === '1' ? 'null(测试静音)' : 'wasapi') + ' device=' + (audioDevice || '(系统默认)') + ' volume=' + Math.round(startVolume * 1000) / 10)
  const r = await mpvEngine.start({ exclusive: wantExclusive, audioDevice, volume: startVolume })
  G.logLine('[mpv] start exclusive=' + wantExclusive + ' ' + JSON.stringify(r) + ' exe=' + mpvExePath())
  pushMpvLog(r.ok ? 'info' : 'error',
    '启动结果：' + (r.ok ? 'ok' : '失败 ' + (r.error || '')) + ' exe=' + mpvExePath())
  // 独占流跑起来之后才开始盯设备（共享模式下 mpv 自己会跟系统默认设备走）
  if (r.ok && wantExclusive) {
    // v3.3.20：重启/重新开启成功后清除回退标记 —— 否则一次 file-error 回退过，
    // 之后即使重启回独占，这段代码也不会再走回退分支（标记永不复位）
    mpvEngine.fellBack = false
    startDeviceWatch()
  }
  return r
}

/**
 * 关掉引擎，并**确认声卡真的还回来了**。
 *
 * v3.3.6 / v2.8.6：用户报「开了独占再关掉，其他软件还是没声音，播放器自己还能继续放」。
 * 根因是「关独占」以前只做了两件事：发信号杀进程 + 立刻重载界面，
 * 既没等进程真退出，也没检查设备是否真的释放，更没扫掉可能残留的孤儿进程。
 * 现在这条路径做全套：
 *   1) 等 mpv 进程真正退出（stop()）；
 *   2) 扫一遍属于本进程却还活着的 mpv（竞态产生的孤儿），一律杀掉；
 *   3) 用一个共享模式的 mpv 实测设备能不能打开；
 *   4) 还占着就把结果回报给界面，明确告诉用户，而不是让用户自己猜。
 */
/**
 * 完整释放独占（对外入口）。
 *
 * v3.3.17：同一时刻只允许一份在执行。releaseMpv 内部会 sweep 掉「命令行里带着
 * 本进程 PID 管道名」的所有 mpv 进程 —— 并发调用时，先启动的那份会在后启动的那份
 * 起好新引擎之后才跑 sweep，把**新引擎**当孤儿杀掉，用户看到「独占已开启但没声音」。
 * 并发的第二份直接复用同一份 Promise；ensureMpv 也会先等它结束再起进程。
 */
function releaseMpv(opts = {}) {
  if (mpvReleasing) return mpvReleasing
  mpvReleasing = releaseMpvOnce(opts).finally(() => { mpvReleasing = null })
  return mpvReleasing
}

async function releaseMpvOnce({ probe = true } = {}) {
  const eng = mpvEngine
  mpvEngine = null
  stopDeviceWatch()
  let exited = true
  if (eng) {
    pushMpvLog('info', '关闭引擎')
    const r = await eng.stop()
    exited = !!r.exited
    if (!exited) pushMpvLog('warn', '引擎进程没有正常退出（pid ' + r.pid + '），已强制结束')
  }
  // 扫残留：属于本进程（管道名里带本 PID）的 mpv 一定是我们的，活着就是孤儿
  const leftover = await sweepOurMpv()
  if (leftover.length) {
    pushMpvLog('warn', '发现残留的 mpv 进程（已强杀）：' + leftover.join(', '))
    G.logLine('[mpv] 残留孤儿进程已清理: ' + leftover.join(','))
  }
  let blocked = false
  let detail = ''
  if (probe) {
    const p = await probeDeviceFree()
    blocked = !!p.blocked
    detail = p.detail || ''
    pushMpvLog(blocked ? 'warn' : 'info', blocked ? '声卡仍被占用：别的程序可能还是没声音' : '声卡已释放，其他程序可以正常发声')
  }
  return { ok: true, exited, leftover, blocked, detail }
}

/** 列出（并杀掉）属于本进程的残留 mpv —— 竞态产生的孤儿会一直霸着声卡 */
async function sweepOurMpv(listTimeout = 8000, killTimeout = 5000) {
  if (process.platform !== 'win32') return []
  const selfPid = process.pid
  const script = [
    'Get-CimInstance Win32_Process -Filter "Name=\'mpv.exe\'" | ForEach-Object {',
    '  $m = [regex]::Match($_.CommandLine, \'lxmpv-(\\d+)-\')',
    '  if (-not $m.Success) { return }',
    '  if ([int]$m.Groups[1].Value -ne ' + selfPid + ') { return }',
    '  $_.ProcessId',
    '}'
  ].join('\n')
  // v3.3.9：改异步 —— 同步版（execFileSync 8 秒 + 逐个 taskkill 各 5 秒）会把主进程
  // 事件循环卡到 13 秒，期间流代理和所有 IPC 全部停摆
  const listPids = () => new Promise((resolve) => {
    G.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: listTimeout }, (err, stdout) => {
        if (err || !stdout) return resolve([])
        resolve(String(stdout).split(/\r?\n/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x)))
      })
  })
  const killPid = (pid) => new Promise((resolve) => {
    G.execFile('taskkill', ['/PID', pid, '/F'], { windowsHide: true, timeout: killTimeout }, () => resolve())
  })
  const pids = await listPids()
  for (const pid of pids) await killPid(pid)
  return pids
}

/** 探测用的 0.5 秒静音 wav（mpv 得有东西播才会去开声卡） */
let probeWavPath = ''

function ensureProbeWav() {
  if (probeWavPath) { try { if (fs.existsSync(probeWavPath)) return probeWavPath } catch {} }
  try {
    const rate = 48000
    const frames = Math.floor(rate * 0.5)
    const bytes = frames * 2
    const buf = Buffer.alloc(44 + bytes)
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8)
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
    buf.write('data', 36); buf.writeUInt32LE(bytes, 40)
    probeWavPath = path.join(G.DATA_DIR, 'probe-silence.wav')
    fs.writeFileSync(probeWavPath, buf)
    return probeWavPath
  } catch (err) {
    return ''
  }
}

/**
 * 实测声卡现在能不能被别人用：拿共享模式的 mpv 试着打开默认设备。
 * 打不开（AUDCLNT_E_DEVICE_IN_USE）就说明还被谁占着 —— 这就是「其他软件没声音」的判定依据。
 * 顺带效果：以共享方式打开一次，Windows 会把端点的独占状态清干净，别人更容易立刻接回来。
 */
function probeDeviceFree() {
  return new Promise((resolve) => {
    const wav = ensureProbeWav()
    const exe = mpvExePath()
    if (!wav || !exe || !fs.existsSync(exe)) {
      resolve({ blocked: false, detail: 'mpv 不可用，跳过探测' })
      return
    }
    const args = [
      '--no-config', '--no-video', '--ao=wasapi', '--audio-exclusive=no',
      '--length=0.4', '--msg-level=all=warn', wav
    ]
    // 探测的必须是「用户实际在用的那个设备」：独占是按设备占的，
    // 探测默认设备而用户选的是 USB DAC，就会漏判（明明还占着却报可用）。
    const dev = String(G.store.get().settings.audioDevice || '').trim()
    if (dev) args.splice(3, 0, '--audio-device=' + dev)
    G.execFile(exe, args, { windowsHide: true, timeout: 12000 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '')
      const blocked = /AUDCLNT_E_DEVICE_IN_USE|0x8889000a|EXCLUSIVE_MODE/i.test(out)
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || ''
      // 第四轮 §4.2 #5：以前完全忽略 err —— 探测超时被杀、或根本没输出时
      // blocked=false 会被当成「声卡已释放」，把用户引向一个必然失败的切换
      if (!blocked && (err || !out)) {
        resolve({ blocked: null, uncertain: true, detail: '探测未取得结论（超时或无输出）' })
        return
      }
      resolve({ blocked, detail: blocked ? first : '' })
    })
  })
}

function stopMpv() {
  // 保留旧的同步入口（退出流程用），真正等待进程退出的逻辑在 releaseMpv() 里
  const eng = mpvEngine
  mpvEngine = null
  stopDeviceWatch()
  if (!eng) return Promise.resolve({ ok: true, exited: true })
  pushMpvLog('info', '关闭引擎')
  return eng.stop()
}

/* ---------------- 输出设备热插拔（v2.1） ---------------- */

/**
 * 独占模式最典型的翻车场景：接 USB DAC 听歌，人走开把线拔了 —— mpv 的独占流会直接失效，
 * 但界面什么都不会说，用户只会觉得"播放器卡住了/没声音"。
 * 这里每 8 秒对一次 WASAPI 设备列表：选定的设备消失就自动退回系统默认并告知界面；
 * 设备插回来后自动切回去（只在同一次运行里记着，重启不猜）。
 */
let deviceWatchId = null

let lostDevice = ''

let deviceWatchBusy = false

function startDeviceWatch() {
  if (deviceWatchId || process.platform !== 'win32') return
  deviceWatchId = setInterval(async () => {
    // 第四轮 §4.1 #8：一轮里 listDevices(4s) + restart(可 >8s) 会超过 8 秒间隔，
    // 没有闸门就会多轮并发，重复写设置、重复发事件、重复排队 restart
    if (deviceWatchBusy) return
    if (!mpvEngine || !mpvEngine.running || !G.store.get().settings.exclusiveOutput) return
    deviceWatchBusy = true
    try {
    // v3.3.6 / v2.8.6：抓住这一轮的引擎实例。下面 await 期间用户可能已经关了独占
    // （引擎被换掉/停掉）。这时如果还拿旧实例去 restart()，就会在「关独占」之后
    // 又起一个新的独占 mpv —— 那个进程没人管，就是一个霸着声卡的孤儿。
    const eng = mpvEngine
    const cur = String(G.store.get().settings.audioDevice || '')
    let devs
    try {
      devs = await eng.listDevices()
    } catch {
      return
    }
    // await 之后重新确认：引擎还是同一个、还在跑、独占仍然开着
    if (mpvEngine !== eng || !eng.running || !G.store.get().settings.exclusiveOutput) return
    const names = new Set(devs.map((d) => d.name))
    if (cur && !names.has(cur)) {
      lostDevice = cur
      pushMpvLog('error', '输出设备已断开：' + cur + ' → 自动切回系统默认')
      G.logLine('[device] 设备断开，回退系统默认：' + cur)
      // v3.3.17：先 restart 成功再写设置与发事件。
      // 以前顺序反了：设置被清空 + 界面收到「已切回默认」，而 restart 的返回值被丢弃 ——
      // restart 失败（设备被别的程序独占 / 驱动还没恢复）时用户看到「已切回」却完全没声音，
      // 而且下次启动 DAC 偏好已经丢了。
      let ok = false
      try { ok = !!(await eng.restart({ exclusive: true, audioDevice: '' })).ok } catch (e) { ok = false }
      if (!ok) {
        pushMpvLog('error', '切回系统默认设备失败，独占可能已中断')
        G.sendToRenderer('device-lost', { device: cur, restored: false, error: '切回系统默认设备失败，请手动重开独占' })
        return
      }
      G.store.patch({ settings: { audioDevice: '' } })
      G.sendToRenderer('device-lost', { device: cur, restored: false })
      return
    }
    if (!cur && lostDevice && names.has(lostDevice)) {
      const back = lostDevice
      lostDevice = ''
      pushMpvLog('info', '输出设备已接回：' + back + ' → 自动切回')
      G.logLine('[device] 设备接回，自动切回：' + back)
      let ok = false
      try { ok = !!(await eng.restart({ exclusive: true, audioDevice: back })).ok } catch (e) { ok = false }
      if (!ok) {
        // 接回失败：保留 lostDevice，等下一轮（8 秒后）再试，但别写进设置
        lostDevice = back
        pushMpvLog('warn', '设备已插回但切换失败，稍后重试：' + back)
        return
      }
      G.store.patch({ settings: { audioDevice: back } })
      G.sendToRenderer('device-lost', { device: back, restored: true })
    }
    } finally { deviceWatchBusy = false }
  }, 8000)
  if (deviceWatchId.unref) deviceWatchId.unref()
  G.logLine('[device] 开始监视输出设备（8s 一次）')
}

function stopDeviceWatch() {
  if (deviceWatchId) { clearInterval(deviceWatchId); deviceWatchId = null }
  lostDevice = ''
}

module.exports = {
  init,
  get mpvEngine() { return mpvEngine },
  MPV_LOG_MAX,
  mpvLogs,
  get mpvLogSeq() { return mpvLogSeq },
  pushMpvLog,
  mpvExePath,
  onMpvEvent,
  get mpvReleasing() { return mpvReleasing },
  ensureMpv,
  releaseMpv,
  releaseMpvOnce,
  sweepOurMpv,
  get probeWavPath() { return probeWavPath },
  ensureProbeWav,
  probeDeviceFree,
  stopMpv,
  get deviceWatchId() { return deviceWatchId },
  get lostDevice() { return lostDevice },
  get deviceWatchBusy() { return deviceWatchBusy },
  startDeviceWatch,
  stopDeviceWatch,
}
