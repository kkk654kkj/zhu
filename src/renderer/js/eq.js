'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 音量均衡 / 均衡器 ================= */

/**
 * 把 audio 元素接进 WebAudio（链路由 audiofx.js 建：source → trackGain → preamp
 * → 10×BiquadFilter → analyser → destination）。失败则全程原声，功能降级不影响播放。
 */
function setupAudioGraph() {
  const ok = AudioFx.init(audio)
  state.audioGraphReady = !!ok
  if (!ok) toast('音频特效不可用，将以原声播放')
  return ok
}

/**
 * EQ / 音量均衡 / 手动增益 / 频谱是否被禁用。
 * v3.3.18（第四轮 P1 #8）：判据从「state.exclusive」改成「WebAudio 链没建起来」——
 * 独占回退共享后 audio 仍是 MpvAudio、AudioFx.ctx 始终为 null，以前靠 state.exclusive
 * 判定会在回退后误放行，用户拖滑块毫无效果却照样落盘。
 */
function eqBlocked() {
  return state.exclusive || !state.audioGraphReady
}

const EQ_BLOCKED_MSG = '独占输出下均衡器/音量均衡不可用（软件处理会破坏位完美）'

/** 当前曲目应施加的增益（dB）：手动优先，其次按开关取分析值 */
function trackGainDb(id) {
  if (!id) return 0
  const s = state.settings
  const manual = s.manualGains && s.manualGains[id]
  if (typeof manual === 'number') return Math.max(-20, Math.min(20, manual))
  if (s.normalizeVolume) {
    const g = s.trackGains && s.trackGains[id]
    if (typeof g === 'number') return Math.max(-20, Math.min(20, g))
    // v2.0：没有分析数据就用文件自带的 ReplayGain 标签。
    // 分析结果优先于标签——分析是按你这套目标响度（targetLufs）算的，更贴合，
    // 标签是别人写的、目标响度不一定和这里一致
    const t = state.byId.get(id)
    if (t && typeof t.rgTrackDb === 'number') return Math.max(-20, Math.min(20, t.rgTrackDb))
  }
  return 0
}

function applyTrackGain(id) {
  AudioFx.setTrackGain(trackGainDb(id))
}

/* ---------------- 均衡器 / 频谱 ---------------- */

function eqSettings() {
  const s = state.settings.eq
  return {
    enabled: !!(s && s.enabled),
    preset: (s && s.preset) || 'flat',
    bands: s && Array.isArray(s.bands) && s.bands.length === EQ_FREQS.length
      ? s.bands.slice()
      : EQ_PRESETS.flat.bands.slice()
  }
}

/** 应用 EQ 设置到音频链 + 刷新界面 + 落盘（落盘可关） */
function applyEq(cfg, { persist = true } = {}) {
  const next = {
    enabled: cfg.enabled !== undefined ? !!cfg.enabled : eqSettings().enabled,
    preset: cfg.preset !== undefined ? cfg.preset : eqSettings().preset,
    bands: cfg.bands !== undefined ? cfg.bands.slice() : eqSettings().bands
  }
  state.settings.eq = next
  AudioFx.applyEq(next)
  UI.renderEq(next)
  if (persist) saveSettings({ eq: next })
}

function setEqBand(index, value) {
  const cfg = eqSettings()
  cfg.bands[index] = Math.max(-EQ_MAX_DB, Math.min(EQ_MAX_DB, Number(value) || 0))
  // 手改滑块 = 自定义，取消预设高亮（除非数值刚好等于某个预设）
  const match = Object.entries(EQ_PRESETS).find(([, p]) => p.bands.every((v, i) => v === cfg.bands[i]))
  cfg.preset = match ? match[0] : 'custom'
  // 一动滑块就自动开启，否则用户拖了没反应
  cfg.enabled = true
  applyEq(cfg)
}

function applyEqPreset(key) {
  const p = EQ_PRESETS[key]
  if (!p) return
  applyEq({ enabled: true, preset: key, bands: p.bands.slice() })
  toast('音效：' + p.label)
}

/** 是否已有可用分析数据 */
function hasAnalyzedGains() {
  const g = state.settings.trackGains
  return !!g && Object.keys(g).length > 0
}

/**
 * 曲库响度分析：逐首解码 → BS.1770 近似响度 → 增益写回 settings.trackGains。
 * Esc 可中断。ape/wma/dsf 等解码器不支持的格式自动跳过。
 */
