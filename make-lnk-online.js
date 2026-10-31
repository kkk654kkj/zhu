/**
 * 生成「猪专属播放器·联网版」桌面快捷方式。
 *
 * 和 make-lnk.js 的区别只有成品目录和名字：本地版和联网版各放各的，
 * 桌面上两个图标靠名字区分（不能同名，同名会互相覆盖）。
 *
 * 用法：node make-lnk-online.js
 */
const path = require('path')
const { execFileSync } = require('child_process')

// 成品最终位置（不能放回 default-workspace，那里是低完整性目录，会弹安全警告）
const dist = 'D:\\猪专属播放器联网版'
const exe = path.join(dist, '猪专属播放器.exe')
const vbs = path.join(dist, '启动播放器.vbs')
const desktop = path.join(process.env.USERPROFILE || 'C:\\Users\\LENOVO', 'Desktop')
const lnk = path.join(desktop, '猪专属播放器·联网版.lnk')

const ps = `
$W = New-Object -ComObject WScript.Shell
$S = $W.CreateShortcut(${JSON.stringify(lnk)})
$S.TargetPath = 'C:\\Windows\\System32\\wscript.exe'
$S.Arguments = '"' + ${JSON.stringify(vbs)} + '"'
$S.WorkingDirectory = ${JSON.stringify(dist)}
$S.IconLocation = ${JSON.stringify(exe + ',0')}
$S.Description = '猪专属播放器 联网版（本地曲库 + 在线搜索播放下载）'
$S.WindowStyle = 1
$S.Save()
Write-Output 'lnk-ok'
`.trim()

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  console.log(out.trim())
} catch (e) {
  console.error('FAIL', e.message)
  process.exit(1)
}

console.log('shortcut:', lnk)
