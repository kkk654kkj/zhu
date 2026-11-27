/**
 * 青听音源清单（music.json）解析 + 档位规划回归测试。
 *
 * 跑法：node test/qing-manifest.mjs
 * 不依赖 Electron / 网络：全部用上游真实文本的片段做输入。
 *
 * 钉住的语义（对着旧代码应当全红）：
 *   ① 上游那份「块注释 + JSON」能解析（直接 JSON.parse 会挂）
 *   ② qs / bili / mg 没有适配器，不得出现在生效线路里
 *   ③ enabled:false 的线下线
 *   ④ 母带优先、沉浸声兜底，有损档永不进无损链
 *   ⑤ 清单全废时必须退回内置兜底，不能变成「零音源」
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const QM = require(path.resolve(here, '../src/main/qing-manifest.js'))

let passed = 0
function ok(name) { passed++; console.log('  PASS ' + name) }

/* 上游真实文本的结构：两段块注释（其中一段是 /*! 开头，说明版本），再是 JSON 正文 */
const REAL = `/**
 * @name 青听音源
 * @description 关注微信公众号: 元力菌
 * @version 1.1
 * @author 微信公众号: 元力菌
 */
/*!
 * 二次版权说明
 */
{
  "lines": [
    { "id": "kw", "name": "小窝源", "enabled": true,
      "levels": ["standard", "exhigh", "lossless", "atmos", "atmos_plus", "master"] },
    { "id": "kg", "name": "小狗源", "enabled": true,
      "levels": ["standard", "exhigh", "lossless", "hires", "atmos", "clear"] },
    { "id": "wy", "name": "小云源", "enabled": true,
      "levels": ["standard", "exhigh", "lossless", "hires", "sky", "jyeffect", "jymaster"] },
    { "id": "tx", "name": "小Q源", "enabled": true,
      "levels": ["standard", "exhigh", "lossless", "sur", "jymaster"] },
    { "id": "qs", "name": "汽水源", "enabled": true,
      "levels": ["standard", "exhigh", "lossless", "hires", "atmos"] },
    { "id": "bili", "name": "哔哩哔哩", "enabled": true, "levels": ["bili192"] },
    { "id": "mg", "name": "小粉源", "enabled": true, "levels": ["standard"] }
  ]
}`

// ① 剥注释
{
  const body = QM.stripHeader(REAL)
  assert.ok(body.startsWith('{'), '注释没剥干净')
  assert.ok(!body.includes('元力菌'), '注释内容仍有残留')
  ok('stripHeader 剥掉两段块注释')
}

// ② 解析出 7 条线 + 版本号
{
  const m = QM.parseManifest(REAL)
  assert.equal(m.version, '1.1')
  assert.equal(m.lines.length, 7)
  assert.equal(m.lines.find((l) => l.id === 'qs').name, '汽水源')
  ok('parseManifest 真实文本 → 7 条线 / version 1.1')
}

// ③ 没有适配器的 qs/bili/mg 必须被丢掉；tx 映射成内部 qq
{
  const plan = QM.planManifest(QM.parseManifest(REAL))
  assert.deepEqual(plan.order, ['kw', 'qq', 'kg', 'wy'])
  assert.equal(plan.lines.length, 4)
  assert.ok(!plan.order.includes('qs'), 'qs 没有适配器，不该生效')
  assert.ok(!plan.order.includes('bili'), 'bili 没有适配器，不该生效')
  assert.ok(!plan.order.includes('mg'), 'mg 没有适配器，不该生效')
  assert.equal(plan.lines.find((l) => l.source === 'qq').id, 'tx')
  ok('planManifest 丢掉无适配器的 qs/bili/mg，tx → qq')
}

// ④ enabled:false 下线
{
  const m = QM.parseManifest(REAL.replace('"id": "kg", "name": "小狗源", "enabled": true', '"id": "kg", "name": "小狗源", "enabled": false'))
  const plan = QM.planManifest(m)
  assert.deepEqual(plan.order, ['kw', 'qq', 'wy'])
  ok('enabled:false 的线不进生效集合')
}

// ⑤ 母带优先、沉浸声兜底（prefer='master'）
{
  const plan = QM.planManifest(QM.parseManifest(REAL))
  const chain = (s, p) => QM.buildLevelChain(plan.levelsBySource[s], p)
  assert.deepEqual(chain('wy', 'master'), ['jymaster', 'hires', 'lossless', 'sky', 'jyeffect'])
  assert.deepEqual(chain('kg', 'master'), ['clear', 'hires', 'lossless', 'atmos'])
  assert.deepEqual(chain('kw', 'master'), ['master', 'lossless', 'atmos_plus', 'atmos'])
  assert.deepEqual(chain('qq', 'master'), ['jymaster', 'lossless', 'sur'])
  ok('prefer=master：母带 → hires → lossless → 沉浸兜底')
}

// ⑥ 沉浸梯队内部把明显更小的 atmos 压到最后
{
  const chain = QM.buildLevelChain(['standard', 'atmos', 'lossless', 'atmos_plus', 'exhigh'], 'master')
  assert.deepEqual(chain, ['lossless', 'atmos_plus', 'atmos'])
  ok('沉浸档内 atmos_plus 先于 atmos')
}

