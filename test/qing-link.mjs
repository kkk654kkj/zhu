/**
 * 汽水分享链接识别 + 分享页元数据解析（v3.3.80）。
 *
 * 跑法：node test/qing-link.mjs
 * 不依赖 Electron / 网络：只测纯函数部分（识别与 JSON 抠取）。
 *
 * 钉住的语义（对着旧代码应当全红 —— 旧版根本没有汽水链路）：
 *   ① 19 位 track_id、分享短链、带 track_id 的落地页都能认出来
 *   ② 普通中文关键词、太短/太长的数字、别的站点链接一律不认（不能把搜索关键词当链接）
 *   ③ 分享页里的 _ROUTER_DATA 必须按花括号配对取，不能截到第一个 `}`
 *   ④ 没有该标记时返回 null，由调用方退回普通搜索
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const online = require(path.resolve(here, '../src/main/online.js'))
const pick = online.__linkTest.pickRouterData

let passed = 0
function ok(name) { passed++; console.log('  PASS ' + name) }

// ① 能认出来的形态
{
  assert.equal(online.looksLikeQishuiLink('7512772704484722704'), true, '19 位 track_id')
  assert.equal(online.looksLikeQishuiLink('https://qishui.douyin.com/s/iX21ep91/'), true, '分享短链')
  assert.equal(online.looksLikeQishuiLink('https://music.douyin.com/qishui/share/track?track_id=7512772704484722704'), true, '落地页')
  ok('认得出 track_id / 短链 / 落地页')
}

// ② 不能误判
{
  assert.equal(online.looksLikeQishuiLink('晴天'), false, '中文关键词')
  assert.equal(online.looksLikeQishuiLink('周杰伦 稻香'), false)
  assert.equal(online.looksLikeQishuiLink('12345'), false, '位数不够')
  assert.equal(online.looksLikeQishuiLink('123456789012345678901'), false, '位数超了')
  assert.equal(online.looksLikeQishuiLink('https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV'), false, '别的站')
  assert.equal(online.looksLikeQishuiLink(''), false)
  ok('普通关键词 / 别站链接 / 位数不对的数字都不认')
}

// ③ 花括号配对：JSON 内部有大量 `}`，截第一个就会断
{
  const html = '<script>window._ROUTER_DATA = {"loaderData":{"track_page":{"audioWithLyricsOption":'
    + '{"trackName":"山水一程","artistName":"唐伯虎Annie","duration":238.438,"offsetDuration":60.001,"nested":{"a":1}}}}}</script>'
  const j = pick(html)
  assert.ok(j, '应该解析出对象')
  const a = j.loaderData.track_page.audioWithLyricsOption
  assert.equal(a.trackName, '山水一程')
  assert.equal(a.artistName, '唐伯虎Annie')
  assert.equal(a.duration, 238.438)
  assert.equal(a.offsetDuration, 60.001)
  ok('_ROUTER_DATA 按括号配对取，嵌套对象完整')
}

// ④ 字符串里的花括号/引号不能骗过扫描器
{
  const html = '<script>_ROUTER_DATA = {"x":"a}b\\"c{d","y":{"z":1}}</script>'
  const j = pick(html)
  assert.equal(j.x, 'a}b"c{d', '字符串内的花括号与转义引号不能被当成结构')
  assert.equal(j.y.z, 1)
  ok('字符串里的 } 与转义引号不干扰配对')
}

// ⑤ 没有标记 → null（调用方据此退回普通搜索）
{
  assert.equal(pick('<html>no data here</html>'), null)
  assert.equal(pick(''), null)
  assert.equal(pick(null), null)
  ok('无 _ROUTER_DATA 返回 null')
}

// ⑥ 非链接输入直接短路，不发请求
{
  const r = await online.resolveQishuiLink('晴天')
  assert.equal(r, null)
  assert.equal(await online.resolveQishuiLink(''), null)
  ok('非汽水输入不进解析（不联网）')
}

console.log('\nqing-link: ' + passed + ' passed')
