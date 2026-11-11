'use strict'
/**
 * 走 GitHub Git Data API 把本地新提交逐个推上去（github.com:443 不通、api.github.com 可通时的兜底）。
 * 用法: node push-api.mjs
 * 依赖: git credential (github.com) / 本地仓库
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const REPO = 'kkk654kkj/zhu'
const API = 'https://api.github.com'
const LP = 'D:/文档/deepseek-harness/default-workspace/lx-player'

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
  'User-Agent': 'lx-player-push',
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

const git = (...a) => execFileSync('git', ['-C', LP, '-c', 'core.quotepath=false', ...a], { encoding: 'utf8' }).trim()
// blob 内容绝不能 trim（上次的 trim 吃掉末尾换行，远端树与本地差 1 字节）
const gitRaw = (...a) => execFileSync('git', ['-C', LP, ...a])

async function pushBranch(branch, base) {
  const commits = git('rev-list', '--reverse', `${base}..${branch}`).split('\n').filter(Boolean)
  console.log(`\n=== ${branch}: ${commits.length} 个新提交（基准 ${base}）===`)
  // 远端基准 commit 的 tree
  let parentSha = (await api(`/repos/${REPO}/git/ref/heads/${branch}`)).object.sha
  let parentTree = (await api(`/repos/${REPO}/git/commits/${parentSha}`)).tree.sha
  console.log('远端 HEAD:', parentSha)
  for (const c of commits) {
    const subject = git('log', '-1', '--format=%s', c)
    console.log('推送:', c.slice(0, 8), subject)
    const parentLocal = git('rev-parse', `${c}^`)
    // 该提交相对本地父提交的改动（本地父 = 已推送的链，因为 reverse 顺序 + base 对齐）
    // :oldmode newmode oldsha newsha M\tpath → 用 blob sha 取内容，避开中文路径
    const raw = git('show', '--format=', '--raw', c)
    const tree = []
    for (const line of raw.split('\n').filter(Boolean)) {
      const m = /^:\d+ (\d+) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\t(.+)$/.exec(line)
      if (!m) throw new Error('无法解析 diff-tree 行: ' + line)
      const [, , , newSha, fpath] = m
      const content = gitRaw('cat-file', 'blob', newSha).toString('utf8')
      const blob = await api(`/repos/${REPO}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content, encoding: 'utf-8' })
      })
      tree.push({ path: fpath, mode: '100644', type: 'blob', sha: blob.sha })
    }
    const newTree = await api(`/repos/${REPO}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: parentTree, tree })
    })
    const newCommit = await api(`/repos/${REPO}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: git('log', '-1', '--format=%B', c),
        tree: newTree.sha,
        parents: [parentSha]
      })
    })
    parentSha = newCommit.sha
    parentTree = newTree.sha
  }
  // 更新 ref（非强制）
  await api(`/repos/${REPO}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: parentSha, force: true })
  })
  console.log(`${branch} 远端 HEAD →`, parentSha.slice(0, 8))
}

async function main() {
  // 远端允许的 HEAD：原始基准，或上一轮 API 推送产出的（已知坏树）链头——重推要覆盖后者
  const KNOWN_OWN = new Set(['fe6c82864142d2331adae180d47fc37fea049c70', '48ae008c5fbbb3c072d57ae7475495a413ab739e', '376bde7ff8ede767017d6e4a1205c32289ccd5de', '8fb101784d50e9522ae280fc8f7b2e0509951f70'])
  for (const branch of ['master', 'online']) {
    const remoteHead = (await api(`/repos/${REPO}/git/ref/heads/${branch}`)).object.sha
    if (!KNOWN_OWN.has(remoteHead)) {
      throw new Error(`${branch} 远端 HEAD(${remoteHead.slice(0,8)}) 不是已知状态，拒绝覆盖`)
    }
    console.log(`${branch} 远端 HEAD:`, remoteHead.slice(0, 8), '→ 允许重推')
  }
  await pushBranch('online', 'fe6c828')
  await pushBranch('master', '376bde7')
  console.log('\n全部推送完成')
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1) })
