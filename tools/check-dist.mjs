// 换装后的完整性校验：node tools/check-dist.mjs "D:/猪专属播放器"
// 为什么要它：electron-packager 产物里没有 启动播放器.vbs / icon.ico / 使用说明.txt，
// 换装时忘了从旧目录搬回来，桌面快捷方式就会报「无法找到脚本文件」。
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('用法: node tools/check-dist.mjs <成品目录>')
  process.exit(2)
}

const must = ['猪专属播放器.exe', 'resources/app.asar', 'engine/mpv.exe', '启动播放器.vbs', 'icon.ico']
const soft = ['data/settings.json', '使用说明.txt']

const MAX_ASAR_JSON = 64 * 1024 * 1024   // 损坏的 asar 头可能给出巨量长度，必须封顶再 Buffer.alloc

let bad = 0
for (const f of must) {
  let ok = false
  try { ok = fs.statSync(path.join(dir, f)).size > 0 } catch { ok = false }
  console.log((ok ? '✓ ' : '✗ ') + f)
  if (!ok) bad++
}
for (const f of soft) {
  const ok = fs.existsSync(path.join(dir, f))
  console.log((ok ? '· ' : '· ') + f + (ok ? '' : '（可选，缺失）'))
}

// 从 app.asar 里读真实版本号，避免「换装换了个旧包」这种低级事故
let fd = null
try {
  fd = fs.openSync(path.join(dir, 'resources/app.asar'), 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  if (!(jsonLen > 0) || jsonLen > MAX_ASAR_JSON) {
    throw new Error('asar 头部 JSON 长度异常: ' + jsonLen)
  }
  const buf = Buffer.alloc(jsonLen)
  fs.readSync(fd, buf, 0, jsonLen, 16)
  const hdr = JSON.parse(buf.toString('utf8'))
  const base = 8 + head.readUInt32LE(4)
  // 抽查关键文件确实在包里（残缺包 / 换错包能提前发现）
  const hasAsarFile = (parts) => {
    let cur = hdr.files
    for (let i = 0; i < parts.length; i++) {
      if (!cur || !cur[parts[i]]) return false
      cur = i === parts.length - 1 ? true : cur[parts[i]].files
    }
    return true
  }
  if (!hasAsarFile(['src', 'main', 'main.js'])) throw new Error('asar 内缺 src/main/main.js')
  const e = hdr.files['package.json']
  if (!e || !(e.size > 0) || e.size > MAX_ASAR_JSON) throw new Error('asar 内 package.json 条目异常')
  const body = Buffer.alloc(e.size)
  fs.readSync(fd, body, 0, e.size, base + Number(e.offset))
  console.log('版本: ' + JSON.parse(body.toString('utf8')).version)
} catch (err) {
  console.log('版本: 读取失败 ' + err.message)
  bad++
} finally {
  if (fd != null) { try { fs.closeSync(fd) } catch {} }
}

process.exit(bad ? 1 : 0)
