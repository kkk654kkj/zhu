'use strict'
/**
 * 极简持久化存储：JSON 文件 + 去抖原子写入。
 * 数据量大时（库缓存）单独走 library.json，避免每次播放都重写全量。
 */
const fs = require('fs')
const path = require('path')

/**
 * 设置文件结构版本。改动「设置键的名字/结构/默认值语义」时 +1，
 * 并在 Store._migrate 里补一段迁移。
 *
 * 为什么必须有：deepMerge 只会增/覆盖，不会删。没有版本号时，
 * 老 data 里被废弃的键会永远留着并继续参与合并，改默认值也不生效。
 */
const SCHEMA_VERSION = 1

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch
  if (typeof patch !== 'object' || patch === null) return patch === undefined ? base : patch
  const out = { ...base }
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k])
  return out
}

class Store {
  constructor(file, defaults, opts = {}) {
    this.file = file
    this.defaults = defaults
    this.data = JSON.parse(JSON.stringify(defaults))
    this._timer = null
    this._loading = true
    this._needsFlush = false
    this.onError = opts.onError || ((msg) => console.error(msg))
    this.load()
    this._loading = false
    // 迁移过就立刻落盘一次，避免每次启动都重跑迁移
    if (this._needsFlush) this.flush()
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8')
        const parsed = JSON.parse(raw)
        // v3.3.10：顶层必须是普通对象 —— 合法 JSON 但顶层是数组/原始值时
        // （磁盘损坏/误编辑），deepMerge 会把它整体当数据，之后一次 patch
        // 就把 settings/playlists 全部清空并写回固化
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('顶层结构损坏（非对象）')
        }
        this.data = deepMerge(JSON.parse(JSON.stringify(this.defaults)), parsed)
        this._migrate(parsed)
      } else {
        this.data._v = SCHEMA_VERSION
      }
    } catch (err) {
      console.error('[store] 读取失败，使用默认值:', err.message)
      this.data = JSON.parse(JSON.stringify(this.defaults))
      this.data._v = SCHEMA_VERSION
    }
  }

  /**
   * 结构迁移。from 取自文件里的 _v（缺失视为 0）。
   * 每次给 SCHEMA_VERSION 加一的同时，在下面补一段 `if (from < N) { ... }`。
   */
  _migrate(parsed) {
    const from = Number(parsed && parsed._v) || 0
    if (from >= SCHEMA_VERSION) {
      this.data._v = SCHEMA_VERSION
      return
    }
    if (from < 1) {
      // v0 → v1：只是引入版本号本身，历史数据无需搬迁。
      // 这里可以删除早期实验字段，例如：delete this.data.settings.someOldKey
    }
    this.data._v = SCHEMA_VERSION
    this._needsFlush = true
  }

  get() {
    return this.data
  }

  patch(partial) {
    this.data = deepMerge(this.data, partial)
    this.save()
    return this.data
  }

  replace(next) {
    this.data = next
    this.save()
    return this.data
  }

  /** 顶层键整体替换（不走 deepMerge —— session 这类「整体换」的数据不能留旧键） */
  setKey(key, value) {
    this.data[key] = value
    this.save()
    return this.data
  }

  save() {
    if (this._loading) return
    clearTimeout(this._timer)
    this._timer = setTimeout(() => this._flush(), 250)
  }

  flush() {
    clearTimeout(this._timer)
    this._flush()
  }

  _flush() {
    let fd = null
    let wrote = false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fd = fs.openSync(tmp, 'w')
      // v3.3.13：writeSync 可能短写；writeFileSync(fd,...) 会循环写满
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      wrote = true
      fs.renameSync(tmp, this.file)
    } catch (err) {
      if (fd) { try { fs.closeSync(fd) } catch (e) {} }
      this.onError('[store] 写入失败: ' + err.message)
      // v3.3.13：rename 失败时 tmp 是「已写完并 fsync 的完整新数据」，不能删；
      // 只有写入阶段失败才清理残件
      if (!wrote) { try { fs.unlinkSync(this.file + '.tmp') } catch (e) { /* 忽略 */ } }
    }
  }
}

module.exports = { Store, deepMerge }
