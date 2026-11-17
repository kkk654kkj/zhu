'use strict'
/**
 * 曲库扫描 · 清理作用域回归（v3.3.67）
 *
 * 背景：`Library.scan` 的清理阶段以前按「本次 seen 里没有」就删曲目。
 * 只要有一次扫描传入的目录是全集的一个子集（新加的「单独重扫某个目录」、
 * 或 settings.json 手改出 isSafeMediaRoot 不认的路径导致 targetDirs 变子集），
 * 其它根的曲目就会被当成已删除，清空并写回 library.json —— 数据丢失。
 *
 * 这个测试真跑 Library（真解析、真落盘、真清理），两个目录各放一首极短 WAV：
 *   ① 全量扫（A+B）→ 2 首；
 *   ② 只扫 A → 仍然是 2 首（B 的曲目不能被连带删除）；
 *   ③ 只扫 A 且 A 里的文件已被删掉 → A 的曲目被清掉，B 还在；
 *   ④ 目录不可达（missingRoots）时清理整体跳过。
 *
 * 用法：node test/scan-scope.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require2 = createRequire(import.meta.url)

// 这个测试要真跑 Library（依赖 music-metadata / pinyin-pro）。干净检出里没有
// node_modules 时明确跳过，而不是假装通过 —— 看到 SKIP 就说明本轮没验证到清理逻辑。
let Library = null
try {
  ({ Library } = require2(path.join(ROOT, 'src/main/library.js')))
} catch (err) {
  console.log('SKIP：缺少运行时依赖（' + (err && err.message ? err.message.split('\n')[0] : err) + '）')
  console.log('      先 npm install（或设置 NODE_PATH 指向已安装的 node_modules）再跑。')
  process.exit(0)
}

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/** 0.1 秒静音 WAV（16bit / 8kHz / 单声道）——只要能被 music-metadata 读出时长即可 */
function wavBytes(seconds = 0.1) {
  const sr = 8000
  const n = Math.round(sr * seconds)
  const data = Buffer.alloc(n * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sr, 24)
  h.writeUInt32LE(sr * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-scan-scope-'))
const dirA = path.join(tmp, 'A')
const dirB = path.join(tmp, 'B')
fs.mkdirSync(dirA, { recursive: true })
fs.mkdirSync(dirB, { recursive: true })
const fileA = path.join(dirA, 'a-one.wav')
const fileB = path.join(dirB, 'b-two.wav')
fs.writeFileSync(fileA, wavBytes())
fs.writeFileSync(fileB, wavBytes())

const lib = new Library({
  cacheFile: path.join(tmp, 'data', 'library.json'),
  coverDir: path.join(tmp, 'data', 'covers'),
  lyricDir: path.join(tmp, 'data', 'lyrics')
})

async function main() {
  await lib.init()

  const r1 = await lib.scan([dirA, dirB], () => {})
  ok('全量扫两个目录：两首入库', lib.list().length === 2 && r1.total === 2, 'total=' + r1.total)

  const r2 = await lib.scan([dirA], () => {})
  ok('子集扫 A：B 的曲目不被连带删除（v3.3.67 核心）',
    lib.list().length === 2 && r2.removed === 0, 'total=' + lib.list().length + ' removed=' + r2.removed)

  fs.unlinkSync(fileA)
  const r3 = await lib.scan([dirA], () => {})
  ok('A 里的文件真被删掉：只清 A 的曲目，B 仍在',
    lib.list().length === 1 && r3.removed === 1 && lib.list()[0].fileName === 'b-two.wav',
    'total=' + lib.list().length + ' removed=' + r3.removed)

  // 目录不存在 → missingRoots 非空 → 清理整体跳过（B 不能被当成已删除）
  const r4 = await lib.scan([path.join(tmp, 'gone'), dirB], () => {})
  ok('有不可达目录时清理整体跳过（B 仍 1 首）',
    lib.list().length === 1 && r4.removed === 0 && Array.isArray(r4.missingRoots) && r4.missingRoots.length === 1,
    'total=' + lib.list().length + ' missing=' + (r4.missingRoots || []).length)

  const r5 = await lib.scan([], () => {})
  ok('空目录列表直接跳过，不清库', r5.skipped === true && lib.list().length === 1)

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\n' + (fail ? fail + ' 项失败 / ' + pass + ' 项通过' : '全部通过（' + pass + ' 项）'))
  process.exit(fail ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})