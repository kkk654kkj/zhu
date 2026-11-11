'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 独占输出（WASAPI 位完美） ================= */

/** mpv 的 audio-out-params → 简短标签，如 44.1k/16bit */
function audioFormatLabel(f) {
  if (!f || !f.samplerate) return ''
  const sr = Number(f.samplerate)
  const kHz = (sr / 1000).toFixed(sr % 1000 ? 1 : 0)
  const raw = String(f.format || '')
  const depth = raw.startsWith('s16') ? '16bit'
    : raw.startsWith('s24') ? '24bit'
      : raw.startsWith('s32') ? '32bit'
        : raw.startsWith('float') ? 'float' : raw
  return `${kHz}k/${depth}`
}

/** 是否真的处于位完美状态：独占 + 未被回退 + 输出格式已知且与源一致 + 音量 100% */
/**
 * 独占失败自动回退共享：把运行时状态与所有派生 UI 一次性同步。
 *
 * v3.3.18（第四轮 P1 #8）：**不能**把 state.exclusive 置 false。回退的是 mpv 的
 * WASAPI 共享模式，audio 仍是 MpvAudio，WebAudio 链从来没建过。以前在这里置 false，
 * 导致下游 7 处「独占下禁用」判据全部误放行：EQ / 音量均衡 / 响度分析 / 手动增益
 * 可操作但无效还照旧落盘；DSD 被误拦；keepAliveMediaSession 走错分支导致 SMTC 失效；
 * player.on('error') 进入共享的失败连跳（设备类错误连跳 3 首）。
 * 现在只立 exclusiveFellBack 供徽标显示，后端语义保持不变。
 */
function applyExclusiveFallback() {
  state.exclusiveFellBack = true
  // 回退后**不能**恢复 EQ：WebAudio 链仍不存在，按钮可点只会让用户白折腾
  UI.setEqDisabled(true)
  UI.setSpectrumVisible(false)
  UI.setNorm(false)
  updateHifiBadge()
}


function isBitPerfect() {
  if (!state.exclusive) return false
  if (!audio || audio.isExclusive === false) return false
  if (!player || player.muted) return false
  if (player.volume < 0.999) return false
  const f = audio.format
  if (!f || !f.samplerate) return false
  const src = player.current && player.current.sampleRate
  return !src || Number(f.samplerate) === Number(src)
}

function updateHifiBadge() {
  const on = state.settings.exclusiveOutput === true
  if (!on) { UI.setHifi({ on: false }); return }

  const fmt = audio && audio.format ? audioFormatLabel(audio.format) : ''
  const srcRate = player.current ? player.current.sampleRate : 0
  const shared = !!(audio && audio.isExclusive === false)
  const resampled = !!(audio && audio.format && srcRate && Number(audio.format.samplerate) !== Number(srcRate))

  let state_ = 'perfect'
  let text = ''
  let hint = ''

  if (shared) {
    state_ = 'warn'
    text = '已回退共享'
    hint = '独占输出失败，当前是 WASAPI 共享模式，不再是位完美' +
      (audio.fallbackMessage ? '：' + audio.fallbackMessage : '')
  } else if (!player.current) {
    state_ = 'idle'
    text = '独占输出 · 待播放'
    hint = 'WASAPI 独占已就绪，开始播放后这里显示实际输出格式'
  } else if (!fmt) {
    state_ = 'probing'
    text = '位完美 · 检测中…'
    hint = '正在等待声卡以文件原生格式打开'
  } else if (resampled) {
    state_ = 'warn'
    text = '已重采样 · ' + fmt + '（源 ' + (srcRate / 1000).toFixed(srcRate % 1000 ? 1 : 0) + 'k）'
    hint = '声卡不接受源采样率，mpv 已重采样，此时不是位完美'
  } else if (player.muted || player.volume < 0.999) {
    state_ = 'warn'
    text = '非位完美 · 音量 ' + Math.round((player.volume || 0) * 100) + '%'
    hint = '软件音量会改变样本数值；把音量调到 100% 才是文件原样输出'
  } else {
    text = '位完美 · ' + fmt
    hint = 'WASAPI 独占，按文件原生采样率/位深直出（输出 ' + fmt + '）'
  }

  UI.setHifi({ on: true, text, hint, perfect: state_ === 'perfect', kind: state_ })
}

