'use strict'
/**
* Release 发布模板（以 v2.8.21 / v3.3.22 为样例）。每版复制改名（如 publish-v14.mjs）后改 tag/title/body/zip/旧版列表。
 * 用法: node publish-v13.mjs（最新模板，每版复制改名）
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
  '## 猪专属播放器（本地版）v2.8.21',
  '',
  '**架构优化轮：曲库列表虚拟滚动 + 内嵌封面按需加载。**',
  '',
  '### 本轮重点',
  '- **曲库列表虚拟滚动**：以前一次性渲染全部行，曲库上千首时 DOM 节点破万、',
  '  切视图/搜索明显掉帧；现在只渲染可视区 ±8 行缓冲，滚动按需重画，',
  '  千首曲库切视图如丝般顺滑。播放高亮 / 多选 / 右键菜单 / 拖序号加歌单行为不变。',
  '- **内嵌封面按需加载**：以前扫描时把所有内嵌封面读进内存（160MB 上限会被填满）；',
  '  现在扫描期只做标记，首次浏览到才解析，且缓存按**专辑**共享——',
  '  同一张专辑几十首只占一份内存、只解析一次。',
  '- 测试/自动化新增 LX_TEST_HIDDEN 隐藏窗口开关（对正常使用无影响）。',
  '',
  ...INSTALL,
  '本地版请下载 **v2.8.21**（`ZhuPlayer_v2.8.21_Portable.zip`）。',
  '',
  '> v2.8.20 已标为 pre-release（保留可下载）。'
].join('\n')

const ONLINE_BODY = [
  '## 猪专属播放器·联网版 v3.3.22',
  '',
  '**架构优化轮：与播放器 v2.8.21 同步发布，同含虚拟滚动与封面内存改造。**',
  '',
  '### 本轮重点',
  '- **曲库列表虚拟滚动**：只渲染可视区 ±8 行，上千首曲库切视图/搜索不再掉帧；',
  '  播放高亮 / 多选 / 右键菜单 / 拖序号加歌单行为不变。',
  '- **内嵌封面按需加载 + 专辑级共享缓存**：扫描期不再把全部封面读进内存（160MB 上限不再被填满）；',
  '  封面墙/专辑视图同专辑几十首只解析一次、占一份内存。',
  '- 测试/自动化新增 LX_TEST_HIDDEN 隐藏窗口开关（对正常使用无影响）。',
  '',
  ...INSTALL,
  '联网版请下载 **v3.3.22**（`ZhuPlayer_v3.3.22_Online.zip`）。',
  '',
  '> v3.3.21 已标为 pre-release（保留可下载）。'
].join('\n')

const RELEASES = [
  {
    tag: 'v2.8.21', branch: 'master',
    title: '播放器 v2.8.21（架构优化：曲库虚拟滚动 + 封面按需加载）',
    zip: 'ZhuPlayer_v2.8.21_Portable.zip',
    body: LOCAL_BODY
  },
  {
    tag: 'v3.3.22', branch: 'online',
    title: '联网版 v3.3.22（架构优化：曲库虚拟滚动 + 封面按需加载·专辑级共享）',
    zip: 'ZhuPlayer_v3.3.22_Online.zip',
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
  for (const old of ['v2.8.20', 'v3.3.21']) {
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
