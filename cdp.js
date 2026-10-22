// 通过 CDP 在渲染进程里执行 JS，用于真实自查 DOM/状态（截图看不出的问题）
// 用法: node cdp.js "<js expression>" [shot.png]         —— 求值并打印 JSON
//       node cdp.js --file expr.js [shot.png]           —— 从文件读表达式
const fs = require('fs')

async function main() {
  const arg = process.argv[2]
  if (!arg) { console.error('need expression'); process.exit(2) }
  const shotPath = arg === '--file' ? process.argv[4] : process.argv[3]
  const expr = arg === '--file' ? fs.readFileSync(process.argv[3], 'utf8') : arg

  const port = process.env.CDP_PORT || '9222'
  const list = await (await fetch('http://127.0.0.1:' + port + '/json')).json()
  // 可选：CDP_MATCH 过滤目标（如 "index.html"），因为有桌面歌词窗口时 /json 会返回多个 page
  const match = process.env.CDP_MATCH
  const candidates = list.filter((t) => t.type === 'page' && (!match || (t.url + ' ' + (t.title || '')).includes(match)))
  const page = candidates[0]
  if (!page) { console.error('no page (filter=' + (match || 'none') + ')'); process.exit(2) }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id
    pending.set(mid, { res, rej })
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
  })

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(JSON.stringify(msg.error)))
      else res(msg.result)
    }
  }

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')) })

  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  const out = r.exceptionDetails
    ? { __error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text }
    : r.result.value
  console.log(JSON.stringify(out, null, 2))

  if (shotPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log('[shot] ' + shotPath)
  }

  ws.close()
  process.exit(0)
}

main().catch((e) => { console.error('CDP ERR', e.message); process.exit(1) })
