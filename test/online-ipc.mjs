'use strict'
/**
 * v3.3.32 防回归：v3.3.24 主进程模块拆分留下的「只搬定义不导出 / 漏 require」
 * 与在线面板乐观赋值问题。上一轮只补了 probeCache，本轮把同类漏网全收口。
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
const sp = read('src/main/streamproxy.js')
const main = read('src/main/main.js')
const online = read('src/renderer/js/online.js')

const exportsBlock = (dl.match(/module\.exports\s*=\s*\{[\s\S]*?\n\}/) || [''])[0]
ok('downloader 导出 dlTasks / dlTargetCache（漏了让下载管理全线抛 TypeError）',
  /\bdlTasks\b/.test(exportsBlock) && /\bdlTargetCache\b/.test(exportsBlock))
ok('dlSeq 用读写器导出（可变 let 不能用值快照）',
  /get dlSeq\(\)\s*\{\s*return dlSeq\s*\}/.test(exportsBlock) &&
  /set dlSeq\(v\)\s*\{\s*dlSeq = v\s*\}/.test(exportsBlock))
ok('dlPruneFinished 摘任务时一并摘 dlTargetCache',
  /dlTasks\.delete\(t\.id\);\s*dlTargetCache\.delete\(t\.id\)/.test(dl))
ok('dlRun 保留解析链原始异常，不伪装成版权限制',
  /catch \(err\) \{\s*parseErr = err\s*\}/.test(dl) &&
  /throw parseErr \|\| new Error\('没有可用地址/.test(dl))
ok('下载被删除时一并清掉 dlTargetCache',
  /if \(task\.deleted\) \{[\s\S]{0,200}?dlTargetCache\.delete\(task\.id\)/.test(dl))
ok('streamproxy 补回 PROTO require（缓存命中播放不再 500）',
  /const PROTO = require\('\.\/protocols'\)/.test(sp) &&
  /PROTO\.mimeFor\(filePath\)/.test(sp))
ok('streamproxy 导出 closeStreamServer 且强制断开 keep-alive',
  /function closeStreamServer\(\)/.test(sp) &&
  /closeAllConnections\(\)/.test(sp) &&
  /\bcloseStreamServer,/.test(sp))
ok('退出链调用 SP.closeStreamServer', /SP\.closeStreamServer\(\)/.test(main))
ok('online:cacheClear 用 DC.cacheStats()（裸调用会让 IPC reject）',
  /return \{ \.\.\.DC\.cacheStats\(\), removed: r\.removed \}/.test(main))
ok('dlDelete / dlClearDone 都清 dlTargetCache',
  (main.match(/DL\.dlTargetCache\.delete\(/g) || []).length >= 3)
ok('音源与音质设置先判写盘成败再改内存',
  (online.match(/patchSettings\([^\n]*\)\.then\(\(\) => true, \(\) => false\)/g) || []).length === 2 &&
  /设置保存失败，音源开关未生效/.test(online) &&
  /设置保存失败，音质偏好未生效/.test(online))
ok('音源写盘失败回滚 enabled（保持原 Set 引用）',
  /this\.enabled\.clear\(\)[\s\S]{0,200}?for \(const s of prev\) this\.enabled\.add\(s\)/.test(online))

let pass = 0
for (const c of checks) {
  if (c.cond) pass++
  console.log((c.cond ? '  ✓ ' : '  ✗ ') + c.name)
}
console.log(`\n全部通过（${pass}/${checks.length} 项）`)
if (pass !== checks.length) process.exit(1)
