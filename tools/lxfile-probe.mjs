// §5.3 lxfile 实读探测：对第一首的 audio 地址发 Range 请求，期望 206
const list = await (await fetch('http://127.0.0.1:9272/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('index.html')) || list.find((t) => t.type === 'page')
if (!page) { console.log('NO PAGE'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const expr = `(async () => {
  const t = (typeof state !== 'undefined' && state.tracks && state.tracks[0]) || null
  if (!t || !t.audio) return { error: 'no track' }
  const r = await fetch(t.audio, { headers: { Range: 'bytes=0-1' } })
  const b = await r.arrayBuffer()
  return { status: r.status, len: b.byteLength, audio: String(t.audio).slice(0, 90) }
})()`
const out = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log(JSON.stringify(out.result && out.result.result ? out.result.result.value : out, null, 2))
ws.close()