// ⑦ prefer='lossless'：无损打头，但更好的档仍然要试
{
  const plan = QM.planManifest(QM.parseManifest(REAL))
  assert.deepEqual(QM.buildLevelChain(plan.levelsBySource.wy, 'lossless'), ['lossless', 'hires', 'jymaster', 'sky', 'jyeffect'])
  ok('prefer=lossless：lossless → hires → master → 沉浸')
}

// ⑧ 有损档永不进链路
{
  const chain = QM.buildLevelChain(['standard', 'exhigh', 'lossless'], 'master')
  assert.deepEqual(chain, ['lossless'])
  assert.ok(!chain.includes('exhigh') && !chain.includes('standard'))
  ok('exhigh/standard 不进无损链')
}

// ⑨ 其它 prefer 不走青听
{
  assert.deepEqual(QM.buildLevelChain(['lossless', 'hires'], 'best'), [])
  assert.deepEqual(QM.buildLevelChain(['lossless', 'hires'], '128k'), [])
  ok('prefer=best/128k 不启用青听链路')
}

// ⑩ 清单结构不对必须抛错（不能返回半个清单）
{
  assert.throws(() => QM.parseManifest('{ "lines": [] }'), /emptyLines/)
  assert.throws(() => QM.parseManifest('not json'), /JSON|Unexpected/i)
  assert.throws(() => QM.parseManifest(''), /empty/)
  ok('坏清单抛错')
}

// ⑪ 上游全关 → 退回内置兜底，不能零音源
{
  const allOff = QM.parseManifest(REAL.replace(/"enabled": true/g, '"enabled": false'))
  const plan = QM.planManifest(allOff)
  assert.deepEqual(plan.order, ['kw', 'qq', 'kg', 'wy'])
  assert.equal(plan.fromFallback, false, '这是「上游全关」分支，不是「没清单」分支')
  ok('上游全关时退回内置兜底')
}

// ⑫ 完全没清单 → 兜底 4 条线
{
  const plan = QM.planManifest(null)
  assert.deepEqual(plan.order, ['kw', 'qq', 'kg', 'wy'])
  assert.equal(plan.fromFallback, true)
  assert.deepEqual(QM.buildLevelChain(plan.levelsBySource.wy, 'master'), ['jymaster', 'hires', 'lossless', 'sky', 'jyeffect'])
  ok('无清单 → 内置兜底 4 条线')
}

// ⑬ 清单地址主/备/官方三份都在
{
  assert.equal(QM.MANIFEST_URLS.length, 3)
  assert.ok(QM.MANIFEST_URLS[0].includes('kstore.space'))
  assert.ok(QM.MANIFEST_URLS[1].includes('haitangw.net'))
  ok('主/备/官方三份地址齐备')
}

// ⑭ 汽水（v3.3.80）：只解析、不进搜索列表
{
  const plan = QM.planManifest(QM.parseManifest(REAL))
  assert.ok(!plan.order.includes('qs'), 'qs 不能进搜索源列表（网关没有汽水搜索）')
  assert.equal(plan.resolveOnly.length, 1)
  assert.equal(plan.resolveOnly[0].source, 'qs')
  assert.ok(Array.isArray(plan.levelsBySource.qs) && plan.levelsBySource.qs.length, 'qs 必须有档位链，否则粘贴链接只能拿 128k')
  ok('qs 进 resolveOnly、不进 order，且带档位')
}

// ⑮ 汽水档位语义与通用分类相反：lossless 必须排在 hires 前面
{
  const plan = QM.planManifest(QM.parseManifest(REAL))
  // 实测同曲 238 秒：lossless 45.6MB(≈1530kbps) > hires 9.2MB(≈310kbps)
  assert.deepEqual(QM.buildLevelChain(plan.levelsBySource.qs, 'master', 'qs'), ['lossless', 'hires', 'atmos'])
  assert.deepEqual(QM.buildLevelChain(plan.levelsBySource.qs, 'lossless', 'qs'), ['lossless', 'hires', 'atmos'])
  // 有损档（standard/exhigh）仍不得进链
  assert.ok(!QM.buildLevelChain(plan.levelsBySource.qs, 'master', 'qs').includes('standard'))
  ok('汽水链 lossless 打头，hires/atmos 兜底，有损档不进链')
}

// ⑯ 通用源不受汽水覆盖影响
{
  const plan = QM.planManifest(QM.parseManifest(REAL))
  assert.deepEqual(QM.buildLevelChain(plan.levelsBySource.wy, 'master', 'wy'), ['jymaster', 'hires', 'lossless', 'sky', 'jyeffect'])
  assert.deepEqual(QM.buildLevelChain(plan.levelsBySource.kw, 'master', 'kw'), ['master', 'lossless', 'atmos_plus', 'atmos'])
  ok('四家老源的档位顺序未被汽水覆盖串改')
}

console.log('\nqing-manifest: ' + passed + ' passed')
