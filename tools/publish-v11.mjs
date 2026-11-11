'use strict'
/**
 * v2.8.19 / v3.3.20 发布脚本（一次性，放在仓库外，不入库）
 * 用法: node publish-v11.mjs
 * 依赖: git credential (github.com) / GitHub API
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'kkk654kkj/zhu'
const API = 'https://api.github.com'
const ZIPDIR = 'D:/猪专属播放器安装包'

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8'
  })
  const m = /^password=(.+)$/m.exec(out)
  if (!m) throw new Error('找不到 GitHub 凭据')
  return m[1].trim()
}
const TOK = token()
const H = {
  Authorization: 'Bearer ' + TOK,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'lx-player-publish',
  'X-GitHub-Api-Version': '2022-11-28'
}

async function api(url, opts = {}) {
  for (let i = 1; i <= 6; i++) {
    try {
      const r = await fetch(API + url, { ...opts, headers: { ...H, ...(opts.headers || {}) } })
      const text = await r.text()
      let j = null
      try { j = JSON.parse(text) } catch { /* 非 JSON */ }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${j && j.message ? j.message : text.slice(0, 200)}`)
      return j
    } catch (e) {
      if (i === 6) throw e
      console.log(`  API 第 ${i} 次失败，重试: ${e.message}`)
      await new Promise((r) => setTimeout(r, 3000 * i))
    }
  }
}

const INSTALL = [
  '### 安装',
  '1. 下载下方 zip，右键「全部解压」到一个固定文件夹（不要直接在压缩包内双击）',
  '2. 双击 `启动播放器.vbs` 或 `猪专属播放器.exe`',
  '3. 设置里添加音乐文件夹；联网版顶部可直接搜索在线音乐',
  '4. 覆盖安装会保留 `data\\` 里的曲库与设置',
  ''
]

const LOCAL_BODY = [
  '## 猪专属播放器（本地版）v2.8.19',
  '',
  '**第五轮审查全修：主进程 8 条 + 渲染层 9 条 + 库扫描 2 条 + 验证工具 2 处自身缺陷。**',
  '',
  '### 本轮重点修复',
  '- **设置文件读不到时先备份再重建**：以前磁盘/权限出问题时 250ms 内用默认值覆盖，',
  '  歌单、收藏、设置全部静默丢失；现在原文件先备份成 `.bak`，再回落默认值。',
  '- **库扫描健壮性**：大曲库（6.5 万首）不再因 spread 合并数组触发 RangeError 导致整次扫描失败；',
  '  内嵌封面单张 4MB 上限，超大图不再永久驻留内存。',
  '- **取消关机不再弹假错误**：15 秒反悔窗口内取消，以前必弹「系统拒绝执行关机命令」。',
  '- **坏文件不再永久降级独占输出**：file-error 现在区分「AO 打不开」与「文件坏了」，',
  '  一首坏歌不再把整个会话降到共享输出；慢起播加 4 秒宽限，不再误杀引擎。',
  '- **拖序号到歌单加歌复活**：唯一的拖拽源此前被 CSS 藏死，整条链路是死代码。',
  '- **右键菜单连点**：覆盖清理函数前先摘上一轮全局监听，加歌单不再重复添加、收藏不再切两次等于没切。',
  '',
  '### 其余修复',
  '- 启动失败弹错误框再退出（不再「双击没反应」）；',
  '- 设置保存失败有限重试（界面显示新值、磁盘旧值、下次启动回滚的问题）；',
  '- 扫描被响度分析挡住时补渲染、目录全被拒时提示「扫描未执行」；',
  '- 键盘快捷键不抢下拉框、频谱 stop 后不再 60fps 空转、裂图全局委托收；',
  '- 声明扫描工具修两处自身漏检（模板字符串插值、短标识符），新增 9 项自检。',
  '',
  ...INSTALL,
  '本地版请下载 **v2.8.19**（`ZhuPlayer_v2.8.19_Portable.zip`）。',
  '',
  '> v2.8.18 已标为 pre-release（保留可下载），**不建议再用**。'
].join('\n')

const ONLINE_BODY = [
  '## 猪专属播放器·联网版 v3.3.20',
  '',
  '**第五轮审查全修：与播放器 v2.8.19 同步发布，另含联网专属修复。**',
  '',
  '### 联网专属修复',
  '- **下载续传同源校验**：暂停后继续时若音源档位/编码与上次不同（无损额度用尽降级、',
  '  多源换源、CDN 重新转码），以前两份不同编码的字节会拼进同一个文件，',
  '  出现「时长正常、后半段全是噪声」的歌；现在换源即丢残片重下。',
  '- **同名下载并发互删**：用原子占位防止两个同名任务互删对方文件。',
  '- **缓存目录误指保护**：启动清扫只认自家断点命名，缓存目录指到用户目录时不再误删别人的文件。',
  '- **直链与请求日志脱敏**：query 里的鉴权参数不再落日志。',
  '- 在线面板 focus 不再抢顶部搜索框光标；在线列表 hover 规则修正。',
  '',
  '### 与本地版共同的修复',
  '设置读失败先备份再重建、库扫描健壮性、取消关机假错误、坏文件不再永久降级独占、',
  '拖序号加歌、菜单连点、设置保存重试、启动失败弹错等（详见本地版说明）。',
  '',
  ...INSTALL,
  '联网版请下载 **v3.3.20**（`ZhuPlayer_v3.3.20_Online.zip`）。',
  '',
  '> v3.3.19 已标为 pre-release（保留可下载），**不建议再用**。'
].join('\n')

const RELEASES = [
  {
    tag: 'v2.8.19', branch: 'master',
    title: '播放器 v2.8.19（第五轮审查全修：设置丢失/库扫描/独占降级/拖拽加歌等 21 条）',
    zip: 'ZhuPlayer_v2.8.19_Portable.zip',
    body: LOCAL_BODY
  },
  {
    tag: 'v3.3.20', branch: 'online',
    title: '联网版 v3.3.20（第五轮审查全修 + 联网专属：续传同源/同名并发/日志脱敏）',
    zip: 'ZhuPlayer_v3.3.20_Online.zip',
    body: ONLINE_BODY
  }
]

async function uploadAsset(uploadUrl, zipPath, name) {
  const size = fs.statSync(zipPath).size
  const url = uploadUrl.replace('{?name,label}', '') + '?name=' + encodeURIComponent(name)
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      console.log(`  上传 ${name} (${(size / 1048576).toFixed(1)} MB) 第 ${attempt} 次…`)
      const body = fs.createReadStream(zipPath)
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + TOK,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'lx-player-publish',
          'Content-Type': 'application/zip',
          'Content-Length': String(size),
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body,
        duplex: 'half'
      })
      const t = await r.text()
      if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`)
      const j = JSON.parse(t)
      console.log('  ✓ 上传成功:', j.browser_download_url)
      return j
    } catch (e) {
      if (attempt === 6) throw e
      console.log('  上传失败，重试:', e.message)
      await new Promise((r) => setTimeout(r, 5000 * attempt))
    }
  }
}

