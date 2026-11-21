#!/usr/bin/env node
'use strict'
/**
 * R02-01：换源必须跳过「正在播的那条源」（v3.3.74）
 *
 * 背景（交接 §六.1）：recoverFromSources 把 meta.source 也算进候选音源，搜索结果里
 * 同一首在死源上分数最高、排最前 → 换源把同一条死链原样再取一遍。界面提示
 * 「已换源继续播放」，几秒后又失败，用户感觉换源功能没用。
 *
 * 这里把 online.js 原样放进 vm，用假 onlineSearch 造「当前源也搜到同一首」的场面：
 *   · 默认（settings 无该键）→ 候选不含当前源，必须换成别家
 *   · settings.onlineRecoverSkipCurrent = false → 才允许换回当前源
 *   · opts.allowCurrent = true → 诊断用强制包含当前源
 *   · 只有当前源一个音源 → 直接返回 null，不发一次注定失败的搜索
 *
 * 只在 online 分支跑（master 没有联网模块）。
 * 用法：node test/online-source-exclude.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------------- 在 vm 里跑真实 online.js ---------------- */

const searchCalls = []
let searchImpl = null

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance,
  // 渲染层全局：online.js 顶层只定义函数与 Online 对象，模块加载期不碰 DOM
  state: { settings: {} },
  document: { getElementById: () => null, querySelectorAll: () => [] },
  window: {
    api: {
      onlineSearch: (arg) => {
        searchCalls.push(arg)
        return Promise.resolve(searchImpl ? searchImpl(arg) : { list: [] })
      }
    }
  }
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(read('src/renderer/js/online.js') + '\n;globalThis.__Online = Online\n', sandbox, { filename: 'online.js' })
const Online = sandbox.__Online
ok('online.js 能在无 DOM 环境装载出 Online', Online && typeof Online.recoverFromSources === 'function')

// init() 会去要代理端口列表，这里不走真网络
Online.init = async () => {}
Online.proxyBase = 'http://127.0.0.1:1'
Online.sources = [{ id: 'kw', short: '酷我' }, { id: 'kg', short: '酷狗' }]

const meta = { title: '晴天', artist: '周杰伦', duration: 269, source: 'kw', id: 'on:kw:1' }
const onKw = { id: '11', source: 'kw', title: '晴天', artist: '周杰伦', duration: 269 }
const onKg = { id: '99', source: 'kg', title: '晴天', artist: '周杰伦', duration: 270 }

/** 假网关：请求哪些源就回哪些源；每个源都给一条 85 分的完美匹配 */
searchImpl = (arg) => {
  const list = []
  const want = Array.isArray(arg.sources) ? arg.sources : []
  if (want.includes('kw')) list.push(onKw)
  if (want.includes('kg')) list.push(onKg)
  return { list }
}

/* ---------------- 用例 ---------------- */

console.log('\n[1] 默认（settings 里没有 onlineRecoverSkipCurrent 这个键）')
searchCalls.length = 0
const got1 = await Online.recoverFromSources(meta)
ok('候选音源里不含当前源 kw', searchCalls.length === 1 && !searchCalls[0].sources.includes('kw'),
  'sources=' + JSON.stringify(searchCalls[0] && searchCalls[0].sources))
ok('换成别家源（旧代码会选回 kw 同一条死链 → 这里必须红）', got1 && got1.source === 'kg',
  'got=' + (got1 && got1.source))

console.log('\n[2] 网关不听话：请求里没有 kw，却硬塞回一条 kw 的结果')
searchCalls.length = 0
searchImpl = () => ({ list: [onKw, onKg] })
const got2 = await Online.recoverFromSources(meta)
ok('结果层再按 source 过滤一遍，仍选 kg', got2 && got2.source === 'kg', 'got=' + (got2 && got2.source))

console.log('\n[3] 开关关掉：onlineRecoverSkipCurrent = false → 允许换回当前源')
searchImpl = (arg) => {
  const want = Array.isArray(arg.sources) ? arg.sources : []
  const list = []
  if (want.includes('kw')) list.push(onKw)
  if (want.includes('kg')) list.push(onKg)
  return { list }
}
sandbox.state.settings.onlineRecoverSkipCurrent = false
searchCalls.length = 0
const got3 = await Online.recoverFromSources(meta)
ok('请求里带回了当前源 kw', searchCalls.length === 1 && searchCalls[0].sources.includes('kw'),
  'sources=' + JSON.stringify(searchCalls[0] && searchCalls[0].sources))
ok('关掉后行为回到旧口径（选回 kw）', got3 && got3.source === 'kw', 'got=' + (got3 && got3.source))

console.log('\n[4] opts.allowCurrent = true 强制包含当前源（诊断用）')
sandbox.state.settings.onlineRecoverSkipCurrent = true
searchCalls.length = 0
const got4 = await Online.recoverFromSources(meta, { allowCurrent: true })
ok('显式允许时带 kw', searchCalls.length === 1 && searchCalls[0].sources.includes('kw'))
ok('显式允许时选回 kw', got4 && got4.source === 'kw', 'got=' + (got4 && got4.source))

console.log('\n[5] 只剩一个音源（就是正在播的那个）')
Online.sources = [{ id: 'kw', short: '酷我' }]
searchCalls.length = 0
const got5 = await Online.recoverFromSources(meta)
ok('无其他源可换 → 返回 null', got5 === null, 'got=' + JSON.stringify(got5))
ok('不发一次注定落回死链的搜索', searchCalls.length === 0, 'calls=' + searchCalls.length)

/* ---------------- 静态钉住配置项三要素 ---------------- */

console.log('\n[6] 配置项：键名 / 默认值 / 落点')
const mainSrc = read('src/main/main.js')
ok('DEFAULT_SETTINGS 有 onlineRecoverSkipCurrent 且默认 true',
  /onlineRecoverSkipCurrent:\s*true/.test(mainSrc))
ok('settings:patch 白名单能覆盖它（键在 DEFAULT_SETTINGS 里 → sanitize 放行布尔）',
  /onlineRecoverSkipCurrent/.test(mainSrc))
const uiSrc = read('src/renderer/js/online.js')
ok('online.js 读 settings 的开关决定是否跳过', /onlineRecoverSkipCurrent\s*!==\s*false/.test(uiSrc))
ok('换源函数带 opts 入口（allowCurrent）', /recoverFromSources\(meta,\s*opts\)/.test(uiSrc))

console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
process.exit(fail ? 1 : 0)
