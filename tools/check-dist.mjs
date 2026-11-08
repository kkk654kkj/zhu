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

let bad = 0
for (const f of must) {
  const ok = fs.existsSync(path.join(dir, f))
  console.log((ok ? '✓ ' : '✗ ') + f)
  if (!ok) bad++
}
for (const f of soft) {
  const ok = fs.existsSync(path.join(dir, f))
  console.log((ok ? '· ' : '· ') + f + (ok ? '' : '（可选，缺失）'))
}

// 从 app.asar 里读真实版本号，避免「换装换了个旧包」这种低级事故
try {
  const fd = fs.openSync(path.join(dir, 'resources/app.asar'), 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const buf = Buffer.alloc(jsonLen)
  fs.readSync(fd, buf, 0, jsonLen, 16)
  const hdr = JSON.parse(buf.toString('utf8'))
  const base = 8 + head.readUInt32LE(4)
  const e = hdr.files['package.json']
  const body = Buffer.alloc(e.size)
  fs.readSync(fd, body, 0, e.size, base + Number(e.offset))
  fs.closeSync(fd)
  console.log('版本: ' + JSON.parse(body.toString('utf8')).version)
} catch (err) {
  console.log('版本: 读取失败 ' + err.message)
  bad++
}

process.exit(bad ? 1 : 0)
