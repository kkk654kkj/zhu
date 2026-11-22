'use strict'
/**
 * 音乐文件夹监视的「什么时候扫 / 扫哪些目录」策略（v3.3.78）。
 *
 * 纯函数、不碰 fs，便于单测。main.js 只负责挂 fs.watch、做可达性校验和真正调 scan。
 *
 * 背景：v1.7 起是「任一文件事件 → 固定 8 秒后全根重扫」。两个问题：
 *   ① 感知慢：拷完一首歌要等 8 秒才出现（用户体感「不灵敏」）；
 *   ② 降防抖就变贵：全根重扫要递归 walk + 逐文件 stat，几千首的库降成 1 秒一次会把 IO 打满。
 * 所以这里做两件事：智能防抖（静默 1.2 秒即扫 + 连绵事件最多等 6 秒）+ 只重扫事件发生的子目录。
 */

/** 防抖/重试参数（单位 ms，MAX_DIRS 是次数） */
const TUNING = {
  /** 事件静默多久就开扫：首响延迟 */
  QUIET_MS: 1200,
  /** 拷贝整张专辑/整棵树时事件连绵不断，最多等这么久必扫一次（分批出歌，不会无限推迟） */
  MAX_WAIT_MS: 6000,
  /** 已有扫描在跑时的重试间隔（扫描结束就立刻接上，不用等满 QUIET_MS） */
  BUSY_RETRY_MS: 2000,
  /** 扫描后的尾巴补扫延迟：拷贝中的文件此刻才写完，这一轮把半截文件补全 */
  TAIL_MS: 3000,
  /** 单次子集扫描最多覆盖的目录数；超过就退回全根扫（避免 N 次 readdir 的开销） */
  MAX_DIRS: 12
}

/** 路径归一：统一分隔符、去尾部斜杠、转小写（Windows 大小写不敏感） */
function normPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/')
  return s.replace(/\/+$/, '').toLowerCase()
}

/** p 是否等于 root 或位于 root 之下 */
function insideRoot(p, root) {
  const low = normPath(p)
  const r = normPath(root)
  if (!low || !r) return false
  return low === r || low.startsWith(r + '/')
}

/**
 * 父子合并：只保留最上层目录。
 * 一次拷贝会在几十个目录各触发事件，父目录扫描已经覆盖子树 —— 留着子目录只是重复 readdir。
 * 返回原样大小写的路径（Windows 上小写路径也能用，但日志/诊断里保留原样更好读）。
 */
function collapseDirs(list) {
  const items = []
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const low = normPath(raw)
    if (!low) continue
    if (items.some((x) => x.low === low)) continue
    items.push({ low, raw })
  }
  items.sort((a, b) => a.low.length - b.low.length)
  const out = []
  for (const it of items) {
    if (out.some((o) => it.low === o.low || it.low.startsWith(o.low + '/'))) continue
    out.push(it)
  }
  return out.map((o) => o.raw)
}

/**
 * 下一次扫描的等待时长：
 * - 距本批第一个事件已超 MAX_WAIT_MS → 0（立刻扫，别让连绵事件无限推迟）
 * - 否则取 QUIET_MS 与「剩余预算」的较小值
 */
function nextDelayMs(batchStart, now, tuning = TUNING) {
  const start = Number(batchStart) || 0
  const t = Number(now) || 0
  if (!start) return tuning.QUIET_MS
  const left = tuning.MAX_WAIT_MS - Math.max(0, t - start)
  if (left <= 0) return 0
  return Math.min(tuning.QUIET_MS, left)
}

module.exports = { TUNING, normPath, insideRoot, collapseDirs, nextDelayMs }
