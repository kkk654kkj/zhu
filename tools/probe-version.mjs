// 成品核对：运行时版本 + 列表型设置可保存（v2.8.18 的回归点）
const PORT = process.env.CDP_PORT || 9273
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const t = list.find((x) => x.type === 'page' && /index\.html/.test(x.url))
if (!t) { console.log('没找到主窗口'); process.exit(1) }
const ws = new WebSocket(t.webSocketDebuggerUrl)
// 成品实例没起来 / 端口不对时不能静默挂起
await new Promise((r, rej) => {
  const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 5000)
  ws.onopen = () => { clearTimeout(timer); r() }
  ws.onerror = () => { clearTimeout(timer); rej(new Error('CDP WebSocket 连接失败')) }
})
let seq = 1
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (!m.id || !pending.has(m.id)) return
  pending.get(m.id)(m)
  pending.delete(m.id)
})
const call = (method, params) => new Promise((res) => {
  const id = seq++
  pending.set(id, res)
  ws.send(JSON.stringify({ id, method, params }))
})
const expr = `(async () => {
  const info = await window.api.appInfo()
  const dirs = (state.settings && state.settings.musicDirs) || []
  let saved = null, err = ''
  try {
    const r = await window.api.patchSettings({ musicDirs: dirs })
    saved = Array.isArray(r && r.musicDirs) ? r.musicDirs.length : null
  } catch (e) { err = (e && e.message) || String(e) }
  return { version: info && info.version, dirs: dirs.length, saved, err }
})()`
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
console.log(JSON.stringify(r.result && r.result.result && r.result.result.value))
if (r.exceptionDetails) console.log('EXC', JSON.stringify(r.exceptionDetails.text))
ws.close()