async function main() {
  for (const rel of RELEASES) {
    const p = path.join(ZIPDIR, rel.zip)
    if (!fs.existsSync(p)) throw new Error('缺少包: ' + p)
    console.log('包就绪', rel.zip, (fs.statSync(p).size / 1048576).toFixed(1) + 'MB')
  }
  for (const rel of RELEASES) {
    console.log('\n=== 发布', rel.tag, '===')
    let release
    try {
      release = await api(`/repos/${REPO}/releases/tags/${rel.tag}`)
      console.log('  已存在，复用 release id', release.id)
      await api(`/repos/${REPO}/releases/${release.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: rel.title, body: rel.body, prerelease: false, draft: false })
      })
      console.log('  标题与说明已更新')
    } catch {
      release = await api(`/repos/${REPO}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          tag_name: rel.tag, target_commitish: rel.branch, name: rel.title,
          body: rel.body, draft: false, prerelease: false
        })
      })
      console.log('  新建 release id', release.id)
    }
    const existing = (release.assets || []).find((a) => a.name === rel.zip)
    if (existing) {
      console.log('  同名资产已存在，删除后重传')
      await api(`/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE' })
    }
    await uploadAsset(release.upload_url, path.join(ZIPDIR, rel.zip), rel.zip)
  }
  // 把上一版标记 pre-release（保留可下载）
  for (const old of ['v2.8.18', 'v3.3.19']) {
    try {
      const r = await api(`/repos/${REPO}/releases/tags/${old}`)
      if (!r.prerelease) {
        await api(`/repos/${REPO}/releases/${r.id}`, { method: 'PATCH', body: JSON.stringify({ prerelease: true }) })
        console.log('  旧版标记 pre-release:', old)
      } else {
        console.log('  旧版已是 pre-release:', old)
      }
    } catch (e) { console.log('  跳过旧版标记', old, e.message) }
  }
  console.log('\n=== 最终核对 ===')
  const list = await api(`/repos/${REPO}/releases?per_page=6`)
  for (const r of list) {
    console.log(r.tag_name, '| prerelease:', r.prerelease, '|', r.name)
    console.log('   assets:', (r.assets || []).map((a) => a.name + ' ' + (a.size / 1048576).toFixed(1) + 'MB').join(', '))
  }
  // tag 指向核对：tag 必须指向分支 HEAD
  for (const rel of RELEASES) {
    const head = (await api(`/repos/${REPO}/git/ref/heads/${rel.branch}`)).object.sha
    const tag = await api(`/repos/${REPO}/git/ref/tags/${rel.tag}`)
    const tagSha = tag.object.type === 'commit' ? tag.object.sha : (await api(`/repos/${REPO}/git/tags/${tag.object.sha}`)).object.sha
    console.log(`tag ${rel.tag} → ${tagSha.slice(0, 8)} | ${rel.branch} HEAD → ${head.slice(0, 8)} | ${tagSha === head ? '一致 ✓' : '不一致 ✗'}`)
  }
}
main().catch((e) => { console.error('发布失败:', e); process.exit(1) })
