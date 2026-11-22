'use strict'
const dns = require('dns')
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
 * 单个 IP 字面量是否属于「不该由播放器主动连接」的网段。
 * v3.3.77（P2-6/P2-8/P2-9）：以前只判 IPv4，IPv6 一律当私有（公网 v6 也取不到封面），
 * 域名完全不判（直链 / 封面 / mpv 三处都只看字面量）。现在统一到这一个函数：
 * IPv4 私网/回环/链路本地/CGNAT/组播保留，IPv6 的 ::1、ULA、link-local、组播、
 * 文档段、v4-mapped，都算私有。
 * @param {string} ip
 */
function isPrivateAddress(ip) {
  const h = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a > 255 || b > 255) return true
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true            // link-local
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT
    if (a >= 224) return true                          // 组播 / 保留
    return false
  }
  if (h.indexOf(':') < 0) return false
  if (h === '::' || h === '::1') return true
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)
  if (mapped) return isPrivateAddress(mapped[1])
  const head = h.split(':')[0]
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true     // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true      // fe80::/10 (link-local)
  if (/^ff[0-9a-f]{0,2}$/.test(head)) return true        // 组播
  if (/^2001:0?db8(:|$)/.test(h)) return true            // 文档示例段
  return false
}

/**
 * 内网 / 回环地址判定（只用于「别让渲染层借主进程去打内网」这类盲 SSRF 防护）。
 * 只认字面量、不做 DNS 解析；需要连真实连接前的解析后校验，用 checkUrlAllowed。
 * @param {string} host
 */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) return isPrivateAddress(h)
  if (h.indexOf(':') >= 0) return isPrivateAddress(h)
  return false
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * 真正发起连接前的地址闸门：协议只允许 http/https，字面量走私网表，
 * 域名先 DNS 解析、再逐地址过私网表（解析失败按拒绝处理）。
 * v3.3.77（P2-6/P2-8/P2-9）：以前取流与下载对 info.url 零校验、封面只校验初始 host、
 * mpv 只看 IPv4 字面量 —— 域名解析到 127.0.0.1 / 169.254.169.254 时全部漏过。
 * @param {string} rawUrl
 * @param {{allowLoopback?:boolean}} [opts] 本机代理场景允许回环
 * @returns {Promise<{ok:boolean, reason?:string, host?:string}>}
 */
async function checkUrlAllowed(rawUrl, opts) {
  const o = opts || {}
  let url = null
  try { url = new URL(String(rawUrl || '')) } catch (e) { return { ok: false, reason: 'bad-url' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'bad-protocol' }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return { ok: false, reason: 'no-host' }
  if (LOOPBACK_HOSTS.has(host) || host === '::1') {
    return o.allowLoopback ? { ok: true, host } : { ok: false, reason: 'loopback' }
  }
  if (isPrivateHost(host)) return { ok: false, reason: 'private-host: ' + host }
  let addrs = []
  try { addrs = await dns.promises.lookup(host, { all: true }) } catch (e) { return { ok: false, reason: 'dns-fail: ' + host } }
  if (!addrs.length) return { ok: false, reason: 'dns-empty: ' + host }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) return { ok: false, reason: 'private-ip: ' + a.address }
  }
  return { ok: true, host }
}

/* 单测接缝：把上游落在 127.0.0.1 的桩服务器放行，才能验「闸门拒绝」之外的正向路径。
   只在进程内可改，渲染层/IPC 触达不到。 */
let urlGuardImpl = checkUrlAllowed
function __setUrlGuard(fn) { urlGuardImpl = typeof fn === 'function' ? fn : checkUrlAllowed }

/**
 * v3.3.77（P2-6/P2-8/P2-9）：带地址闸门的 fetch。
 * 每一跳都过 checkUrlAllowed，并手动跟随跳转 —— follow 模式下第二跳的地址我们
 * 根本看不到，等于一次 302 就能绕过校验。
 * @param {string} rawUrl
 * @param {object} [opts] fetch 选项（headers / signal 等）
 * @param {{maxHops?:number, allowLoopback?:boolean}} [cfg]
 */
async function fetchSafe(rawUrl, opts, cfg) {
  const o = cfg || {}
  const maxHops = Number.isInteger(o.maxHops) ? o.maxHops : 5
  let cur = String(rawUrl)
  for (let hop = 0; hop <= maxHops; hop++) {
    const chk = await urlGuardImpl(cur, { allowLoopback: o.allowLoopback === true })
    if (!chk.ok) {
      const err = new Error('blocked: ' + chk.reason)
      err.name = 'BlockedUrlError'
      throw err
    }
    const res = await fetch(cur, Object.assign({}, opts || {}, { redirect: 'manual' }))
    if (res.status >= 300 && res.status < 400) {
      const loc = (res.headers && res.headers.get && res.headers.get('location')) || ''
      try { Promise.resolve(res.body && res.body.cancel()).catch(() => {}) } catch (e) { /* 忽略 */ }
      if (!loc) {
        const err = new Error('blocked: redirect without location')
        err.name = 'BlockedUrlError'
        throw err
      }
      cur = new URL(loc, cur).href
      continue
    }
    return res
  }
  const err = new Error('blocked: too many redirects')
  err.name = 'BlockedUrlError'
  throw err
}

module.exports = {
  buildUpstreamHeaders, isPrivateHost, isPrivateAddress, checkUrlAllowed, fetchSafe,
  __setUrlGuard, HOP_HEADER
}