'use strict'
/**
 * 在线曲目收藏 / 加入歌单 · 运行时单测（v3.3.64）
 *
 * 这轮功能的风险点不在界面，而在两处纯逻辑：
 *   ① 元数据落盘的校验 —— 脏 id / 类型漂移会让「我的收藏」里留一个点不开的空行；
 *   ② 按引用清理 —— 少清是越攒越多，多清是收藏里那条当场消失。
 * 两处都必须真跑一遍，静态断言只能证明代码长成那个样子。
 *
 * 另外把「id 口径」钉死：`Online.metaOf(song).id` 必须等于 `Online.toTrack(song).id`，
 * 不然收藏写进去的 id 和列表渲染读的 id 对不上，表现就是收藏了但列表里没有。
 *
 * 用法：node test/online-fav.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
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

/* ---------------- ① 主进程纯逻辑 ---------------- */

const OMETA = require2(path.join(ROOT, 'src/main/online-meta.js'))

const good = { source: 'kw', songId: '778899', id: 'on:kw:778899', title: '晴天', artist: '周杰伦', duration: 269 }
const m1 = OMETA.sanitizeMeta(good, 1000)
ok('合法条目规范化后字段齐全', m1 && m1.id === 'on:kw:778899' && m1.songId === '778899' && m1.duration === 269)
ok('at 缺省时用传入时间戳（便于测试与可重复）', m1 && m1.at === 1000)

ok('id 与 source/songId 不一致 → 丢弃（否则永久占位、prune 永远对不上）',
  OMETA.sanitizeMeta({ ...good, id: 'on:qq:778899' }) === null)
ok('缺 songId → 丢弃', OMETA.sanitizeMeta({ source: 'kw', id: 'on:kw:' }) === null)
ok('缺 source → 丢弃', OMETA.sanitizeMeta({ songId: '1', id: 'on::1' }) === null)
ok('非对象 → 丢弃', OMETA.sanitizeMeta('kw:1') === null && OMETA.sanitizeMeta(null) === null)
ok('duration 非法（NaN / 负数）落成 0 而不是 NaN',
  OMETA.sanitizeMeta({ ...good, duration: 'abc' }).duration === 0)
ok('数字型 songId 被统一成字符串（渲染层口径一致）',
  OMETA.sanitizeMeta({ source: 'kg', songId: 42, id: 'on:kg:42' }).songId === '42')

const batch = OMETA.sanitizeMetas([good, { bad: true }, { ...good, id: 'on:qq:1' }, { ...good, songId: '999999', id: 'on:kw:999999' }], 5)
ok('批量里坏条目静默丢弃、好条目照收', batch.length === 2 && batch[1].songId === '999999')

const map = {
  'on:kw:1': { id: 'on:kw:1' },      // 被收藏引用 → 留
  'on:kw:2': { id: 'on:kw:2' },      // 被歌单引用 → 留
  'on:kw:3': { id: 'on:kw:3' },      // 无人引用 → 清
  'on:kw:4': { id: 'on:kw:4' }       // 已在歌单又被取消收藏 → 仍留（歌单还引用着）
}
const pr = OMETA.pruneToRefs(map, ['on:kw:1'], [{ trackIds: ['on:kw:2', 'on:kw:4'] }])
ok('清理只留被引用条目', Object.keys(pr.out).sort().join(',') === 'on:kw:1,on:kw:2,on:kw:4' && pr.dropped === 1)
ok('收藏被取消但仍在歌单里 → 不清（否则歌单里那条当场消失）', !!pr.out['on:kw:4'])
ok('空表 / 脏入参不炸', OMETA.pruneToRefs(null).dropped === 0 && OMETA.pruneToRefs({}, null, null).dropped === 0)
ok('歌单里出现非字符串 id 不会污染 keep', OMETA.pruneToRefs({ 'on:kw:5': {} }, [], [{ trackIds: [null, 5] }]).dropped === 1)

// v3.3.66：同一首的后到元数据不能把已存档位洗掉
// （收藏页规格列从「高解析」退化成「在线」的根因：整条覆盖 + spec:null）
const withSpec = OMETA.sanitizeMeta({ ...good, spec: { text: '高解析', cls: 'lossless', tip: 'FLAC' } }, 10)
const noSpec = OMETA.sanitizeMeta(good, 11)
ok('后到条目没带档位 → 保留旧档位',
  OMETA.mergeMeta(withSpec, noSpec).spec && OMETA.mergeMeta(withSpec, noSpec).spec.text === '高解析')
ok('后到条目带档位 → 以新值为准',
  OMETA.mergeMeta(withSpec, OMETA.sanitizeMeta({ ...good, spec: { text: '128k', cls: 'dim', tip: '' } }, 12)).spec.text === '128k')
ok('没有旧条目时直接用新条目', OMETA.mergeMeta(null, noSpec).id === 'on:kw:778899')
ok('mergeMeta 不吃脏入参', OMETA.mergeMeta(null, null) === null && OMETA.mergeMeta(null, undefined) === null)

/* ---------------- ② 渲染层 Online ---------------- */

