'use strict'
/**
 * 上游请求头 / 地址的公共小工具（v3.3.66）。
 *
 * 为什么单独抽出来：下载器（downloader.js）和在线取流（streamproxy.js / online.js）
 * 都要把网关给的头合并到自己的请求上。以前三处各写一份，其中两处直接
 * `Object.assign(headers, info.headers)` —— 逐跳头（Host / Content-Length /
 * Connection / Range）被原样透传给 undici，遇到上游回这类头就是 TypeError，
 * 表现为「这首歌下载必失败 / 探测永远超时」。
 *
 * 与 Electron 完全解耦，纯函数，可直接 require。
 */

/** 不能透传给上游的逐跳头（大小写不敏感）；Range 由调用方按需自己补 */
const HOP_HEADER = /^(host|content-length|connection|keep-alive|transfer-encoding|upgrade|proxy-connection|te|trailer|range)$/i

/**
 * 组装上游请求头：默认 UA + 平台要求的 Referer，再合并网关给的附加头。
 * 只收字符串值，逐跳头一律丢弃。
 * @param {{referer?:string, headers?:object}} info
 * @returns {Record<string,string>}
 */
function buildUpstreamHeaders(info) {
  const src = (info && typeof info === 'object') ? info : {}
  const headers = { 'User-Agent': 'Mozilla/5.0' }
  if (typeof src.referer === 'string' && src.referer) headers.Referer = src.referer
  // 有些平台的直链要带它自己指定的头（比如 QQ 的 Cookie/Referer），网关会一起给
  if (src.headers && typeof src.headers === 'object') {
    for (const [k, v] of Object.entries(src.headers)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue
      if (HOP_HEADER.test(k)) continue
      headers[k] = v
    }
  }
  return headers
}

/**
 * 内网 / 回环地址判定（只用于「别让渲染层借主进程去打内网」这类盲 SSRF 防护）。
 * 只认字面量、不做 DNS 解析：解析后的真实 IP 校验属于网络层，不在这里冒充。
 * @param {string} host
 */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true            // link-local
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT
    return false
  }
  if (h.indexOf(':') >= 0) return true                 // IPv6 字面量：公网封面地址极少，宁可不取色
  return false
}

module.exports = { buildUpstreamHeaders, isPrivateHost, HOP_HEADER }