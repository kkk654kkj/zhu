'use strict'
/* LRC 歌词解析 */

/** 单行最大字符数：病态超长行会让「时间戳循环 + 反复 slice」退化成 O(n²)，先截断 */
const MAX_LRC_LINE = 2000

/**
 * v2.8.42：制作信息 / 版权信息行。
 * 大量 lrc 会把「词：xx / 曲：xx / 编曲：xx / 制作人：xx」塞上 0~7 秒的时间戳，
 * 于是开头几秒歌词疯狂滚动、人声还没进来就已经"唱"完了 —— 用户看到的就是
 * 「歌词比音乐快」。这类行解析时打标记，渲染层不让它们参与同步与居中。
 * 只认「短前缀 + 冒号」的写法，避免把歌词里正常的句子误判（如「他说：别走」）。
 */
const CREDIT_WORDS = [
  '作词', '作曲', '编曲', '制作人', '监制', '混音', '母带', '吉他', '贝斯', '鼓', '键盘',
  '和声', '和音', '录音', '录音师', '出品', '发行', '统筹', '企划', '宣发', '宣传', '设计',
  '配唱', '制作助理', '人声', '弦乐', '钢琴', '小提琴', '大提琴', '长笛', '萨克斯', '口琴',
  '二胡', '古筝', '琵琶', '笛子', '合成器', '录音室', '录音棚', '混音室', '母带室',
  '原唱', '翻唱', '演唱', '词曲'
]
/** 单字/缩写前缀：必须整段相等才算，避免「台词：」「插曲：」被误吃 */
const CREDIT_SHORT = new Set(['词', '曲', '鼓', 'OP', 'SP'])

/** 英文制作信息：Produced by / Written by / Mixed : … （必须带 by 或冒号，避免误伤歌词） */
const CREDIT_EN_RE = /^(produced|written|composed|arranged|mixed|mastered|recorded|lyrics?|music|vocals?|guitar|bass|drums|piano|strings|engineer|producer|composer|arranger|programmed)\b\s*(by\b|[:：])/i

/** 是否属于「制作信息 / 版权信息」行（短前缀 + 冒号，或英文 Produced by 这类） */
function isCreditLine(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 48) return false
  // 中文：取冒号前那一小段（≤12 字），含制作类词就算。
  // 这样「混音/母带：徐伊豆」「词曲：某某」这类复合写法也能命中。
  const m = /^([^:：]{1,12})\s*[:：]/.exec(t)
  if (m) {
    const head = m[1].replace(/\s+/g, '')
    if (CREDIT_SHORT.has(head)) return true
    if (head.length <= 12 && CREDIT_WORDS.some((w) => head.includes(w))) return true
  }
  return CREDIT_EN_RE.test(t)
}

