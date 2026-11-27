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
 * 清单 id → 播放器内部 source key。
 * 清单管腾讯叫 tx，我们从洛雪那一套沿用 qq；其余三家同名。
 * qs（汽水）/ bili / mg 不在表里 = 没有适配器，一律不显示。
 */
const ADAPTERS = { kw: 'kw', kg: 'kg', wy: 'wy', tx: 'qq', qq: 'qq' }

/**
 * 线路优先级。**不照抄清单顺序**（清单是 kw/kg/wy/tx/...）：
 * 网易的公开搜索索引里热门版权歌原唱基本搜不到，实测排前面会拖慢且换错人，所以压末位。
 */
const PRIORITY = ['kw', 'qq', 'kg', 'wy']

/** 清单一次都没拉到过时的兜底：等价于本地 v1.0 配置里我们适配过的那 4 条线 */
const FALLBACK_LINES = [
  { id: 'kw', name: '小窝源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'atmos', 'atmos_plus', 'master'] },
  { id: 'kg', name: '小狗源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'hires', 'atmos', 'clear'] },
  { id: 'wy', name: '小云源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'hires', 'sky', 'jyeffect', 'jymaster'] },
  { id: 'tx', name: '小Q源', enabled: true, levels: ['standard', 'exhigh', 'lossless', 'sur', 'jymaster'] }
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
 * 由清单的 levels 生成尝试链。母带优先、沉浸声兜底；有损档（exhigh/standard/…）永不进链
 * —— 这条链路对外一律承诺「无损」，混进 320k 就成了骗界面。
 *
 * prefer='master'  ：master → hires → lossless → 沉浸
 * prefer='lossless'：lossless → hires → master → 沉浸（能拿更好的就拿，但至少无损）
 * 其它 prefer 返回空数组（不走青听）。
 */
function buildLevelChain(levels, prefer) {
  const list = Array.isArray(levels) ? levels.filter((l) => typeof l === 'string' && l) : []
  if (!list.length) return []
  const master = list.filter((l) => MASTER_LEVELS.has(l))
  const hires = list.filter((l) => HIRES_LEVELS.has(l))
  const loss = list.filter((l) => LOSSLESS_LEVELS.has(l))
  const imm = sortImmersive(list.filter((l) => IMMERSIVE_LEVELS.has(l)))
  if (prefer === 'master') return uniq([...master, ...hires, ...loss, ...imm])
  if (prefer === 'lossless') return uniq([...loss, ...hires, ...master, ...imm])
  return []
}

/**
 * 清单 → 实际生效的线路集合。
 * 规则：上游 enabled 才算启用；没有适配器的线（qs/bili/mg）直接丢；顺序按 PRIORITY。
 * 若收敛后一条都不剩（上游全关 / 清单结构变了），退回 FALLBACK，绝不让播放器变成没音源。
 */
function planManifest(raw) {
  const hasRaw = !!(raw && Array.isArray(raw.lines) && raw.lines.length)
  const src = hasRaw ? raw.lines : FALLBACK_LINES
  const bySource = new Map()
  for (const line of src) {
    if (!line || line.enabled === false) continue
    const source = ADAPTERS[line.id]
    if (!source) continue
    if (bySource.has(source)) continue
    bySource.set(source, { source, id: line.id, name: String(line.name || line.id), levels: (line.levels || []).slice() })
  }
  let order = PRIORITY.filter((s) => bySource.has(s))
  if (!order.length) {
    for (const line of FALLBACK_LINES) {
      if (bySource.has(ADAPTERS[line.id])) continue
      bySource.set(ADAPTERS[line.id], { source: ADAPTERS[line.id], id: line.id, name: line.name, levels: line.levels.slice() })
    }
    order = PRIORITY.filter((s) => bySource.has(s))
  }
  const lines = order.map((s) => bySource.get(s))
  const levelsBySource = {}
  for (const line of lines) levelsBySource[line.source] = line.levels
  return {
    order,
    lines,
    levelsBySource,
    version: hasRaw ? String(raw.version || '') : '',
    fromFallback: !hasRaw
  }
}

module.exports = {
  MANIFEST_URLS,
  ADAPTERS,
  PRIORITY,
  FALLBACK_LINES,
  IMMERSIVE_ORDER,
  stripHeader,
  parseManifest,
  buildLevelChain,
  planManifest
}
