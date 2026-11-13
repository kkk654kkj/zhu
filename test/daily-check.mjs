#!/usr/bin/env node
'use strict'
/**
 * 每日推荐渲染层单测（联网版 v3.3.38，仓库内）
 *
 * 不启动 Electron、不弹窗、不出声：用 vm 装载真实 daily.js，打桩 DOM / IPC /
 * player / Online，验证「全在线」口径、多歌手取数、冷启动、降级、并发作废、
 * 音质优先级与跨源队列。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(ROOT, 'src/renderer/js/daily.js'), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const mkTracks = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'L' + i,
  title: '本地歌曲' + i,
  artist: i % 3 === 0 ? '孙燕姿' : (i % 3 === 1 ? '周杰伦' : '陈奕迅'),
  album: '专辑' + i,
  duration: 200 + i,
  ext: i % 2 ? 'FLAC' : 'MP3',
  cover: null
}))
const tracks = mkTracks(60)
const byId = new Map(tracks.map((t) => [t.id, t]))

const els = new Map()
const el = (id) => {
  if (!els.has(id)) els.set(id, {
    id, textContent: '', innerHTML: '', hidden: false,
    addEventListener() {}, dataset: {}
  })
  return els.get(id)
}

let searchImpl = null
let probeImpl = null
const searchCalls = []      // 关键词
const searchPages = []      // 对应的页码（v3.3.43：换一批靠它翻页）
let playableCalls = 0
let downloadCalls = 0
let lastQueue = null
const state = {
  tracks, byId,
  favorites: new Set(['L1', 'L7']),
  playCounts: { L2: 12, L3: 8, L4: 5 },
  history: [{ id: 'L5', at: 1 }, { id: 'L6', at: 2 }],
  settings: { onlineSources: ['kw'], onlineQuality: 'master' },
  view: 'daily',
  visible: []
}
const windowApi = {
  onlineSearch: (opts) => {
    searchCalls.push(opts.keyword)
    searchPages.push(opts.page || 1)
    return searchImpl(opts)
  },
  onlineProbe: (song) => probeImpl(song),
  onlinePlayable: async () => { playableCalls++; return { ok: true, lossless: true, level: 'master', bitrate: 1700 } },
  onlineDownload: async () => { downloadCalls++; return { ok: true } }
}
const Online = {
  sources: [{ id: 'kw', short: '酷我', name: '酷我' }],
  enabled: new Set(['kw', 'qq']),
  proxyBase: 'http://127.0.0.1:12345',
  init: async () => {},
  toTrack: (s) => ({ id: 'on:' + s.source + ':' + s.id, online: s, source: s.source })
}
const player = {
  queues: [],
  setMode(mode) { this.mode = mode },
  setQueue(q, i, auto) { this.queues.push({ q, i, auto }); lastQueue = q }
}

const ctx = vm.createContext({
  state, window: { api: windowApi }, Online, player,
  document: { getElementById: el },
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  icon: (name) => '<svg><use href="#i-' + name + '"/></svg>',
  fmtDuration: (s) => (s > 0 ? '3:20' : '--:--'),
  toast: () => {},
  setTimeout, clearTimeout, console
})
vm.runInContext(src, ctx)
const Daily = vm.runInContext('Daily', ctx)

/**
 * 每个歌手返回一批「该歌手」的歌，source 在 kw/qq 间交替。
 * v3.3.43：按页码返回不同的歌（模拟真实「翻页拿到另一批」），
 * 否则换一批的页码轮换在测试里看不出效果。
 */
const songsOf = (artist, n, src = 'kw', page = 1) => Array.from({ length: n }, (_, i) => ({
  id: src + '-' + artist + '-p' + page + '-' + i,
  source: src,
  title: artist + '在线新歌' + ((page - 1) * 100 + i),
  artist, duration: 240, quality: '128k'
}))
const byArtist = (artist, n = 15, page = 1) => ({
  list: songsOf(artist, n, artist === '周杰伦' ? 'qq' : 'kw', page)
})
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

