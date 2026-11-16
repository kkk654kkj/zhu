'use strict'
/**
 * 每日推荐 · 收藏 / 加入歌单 + 规格档位（v3.3.65）
 *
 * 与在线搜索面板同款：每日推荐的在线曲行尾也有 ♥ 收藏 / ＋ 加入歌单，
 * 收藏时把探测到的档位一并落盘，重开后「我的收藏 / 队列」的规格列能读出档位，
 * 没探到的老条目显示「在线」占位而不是空白。
 *
 * 风险点在纯逻辑：行尾按钮的数据口径（key 与 metaOf 一致）、档位随元数据落盘/还原、
 * 收藏顺序（先落元数据再写引用）、以及渲染层渲染函数的占位分支。
 *
 * 用法：node test/daily-fav.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require2 = createRequire(import.meta.url)
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

const dSrc = read('src/renderer/js/daily.js')
const oSrc = read('src/renderer/js/online.js')
const cSrc = read('src/renderer/css/daily.css')

/* ---------------- ① 静态口径：行尾四键 + 落盘顺序 ---------------- */

ok('每日推荐行尾有 ♥ / ＋，且带 aria-pressed 与 data-id',
  /data-act="fav" aria-pressed/.test(dSrc) &&
  /data-act="addpl"/.test(dSrc) &&
  /return `<div class="op-tr" data-index="\$\{i\}" data-id=/.test(dSrc))
ok('每日推荐收藏/加歌单都先落元数据（含探测档位 x.q）再写引用',
  (dSrc.match(/onlineTracksRemember\(\[Online\.metaOf\(song, x\.q\)\]\)/g) || []).length === 2)
ok('每日推荐收藏后同步渲染层元数据 + 就地翻 ♥',
  /Online\.syncOnlineMeta\(map\)/.test(dSrc) &&
  /paintFavRows\(\)/.test(dSrc) &&
  /#dailyBody \.op-tr/.test(dSrc))
ok('加入歌单走同一条 add-pl 菜单管道',
  /act: 'add-pl', arg: p\.id/.test(dSrc))
ok('每日推荐行尾列宽按 4 键放宽（末列 118/104/104）',
  /46px 118px/.test(cSrc) && /42px 104px/.test(cSrc) && /52px 104px/.test(cSrc))
ok('本地兜底行不出现 ♥ / ＋（isLocal 时 acts 后缀为空）',
  /\(isLocal \? '' :\s*`<button class="op-act-btn\$\{favOn\}" data-act="fav"/.test(dSrc))

/* ---------------- ② 运行时：档位落盘 / 还原 / 占位 ---------------- */

const sandbox = {
  console,
  state: { settings: {}, favorites: new Set(), playlists: [] },
  document: { querySelectorAll: () => [], getElementById: () => null },
  window: { api: {} },
  player: null,
  toast: () => {},
  esc: (v) => String(v == null ? '' : v),
  icon: () => '',
  fmtDuration: () => '0:00',
  UI: { showContextMenu: () => {} },
  handleCtxAction: async () => {},
  currentMenuTrack: null,
  currentMenuTracks: [],
  URLSearchParams,
  URL
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(oSrc + '\n;globalThis.__Online = Online\n', sandbox, { filename: 'online.js' })
const Online = sandbox.__Online
Online.proxyBase = 'http://127.0.0.1:51000'

const song = { source: 'kw', id: '1', title: '晴天', artist: '周杰伦', duration: 269, quality: '128k' }
const probe = { text: '母带', cls: 'lossless', tip: '高解析 FLAC · 3200k', rank: 3 }

const meta = Online.metaOf(song, probe)
ok('metaOf 把探测档位写进元数据（rank 由主进程 sanitize 裁掉；无直链）',
  meta.spec && meta.spec.text === '母带' && meta.spec.cls === 'lossless' &&
  !JSON.stringify(meta).includes('/stream?'))

const restored = Online.trackFromMeta(meta)
ok('trackFromMeta 还原档位到 track（规格列读 specText/specCls/specTip）',
  restored.specText === '母带' && restored.specCls === 'lossless' &&
  restored.specTip === '高解析 FLAC · 3200k')

const noSpec = Online.trackFromMeta(Online.metaOf(song, null))
ok('没探到档位的老条目 → specText 为空，由渲染层显示「在线」占位',
  noSpec && noSpec.specText === '' && noSpec.specCls === 'dim')

const uiSrc = read('src/renderer/js/ui.js')
ok('规格列：在线曲有档位显示档位文本，无档位显示「在线」，都不走本地 fmtQuality',
  /t\.online[\s\S]{0,220}specText \|\| '在线'/.test(uiSrc) &&
  /!t\.online && isHires\(t\)/.test(uiSrc))

const metaMod = require2(path.join(ROOT, 'src/main/online-meta.js'))
ok('主进程校验档位：cls 走白名单、text/tip 限长，畸形不炸',
  metaMod.sanitizeMeta({ ...meta, spec: { text: 'X'.repeat(200), cls: '<script>', tip: 'Y'.repeat(500) } }).spec.cls === 'dim' &&
  metaMod.sanitizeMeta({ ...meta, spec: 'bad' }).spec === null)

console.log('\n' + (fail ? `${fail} 项失败 / ${pass} 项通过` : `全部通过（${pass} 项）`))
process.exit(fail ? 1 : 0)
