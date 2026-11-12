'use strict'
/**
 * v3.3.31 防回归：在线搜索结果的音质列必须能拿到真实音质。
 *
 * 背景：v3.3.24 主进程模块拆分把 probeCache 搬进 downloader.js 却漏了导出，
 * main.js 的 online:probe 每次 0ms 抛 TypeError，列表永远只显示 128k/320k。
 * 只在 online 分支跑（master 没有联网模块）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const checks = []
const ok = (name, cond) => checks.push({ name, cond: !!cond })

const dl = read('src/main/downloader.js')
const main = read('src/main/main.js')
const pre = read('src/main/preload.js')
const ui = read('src/renderer/js/online.js')

const exportsBlock = (dl.match(/module\.exports\s*=\s*\{[\s\S]*?\n\}/) || [''])[0]
ok('downloader.js 的 module.exports 导出 probeCache（漏了会让探测直接抛 TypeError）',
  /\bprobeCache\b/.test(exportsBlock))
ok('main.js 仍在使用 DL.probeCache', /DL\.probeCache\.get\(ck\)/.test(main))
ok('不再按 sender 一刀切取消探测（同轮 3 路并发会互相 abort）', !/probeCtrls/.test(main))
ok('online:probe 接收 round 参数', /ipcMain\.handle\('online:probe',\s*async\s*\(e,\s*song,\s*round\)/.test(main))
ok('同轮并发共用一个控制器集合', /probeRounds[\s\S]{0,900}ctrls:\s*new Set\(\)/.test(main))
ok('母带档探测预算不小于 12s 无损窗口',
  /probeBudget\s*=\s*prefer === 'master' \?\s*(?:1[2-9]\d{3}|\d{6,})\s*:/.test(main))
ok('preload 把 round 透传给主进程',
  /onlineProbe:\s*\(song,\s*round\)\s*=>\s*invoke\('online:probe',\s*song,\s*round\)/.test(pre))
ok('渲染层把 probeToken 作为 round 传入', /onlineProbe\(song,\s*token\)/.test(ui))

let pass = 0
for (const c of checks) {
  if (c.cond) pass++
  console.log((c.cond ? '  ✓ ' : '  ✗ ') + c.name)
}
console.log(`\n全部通过（${pass}/${checks.length} 项）`)
if (pass !== checks.length) process.exit(1)
