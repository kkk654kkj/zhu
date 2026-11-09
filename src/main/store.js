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

/**
 * 合法的顶层数据结构判定：必须是普通对象。
 * 合法 JSON 但顶层是数组/原始值（磁盘损坏、误编辑）时，deepMerge 会把它整体当数据，
 * 之后一次 patch 就把 settings/playlists 全部清空并写回固化 —— 所以每个入口都要挡。
 */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 深拷贝默认值：不能让 this.data 直接持有 defaults 的引用，否则 patch 会污染默认值 */
function cloneDefaults(defaults) {
  return JSON.parse(JSON.stringify(defaults))
}

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch
  if (typeof patch !== 'object' || patch === null) return patch === undefined ? base : patch
  const out = { ...base }
  for (const k of Object.keys(patch)) {
    // v3.3.13：结构化克隆会保留自有 __proto__/constructor/prototype，
    // 直接 out['__proto__']=... 会触发 setter 改写原型（原型污染）。
    // 跳过危险键，并用 defineProperty 赋值彻底绕开任何 setter。
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
    Object.defineProperty(out, k, {
      value: deepMerge(base[k], patch[k]),
      enumerable: true,
      writable: true,
      configurable: true
    })
  }
  return out
}

class Store {
  constructor(file, defaults, opts = {}) {
    this.file = file
    this.defaults = defaults
    this.data = cloneDefaults(defaults)
    this._timer = null
    this._loading = true
    this._needsFlush = false
    // v3.3.13：写盘失败标记与有上限的自动重试（避免死循环）
    this._dirty = false
    this._retries = 0
    this._retryTimer = null
    // tmp 是否已「写完并 fsync」：决定失败时能不能删残件（见 _flush 的失败分支）
    this._tmpComplete = false
    this.onError = opts.onError || ((msg) => console.error(msg))
    this.load()
    this._loading = false
    // 迁移过就立刻落盘一次，避免每次启动都重跑迁移
    if (this._needsFlush) this.flush()
  }

