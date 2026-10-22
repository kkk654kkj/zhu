'use strict'
/**
 * 极简持久化存储：JSON 文件 + 去抖原子写入。
 * 数据量大时（库缓存）单独走 library.json，避免每次播放都重写全量。
 */
const fs = require('fs')
const path = require('path')

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch
  if (typeof patch !== 'object' || patch === null) return patch === undefined ? base : patch
  const out = { ...base }
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k])
  return out
}

class Store {
  constructor(file, defaults) {
    this.file = file
    this.defaults = defaults
    this.data = JSON.parse(JSON.stringify(defaults))
    this._timer = null
    this._loading = true
    this.load()
    this._loading = false
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8')
        const parsed = JSON.parse(raw)
        this.data = deepMerge(JSON.parse(JSON.stringify(this.defaults)), parsed)
      }
    } catch (err) {
      console.error('[store] 读取失败，使用默认值:', err.message)
      this.data = JSON.parse(JSON.stringify(this.defaults))
    }
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
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[store] 写入失败:', err.message)
    }
  }
}

module.exports = { Store, deepMerge }
