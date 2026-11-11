'use strict'
// 成品实测：appInfo 版本 + 保存一次列表型设置（写→读→还原）
const PORT = Number(process.env.CDP_PORT || 9273)

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map()
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data) } catch { return }
      if (!m.id || !this.pending.has(m.id)) return
      const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id)
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result)
    }
  }
  static async attach(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    return new CDP(ws)
  }
  call(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expr) {
    const r = await this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
    return r.result.value
  }
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const t = targets.find((x) => x.type === 'page' && /猪专属播放器/.test(x.title)) ||
            targets.find((x) => x.type === 'page' && /index\.html/.test(x.url))
  if (!t) { console.log('FAIL 找不到主窗口，候选:', targets.map(x => x.title).join(' | ')); process.exit(1) }
  const c = await CDP.attach(t.webSocketDebuggerUrl)
  // 1) appInfo 版本
  const info = await c.evaluate('window.api.appInfo()')
  console.log('版本:', info.version, '| electron', info.electron)
  // 2) 列表型设置写读：musicDirs 追加 marker → 读回 → 还原（真实键，走白名单+数组校验）
  const before = await c.evaluate('window.api.getSettings()')
  const orig = Array.isArray(before.musicDirs) ? before.musicDirs : []
  const marker = 'D:\\live-check-' + Date.now()
  await c.evaluate(`window.api.patchSettings({ musicDirs: [...${JSON.stringify(orig)}, ${JSON.stringify(marker)}] })`)
  const after = await c.evaluate('window.api.getSettings()')
  const hasMarker = Array.isArray(after.musicDirs) && after.musicDirs.includes(marker)
  console.log('列表型设置写读:', hasMarker ? 'OK' : 'FAIL')
  await c.evaluate(`window.api.patchSettings({ musicDirs: ${JSON.stringify(orig)} })`)
  const restored = await c.evaluate('window.api.getSettings()')
  const clean = JSON.stringify(Array.isArray(restored.musicDirs) ? restored.musicDirs : []) === JSON.stringify(orig)
  console.log('设置还原:', clean ? 'OK' : 'FAIL')
  // 3) 渲染层无全局异常
  const noErr = await c.evaluate('(typeof window.__v5err === "undefined" || window.__v5err === null)')
  console.log('渲染层无全局异常:', noErr ? 'OK' : 'FAIL')
  process.exit(hasMarker && clean && noErr ? 0 : 1)
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1) })
