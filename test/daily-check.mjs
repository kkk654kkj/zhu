#!/usr/bin/env node
'use strict'
/**
 * 每日推荐渲染层单测（联网版 v3.3.37，仓库内）
 *
 * 不启动 Electron、不弹窗、不出声：用 vm 装载真实 daily.js，打桩 DOM / IPC /
 * player / Online，验证推荐口径、去重、降级、并发作废与队列隔离。
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
let playableCalls = 0
let downloadCalls = 0
let lastQueue = null
const state = {
  tracks, byId,
  favorites: new Set(['L1', 'L7']),
  playCounts: { L2: 12, L3: 8, L4: 5 },
  history: [{ id: 'L5', at: 1 }, { id: 'L6', at: 2 }],
  settings: { onlineSources: ['kw'] },
  view: 'daily',
  visible: []
}
const windowApi = {
  onlineSearch: (opts) => searchImpl(opts),
  onlinePlayable: async () => { playableCalls++; return { ok: true, lossless: false } },
  onlineDownload: async () => { downloadCalls++; return { ok: true } }
}
const Online = {
  sources: [{ id: 'kw', short: '酷我', name: '酷我' }],
  enabled: new Set(['kw']),
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

const onlineSongs = (n, prefix = '在线') => Array.from({ length: n }, (_, i) => ({
  id: 'O' + prefix + i, source: 'kw', title: prefix + '新歌' + i,
  artist: '孙燕姿', duration: 240, quality: '320k'
}))

async function run() {
  console.log('=== 1) 混合推荐：本地 24 + 在线 6，本地去重 ===')
  // 前 2 首与本地曲库同名同歌手，应被过滤掉
  const dup = [{
    id: 'OD', source: 'kw', title: '本地歌曲1', artist: '周杰伦', duration: 200, quality: '320k'
  }]
  searchImpl = async () => ({ list: dup.concat(onlineSongs(12)) })
  await Daily.recompute()
  ok('总数 30 首', Daily.list.length === 30, '实际 ' + Daily.list.length)
  ok('本地 24 首 / 在线 6 首',
    Daily.localTracks().length === 24 && Daily.onlineCount === 6,
    `本地 ${Daily.localTracks().length} / 在线 ${Daily.onlineCount}`)
  ok('在线结果与本地曲库去重',
    !Daily.list.some((x) => x.kind === 'online' && x.song.title === '本地歌曲1'))
  ok('在线搜索关键词来自高频歌手',
    Daily.topArtists().length > 0 && /因为你常听/.test(el('dailySub').textContent))
  ok('本地行带推荐理由',
    ['你的收藏', '常听', '最近播放', '值得一听'].includes(Daily.list[0].reason))
  // 直接把恶意标题塞进当前列表首位，避免「随机加权没抽到这首」造成偶发假绿
  const htmlWithInjection = (() => {
    const save = Daily.list[0]
    Daily.list[0] = { kind: 'local', track: { ...tracks[0], title: '<script>x</script>' }, reason: '值得一听' }
    Daily.render()
    const html = el('dailyBody').innerHTML
    Daily.list[0] = save
    return html
  })()
  ok('行 HTML 会转义标题（不注入标签）',
    /&lt;script&gt;/.test(htmlWithInjection) && !/<script>x/.test(htmlWithInjection))

  console.log('\n=== 2) 在线失败 / 无结果 → 降级为全本地 30 首 ===')
  searchImpl = async () => { throw new Error('网关超时') }
  await Daily.recompute()
  ok('在线异常时总数仍 30', Daily.list.length === 30, '实际 ' + Daily.list.length)
  ok('全部降级为本地，且 in-flight 状态明确',
    Daily.onlineCount === 0 && Daily.list.every((x) => x.kind === 'local') &&
    /没成功/.test(el('dailyStatus').textContent))
  searchImpl = async () => ({ list: [] })
  await Daily.recompute()
  ok('在线无结果时同样补满 30 首本地',
    Daily.list.length === 30 && Daily.list.every((x) => x.kind === 'local'))

  console.log('\n=== 3) 并发重算：旧在线请求收尾不能覆盖新一批 ===')
  searchImpl = () => new Promise((resolve) => setTimeout(() => resolve({ list: onlineSongs(10, '旧') }), 30))
  const p1 = Daily.recompute()
  await new Promise((r) => setTimeout(r, 5))   // 让旧请求真的发出去
  searchImpl = async () => ({ list: onlineSongs(10, '新') })
  await Daily.recompute()
  await p1
  ok('最新一批生效，旧请求作废',
    !Daily.list.some((x) => x.kind === 'online' && String(x.song.title).startsWith('旧')),
    Daily.list.filter((x) => x.kind === 'online').map((x) => x.song.title).join(','))

  console.log('\n=== 4) 队列隔离与点播链路 ===')
  player.queues.length = 0
  Daily.playAll()
  ok('播放全部只播本地 24 首',
    player.queues.length === 1 && player.queues[0].q.length === 24 &&
    player.queues[0].q.every((t) => String(t.id).startsWith('L')))
  player.queues.length = 0
  await Daily.playAt(0)
  ok('点本地行不触发在线解析', playableCalls === 0 && lastQueue.length === 24)
  const oi = Daily.list.findIndex((x) => x.kind === 'online')
  await Daily.playAt(oi)
  ok('点在线行走解析 + 队列只含同源在线条目',
    playableCalls === 1 && lastQueue.length === 6 &&
    lastQueue.every((t) => String(t.id).startsWith('on:')))
  await Daily.downloadAt(oi)
  ok('在线行下载按钮接到 IPC', downloadCalls === 1)

  console.log('\n=== 5) 换一批确实会换掉本地选曲 ===')
  searchImpl = async () => ({ list: [] })
  const before = Daily.localTracks().map((t) => t.id).join(',')
  await Daily.recompute()
  ok('上一批本地 id 被降权，重抽结果不同',
    Daily.localTracks().map((t) => t.id).join(',') !== before)

  console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
  process.exit(fail ? 1 : 0)
}

run().catch((e) => { console.error(e); process.exit(1) })