  load() {
    // v3.3.13：上次 rename 失败（Windows 文件被占用）会留下已 fsync 的完整 .tmp，
    // 它比正式文件更新时优先恢复；否则下次 _flush() 用 'w' 打开会覆盖并静默丢数据
    const recovered = this._recoverTmp()
    try {
      let parsed
      if (recovered) parsed = recovered
      else if (fs.existsSync(this.file)) parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed !== undefined) {
        // v3.3.10：顶层必须是普通对象 —— 合法 JSON 但顶层是数组/原始值时
        // （磁盘损坏/误编辑），deepMerge 会把它整体当数据，之后一次 patch
        // 就把 settings/playlists 全部清空并写回固化
        if (!isPlainObject(parsed)) throw new Error('顶层结构损坏（非对象）')
        this.data = deepMerge(cloneDefaults(this.defaults), parsed)
        this._migrate(parsed)
      } else {
        this.data._v = SCHEMA_VERSION
      }
    } catch (err) {
      console.error('[store] 读取失败，使用默认值:', err.message)
      this.data = cloneDefaults(this.defaults)
      this.data._v = SCHEMA_VERSION
    }
  }

  /** 从上次 rename 失败残留的 .tmp 恢复数据；返回可用的顶层对象或 null */
  _recoverTmp() {
    const tmp = this.file + '.tmp'
    let stTmp
    try { stTmp = fs.statSync(tmp) } catch { return null }
    let stFile = null
    try { stFile = fs.statSync(this.file) } catch { /* 正式文件还不存在 */ }
    // 只有 tmp 比正式文件更新才采用，避免用半写入/陈旧的 tmp 覆盖已提交数据
    if (stFile && stTmp.mtimeMs <= stFile.mtimeMs) return null
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'))
    } catch {
      this._quarantineCorruptTmp(tmp)
      return null
    }
    if (!isPlainObject(parsed)) {
      this._quarantineCorruptTmp(tmp)
      return null
    }
    // 采用：先尝试 rename 成正式文件（占用失败也没关系，数据已在内存）
    try { fs.renameSync(tmp, this.file) } catch (e) { /* Windows 占用，忽略 */ }
    return parsed
  }

  /** 损坏的 tmp 不直接删，改名备份留证 */
  _quarantineCorruptTmp(tmp) {
    try { fs.renameSync(tmp, tmp + '.corrupt-' + Date.now()) } catch (e) { /* 占用，忽略 */ }
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
    // v3.3.13：与 load() 一致校验顶层结构，防止数组/null 把 this.data
    // 变成非法结构后 store.get().settings 抛错、当前会话崩
    if (!isPlainObject(next)) {
      this.onError('[store] replace 忽略非法顶层结构（非普通对象）')
      return this.data
    }
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
    // v3.3.13：上次写盘失败时，除正常去抖外再挂一条有上限的重试链，
    // 避免"改一次设置写失败后整个会话都不再落盘"
    if (this._dirty) this._scheduleRetry()
  }

  /** 有上限的自动重试：连续失败最多 3 次，超过停手并 onError，避免死循环 */
  _scheduleRetry() {
    if (this._retryTimer) return
    if (this._retries >= 3) {
      this.onError('[store] 连续重试 3 次仍写入失败，停止自动重试')
      return
    }
    this._retries++
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      if (!this._dirty) { this._retries = 0; return }
      this._flush()
      // _flush 失败会自行 _scheduleRetry 续链；成功则 _dirty=false、_retries=0
    }, 1000)
  }

  flush() {
    clearTimeout(this._timer)
    this._flush()
  }

  /**
   * 落盘：写 tmp → fsync → rename → fsync 目录。
   * 失败不抛出：置 _dirty 并挂有上限的重试链（调用方都是「尽力而为」的写设置路径，
   * 抛错会把上层的业务逻辑一起打断）。
   */
  _flush() {
    try {
      this._writeAtomically()
      this._dirty = false
      this._retries = 0
    } catch (err) {
      this._dirty = true
      this.onError('[store] 写入失败: ' + err.message)
      // v3.3.13：rename 失败时 tmp 是「已写完并 fsync 的完整新数据」，不能删；
      // 只有写入阶段失败（_tmpComplete 未置位）才清理残件
      if (!this._tmpComplete) { try { fs.unlinkSync(this.file + '.tmp') } catch (e) { /* 忽略 */ } }
      // 写失败后续上重试链（_scheduleRetry 自带 3 次上限守卫）
      this._scheduleRetry()
    }
  }

  /** 原子写本体：任何一步抛错都由 _flush 统一处理 */
  _writeAtomically() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    this._tmpComplete = false
    const fd = fs.openSync(tmp, 'w')
    try {
      // v3.3.13：writeSync 可能短写；writeFileSync(fd,...) 会循环写满
      fs.writeFileSync(fd, JSON.stringify(this.data, null, 2), 'utf8')
      fs.fsyncSync(fd)
    } finally {
      try { fs.closeSync(fd) } catch (e) { /* 已关闭 */ }
    }
    this._tmpComplete = true
    fs.renameSync(tmp, this.file)
    this._fsyncDir()
  }

  /**
   * rename 后 fsync 父目录，让目录项本身也落盘（防断电丢目录项）。
   * Windows 对目录 fsync 会抛 EBADF/EINVAL，忽略即可，不影响文件写入成功。
   */
  _fsyncDir() {
    let dirFd = null
    try {
      dirFd = fs.openSync(path.dirname(this.file), 'r')
      fs.fsyncSync(dirFd)
    } catch (e) {
      /* Windows 不支持目录 fsync，忽略 */
    } finally {
      if (dirFd !== null) { try { fs.closeSync(dirFd) } catch (e) { /* 已关 */ } }
    }
  }
}

module.exports = { Store, deepMerge }