/** 切换引擎：改设置后重载界面（队列/进度/播放模式会从会话恢复） */
let exclusiveSwitching = false

async function toggleExclusiveOutput() {
  // v3.3.17：整个流程包含「写设置 → 释放引擎（最长 11 秒）→ flush → reload」，
  // 期间连点会并发跑两条链路（release 与 start 交叉），结果不可预料。
  if (exclusiveSwitching) return
  exclusiveSwitching = true
  try {
    await toggleExclusiveOutputOnce()
  } finally {
    exclusiveSwitching = false
  }
}

async function toggleExclusiveOutputOnce() {
  if (state.settings.exclusiveOutput) {
    state.settings.exclusiveOutput = false
    const saved = await window.api.patchSettings({ exclusiveOutput: false }).then(() => true, () => false)
    // 写盘失败就别继续释放并重载 —— 重载后设置还是「开」，用户会看到按钮自己又亮回来
    if (!saved) { state.settings.exclusiveOutput = true; toast('设置保存失败，已取消关闭独占'); return }
    saveSession()
    // v3.3.6 / v2.8.6：关独占要走完整的「释放」流程 ——
    // 等 mpv 进程真退出、扫掉可能残留的孤儿、实测声卡能不能被别人打开。
    // 以前只发个信号就重载界面，设备可能还被占着，用户看到的是
    // 「关了独占，别的软件还是没声音，播放器自己还能继续放」。
    const rel = await window.api.mpvRelease().catch(() => null)
    try { sessionStorage.setItem('lx_release_notice', JSON.stringify(rel || {})) } catch (err) { /* 忽略 */ }
    await flushSaveSettingsForExit()
    location.reload()
    return
  }
  const ok = await window.api.mpvConfirmEnable().catch(() => false)
  if (!ok) return
  state.settings.exclusiveOutput = true
  const saved = await window.api.patchSettings({ exclusiveOutput: true }).then(() => true, () => false)
  if (!saved) { state.settings.exclusiveOutput = false; toast('设置保存失败，未开启独占'); return }
  saveSession()
  await flushSaveSettingsForExit()
  location.reload()
}

/**
 * 重载之后把「释放独占」的结果告诉用户（sessionStorage 传话，重载会清空内存）。
 * 声卡确实被还回来了 → 说明别的程序可能需要重新点一下播放才恢复；
 * 还被占着 → 直说，别让用户自己猜。
 */
function showReleaseNotice() {
  let raw = ''
  try { raw = sessionStorage.getItem('lx_release_notice') || '' } catch (err) { return }
  if (!raw) return
  try { sessionStorage.removeItem('lx_release_notice') } catch (err) { /* 忽略 */ }
  let rel = null
  try { rel = JSON.parse(raw) } catch (err) { return }
  if (!rel) return
  if (rel.blocked) {
    toast('声卡仍被占用，其它程序可能还是没声音。已清理本程序的残留进程，若仍无声请重启声卡设备。', 6000)
  } else if (rel.leftover && rel.leftover.length) {
    toast('已关闭独占输出，并清理了 ' + rel.leftover.length + ' 个残留进程。其它程序若没声音，重新播放一下即可。', 5000)
  } else {
    toast('已关闭独占输出，声卡已释放。其它程序若没声音，重新播放一下即可。', 4000)
  }
}

/* ================= 独占输出设备面板（v2.3：从隐藏的右键菜单升级为正式面板） ================= */

let audioDevicesCache = []
let audioDevicesLoading = false