/**
 * 解析 lrc 文本 → { lines: [{t, text, credit, skip}], meta, plain, count, sync }
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
    // v3.3.10：let —— 元信息行去掉头部标签后，剩余部分还要继续按时间戳行处理
    let line = row.trim()
    if (!line) continue
    // v3.3.13：病态超长行先截断，避免后续正则循环 + 反复 slice 退化成 O(n²)
    if (line.length > MAX_LRC_LINE) line = line.slice(0, MAX_LRC_LINE)

    // 元信息标签 [ti:xxx]
    // v3.3.9：去掉结尾锚 —— `[ti:标题] 备注` 这种行以前被当纯文本丢掉
    // v3.3.10：值域改 [^\\]]* —— 以前 (.*) 贪婪到行尾最后一个 ]，
    // `[ar:x] [00:12]词` 会把同行歌词整行吞掉
    // v3.3.13：循环剥掉行首所有元信息标签（[ti:x][ar:y] 是常见写法），
    // 余下内容只有带合法时间戳才算歌词，备注/多标签残片不能混进纯文本歌词
    let hadMeta = false
    const metaRe = /^\[(ti|ar|al|by|offset|tool|re|ve):([^\]]*)\]\s*/i
    for (;;) {
      const mm = metaRe.exec(line)
      if (!mm) break
      hadMeta = true
      const key = mm[1].toLowerCase()
      const val = mm[2].trim()
      if (key === 'offset') {
        const n = parseInt(val, 10)
        if (!Number.isNaN(n)) offsetMs = n
      } else {
        meta[key] = val
      }
      line = line.slice(mm[0].length).trim()
    }
    if (!line) continue

    // 时间戳 [mm:ss.xx] 或 [mm:ss:xx]
    const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
    const stamps = []
    let m
    let lastEnd = 0
    while ((m = timeRe.exec(line))) {
      // v3.3.9：时间戳之间允许空白 —— `[00:10.00] [00:20.00]词` 这种真实写法
      // 以前第二个时间戳起全部失效，原始标签文本还混进歌词里
      if (line.slice(lastEnd, m.index).trim()) break
      lastEnd = timeRe.lastIndex
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      let ms = 0
      if (m[3]) ms = parseInt(m[3].padEnd(3, '0').slice(0, 3), 10)
      stamps.push(min * 60 + sec + ms / 1000)
      tagged++
    }
    if (!stamps.length) {
      if (hadMeta) continue
      // 纯文本行（无时间戳）→ 作为普通歌词，后续整体按纯文本处理
      lines.push({ t: null, text: line, credit: isCreditLine(line) })
      continue
    }
    const content = line.slice(lastEnd).trim()

    // v3.3.27（追加清单 #2）：A2 增强歌词的词内时间标签 <mm:ss.xxx> 或 <start,end>。
    // ≥2 个标签才当逐字行（单个标签无意义），否则按整句处理（降级）。
    // 词文本 = 本标签到下一标签之间；词尾缺省时由渲染层用下一词起点推。
    let words = null
    if (/<\d{1,3}:\d{1,2}/.test(content)) {
      const wordRe = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?(?:,(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?)?>/g
      const wm = []
      let wm2
      while ((wm2 = wordRe.exec(content))) wm.push(wm2)
      if (wm.length >= 2) {
        const toSec = (mm) => {
          const min = parseInt(mm[1], 10)
          const sec = parseInt(mm[2], 10)
          const frac = mm[3] ? parseInt(mm[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0
          return min * 60 + sec + frac
        }
        words = []
        for (let i = 0; i < wm.length; i++) {
          const st = toSec(wm[i])
          const en = wm[i][4] != null ? toSec([, wm[i][4], wm[i][5], wm[i][6]]) : null
          const text = content.slice(wm[i].index + wm[i][0].length, i + 1 < wm.length ? wm[i + 1].index : content.length)
            .replace(/<[^>]*$/, '').trim()
          if (text) words.push({ t: st, e: en, text })
        }
        if (words.length < 2) words = null
      }
    }

    for (const t of stamps) {
      const body = words ? words.map((w) => w.text).join('') || '♪' : (content || '♪')
      const credit = isCreditLine(body)
      lines.push({ t, text: body, words, credit })
    }
  }

  const timed = lines.filter((l) => l.t != null)
  const plain = timed.length === 0
  const out = (plain ? lines : timed).map((l) => ({
    t: l.t != null ? Math.max(0, l.t - offsetMs / 1000) : null,
    text: l.text,
    words: l.words || null,
    credit: !!l.credit
  }))
  if (!plain) out.sort((a, b) => a.t - b.t)

  /* v2.8.42 同步体检：
     - 开头连续 ≥3 行制作信息、且总跨度 ≤12 秒 → 判定为「被硬塞时间戳的名单」，
       整段标 skip（渲染层不让它们抢高亮、不触发居中滚动）
     - 顺带算出 firstVocal / lastTs / dense，供 UI 做「歌词只到 xx:xx」这类提示 */
  const timedOut = out.filter((l) => l.t != null)
  const headCredits = []
  for (const l of timedOut) {
    if (l.t > 15) break
    // 首行常常是「歌名 - 歌手」（[00:00.00]Dear D (甜蜜版) - 项睿娴），
    // 它不是歌词，跟着制作信息一起跳过；只在「第一行」上放宽，避免误伤正文
    const titleLike = headCredits.length === 0 && l.t < 1.5 &&
      typeof l.text === 'string' && l.text.length <= 60 && /^.+?\s+[-–—]\s+.+$/.test(l.text.trim())
    if (l.credit || titleLike) { headCredits.push(l); continue }
    break
  }
  let creditSkip = false
  if (headCredits.length >= 3) {
    const span = headCredits[headCredits.length - 1].t - headCredits[0].t
    if (span <= 12) {
      creditSkip = true
      for (const l of headCredits) l.skip = true
    }
  }
  let dense = 0
  for (let i = 1; i < timedOut.length; i++) {
    if (timedOut[i].t - timedOut[i - 1].t < 0.25) dense++
  }
  const firstVocalLine = timedOut.find((l) => !l.skip)
  const sync = {
    creditLines: out.filter((l) => l.credit && l.t != null).length,
    creditSkip,
    firstVocal: firstVocalLine ? firstVocalLine.t : null,
    lastTs: timedOut.length ? timedOut[timedOut.length - 1].t : null,
    dense
  }
  return { lines: out, meta, plain, count: out.length, sync }
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
