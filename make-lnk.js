const path = require('path')
const { execFileSync } = require('child_process')

const ws = process.argv[2]
// 成品最终位置在 D:\猪专属播放器（不能放回 default-workspace，那里是低完整性目录，会弹安全警告）
const dist = 'D:\\猪专属播放器'
const exe = path.join(dist, '猪专属播放器.exe')
const vbs = path.join(dist, '启动播放器.vbs')
const desktop = path.join(process.env.USERPROFILE || 'C:\\Users\\LENOVO', 'Desktop')
const lnk = path.join(desktop, '猪专属播放器.lnk')

const ps = `
$W = New-Object -ComObject WScript.Shell
$S = $W.CreateShortcut(${JSON.stringify(lnk)})
$S.TargetPath = 'C:\\Windows\\System32\\wscript.exe'
$S.Arguments = '"' + ${JSON.stringify(vbs)} + '"'
$S.WorkingDirectory = ${JSON.stringify(dist)}
$S.IconLocation = ${JSON.stringify(exe + ',0')}
$S.Description = '猪专属播放器（本地音乐播放器）'
$S.WindowStyle = 1
$S.Save()
Write-Output 'lnk-ok'
`.trim()

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8'
  })
  console.log(out.trim())
} catch (e) {
  console.error('FAIL', e.message)
  process.exit(1)
}

// 删除旧的「音乐播放器.lnk」
const fs = require('fs')
const old = path.join(desktop, '音乐播放器.lnk')
if (fs.existsSync(old)) {
  fs.unlinkSync(old)
  console.log('removed old shortcut:', old)
}
console.log('shortcut:', lnk)