async function run() {
  searchImpl = async (opts) => byArtist(opts.keyword, 15, opts.page || 1)
  probeImpl = async () => ({ ok: false })
  await Daily.recompute()
  await tick()

  console.log('=== 1) 全在线：30 首、零本地行、与本地曲库去重 ===')
  ok('总数 30 首', Daily.list.length === 30, '实际 ' + Daily.list.length)
  ok('一行本地曲库都没有', Daily.localTracks().length === 0,
    '本地 ' + Daily.localTracks().length)
  ok('全部是在线行', Daily.list.every((x) => x.kind === 'online'))
  const coldSeeds = vm.runInContext('DAILY_COLD_SEEDS', ctx)
  const allowedSeeds = new Set(Daily.topArtists(12).concat(coldSeeds))
  ok('多歌手轮搜（口味池 / 冷启动池里逐个当关键词）',
    searchCalls.length >= 2 && searchCalls.every((k) => allowedSeeds.has(k)),
    searchCalls.join(','))
  ok('同一歌手不会占满整页（轮转取歌）',
    new Set(Daily.list.map((x) => x.song.artist)).size >= 2,
    Daily.list.map((x) => x.song.artist).join(','))

  // 与本地曲库同名同歌手的在线结果必须被剔除
  searchImpl = async () => ({
    list: [{ id: 'dup', source: 'kw', title: '本地歌曲1', artist: '周杰伦', duration: 200, quality: '320k' }]
      .concat(songsOf('周杰伦', 30, 'qq'))
  })
  await Daily.recompute()
  await tick()
  ok('在线结果与本地曲库去重',
    !Daily.list.some((x) => x.song.title === '本地歌曲1'))

  console.log('\n=== 2) 音质探测：母带/无损优先，整批探完只重排一次 ===')
  searchImpl = async (opts) => byArtist(opts.keyword, 15, opts.page || 1)
  // 每个歌手「第 1 首」判为母带（标题以 在线新歌0 结尾），其余 128k。
  // 不写死 id：换批会翻页，选中的歌每次不同，写死 id 会变成偶发红。
  probeImpl = async (song) => (/在线新歌0$/.test(song.title)
    ? { ok: true, lossless: true, level: 'master', bitrate: 1700, ext: 'flac', size: 40 * 1048576 }
    : { ok: true, lossless: false, level: '', bitrate: 128, ext: 'mp3' })
  await Daily.recompute()
  await tick(120)
  const ranks = Daily.list.map((x) => x.qr || 0)
  ok('探测结果回写到行（有档位）',
    Daily.list.every((x) => x.q && x.q.text && x.q.text !== '—'), JSON.stringify(Daily.list[0].q))
  ok('按音质档位降序重排', ranks.every((v, i) => i === 0 || ranks[i - 1] >= v), ranks.join(','))
  ok('母带行排在最前（且至少有一首）',
    ranks[0] === 3 && ranks.filter((v) => v === 3).length >= 1, ranks.join(','))

  console.log('\n=== 3) 冷启动：本地曲库为空也能出 30 首在线 ===')
  const savedTracks = state.tracks
  const savedFavs = state.favorites
  const savedCounts = state.playCounts
  const savedHist = state.history
  state.tracks = []
  state.favorites = new Set()
  state.playCounts = {}
  state.history = []
  searchCalls.length = 0
  await Daily.recompute()
  await tick()
  ok('曲库空时用内置歌手池当种子，仍出 30 首',
    Daily.list.length === 30 && new Set(searchCalls).size === 6,
    '列表 ' + Daily.list.length + ' / 歌手 ' + new Set(searchCalls).size + ' / 搜索 ' + searchCalls.length)
  ok('冷启动文案不写成「因为你常听」', !/因为你常听/.test(el('dailySub').textContent))
  state.tracks = savedTracks
  state.favorites = savedFavs
  state.playCounts = savedCounts
  state.history = savedHist

  console.log('\n=== 4) 一首都没拿到 → 本地兜底 30 首且写明原因 ===')
  searchImpl = async () => { throw new Error('网关超时') }
  await Daily.recompute()
  await tick()
  ok('全部降级为本地，数字仍是 30',
    Daily.localTracks().length === 30 && Daily.list.every((x) => x.kind === 'local'))
  ok('状态栏写明在线失败', /没成功/.test(el('dailyStatus').textContent))
  searchImpl = async () => ({ list: [] })
  await Daily.recompute()
  await tick()
  ok('在线无结果时同样兜底 30 首本地', Daily.localTracks().length === 30)

  console.log('\n=== 5) 并发重算：旧请求收尾不能覆盖新一批 ===')
  searchImpl = () => new Promise((resolve) => setTimeout(() => resolve(byArtist('周杰伦')), 40))
  const p1 = Daily.recompute()
  await tick(5)
  searchImpl = async (opts) => byArtist('孙燕姿', 15, opts.page || 1)
  await Daily.recompute()
  await p1
  await tick()
  ok('最新一批生效，旧请求作废',
    !Daily.list.some((x) => x.song.title.startsWith('周杰伦')),
    Daily.list.map((x) => x.song.title).slice(0, 3).join(','))

  console.log('\n=== 6) 队列：播放全部 = 全 30 首在线（跨源），点播只解析当前这首 ===')
  searchImpl = async (opts) => byArtist(opts.keyword, 15, opts.page || 1)
  probeImpl = async () => ({ ok: false })
  await Daily.recompute()
  await tick()
  player.queues.length = 0
  await Daily.playAll()
  ok('播放全部把 30 首在线曲目全入队',
    player.queues.length === 1 && player.queues[0].q.length === 30 &&
    player.queues[0].q.every((t) => String(t.id).startsWith('on:')),
    '队列 ' + (player.queues[0] ? player.queues[0].q.length : 0))
  ok('队列里跨源共存（kw + qq）',
    new Set(player.queues[0].q.map((t) => t.source)).size === 2,
    Array.from(new Set(player.queues[0].q.map((t) => t.source))).join(','))
  player.queues.length = 0
  const before = playableCalls
  await Daily.playAt(0)
  ok('点在线行只解析当前这一首，队列仍是整页 30 首',
    playableCalls === before + 1 && lastQueue.length === 30,
    '解析 ' + (playableCalls - before) + ' / 队列 ' + lastQueue.length)
  await Daily.downloadAt(0)
  ok('在线行下载按钮接到 IPC', downloadCalls === 1)

  console.log('\n=== 7) 行 HTML 转义 ===')
  const saved = Daily.list[0]
  Daily.list[0] = { kind: 'online', song: { ...saved.song, title: '<script>x</script>' }, reason: '你常听', w: 1, q: null, qr: 0 }
  Daily.render()
  const html = el('dailyBody').innerHTML
  Daily.list[0] = saved
  ok('标题里的标签被转义', /&lt;script&gt;/.test(html) && !/<script>x/.test(html))

  console.log('\n=== 8) 换一批：两批不能一模一样（v3.3.43）===')
  probeImpl = async () => ({ ok: false })
  searchImpl = async (opts) => byArtist(opts.keyword, 30, opts.page || 1)
  // 真实用户口味通常 >= 6 位歌手；少于 6 位时 seedArtists 会用冷启动池随机补，
  // 那份随机性会掩盖「种子不轮换」的问题 —— 所以这里先造 8 位口味歌手。
  const savedT8 = state.tracks
  const savedF8 = state.favorites
  const savedC8 = state.playCounts
  const savedH8 = state.history
  state.tracks = ['周杰伦', '林俊杰', '陈奕迅', '孙燕姿', '邓紫棋', '李荣浩', '薛之谦', '王菲']
    .map((a, i) => ({ id: 'T' + i, title: '口味歌' + i, artist: a, album: '', duration: 200, ext: 'mp3', cover: null }))
  state.favorites = new Set()
  state.playCounts = state.tracks.reduce((m, t, i) => { m[t.id] = 9 - i; return m }, {})
  state.history = []
  Daily.lastKeys = new Set()      // 从干净状态起算，只看这两批
  await Daily.recompute()
  await tick()
  const sigA = Daily.list.map((x) => Daily.key(x.song.title, x.song.artist))
  const seedsA = (Daily._lastSeeds || []).slice()
  const pagesA = (Daily._lastPages || []).slice()
  await Daily.recompute()
  await tick()
  const sigB = Daily.list.map((x) => Daily.key(x.song.title, x.song.artist))
  const seedsB = (Daily._lastSeeds || []).slice()
  const pagesB = (Daily._lastPages || []).slice()
  const ov = sigA.filter((k) => sigB.indexOf(k) >= 0).length

  ok('两批都是 30 首', sigA.length === 30 && sigB.length === 30, sigA.length + ' / ' + sigB.length)
  ok('换一批后内容有变化（不是原样重画）', sigA.join('|') !== sigB.join('|'))
  ok('两批重合 < 70%（不是只换个顺序）', ov / Math.max(1, sigA.length) < 0.7,
    '重合 ' + ov + '/' + sigA.length)
  ok('种子歌手或页码至少一项轮换了',
    JSON.stringify(seedsA) !== JSON.stringify(seedsB) || JSON.stringify(pagesA) !== JSON.stringify(pagesB),
    JSON.stringify(seedsA) + JSON.stringify(pagesA))
  ok('每批都真的翻页了（页码里既有 1 也有 2）',
    pagesA.includes(1) && pagesA.includes(2) && pagesB.includes(1) && pagesB.includes(2),
    JSON.stringify(pagesA) + ' / ' + JSON.stringify(pagesB))
  ok('口味歌手 >= 6 位时种子集合真的换了位置（不是固定 top6）',
    seedsA.length === 6 && seedsB.length === 6 && seedsA.join(',') !== seedsB.join(','),
    seedsA.join(',') + ' → ' + seedsB.join(','))

  console.log('\n=== 9) 源不支持翻页时，靠「排除上一批」也要换掉 ===')
  // 有些音源 page 参数其实无效（始终返回同一批），这时只能靠 prev 排除：
  // 每歌手 30 首、6 歌手 → 第一批取每桶前 5 首，第二批应取第 6~10 首，重合 0。
  searchImpl = async (opts) => byArtist(opts.keyword, 30, 1)
  Daily.lastKeys = new Set()
  await Daily.recompute()
  await tick()
  const pA = Daily.list.map((x) => Daily.key(x.song.title, x.song.artist))
  await Daily.recompute()
  await tick()
  const pB = Daily.list.map((x) => Daily.key(x.song.title, x.song.artist))
  const ov2 = pA.filter((k) => pB.indexOf(k) >= 0).length
  ok('翻页无效（两批候选完全相同）时，第二批仍然换掉了',
    pB.length === 30 && ov2 === 0, '重合 ' + ov2 + '/' + pA.length)

  state.tracks = savedT8
  state.favorites = savedF8
  state.playCounts = savedC8
  state.history = savedH8

  console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
  process.exit(fail ? 1 : 0)
}

run().catch((e) => { console.error(e); process.exit(1) })