const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/online.js'), 'utf8')
const sandbox = {
  console,
  // online.js 顶层只定义函数与对象，不执行 —— 这些桩只是给实例方法用
  state: { settings: {}, favorites: new Set(), onlineMeta: new Map() },
  document: { querySelectorAll: () => [], getElementById: () => null },
  // v3.3.66：rememberTrack 会把返回的整表同步回 state.onlineMeta
  window: { api: { onlineTracksRemember: async (metas) => ({ [metas[0].id]: metas[0] }) } },
  player: null,
  toast: () => {},
  esc: (v) => String(v == null ? '' : v),
  icon: () => '',
  fmtDuration: () => '0:00',
  UI: { showContextMenu: () => {} },
  handleCtxAction: async () => {},
  // streamUrlFor 用它们拼代理地址
  URLSearchParams,
  URL
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
// `const Online = {...}` 是词法声明，不会挂到 global 上 —— 这里显式导出一个句柄
vm.runInContext(src + '\n;globalThis.__Online = Online\n', sandbox, { filename: 'online.js' })
const Online = sandbox.__Online
ok('online.js 能在无 DOM 环境装载出 Online', !!Online && typeof Online.metaOf === 'function')

Online.proxyBase = 'http://127.0.0.1:51000'
const song = { source: 'kw', id: '778899', title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, cover: 'http://x/c.jpg', quality: '320k' }
const meta = Online.metaOf(song)
const track = Online.toTrack(song, null)
ok('id 口径一致：metaOf().id === toTrack().id', meta.id === track.id && meta.id === 'on:kw:778899')
ok('元数据里不带直链（签名会过期，存下来下次必失败）',
  !('audio' in meta) && !JSON.stringify(meta).includes('/stream?'))
ok('metaOf 带上重播必需字段', meta.source === 'kw' && meta.songId === '778899' && meta.duration === 269 && meta.title === '晴天')

const rt = Online.trackFromMeta(meta)
ok('meta → 可播曲目：id 与代理地址都对', rt && rt.id === meta.id &&
  rt.audio.startsWith('http://127.0.0.1:51000/stream?src=kw&id=778899'))
ok('meta → 曲目时挂上 onlineMeta（换源兜底要用）', rt && rt.onlineMeta === meta)
ok('脏元数据不造出空曲目', Online.trackFromMeta({ source: 'kw' }) === null && Online.trackFromMeta(null) === null)

// v3.3.65：探测档位随元数据落盘并还原（规格列读它，没探到走「在线」占位）
const probe = { text: '母带', cls: 'lossless', tip: '高解析 FLAC · 3200k', rank: 3 }
const metaSpec = Online.metaOf(song, probe)
ok('v3.3.65：metaOf 落盘探测档位', metaSpec.spec && metaSpec.spec.text === '母带' && metaSpec.spec.cls === 'lossless')
ok('v3.3.65：档位还原到 track，老条目为空串（渲染层给「在线」占位）',
  Online.trackFromMeta(metaSpec).specText === '母带' && Online.trackFromMeta(meta).specText === '')

// v3.3.66：底栏 ♥ / 迷你卡 / 播放历史只传 id —— 写收藏前必须先把元数据补齐，
// 否则收藏里留下一个 resolveTrack 解析不出来的 on: 空行（计数 +1、列表没有）
const idOnly = { id: 'on:kw:778899', title: '晴天', artist: '周杰伦', duration: 269 }
ok('只有 id 的在线曲：rememberTrack 能反推 source/songId 并落盘',
  await Online.rememberTrack(idOnly) === true)
ok('rememberTrack 之后 state.onlineMeta 里查得到', sandbox.state.onlineMeta.has('on:kw:778899'))
ok('本地曲不需要元数据，直接放行', await Online.rememberTrack({ id: 'local-1' }) === true)
ok('on: 前缀但拆不出 source/songId → 拒绝（不写出一条永久空行）',
  await Online.rememberTrack({ id: 'on:broken' }) === false)

// matchScore：换源时「宁可不播也不放错歌」
const base = { title: '晴天', artist: '周杰伦', duration: 269 }
ok('同名同歌手同时长 → 高分', Online.matchScore({ ...base }, meta) >= 80)
ok('标题全等但时长差 60 秒 → 不够分（可能是另一个版本）',
  Online.matchScore({ title: '晴天', artist: '周杰伦', duration: 209 }, meta) < 60)
ok('只有时长撞上、标题不同 → 0 分（时长不能单独当证据）',
  Online.matchScore({ title: '稻香', artist: '陈奕迅', duration: 269 }, meta) === 0)
ok('完全不同的歌 → 0 分',
  Online.matchScore({ title: '稻香', artist: '陈奕迅', duration: 269 }, meta) === 0)
ok('标题带后缀（Live / 伴奏）先降权，再由歌手与时长补回来',
  Online.matchScore({ title: '晴天 (Live)', artist: '周杰伦', duration: 270 }, meta) >= 60)
ok('空标题不给分', Online.matchScore({ title: '', artist: '周杰伦' }, meta) === 0)

console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
process.exit(fail ? 1 : 0)
