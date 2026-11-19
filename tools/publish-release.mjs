'use strict'
/**
 * Release 发布器（v2.8.59 / v3.3.72 从 .tmp 收编，改为配置驱动）
 *
 * 以前每版复制一份 publish-vXXX.mjs 再改 tag/正文/旧版列表 —— 版本多了就是一堆
 * 只差几行的快照脚本，正文还容易漏改。现在正文与版本清单全在 JSON 里：
 *
 * 用法:
 *   node tools/publish-release.mjs --config tools/release.json [--dry-run]
 *
 * 配置（见 tools/release.template.json）:
 *   repo     GitHub owner/repo
 *   zipdir   安装包目录
 *   releases [{ tag, branch, title, zip, body }]   body 可为字符串或字符串数组
 *   prev     [tag]  发布后标记为 pre-release 的旧版本（保留可下载）
 *
 * 行为：release 已存在则更新标题/正文并重传同名资产；tag 必须指向分支 HEAD，
 * 不一致直接非零退出（以前只打印一行「不一致」还返回成功）。
 * 依赖：git credential (github.com) / GitHub API
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const getArg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : ''
}
const DRY = argv.includes('--dry-run')
const cfgPath = getArg('--config')
if (!cfgPath) {
  console.error('用法: node tools/publish-release.mjs --config <release.json> [--dry-run]')
  process.exit(2)
}
const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const REPO = CFG.repo || 'kkk654kkj/zhu'
const API = 'https://api.github.com'
const ZIPDIR = CFG.zipdir || 'D:/猪专属播放器安装包'
const RELEASES = (CFG.releases || []).map((r) => ({
  ...r,
  body: Array.isArray(r.body) ? r.body.join('\n') : String(r.body || '')
}))
const PREV = CFG.prev || []

if (!RELEASES.length) {
  console.error('配置里没有 releases')
  process.exit(2)
}

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8'
  })
  const m = /^password=(.+)$/m.exec(out)
  if (!m) throw new Error('找不到 GitHub 凭据')
  return m[1].trim()
}
const TOK = DRY ? '' : token()
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
  // 先验包：缺包/包太小一律不进网络流程
  for (const rel of RELEASES) {
    const p = path.join(ZIPDIR, rel.zip)
    if (!fs.existsSync(p)) throw new Error('缺少包: ' + p)
    const size = fs.statSync(p).size
    if (size < 50 * 1048576) throw new Error('包太小，疑似打残: ' + p + ' ' + size)
    console.log('包就绪', rel.zip, (size / 1048576).toFixed(1) + 'MB')
    if (!rel.tag || !rel.branch || !rel.title) throw new Error('配置缺字段（tag/branch/title）: ' + rel.zip)
  }
  if (DRY) {
    console.log('\n[dry-run] 计划发布:')
    for (const rel of RELEASES) console.log(`  ${rel.tag} (${rel.branch}) → ${rel.zip} | ${rel.title}`)
    if (PREV.length) console.log('  旧版标记 pre-release:', PREV.join(', '))
    console.log('  正文预览（' + RELEASES[0].tag + ' 前 3 行）:')
    console.log(RELEASES[0].body.split('\n').slice(0, 3).map((l) => '    ' + l).join('\n'))
    return
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
  for (const old of PREV) {
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
  // tag 必须指向分支 HEAD
  for (const rel of RELEASES) {
    const head = (await api(`/repos/${REPO}/git/ref/heads/${rel.branch}`)).object.sha
    const tag = await api(`/repos/${REPO}/git/ref/tags/${rel.tag}`)
    const tagSha = tag.object.type === 'commit' ? tag.object.sha : (await api(`/repos/${REPO}/git/tags/${tag.object.sha}`)).object.sha
    if (tagSha !== head) throw new Error('tag 未指向分支 HEAD: ' + rel.tag)
    console.log(`tag ${rel.tag} → ${tagSha.slice(0, 8)} | ${rel.branch} HEAD → ${head.slice(0, 8)} | 一致 ✓`)
  }
}

main().catch((e) => { console.error('发布失败:', e.message || e); process.exit(1) })
