const path = require('path')
const { execFileSync } = require('child_process')

// PowerShell 单引号字符串：内部所有字符（含 $ / 反引号 / 双引号）都按字面处理，
// 只需把单引号翻倍。避免 USERPROFILE 含 $ 或反引号时被 PowerShell 当变量展开。
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"

const ws = process.argv[2]
// 成品最终位置在 D:\猪专属播放器（不能放回 default-workspace，那里是低完整性目录，会弹安全警告）
const dist = 'D:\\猪专属播放器'
const exe = path.join(dist, '猪专属播放器.exe')
const vbs = path.join(dist, '启动播放器.vbs')
const desktop = path.join(process.env.USERPROFILE || 'C:\\Users\\LENOVO', 'Desktop')
const lnk = path.join(desktop, '猪专属播放器.lnk')

const ps = `
$W = New-Object -ComObject WScript.Shell
$S = $W.CreateShortcut(${psq(lnk)})
$S.TargetPath = 'C:\\Windows\\System32\\wscript.exe'
$S.Arguments = '"' + ${psq(vbs)} + '"'
$S.WorkingDirectory = ${psq(dist)}
$S.IconLocation = ${psq(exe + ',0')}
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
  // 快捷方式已建成功，删旧文件失败不应让整个任务报失败
  try { fs.unlinkSync(old); console.log('removed old shortcut:', old) } catch (e) { /* 忽略 */ }
}
console.log('shortcut:', lnk)
