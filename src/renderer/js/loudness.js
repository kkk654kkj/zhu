'use strict'
/* 响度分析（音量均衡的后端计算，全部在渲染进程跑）
 *
 * 算法：ITU-R BS.1770-4 的近似实现
 *   1. fetch(lxfile://) → arrayBuffer → OfflineAudioContext(48kHz).decodeAudioData 重采样解码
 *   2. 每声道过两级 K 滤波（高通 38Hz + 高搁置 +4dB，48kHz 标准系数）
 *   3. 400ms 分块（100ms 步进）求能量，绝对门限 -70 LUFS + 相对门限 -10 LU 双重过滤
 *   4. 综合响度 → 与目标响度的差即需要的增益；再按真峰值防削波夹紧
 *
 * 注意：decodeAudioData 会消费（detach）传入的 ArrayBuffer，每次都要新取。
 */

const LUFS_DEFAULT_TARGET = -16

/* 48kHz 下的 K 滤波系数（BS.1770-4 规范值） */
const K_STAGE1_B = [1.53512485958697, -2.69169618940638, 1.19839281085285]
const K_STAGE1_A = [1, -1.69065929318241, 0.73248077421585]
const K_STAGE2_B = [1, -2, 1]
const K_STAGE2_A = [1, -1.99004745483398, 0.99007225036621]

/** Chromium 解码器支持的格式（ape/wma/dsf/dff/mka 解不了，分析时跳过） */
const LOUDNESS_OK_EXT = new Set(['flac', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'aiff', 'aif'])

/** 原地跑一个 biquad */
function kFilter(data, b, a) {
  const b0 = b[0], b1 = b[1], b2 = b[2], a1 = a[1], a2 = a[2]
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i]
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
    data[i] = y0
  }
}

/** 解码上下文：sampleRate=48000 的 OfflineAudioContext，decodeAudioData 会自动重采样到 48k */
let _decodeCtx = null
function getDecodeCtx() {
  if (!_decodeCtx) _decodeCtx = new OfflineAudioContext(2, 48000, 48000)
  return _decodeCtx
}

/** 分析一个音频 URL 的响度。返回 { lufs, peakDb, gain }，失败抛异常。 */
async function analyzeLoudness(url, targetLufs = LUFS_DEFAULT_TARGET) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const ab = await res.arrayBuffer()
  const buf = await getDecodeCtx().decodeAudioData(ab)
  return analyzeBuffer(buf, targetLufs)
}

function analyzeBuffer(buf, targetLufs) {
  const sr = buf.sampleRate
  const n = buf.length
  const nCh = Math.min(buf.numberOfChannels, 2) // BS.1770 对立体声求和；环绕声罕见，取前两声道
  if (!n || !nCh) throw new Error('空音频')
  // v3.3.9：长音轨直接拒绝 —— decodeAudioData 整段解码 + 每声道再拷一份，
  // 1 小时立体声内存峰值约 2.8GB，整库分析遇到有声书必 OOM（调用方按失败跳过）
  if (n / sr > 1800) throw new Error('音轨超过 30 分钟，跳过响度分析')

  // 1) 峰值（滤波前）+ 每声道 K 滤波后的副本
  const filtered = []
  let peak = 0
  for (let c = 0; c < nCh; c++) {
    const src = buf.getChannelData(c)
    const d = new Float32Array(src) // 拷贝，不动原数据
    for (let i = 0; i < n; i++) {
      const v = Math.abs(src[i])
      if (v > peak) peak = v
    }
    kFilter(d, K_STAGE1_B, K_STAGE1_A)
    kFilter(d, K_STAGE2_B, K_STAGE2_A)
    filtered.push(d)
  }

  // 2) 分块能量（400ms 块 / 100ms 步进）
  const blockLen = Math.round(0.4 * sr)
  const hop = Math.round(0.1 * sr)
  const powers = []
  for (let start = 0; start + blockLen <= n; start += hop) {
    let sum = 0
    for (let ci = 0; ci < filtered.length; ci++) {
      const d = filtered[ci]
      for (let i = start; i < start + blockLen; i++) sum += d[i] * d[i]
    }
    powers.push(sum / blockLen)
  }
  if (!powers.length) throw new Error('音频太短')

  const toL = (p) => -0.691 + 10 * Math.log10(Math.max(p, 1e-12))

  // 3) 双门限
  const kept1 = powers.filter((p) => toL(p) > -70)
  if (!kept1.length) throw new Error('静音')
  const mean1 = kept1.reduce((a, b) => a + b, 0) / kept1.length
  const relGate = toL(mean1) - 10
  const kept2 = kept1.filter((p) => toL(p) > relGate)
  const finalArr = kept2.length ? kept2 : kept1
  const meanFinal = finalArr.reduce((a, b) => a + b, 0) / finalArr.length
  const lufs = toL(meanFinal)

  // 4) 增益：目标 - 综合响度；按峰值防削波（峰值+增益 ≤ -1dB），再整体夹紧
  let gain = targetLufs - lufs
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-9))
  const maxByPeak = -1 - peakDb
  if (maxByPeak < gain) gain = Math.max(maxByPeak, -20)
  gain = Math.max(-20, Math.min(12, gain))

  return {
    lufs: Math.round(lufs * 10) / 10,
    peakDb: Math.round(peakDb * 10) / 10,
    gain: Math.round(gain * 10) / 10
  }
}
