'use strict'
/**
 * 青听音源清单（music.json）的解析与档位规划 —— 纯函数，不碰网络/文件，便于单测。
 *
 * 上游发布的那种文件长这样：先一段 @name/@version 的 **JS 块注释**，后面才是 JSON 正文。
 * 所以 JSON.parse 之前必须先剥注释，否则整份清单直接解析失败（这是最容易踩的一脚）。
 *
 * 清单只声明「有哪几条线、每条线支持哪些音质档」，它不含任何接口地址：
 * searchApi / detailApi 是青听客户端内部的 JS 函数名，不是 HTTP 端点，对我们没有意义。
 * 真正能不能解析，取决于我们的适配器 + 网关实测，因此这里只做两件事：
 *   ① 把清单收敛成「我们支持且上游启用」的线路集合；
 *   ② 把 levels 排成一条从高到低的尝试链。
 */

/** 清单地址：主 → 备 → 官方 README 里写的 .vip（三份实测内容一致，互为冗余） */
const MANIFEST_URLS = [
  'https://13413.kstore.space/QingMusic/music.json',
  'https://musicapi.haitangw.net/music.json',
  'https://13413.kstore.vip/QingMusic/music.json'
]

/**
 * 清单 id → 播放器内部 source key（**可搜索 + 可解析**）。
 * 清单管腾讯叫 tx，我们从洛雪那一套沿用 qq；其余三家同名。
 * bili / mg 不在表里也不在下面那张表里 = 网关没有这条线路，一律不显示。
 */
const ADAPTERS = { kw: 'kw', kg: 'kg', wy: 'wy', tx: 'qq', qq: 'qq' }

/**
 * 只能解析、不能搜索的线路（v3.3.80）。
 *
 * 汽水（qs）：网关只对它放行「按 id 换直链」，而青听网关**没有搜索端点**
 * （试过 music/search、gateway/search、v2/music/search 等 12 条路径，全 404），
 * 汽水官方 luna 接口又要登录态。所以它进不了搜索源列表 —— 放进去就是
 * 「筛选里有一条，搜了永远零结果」。它的入口是「粘贴分享链接」。
 */
const RESOLVE_ONLY = { qs: 'qs' }

/**
 * 线路优先级。**不照抄清单顺序**（清单是 kw/kg/wy/tx/...）：
 * 网易的公开搜索索引里热门版权歌原唱基本搜不到，实测排前面会拖慢且换错人，所以压末位。
 */
const PRIORITY = ['kw', 'qq', 'kg', 'wy']