/** 打开面板并重新枚举设备（枚举需要引擎在跑，主进程会自动管理临时进程） */
async function openAudioPanel() {
  toggleAudioPanel(true)
  paintExclusiveVolume()
  await refreshAudioDevices()
}

/* ---- 高精度音量（v2.5）：独占下直达 mpv 浮点音量，0.1 步进，附 dB 换算 ---- */

function paintExclusiveVolume() {
  const slider = document.getElementById('apVol')
  if (!slider) return
  const v = Math.round((player.volume || 0) * 1000) / 10
  slider.value = v.toFixed(1)
  const db = v > 0 ? (20 * Math.log10(v / 100)).toFixed(1) + ' dB' : '-∞ dB'
  document.getElementById('apVolVal').textContent = v.toFixed(1) + '% · ' + db
  document.querySelectorAll('#apVolPresets .sp-chip').forEach((chip) => {
    chip.classList.toggle('on', Math.abs(Number(chip.dataset.v) - v) < 0.05)
  })
}

function setExclusiveVolume(v) {
  v = Math.max(0, Math.min(100, Number(v) || 0))
  // v3.3.17：静音状态下拖音量要顺手解除静音，与主音量条一致。
  // 否则面板显示 50% 却依然无声，用户会怀疑设备/独占坏了。
  if (player.muted) player.setMuted(false)
  // player.setVolume → MpvAudio.volume → mpv set_property volume（浮点）→ vol-change 落盘
  player.setVolume(v / 100)
  paintExclusiveVolume()
}

function toggleAudioPanel(show) {
  const panel = document.getElementById('audioPanel')
  const target = show === undefined ? panel.hidden : !!show
  panel.hidden = !target
}

async function refreshAudioDevices() {
  if (audioDevicesLoading) return
  audioDevicesLoading = true
  const body = document.getElementById('audioDevices')
  body.innerHTML = '<span class="ap-loading">正在检测输出设备…</span>'
  const res = await window.api.mpvDevices().catch((err) => ({ ok: false, error: err.message }))
  audioDevicesLoading = false
  if (!res || !res.ok) {
    body.innerHTML = '<span class="ap-loading">检测失败：' + esc((res && res.error) || '未知错误') + '</span>'
    return
  }
  audioDevicesCache = res.devices || []
  paintAudioPanel()
}

function paintAudioPanel() {
  const cur = state.settings.audioDevice || ''
  const body = document.getElementById('audioDevices')
  const chip = (label, name) =>
    '<button class="sp-chip' + (name === cur ? ' on' : '') + '" data-dev="' + esc(name) + '">' +
    esc(label) + (name === cur ? '（当前）' : '') + '</button>'
  let html = chip('跟随系统默认设备', '')
  for (const d of audioDevicesCache) {
    html += chip(d.description || d.name, d.name)
  }
  if (!audioDevicesCache.length) {
    html += '<span class="ap-loading">没有检测到可用设备</span>'
  }
  body.innerHTML = html
}

/** 选中设备（'' = 跟随系统默认）。保存并即时切（独占没开时只保存，开启后生效）。 */
async function setAudioDevice(name) {
  name = name || ''
  const r = await window.api.mpvSetDevice(name).catch((err) => ({ ok: false, error: err.message }))
  // v3.3.17：主进程会在新设备起不来时自动退回原设备并回传 reverted。
  // 以前只看 ok/applied，界面提示「已切换」、面板还把失败设备标成「（当前）」，
  // 用户以为换了设备其实还在旧的上面。
  if (r && r.reverted) {
    state.settings.audioDevice = r.device || ''
    toast(r.error || '该设备不可用，已退回原设备', 3500)
  } else if (!r || !r.ok) {
    toast('切换输出设备失败：' + ((r && r.error) || '未知错误'), 3000)
  } else {
    state.settings.audioDevice = name
    toast(r.applied ? '输出设备已切换' : '输出设备已保存（开启独占后生效）')
  }
  paintAudioPanel()
}

