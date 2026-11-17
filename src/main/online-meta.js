'use strict'
/**
 * 在线曲目元数据的纯逻辑（v3.3.64）。
 *
 * 为什么单独一个模块：收藏 / 歌单里的在线曲要把「标题 歌手 时长 原音源」落盘，
 * 重播时靠它重新解析。这段校验与清理逻辑放在 main.js 里只能靠静态断言，
 * 抽出来后 `test/online-fav.mjs` 能真跑一遍 —— 表被写坏（脏 id / 类型漂移）
 * 是这类「顺手存一条记录」的功能最容易出事的地方。
 *
 * 与 Electron 完全解耦：不 require electron，不碰 store。
 */

/** id 的口径必须与渲染层 `Online.toTrack` / `Online.metaOf` 完全一致 */
function metaIdOf(source, songId) {
  return 'on:' + source + ':' + songId
}

/**
 * 探测档位（v3.3.65）：只留展示用的文本 / 配色类 / 悬停提示，限长且 cls 走白名单。
 * 绝不存直链或大对象 —— 这三项只为了让收藏 / 队列列表的「规格」列和在线搜索页一致。
 * @returns {{text:string,cls:string,tip:string}|null}
 */
function sanitizeSpec(sp) {
  if (!sp || typeof sp !== 'object') return null
  const clip = (v, n) => typeof v === 'string' ? v.slice(0, n) : ''
  const cls = clip(sp.cls, 16)
  return {
    text: clip(sp.text, 24),
    cls: ['lossless', 'high', 'ok', 'dim', ''].includes(cls) ? cls : 'dim',
    tip: clip(sp.tip, 160)
  }
}

/**
 * 校验并规范化一条元数据。形不成合法曲目就返回 null（调用方直接跳过）。
 * @param {object} m 渲染层传来的对象（不可信）
 * @returns {object|null}
 */
function sanitizeMeta(m, now) {
  if (!m || typeof m !== 'object') return null
  const source = typeof m.source === 'string' ? m.source.trim() : ''
  const rawId = m.songId
  const songId = (typeof rawId === 'string' || typeof rawId === 'number') ? String(rawId).trim() : ''
  if (!source || !songId) return null
  const id = typeof m.id === 'string' ? m.id : ''
  // id 必须是 on:<source>:<songId>：不做这个校验，一条 id 写错就永久占位、
  // 且 prune 时按 id 判引用，永远对不上，收藏里会留一个点不开的空行
  if (id !== metaIdOf(source, songId)) return null
  return {
    id,
    source,
    songId,
    title: String(m.title == null ? '' : m.title),
    artist: String(m.artist == null ? '' : m.artist),
    album: String(m.album == null ? '' : m.album),
    duration: Number(m.duration) > 0 ? Number(m.duration) : 0,
    cover: typeof m.cover === 'string' ? m.cover : '',
    quality: typeof m.quality === 'string' ? m.quality : '',
    spec: sanitizeSpec(m.spec),
    at: Number(m.at) > 0 ? Number(m.at) : (Number(now) || Date.now())
  }
}

/** 批量校验；坏条目静默丢弃，好条目照收（不能因为一条畸形就整批失败） */
function sanitizeMetas(list, now) {
  const arr = Array.isArray(list) ? list : [list]
  const out = []
  for (const m of arr) {
    const one = sanitizeMeta(m, now)
    if (one) out.push(one)
  }
  return out
}

/**
 * 把一条新元数据合并到旧条目上（v3.3.66）。
 *
 * 为什么不能整条替换：规格列只有「探测完成」时才有值，而收藏 / 加歌单可能在
 * 探测之前就发生 —— 那时 metaOf 落下来的是 spec:null，整条替换会把已经存好的
 * 「母带」洗成「在线」。所以规格只增不减，其余字段仍以新值为准。
 * @returns {object|null}
 */
function mergeMeta(prev, next) {
  if (!next) return prev || null
  const out = Object.assign({}, next)
  if (!out.spec && prev && prev.spec) out.spec = prev.spec
  return out
}

/**
 * 按「仍被引用」清理元数据表。
 *
 * 引用来源只有两个：收藏 id 列表、各歌单的 trackIds。
 * 注意：这里只算「该不该留」，不负责写盘 —— 调用方比对 dropped 后再决定 patch。
 * @returns {{ out: object, dropped: number }}
 */
function pruneToRefs(map, favorites, playlists) {
  if (!map || typeof map !== 'object') return { out: {}, dropped: 0 }
  const keep = new Set(Array.isArray(favorites) ? favorites : [])
  for (const pl of Array.isArray(playlists) ? playlists : []) {
    for (const id of (pl && pl.trackIds) || []) if (typeof id === 'string') keep.add(id)
  }
  const out = {}
  let dropped = 0
  for (const [id, meta] of Object.entries(map)) {
    if (keep.has(id)) out[id] = meta
    else dropped++
  }
  return { out, dropped }
}

module.exports = { metaIdOf, sanitizeMeta, sanitizeMetas, mergeMeta, pruneToRefs }
