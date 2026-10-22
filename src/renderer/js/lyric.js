'use strict'
/* LRC 歌词解析 */

/**
 * 解析 lrc 文本 → { lines: [{t, text}], meta: {ti, ar, al, by, offset}, plain: bool }
 * 支持：一行多时间戳 [00:12.34][01:20.00]词、[offset:+200]、[ti:]/[ar:]/[al:]
 */
function parseLrc(text) {
  const meta = {}
  const lines = []
  let offsetMs = 0
  let tagged = 0

  const raw = String(text || '').replace(/\r\n?/g, '\n')
  const rows = raw.split('\n')

  for (const row of rows) {
    const line = row.trim()
    if (!line) continue

    // 元信息标签 [ti:xxx]
    const metaMatch = /^\[(ti|ar|al|by|offset|tool|re|ve):(.*)\]$/i.exec(line)
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase()
      const val = metaMatch[2].trim()
      if (key === 'offset') {
        const n = parseInt(val, 10)
        if (!Number.isNaN(n)) offsetMs = n
      } else {
        meta[key] = val
      }
      continue
    }

    // 时间戳 [mm:ss.xx] 或 [mm:ss:xx]
    const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
    const stamps = []
    let m
    let lastEnd = 0
    while ((m = timeRe.exec(line))) {
      if (m.index !== lastEnd) break
      lastEnd = timeRe.lastIndex
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      let ms = 0
      if (m[3]) ms = parseInt(m[3].padEnd(3, '0').slice(0, 3), 10)
      stamps.push(min * 60 + sec + ms / 1000)
      tagged++
    }
    if (!stamps.length) {
      // 纯文本行（无时间戳）→ 作为普通歌词，后续整体按纯文本处理
      lines.push({ t: null, text: line })
      continue
    }
    const content = line.slice(lastEnd).trim()
    for (const t of stamps) {
      lines.push({ t, text: content || '♪' })
    }
  }

  const timed = lines.filter((l) => l.t != null)
  const plain = timed.length === 0
  const out = (plain ? lines : timed).map((l) => ({
    t: l.t != null ? Math.max(0, l.t - offsetMs / 1000) : null,
    text: l.text
  }))
  if (!plain) out.sort((a, b) => a.t - b.t)
  return { lines: out, meta, plain, count: out.length }
}

/** 二分查找当前行索引 */
function findLineIndex(lines, curSec) {
  if (!lines.length) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const t = lines[mid].t
    if (t == null) { lo = mid + 1; continue }
    if (t <= curSec + 1e-4) { ans = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  return ans
}
