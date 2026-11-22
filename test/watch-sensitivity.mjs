'use strict'
/**
 * 文件监视灵敏度回归（v3.3.78）
 *
 * 背景：v1.7 起的监视是「任一文件事件 → 固定 8 秒后全根重扫」。用户反馈「不够灵敏」。
 * 不能只把 8000 改成 1200 —— 全根重扫要递归 walk + 逐文件 stat，降防抖会把 IO 打满。
 * 所以改的是两件事，这个测试逐条钉住：
 *   ① 智能防抖：静默 1.2 秒即扫，连绵事件最多等 6 秒（watch-plan.nextDelayMs）
 *   ② 子集扫描：只重扫事件发生的目录，父子目录合并、上限 12 个（collapseDirs / insideRoot）
 *   ③ 忙碌重排、尾巴补扫、无变更不刷新（main.js / scan.js 静态断言）
 *
 * 用法：node test/watch-sensitivity.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require2 = createRequire(import.meta.url)

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------------- 1) 策略纯函数 ---------------- */
let WP = null
try {
  WP = require2(path.join(ROOT, 'src/main/watch-plan.js'))
} catch (err) {
  ok('watch-plan 模块可加载', false, String(err && err.message).slice(0, 80))
}
if (!WP) {
  console.log('\n' + fail + ' 项失败 / ' + pass + ' 项通过')
  process.exit(1)
}

const T = WP.TUNING
console.log('== 防抖预算 ==')
ok('静默阈值 1.2 秒（旧版固定 8 秒）', T.QUIET_MS === 1200, T.QUIET_MS + 'ms')
ok('连绵事件最长等 6 秒', T.MAX_WAIT_MS === 6000, T.MAX_WAIT_MS + 'ms')

// 单次事件：batchStart == now → 等满 QUIET_MS
ok('首个事件：等 1.2 秒就扫（不再等 8 秒）',
  WP.nextDelayMs(1000, 1000) === 1200, WP.nextDelayMs(1000, 1000) + 'ms')
// 事件持续：t = start+5000 → 剩余预算 1000 < QUIET_MS → 取 1000
ok('连绵 5 秒后只剩 1 秒预算', WP.nextDelayMs(0 + 1000, 6000) === 1000, WP.nextDelayMs(1000, 6000) + 'ms')
// 事件持续超过 6 秒 → 立刻扫（不等）
ok('连绵超过 6 秒立刻扫', WP.nextDelayMs(1000, 9000) === 0, WP.nextDelayMs(1000, 9000) + 'ms')
ok('batchStart 缺失时按首响处理', WP.nextDelayMs(0, 12345) === T.QUIET_MS)

console.log('== 目录收敛 ==')
ok('父子合并：父吃掉子',
  JSON.stringify(WP.collapseDirs(['D:\\M\\A\\B', 'D:\\M\\A'])) === JSON.stringify(['D:\\M\\A']))
ok('大小写/尾斜杠去重',
  WP.collapseDirs(['D:\\M\\A\\', 'd:/m/a']).length === 1, JSON.stringify(WP.collapseDirs(['D:\\M\\A\\', 'd:/m/a'])))
ok('同层不同目录都保留',
  WP.collapseDirs(['D:\\M\\A', 'D:\\M\\B']).length === 2)
ok('前缀相似不算父子（Music vs Music2）',
  WP.collapseDirs(['D:\\Music2', 'D:\\Music']).length === 2)
ok('空值/非字符串被丢弃', WP.collapseDirs(['', null, 0, 'D:\\M']).length === 1)
ok('insideRoot：根本身 / 子目录 / 伪相似',
  WP.insideRoot('D:\\M', 'D:\\M') === true &&
  WP.insideRoot('D:\\M\\A\\x.flac', 'D:\\M') === true &&
  WP.insideRoot('D:\\Music2', 'D:\\M') === false &&
  WP.insideRoot('E:\\M\\A', 'D:\\M') === false)

/* ---------------- 2) main.js 接线 ---------------- */
console.log('== 主进程接线 ==')
const mainSrc = read('src/main/main.js')
ok('不再用固定 8 秒定时器', !/setTimeout\(runWatchScan,\s*8000\)/.test(mainSrc))
ok('防抖预算走 watch-plan', /WATCHP\.nextDelayMs\(/.test(mainSrc))
ok('事件带「变化目录」而不是只记 bool', /scheduleWatchScan\(path\.dirname\(path\.join\(dir, name\)\)\)/.test(mainSrc))
ok('变化目录不可达时往上找祖先', /async function resolveWatchDirs/.test(mainSrc) && /path\.dirname\(dir\)/.test(mainSrc))
ok('定位失败退回全根（不静默跳过）', /退回全根扫描/.test(mainSrc))
ok('子集目录交给 scan', /library\.scan\(scanDirs,/.test(mainSrc))
ok('扫描在跑时忙等重排', /WATCHP\.TUNING\.BUSY_RETRY_MS/.test(mainSrc))
ok('扫完排尾巴补扫（半截文件）', /WATCHP\.TUNING\.TAIL_MS/.test(mainSrc))
ok('stopWatching 清尾巴与批次状态',
  /if \(watchTailTimer\) \{ clearTimeout\(watchTailTimer\); watchTailTimer = null \}/.test(mainSrc) &&
  /watchPendingDirs = new Set\(\)[\s\S]{0,120}watchPendingAll = false/.test(mainSrc))
ok('尾巴补扫最多两跳（不会无限自我续排）',
  /hops < 2/.test(mainSrc) && /hops: hops \+ 1/.test(mainSrc))
ok('补扫用失败清单涨幅判断「还在写」', /failAfter > failBefore/.test(mainSrc))
ok('监视扫描仍过 isSafeMediaRoot', /const roots = \(Array\.isArray\(s\.musicDirs\)[\s\S]{0,160}PROTO\.isSafeMediaRoot\(d\)/.test(mainSrc))

/* ---------------- 3) 无变更不刷新 ---------------- */
console.log('== 无变更不刷新 ==')
const libSrc = read('src/main/library.js')
const scanSrc = read('src/renderer/js/scan.js')
ok('scan 返回 changed 标记', /changed: !!\(dirty \|\| added \|\| updated \|\| removed\)/.test(libSrc))
ok('渲染层 changed===false 跳过大刷新', /res\.changed === false/.test(scanSrc))
ok('跳过时仍刷新失败清单（诊断面板）', /if \(typeof Diag !== 'undefined' && Diag\.isOpen\(\)\) Diag\.loadFailures\(\)\n    return/.test(scanSrc))

console.log('\n' + (fail ? fail + ' 项失败 / ' + pass + ' 项通过' : '全部通过（' + pass + ' 项）'))
process.exit(fail ? 1 : 0)
