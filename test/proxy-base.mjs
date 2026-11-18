'use strict'
/**
 * proxyBase 取空重试（T02-03 / v3.3.71）
 *
 * 端口是异步绑的；安全软件临时拦截、TIME_WAIT 都会让第一次拿到空串。
 * 以前空串会被拼成相对 `/stream`（file:// 页面下 = file:///stream），
 * <audio> 报 ERR_FILE_NOT_FOUND，错误链当成坏链去换源，越换越死。
 *
 * 这里：
 *   ① 真跑渲染层的 fetchProxyBase：空两次后成功 / 一直空 / 抛错三种情形
 *   ② 静态钉住「空串绝不拼地址」「有限重试」「错误链不跳曲」四处约束
 *
 * 用法：node test/proxy-base.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  [' + extra + ']' : '')) }
}

/* ---------- ① 渲染层 fetchProxyBase 真跑 ---------- */
const sandbox = { console, setTimeout, clearTimeout, URLSearchParams, Promise, Date }
sandbox.globalThis = sandbox
sandbox.window = { api: {} }
vm.createContext(sandbox)
vm.runInContext(
  read('src/renderer/js/online.js') + '\n;globalThis.__fetchProxyBase = fetchProxyBase\n',
  sandbox,
  { filename: 'online.js' }
)
const fetchProxyBase = sandbox.__fetchProxyBase
ok('online.js 能在无 DOM 环境装载出 fetchProxyBase', typeof fetchProxyBase === 'function')

{
  let n = 0
  const api = { onlineProxyBase: async () => (++n >= 3 ? 'http://127.0.0.1:4567' : '') }
  const base = await fetchProxyBase(api, 3, 0)
  ok('前两次取空、第三次成功 → 返回可用地址（有限重试）',
    base === 'http://127.0.0.1:4567' && n === 3, 'base=' + base + ' calls=' + n)
}
{
  let n = 0
  const api = { onlineProxyBase: async () => { n++; return '' } }
  const base = await fetchProxyBase(api, 3, 0)
  ok('一直取空 → 重试 3 次后明确回空串（不会无限转）',
    base === '' && n === 3, 'calls=' + n)
}
{
  let n = 0
  const api = { onlineProxyBase: async () => { n++; throw new Error('ipc gone') } }
  const base = await fetchProxyBase(api, 2, 0)
  ok('IPC 抛错也被吞掉并按次数重试（不把异常抛给播放链）',
    base === '' && n === 2, 'calls=' + n)
}
{
  const base = await fetchProxyBase(null, 1, 0)
  ok('没有 api 时直接回空串（不抛 TypeError）', base === '')
}

/* ---------- ② 静态约束 ---------- */
const online = read('src/renderer/js/online.js')
const main = read('src/main/main.js')
const player = read('src/renderer/js/player.js')
const app = read('src/renderer/js/app.js')
const daily = read('src/renderer/js/daily.js')

const guardAt = online.indexOf("if (!this.proxyBase) return ''")
const streamAt = online.indexOf('`${this.proxyBase}/stream')
ok('代理为空时绝不拼相对 /stream（先判空再拼地址）',
  guardAt >= 0 && streamAt > guardAt, 'guard=' + guardAt + ' stream=' + streamAt)

ok('在线曲地址改成 getter（端口就绪后不必重建队列）',
  /Object\.defineProperty\(track, 'audio'/.test(online))

ok('ensureBase 走有限重试（不是一次定生死）',
  /this\.proxyBase = await fetchProxyBase\(window\.api\)/.test(online))

ok('主进程 online:proxyBase 也做有限次重试',
  /ipcMain\.handle\('online:proxyBase', async \(\) => \{/.test(main) &&
  (main.match(/SP\.ensureStreamBase\(\)/g) || []).length >= 2)

ok('地址为空时播放器直接报 NO_PROXY，不去 load 一个假地址',
  /err\.code = 'NO_PROXY'/.test(player) && /if \(!track\.audio\) \{/.test(player))

ok('错误链对 NO_PROXY 只提示并停住（不换源、不跳曲）',
  /err\.code === 'NO_PROXY'/.test(app) && /player\.pause\(\)/.test(app) &&
  app.indexOf("err.code === 'NO_PROXY'") < app.indexOf('recoverOnlineTrack(cur)'))

ok('每日推荐两个播放入口都在播前现问代理',
  (daily.match(/await Online\.ensureBase\(\)/g) || []).length >= 2)

console.log(fail ? `\n${pass} 通过 / ${fail} 失败` : `\n全部通过（${pass} 项）`)
process.exit(fail ? 1 : 0)