/** 清单一次都没拉到过时的兜底：等价于本地 v1.0 配置里我们适配过的那 4 条线 + 汽水 */
const FALLBACK_LINES = [
  { id: 'kw', name: '小窝源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'atmos', 'atmos_plus', 'master'] },
  { id: 'kg', name: '小狗源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'hires', 'atmos', 'clear'] },
  { id: 'wy', name: '小云源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'hires', 'sky', 'jyeffect', 'jymaster'] },
  { id: 'tx', name: '小Q源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'sur', 'jymaster'] },
  { id: 'qs', name: '汽水源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'hires', 'atmos'] }
]

/** 母带/臻品档：目标最高档，排第一梯队 */
const MASTER_LEVELS = new Set(['master', 'jymaster', 'clear'])
const HIRES_LEVELS = new Set(['hires'])
const LOSSLESS_LEVELS = new Set(['lossless'])
/**
 * 沉浸声/环绕声：容器实测同样是 flac（magic 664c6143），但码率不一定过 700k，
 * 且部分档走中转（kw 的 atmos 走 kwstream），所以只当最后兜底，不占无损梯队的位置。
 */
const IMMERSIVE_LEVELS = new Set(['atmos_plus', 'sky', 'sur', 'jyeffect', 'atmos'])
/**
 * 沉浸梯队内部排序：实测容量 atmos_plus 80MB > sky 98MB(网易) > sur 80MB > jyeffect > atmos 31MB，
 * 这里把明显更小的 atmos 压到最后，其余按这个固定序（清单里的顺序是 atmos 在前，照抄反而先拿差的）。
 */
const IMMERSIVE_ORDER = ['atmos_plus', 'sky', 'sur', 'jyeffect', 'atmos']

/** 剥掉上游塞在 JSON 前面的块注释（可能不止一段） */
function stripHeader(text) {
  let s = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim()
  for (let i = 0; i < 4; i++) {
    const m = /^\/\*[\s\S]*?\*\//.exec(s)
    if (!m) break
    s = s.slice(m[0].length).trim()
  }
  return s
}

/**
 * 解析清单文本 → { version, lines: [{ id, name, enabled, levels }] }
 * 结构不对就抛错，由调用方决定「用缓存还是用兜底」——绝不返回半个清单。
 */
function parseManifest(text) {
  const body = stripHeader(text)
  if (!body) throw new Error('manifest.empty')
  const json = JSON.parse(body)
  if (!json || !Array.isArray(json.lines)) throw new Error('manifest.lines')
  const lines = []
  for (const line of json.lines) {
    if (!line || typeof line.id !== 'string' || !line.id) continue
    const levels = Array.isArray(line.levels)
      ? line.levels.filter((l) => typeof l === 'string' && l)
      : []
    lines.push({
      id: line.id,
      name: String(line.name || line.id),
      // 上游用 enabled:false 下线一条线；缺省视为启用
      enabled: line.enabled !== false,
      levels
    })
  }
  if (!lines.length) throw new Error('manifest.emptyLines')
  const ver = /@version\s+([0-9A-Za-z.]+)/.exec(String(text))
  return { version: ver ? ver[1] : '', lines }
}

function sortImmersive(levels) {
  const rank = (l) => {
    const i = IMMERSIVE_ORDER.indexOf(l)
    return i === -1 ? IMMERSIVE_ORDER.length : i
  }
  return levels.slice().sort((a, b) => rank(a) - rank(b))
}

function uniq(list) {
  const seen = new Set()
  const out = []
  for (const x of list) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

/**
 * 个别线路的档位语义和通用分类不一致，按源覆盖顺序（v3.3.80）。
 *
 * 汽水：实测同一首 238 秒的歌 —— lossless 45.6MB(≈1530kbps) > hires 9.2MB(≈310kbps)
 * > standard 1.9MB。它的 hires 不是「高于无损」，只是高码率有损；照通用规则
 * 「hires 排在 lossless 前面」会先拿 9MB 的有损当无损。所以汽水固定 lossless 打头。
 */
const SOURCE_LEVEL_ORDER = {
  qs: ['lossless', 'hires', 'atmos', 'exhigh', 'standard']
}

/**
 * 由清单的 levels 生成尝试链。母带优先、沉浸声兜底；有损档（exhigh/standard/…）永不进链
 * —— 这条链路对外一律承诺「无损」，混进 320k 就成了骗界面。
 *
 * prefer='master'  ：master → hires → lossless → 沉浸
 * prefer='lossless'：lossless → hires → master → 沉浸（能拿更好的就拿，但至少无损）
 * 其它 prefer 返回空数组（不走青听）。
 *
 * source 传了且命中 SOURCE_LEVEL_ORDER 时，按该源的固定顺序取「无损及以上」的档，
 * 不再套通用分组（汽水的 hires/lossless 高低是反的）。
 */
function buildLevelChain(levels, prefer, source) {
  const list = Array.isArray(levels) ? levels.filter((l) => typeof l === 'string' && l) : []
  if (!list.length) return []
  if (prefer !== 'master' && prefer !== 'lossless') return []
  const fixed = SOURCE_LEVEL_ORDER[source]
  if (fixed) {
    // 只留「无损及以上」：有损档（exhigh/standard）不出现在这条链路里
    const keep = new Set([...MASTER_LEVELS, ...HIRES_LEVELS, ...LOSSLESS_LEVELS, ...IMMERSIVE_LEVELS])
    return fixed.filter((l) => list.includes(l) && keep.has(l))
  }
  const master = list.filter((l) => MASTER_LEVELS.has(l))
  const hires = list.filter((l) => HIRES_LEVELS.has(l))
  const loss = list.filter((l) => LOSSLESS_LEVELS.has(l))
  const imm = sortImmersive(list.filter((l) => IMMERSIVE_LEVELS.has(l)))
  if (prefer === 'master') return uniq([...master, ...hires, ...loss, ...imm])
  return uniq([...loss, ...hires, ...master, ...imm])
}

/**
 * 清单 → 实际生效的线路集合。
 * 规则：上游 enabled 才算启用；没有适配器的线（qs/bili/mg）直接丢；顺序按 PRIORITY。
 * 若收敛后一条都不剩（上游全关 / 清单结构变了），退回 FALLBACK，绝不让播放器变成没音源。
 */
function planManifest(raw) {
  const hasRaw = !!(raw && Array.isArray(raw.lines) && raw.lines.length)
  const src = hasRaw ? raw.lines : FALLBACK_LINES
  const bySource = new Map()      // 可搜索源
  const byResolve = new Map()     // 只解析源（汽水）
  for (const line of src) {
    if (!line || line.enabled === false) continue
    const entry = { source: '', id: line.id, name: String(line.name || line.id), levels: (line.levels || []).slice() }
    const source = ADAPTERS[line.id]
    if (source) {
      if (bySource.has(source)) continue
      bySource.set(source, { ...entry, source })
      continue
    }
    const ro = RESOLVE_ONLY[line.id]
    if (ro && !byResolve.has(ro)) byResolve.set(ro, { ...entry, source: ro })
  }
  let order = PRIORITY.filter((s) => bySource.has(s))
  if (!order.length) {
    // 上游全关 / 清单结构变了：退回兜底，绝不让播放器变成没音源
    for (const line of FALLBACK_LINES) {
      const source = ADAPTERS[line.id]
      if (!source || bySource.has(source)) continue
      bySource.set(source, { source, id: line.id, name: line.name, levels: line.levels.slice() })
    }
    order = PRIORITY.filter((s) => bySource.has(s))
  }
  const resolveOnly = Array.from(byResolve.values())
  const lines = order.map((s) => bySource.get(s))
  const levelsBySource = {}
  for (const line of lines) levelsBySource[line.source] = line.levels
  // 只解析源也要有档位链，否则「粘贴链接播放」拿不到无损
  for (const line of resolveOnly) levelsBySource[line.source] = line.levels
  return {
    order,
    lines,
    resolveOnly,
    levelsBySource,
    version: hasRaw ? String(raw.version || '') : '',
    fromFallback: !hasRaw
  }
}

module.exports = {
  MANIFEST_URLS,
  ADAPTERS,
  RESOLVE_ONLY,
  PRIORITY,
  FALLBACK_LINES,
  IMMERSIVE_ORDER,
  SOURCE_LEVEL_ORDER,
  stripHeader,
  parseManifest,
  buildLevelChain,
  planManifest
}
