'use strict'
/**
 * v3.3.24 模块拆分：从 main.js 原样搬出（只做 G. 前缀注入，不改逻辑）。
 * init(G) 注入 main 的共享状态访问器（getter，见 main.js 的 G 定义）。
 */
const PROTO = require('./protocols')

let G = null
function init(g) { G = g }

/** 递归剔除 __proto__ / constructor / prototype 等原型污染键（保留其它值） */
const FORBIDDEN_SETTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function sanitizePlainValue(v) {
  if (Array.isArray(v)) return v.map(sanitizePlainValue)
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_SETTING_KEYS.has(k)) continue
      o[k] = sanitizePlainValue(x)
    }
    return o
  }
  return v
}

/**
 * 已知数值键的取值范围。渲染层可以调 settings:patch，光校验「是有限数」不够：
 * volume=5 会让 audio.volume 赋值抛 IndexSizeError，fadeMs 为负会让淡入淡出反向，
 * onlineCacheLimitMB 为负会让缓存淘汰逻辑算错目标。
 */
const SETTING_RANGES = {
  volume: [0, 1],
  fadeMs: [0, 3000],
  lyricFontSize: [8, 200],
  lyricOffset: [-60, 60],
  onlineCacheLimitMB: [0, 102400],
  targetLufs: [-40, 0],
  windowWidth: [200, 10000],
  windowHeight: [200, 10000]
}

/** 数值 map（lyricOffsetById / trackGains / resumePos / manualGains）的条数上限 */
const SETTING_MAP_MAX = 5000

// 第四轮 §4.1 #5：数组型设置的长度上限。超长 musicDirs 会让 startWatching() 无限
// fs.watch，句柄耗尽后整个曲库增删都失效（历史 #26 只补了数值范围，没补长度）
const SETTING_ARRAY_MAX = 200

function clampSetting(key, v) {
  const r = SETTING_RANGES[key]
  if (!r) return v
  return Math.min(r[1], Math.max(r[0], v))
}

/**
 * 按 DEFAULT_SETTINGS 的形状校验一个 settings patch：
 *  · 只放行模板里已有的键（顶层白名单）；
 *  · 数组元素类型须与模板一致、数值键须为有限数（并夹到 SETTING_RANGES 范围内）、
 *    布尔键须为布尔、字符串键须为字符串；
 *  · 空对象模板 = 数值 map（歌词偏移/增益/断点），只留有限数，条数上限 SETTING_MAP_MAX；
 *  · 递归拒绝 __proto__/constructor/prototype，未知类型一律丢弃。
 * template 传 DEFAULT_SETTINGS.desktopLyric 即可用于 dlyric:cfg 的子对象过滤。
 */
function sanitizeSettingsPatch(patch, template) {
  // v3.3.32：默认参数写的是裸标识符 DEFAULT_SETTINGS（定义在 main.js），CommonJS
  // 模块作用域拿不到 → 单参数调用必抛 ReferenceError。改走 init() 注入的 G getter。
  if (!template) template = G && G.DEFAULT_SETTINGS
  const out = {}
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out
  if (!template || typeof template !== 'object') return out
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_SETTING_KEYS.has(k)) continue
    if (!Object.prototype.hasOwnProperty.call(template, k)) continue  // 白名单
    const tv = template[k]
    if (Array.isArray(tv)) {
      if (!Array.isArray(v)) continue
      if (tv.length && !v.every((x) => typeof x === typeof tv[0])) continue
      if (v.length > SETTING_ARRAY_MAX) continue
      let arr = v.map(sanitizePlainValue)
      // musicDirs 每个元素都要是合法的白名单根，否则等于给 lxfile 开了任意目录读权限
      if (k === 'musicDirs') arr = arr.filter((d) => typeof d === 'string' && PROTO.isSafeMediaRoot(d))
      out[k] = arr
    } else if (tv && typeof tv === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const tvKeys = Object.keys(tv)
      if (tvKeys.length === 0) {
        // 空对象模板 = 数值 map（lyricOffsetById / trackGains / manualGains / resumePos）
        const clean = {}
        let n = 0
        for (const [mk, mv] of Object.entries(v)) {
          if (FORBIDDEN_SETTING_KEYS.has(mk)) continue
          // v3.3.17：数值 map 也要设条数上限 —— 否则一次 patch 就能塞进十万条，
          // 之后每次 saveSettings 都要把整份 settings.json 重写一遍
          if (n >= SETTING_MAP_MAX) break
          if (typeof mv === 'number' && Number.isFinite(mv)) { clean[mk] = mv; n++ }
        }
        out[k] = clean
      } else {
        out[k] = sanitizeSettingsPatch(v, tv)
      }
    } else if (tv === null) {
      // 模板为 null = 自由结构（窗口 bounds 等），只做递归去污染键
      out[k] = sanitizePlainValue(v)
    } else if (typeof tv === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampSetting(k, v)
    } else if (typeof tv === 'boolean') {
      if (typeof v === 'boolean') out[k] = v
    } else if (typeof tv === 'string') {
      if (typeof v === 'string') out[k] = v
    }
    // 其余类型（undefined/function/...）→ 拒绝该键
  }
  return out
}

module.exports = {
  init,
  FORBIDDEN_SETTING_KEYS,
  sanitizePlainValue,
  SETTING_RANGES,
  SETTING_MAP_MAX,
  SETTING_ARRAY_MAX,
  clampSetting,
  sanitizeSettingsPatch,
}
