const fs = require('fs')
const path = require('path')

const ws = process.argv[2]
// 成品最终位置在 D:\猪专属播放器（不能放回 default-workspace，那里是低完整性目录，会弹安全警告）
const dist = 'D:\\猪专属播放器'
const NAME = '猪专属播放器'
const cw = [...NAME].map((c) => 'ChrW(' + c.codePointAt(0) + ')').join(' & ')

const lines = [
  "' 猪专属播放器启动器（Unicode 保存，勿改编码）",
  'Option Explicit',
  'Dim fso, sh, base, exePath',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'Set sh = CreateObject("WScript.Shell")',
  'base = fso.GetParentFolderName(WScript.ScriptFullName)',
  'exePath = base & "\\" & ' + cw + ' & ".exe"',
  'If Not fso.FileExists(exePath) Then',
  '  MsgBox "找不到主程序：" & vbCrLf & exePath, 16, "' + NAME + '"',
  '  WScript.Quit 1',
  'End If',
  "' 1 = 正常显示窗口（程序本身是 GUI 程序，不会弹控制台；若写 0 主窗口会被隐藏）",
  'sh.Run """" & exePath & """ --no-sandbox", 1, False',
  ''
]
const vbs = lines.join('\r\n')
const out = path.join(dist, '启动播放器.vbs')
// VBScript 的 UTF-16LE 必须带 BOM，否则 cscript/wscript 按 ANSI 解析会报「无效字符」
fs.writeFileSync(out, '\ufeff' + vbs, 'utf16le')
console.log('written', out, fs.statSync(out).size, 'bytes')
console.log('---')
console.log(vbs)