async function analyzeLibraryLoudness() {
  if (state.analyzing) { toast('正在分析中…'); return }
  // v3.3.17：两者共用同一个扫描遮罩，谁先结束都会把对方的进度条关掉
  if (scanning) { toast('正在扫描曲库，稍后再分析响度'); return }
  const all = state.tracks
  const byExt = all.filter((t) => LOUDNESS_OK_EXT.has((t.ext || '').toLowerCase()))
  // v2.0：带 ReplayGain 标签的直接跳过——标签就是别人算好的响度，
  // 再花几分钟解一遍纯属浪费（用户想覆盖时可以先用「清除分析数据」）
  const tagCount = byExt.filter((t) => typeof t.rgTrackDb === 'number').length
  const list = byExt.filter((t) => typeof t.rgTrackDb !== 'number')
  const skipped = all.length - list.length
  if (!list.length) {
    toast(tagCount ? `所有可分析曲目都自带 ReplayGain 标签（${tagCount} 首），无需分析` : '曲库里没有可分析的格式', 3000)
    return
  }

  state.analyzing = true
  state.abortAnalysis = false
  UI.showScan('正在分析响度…', 'analyze')
  const target = state.settings.targetLufs || LUFS_DEFAULT_TARGET
  const gains = Object.assign({}, state.settings.trackGains || {})
  let done = 0
  let failed = 0
  let preSkipped = 0
  try {
    for (const t of list) {
      if (state.abortAnalysis) break
      UI.updateScan({ phase: 'parse', done, total: list.length, name: t.title, label: '正在分析响度' })
      // v3.3.9：超长音轨在解码前就跳过 —— decodeAudioData 整段解码内存峰值无上限，
      // 1 小时 FLAC ≈ 2.8GB（analyzBuffer 里还有一道兜底）
      // v3.3.13：主动跳过不算「失败」，也不进 done（done 只记真正进入分析的曲目）
      if ((t.duration || 0) > 1800) {
        preSkipped++
        console.warn('[loudness] 跳过长音轨', t.title)
        continue
      }
      try {
        const r = await analyzeLoudness(t.audio, target)
        gains[t.id] = r.gain
      } catch (err) {
        failed++
        console.warn('[loudness] 跳过', t.title, err && err.message)
      }
      done++
      // 给 UI 喘口气，也让 GC 有机会回收解码缓冲
      await new Promise((r) => setTimeout(r, 20))
    }
    // v3.3.17：中途点了「清除分析数据」就不要再写回 —— 以前分析收尾无条件把
    // 开头快照的 gains 落盘，用户刚清除的数据会整批复活。
    if (state.gainsCleared) {
      state.settings.trackGains = {}
      applyTrackGain(state.currentId)
      toast('响度分析已中止，数据已清除')
      return
    }
    state.settings.trackGains = gains
    await window.api.patchSettings({ trackGains: gains })
    applyTrackGain(state.currentId)
    if (state.abortAnalysis) toast('响度分析已中断（已完成部分已保存）')
    else toast(`响度分析完成：${done} 首` +
      (skipped ? `，跳过 ${skipped} 首（无解码器 / 自带 ReplayGain）` : '') +
      (preSkipped ? `，超长跳过 ${preSkipped} 首` : '') +
      (failed ? `，${failed} 首失败` : '') +
      (tagCount ? `，${tagCount} 首直接用标签` : ''), 4000)
  } catch (err) {
    console.error('[loudness]', err)
    toast('响度分析失败：' + (err && err.message))
  } finally {
    state.analyzing = false
    state.gainsCleared = false   // 第四轮 §4.4 #1：异常路径也必须复位，否则下一轮正常分析会被整批丢弃
    UI.hideScan('analyze')
    // v3.3.20：分析期间到达的 scan-done 在这里补渲染（见 onScanDone 的 pending 分支）
    if (state.scanDonePending) {
      state.scanDonePending = false
      onScanDone(null)
    }
  }
}

function clearAnalyzedGains() {
  state.settings.trackGains = {}
  // v3.3.17：分析进行中清除会被整批回写覆盖 —— 分析结束时无条件把开头快照的
  // trackGains 写成结果。这里先立一个中止标记，分析循环每首前检查。
  if (state.analyzing) { state.abortAnalysis = true; state.gainsCleared = true }
  window.api.patchSettings({ trackGains: {} }).catch(() => {})
  applyTrackGain(state.currentId)
  toast(state.analyzing ? '已清除，并中止正在进行的分析' : '已清除响度分析数据')
}

