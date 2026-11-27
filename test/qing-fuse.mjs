/**
 * 音质档熔断回归测试。
 *
 * 跑法：node test/qing-fuse.mjs
 * 不依赖 Electron / 网络：直接 require online.js 里的测试接缝。
 *
 * 钉住的语义：
 *   ① 偶发失败不惩罚（阈值 3）—— kw 的 master 档实测时好时坏，2 次就沉底会误伤
 *   ② 连续 3 次才沉底，且**只改变顺序**，档位仍留在链里（其它档全挂时还能试到它）
 *   ③ 成功一次立即清零、恢复原位
 *   ④ 超过 TTL 自动复活
 *   ⑤ 不同 source / 不同档互不影响
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const online = require(path.resolve(here, '../src/main/online.js'))
const F = online.__levelFuse

let passed = 0
function ok(name) { passed++; console.log('  PASS ' + name) }

function reset() { F.state.clear() }

// ① 一次、两次失败都不算坏
{
  reset()
  F.noteLevelFail('kw', 'master')
  assert.equal(F.levelIsBad('kw', 'master'), false, '失败 1 次不该沉底')
  F.noteLevelFail('kw', 'master')
  assert.equal(F.levelIsBad('kw', 'master'), false, '失败 2 次不该沉底（kw master 时好时坏，阈值 3）')
  ok('偶发失败（1~2 次）不沉底')
}

// ② 连续 3 次才沉底
{
  reset()
  F.noteLevelFail('kw', 'master')
  F.noteLevelFail('kw', 'master')
  F.noteLevelFail('kw', 'master')
  assert.equal(F.after, 3)
  assert.equal(F.levelIsBad('kw', 'master'), true)
  ok('连续 3 次失败 → 沉底')
}

// ③ 沉底只改顺序，不删档位
{
  reset()
  const before = F.chain('kw', 'master')
  assert.deepEqual(before, ['master', 'lossless', 'atmos_plus', 'atmos'], '母带优先、沉浸兜底的基础链')
  for (let i = 0; i < 3; i++) F.noteLevelFail('kw', 'master')
  const after = F.chain('kw', 'master')
  assert.deepEqual(after, ['lossless', 'atmos_plus', 'atmos', 'master'], '坏档沉到末尾但仍保留')
  assert.equal(after.length, before.length, '不能因为沉底丢掉档位')
  ok('沉底 = 排到链尾，档位不丢')
}

// ④ 成功一次立即清零并恢复原位
{
  reset()
  for (let i = 0; i < 3; i++) F.noteLevelFail('kw', 'master')
  F.clearLevelFail('kw', 'master')
  assert.equal(F.levelIsBad('kw', 'master'), false)
  assert.deepEqual(F.chain('kw', 'master'), ['master', 'lossless', 'atmos_plus', 'atmos'])
  ok('成功一次 → 清零并回到队首')
}

// ⑤ 超过 TTL 自愈
{
  reset()
  for (let i = 0; i < 3; i++) F.noteLevelFail('wy', 'jymaster')
  assert.equal(F.levelIsBad('wy', 'jymaster'), true)
  const rec = F.state.get('wy:jymaster')
  rec.at = Date.now() - F.ttl - 1000   // 假装已经过了 TTL
  assert.equal(F.levelIsBad('wy', 'jymaster'), false, 'TTL 过后应自动复活')
  assert.ok(!F.state.has('wy:jymaster'), '过期的记录要顺手清掉，不能一直涨')
  ok('超过 TTL 自动复活并清理记录')
}

// ⑥ 不同 source / 不同档互不影响
{
  reset()
  for (let i = 0; i < 3; i++) F.noteLevelFail('qq', 'sur')
  assert.equal(F.levelIsBad('qq', 'sur'), true)
  assert.equal(F.levelIsBad('kw', 'sur'), false)
  assert.equal(F.levelIsBad('qq', 'jymaster'), false)
  assert.deepEqual(F.chain('wy', 'master'), ['jymaster', 'hires', 'lossless', 'sky', 'jyeffect'], '其它线路不受牵连')
  assert.deepEqual(F.chain('qq', 'master'), ['jymaster', 'lossless', 'sur'], 'qq 的坏档在末尾')
  ok('熔断按 source:level 隔离')
}

// ⑦ 清单里没有的 source 返回空链（不会瞎试）；汽水是只解析源，有链且 lossless 打头
{
  reset()
  assert.deepEqual(F.chain('bili', 'master'), [])
  assert.deepEqual(F.chain('mg', 'master'), [])
  // v3.3.80：qs 只解析不搜索，但档位链必须有（lossless 优先，见 SOURCE_LEVEL_ORDER）
  assert.deepEqual(F.chain('qs', 'master'), ['lossless', 'hires', 'atmos'])
  ok('无适配器线路空链；汽水只有解析链且 lossless 打头')
}

console.log('\nqing-fuse: ' + passed + ' passed')
