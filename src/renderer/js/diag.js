'use strict'
/**
 * 诊断面板（v1.8）：解析失败清单 + mpv 日志 + 环境快照。
 *
 * 存在的理由：以前「少了几首歌」「独占突然不响了」只能靠翻 data\lx-player.log，
 * 而扫描彻底失败的文件根本没进曲库，界面上一声不响就少了几首。
 * 现在失败明细由主进程落盘（parse-failures.json），mpv 侧另有一份环形缓冲，
 * 面板只负责展示与复制，不做任何业务判断。
 */

const Diag = {
  tab: 'failures',
  mpvMode: 'live',        // live = 本次运行的实时事件；file = lx-player.log 尾部
  liveLines: [],          // {seq, at, level, text}（跨标签切换保留）
  lastSeq: 0,
  timer: null,
  info: null,
  failures: null,
  fileLog: null,
  MAX_LIVE: 1000,

  el(id) { return document.getElementById(id) },

  init() {
    const modal = this.el('diagModal')
    if (!modal) return

    this.el('btnDiag').addEventListener('click', () => this.open())
    this.el('btnDiagClose').addEventListener('click', () => this.close())
    modal.addEventListener('click', (e) => { if (e.target === modal) this.close() })

    // 标签切换
    this.el('diagTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]')
      if (btn) this.switchTab(btn.dataset.tab)
    })

    // 失败列表：定位文件
    this.el('diagFailList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-reveal]')
      if (!btn) return
      const p = btn.getAttribute('data-reveal')
      if (p) window.api.showInFolder(p)
    })

    this.el('btnDiagClear').addEventListener('click', async () => {
      if (!this.failures || !this.failures.length) { toast('没有失败记录'); return }
      const r = await window.api.diagClearFailures().catch(() => null)
      if (!r || !r.ok) { toast('清空失败'); return }
      toast('已清空 ' + r.cleared + ' 条失败记录')
      await this.loadFailures()
    })

    // mpv 日志：实时 / 文件 切换
    this.el('diagModal').querySelectorAll('[data-mpv]').forEach((b) => {
      b.addEventListener('click', () => this.setMpvMode(b.dataset.mpv))
    })
    this.el('btnDiagMpvRefresh').addEventListener('click', () => {
      if (this.mpvMode === 'file') this.loadFileLog(true)
      else this.pollLive(true)
    })

    this.el('btnDiagCopy').addEventListener('click', () => this.copy())
    this.el('btnDiagOpenLog').addEventListener('click', () => window.api.diagOpenLog())
    // v2.8.6：声卡占用自查 + 一键释放独占。
    // 用户遇到「开了独占再关掉，别的软件还是没声音」时，在诊断面板里点一下就知道
    // 声卡到底被谁占着，不用去翻任务管理器。
    this.el('btnDiagProbeDevice').addEventListener('click', async () => {
      toast('正在检测声卡…', 1200)
      const r = await window.api.mpvProbeDevice().catch(() => null)
      if (!r) { toast('检测失败', 2500); return }
      if (r.blocked) toast('声卡仍被占用（别人打不开）：' + (r.detail || '未知原因'), 6000)
      else toast('声卡可用，别的程序可以正常发声', 3000)
    })
    this.el('btnDiagRelease').addEventListener('click', async () => {
      toast('正在释放独占…', 1200)
      const r = await window.api.mpvRelease().catch(() => null)
      if (!r) { toast('释放失败', 2500); return }
      if (r.blocked) toast('已关闭引擎，但声卡仍被别的程序占着', 5000)
      else toast('已释放：声卡可以给别的程序用了', 3000)
      this.pollLive(true)
    })
    this.el('btnDiagRescan').addEventListener('click', async () => {
      this.close()
      if (typeof doScan === 'function') await doScan()
      else toast('扫描入口不可用')
    })
  },

  /* ---------------- 打开 / 关闭 ---------------- */

  async open() {
    const modal = this.el('diagModal')
    if (!modal || !modal.hidden) return
    modal.hidden = false
    // 每次打开都重新拉一次快照：用户多半是「刚出问题」才点进来的
    this.info = await window.api.diagInfo().catch(() => null)
    this.renderEnv()
    await this.loadFailures()
    if (this.tab === 'mpv') this.enterMpvTab()
  },

  close() {
    const modal = this.el('diagModal')
    if (!modal) return
    modal.hidden = true
    this.stopLive()
  },

  isOpen() {
    const modal = this.el('diagModal')
    return !!(modal && !modal.hidden)
  },

  switchTab(tab) {
    if (!['failures', 'mpv', 'env'].includes(tab)) return
    this.tab = tab
    this.el('diagTabs').querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab)
    })
    this.el('diagModal').querySelectorAll('[data-pane]').forEach((p) => {
      p.hidden = p.dataset.pane !== tab
    })
    if (tab === 'mpv') this.enterMpvTab()
    else this.stopLive()
    if (tab === 'env') this.renderEnv()
  },

  /* ---------------- 解析失败 ---------------- */

  async loadFailures() {
    const r = await window.api.diagFailures().catch(() => null)
    const list = (r && r.ok && r.failures) || []
    this.failures = list
    const badge = this.el('diagFailBadge')
    if (badge) {
      badge.textContent = String(list.length)
      badge.classList.toggle('zero', list.length === 0)
    }
    this.renderFailures(r && r.counts)
  },

  renderFailures(counts) {
    const list = this.failures || []
    const box = this.el('diagFailList')
    const sum = this.el('diagFailSum')
    if (!box || !sum) return

    const c = counts || {}
    const hard = c.parse || 0         // 元数据完全解析失败，进不了曲库
    const meta = c.metadata || 0      // 能播，但标签读不出来
    const stat = c.stat || 0          // 读不到文件信息
    const dur = c.duration || 0       // 解析"成功"但读不出时长，多半是坏文件
    sum.innerHTML = list.length
      ? `<b>${list.length}</b> 个文件有问题：` +
        `<span class="sf-hard">${hard} 个无法解析</span> · ` +
        `<span class="sf-meta">${meta} 个标签缺失</span>` +
        (dur ? ` · <span class="sf-meta">${dur} 个时长未知</span>` : '') +
        (stat ? ` · <span class="sf-hard">${stat} 个读不到</span>` : '')
      : '没有解析失败的曲目'

    if (!list.length) {
      box.innerHTML = '<div class="diag-empty">曲库里所有文件都解析正常。</div>'
      return
    }

    const STAGE = {
      parse: ['无法解析', 'hard'],
      metadata: ['标签缺失', 'meta'],
      duration: ['时长未知', 'meta'],
      stat: ['读不到', 'hard']
    }
    box.innerHTML = list.map((f) => {
      const [label, cls] = STAGE[f.stage] || [f.stage || '未知', 'meta']
      const when = f.at ? new Date(f.at).toLocaleString('zh-CN', { hour12: false }) : ''
      return `<div class="df-row${f.exists === false ? ' gone' : ''}">
        <span class="df-ext">${esc((f.ext || '?').toUpperCase())}</span>
        <div class="df-main">
          <div class="df-name" title="${esc(f.fileName)}">${esc(f.fileName)}
            <span class="df-stage ${cls}">${esc(label)}</span>
            ${f.exists === false ? '<span class="df-stage hard">文件已不在</span>' : ''}
          </div>
          <div class="df-err">${esc(f.error)}</div>
          <div class="df-path" title="${esc(f.path)}">${esc(f.path)}</div>
        </div>
        <span class="df-time">${esc(when)}</span>
        <button class="mini-btn" data-reveal="${esc(f.path)}" title="在文件夹中显示">${icon('folder')}</button>
      </div>`
    }).join('')
  },

  /* ---------------- mpv 日志 ---------------- */

  enterMpvTab() {
    this.setMpvMode(this.mpvMode, true)
  },

  setMpvMode(mode, force) {
    if (!force && this.mpvMode === mode) return
    this.mpvMode = mode
    this.el('diagModal').querySelectorAll('[data-mpv]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mpv === mode)
    })
    this.stopLive()
    if (mode === 'live') {
      this.renderLive()          // 先把已缓存的补上，再开轮询
      this.startLive()
    } else {
      this.loadFileLog(true)
    }
  },

  startLive() {
    this.stopLive()
    this.pollLive(false)
    this.timer = setInterval(() => this.pollLive(false), 1200)
  },

  stopLive() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  },

  async pollLive(reset) {
    // v3.3.7：加 in-flight 防护 —— IPC 偶发慢于 1.2s 时两次请求并行，
    // 同一批日志行会入列两次（「复制」会输出重复行）
    if (this._polling) return
    if (reset) {
      this.liveLines = []
      this.lastSeq = 0
      this._renderedSeq = 0
    }
    this._polling = true
    try {
      const r = await window.api.diagMpvLog(this.lastSeq).catch(() => null)
      if (!r || !r.ok) return
      if (r.entries && r.entries.length) {
        this.liveLines.push(...r.entries)
        if (this.liveLines.length > this.MAX_LIVE) {
          this.liveLines.splice(0, this.liveLines.length - this.MAX_LIVE)
        }
        this.lastSeq = r.seq
        if (this.mpvMode === 'live' && this.tab === 'mpv') this.renderLive(true)
      }
      this.renderMpvState(r.running, r.exclusive)
    } finally {
      this._polling = false
    }
  },

  renderMpvState(running, exclusive) {
    const dot = this.el('diagMpvDot')
    const st = this.el('diagMpvState')
    if (!dot || !st) return
    dot.className = 'diag-dot' + (running ? (exclusive ? ' on-excl' : ' on') : '')
    if (running) st.textContent = exclusive ? '引擎运行中 · 独占输出' : '引擎运行中 · 共享输出'
    else st.textContent = '引擎未运行'
  },

  renderLive(append) {
    const pre = this.el('diagLog')
    if (!pre) return
    if (!this.liveLines.length) {
      pre.innerHTML = '<span class="lg-dim">（本次运行还没有 mpv 事件。开启独占输出或播放一首歌后这里才会有内容。）</span>'
      this._placeholder = true
      return
    }
    if (!append) {
      pre.innerHTML = this.liveLines.map((l) => this.lineHtml(l.at, l.level, l.text)).join('')
      this._renderedSeq = this.liveLines[this.liveLines.length - 1].seq
      this._placeholder = false
      this.scrollBottom(pre, true)
      return
    }
    // 追加：按 seq 找出还没画过的行（不能按"最后 N 条"取，会把已经画过的重复插入）
    const fresh = this.liveLines.filter((l) => l.seq > (this._renderedSeq || 0))
    if (!fresh.length) return
    // 第一行到来前显示的是占位提示，必须清掉，否则会残留在日志顶部
    if (this._placeholder) { pre.innerHTML = ''; this._placeholder = false }
    const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48
    pre.insertAdjacentHTML('beforeend', fresh.map((l) => this.lineHtml(l.at, l.level, l.text)).join(''))
    this._renderedSeq = fresh[fresh.length - 1].seq
    // 节点数上限：一行是两个 span（时间 + 正文），所以按 2 倍算，超出从头裁掉
    while (pre.childElementCount > this.MAX_LIVE * 2) pre.removeChild(pre.firstElementChild)
    if (nearBottom) this.scrollBottom(pre, true)
  },

  lineHtml(at, level, text) {
    const t = at ? new Date(at).toTimeString().slice(0, 8) : '--:--:--'
    const lv = String(level || 'info').toLowerCase()
    return `<span class="lg-time">${esc(t)}</span><span class="lg-${esc(lv)}">${esc(text)}</span>\n`
  },

  async loadFileLog(showTip) {
    const pre = this.el('diagLog')
    this._placeholder = false
    if (pre) pre.innerHTML = '<span class="lg-dim">正在读取日志文件…</span>'
    const r = await window.api.diagLogTail(600).catch(() => null)
    this.fileLog = r
    if (!pre) return
    if (!r || !r.ok) {
      pre.innerHTML = `<span class="lg-error">读取日志文件失败：${esc((r && r.error) || '未知错误')}</span>`
      return
    }
    if (!r.lines.length) {
      pre.innerHTML = '<span class="lg-dim">（日志文件为空）</span>'
      return
    }
    pre.innerHTML = r.lines.map((line) => {
      let cls = 'info'
      const s = String(line)
      if (/UNCAUGHT|UNHANDLED|FATAL|\[mpv\] file-error|ERROR|error=|code 1/.test(s)) cls = 'error'
      else if (/WARN/.test(s)) cls = 'warn'
      else if (/===|stage:/.test(s)) cls = 'info'
      return `<span class="lg-${cls}">${esc(s)}</span>\n`
    }).join('')
    this.scrollBottom(pre, true)
    if (showTip && r.truncated) toast('只显示最后 ' + r.lines.length + ' 行')
  },

  scrollBottom(el, force) {
    if (force) el.scrollTop = el.scrollHeight
  },

  /* ---------------- 环境 ---------------- */

  renderEnv() {
    const box = this.el('diagEnv')
    if (!box) return
    const i = this.info
    if (!i) { box.innerHTML = '<div class="diag-empty">读取环境信息失败。</div>'; return }
    const rows = [
      ['版本', i.version + (i.packaged ? '（打包版）' : '（开发版）')],
      ['Electron / Chromium / Node', `${i.electron} / ${i.chrome} / ${i.node}`],
      ['数据目录', i.dataDir],
      ['日志文件', i.logFile],
      ['mpv 引擎', i.mpvExe + (i.mpvExeExists ? '' : '  ← 不存在')],
      ['引擎状态', i.mpvRunning ? (i.mpvExclusive ? '运行中 · 独占' : '运行中 · 共享') + (i.mpvFellBack ? '（已回退过共享）' : '') : '未运行'],
      ['独占输出设置', i.exclusiveOutput ? '已开启' : '关闭'],
      ['输出设备', i.audioDevice || '（跟随系统默认）'],
      ['曲库', `${i.trackCount} 首 · ${i.failureCount} 个失败记录`],
      ['音乐目录', (i.musicDirs && i.musicDirs.length) ? i.musicDirs.join('\n') : '（未设置）'],
      ['文件夹监视', i.watchFolders ? '开启' : '关闭'],
      ['扫描中', i.scanning ? '是' : '否']
    ]
    box.innerHTML = rows.map(([k, v]) => `<div class="kv-row">
      <div class="kv-k">${esc(k)}</div>
      <div class="kv-v">${esc(v)}</div>
    </div>`).join('')
  },

  /* ---------------- 复制 ---------------- */

  async copy() {
    let text = ''
    if (this.tab === 'failures') {
      const list = this.failures || []
      text = list.length
        ? '解析失败 ' + list.length + ' 个：\n' + list.map((f) =>
            `- [${f.stage}] ${f.fileName} :: ${f.error}\n  ${f.path}`).join('\n')
        : '解析失败：无'
    } else if (this.tab === 'mpv') {
      if (this.mpvMode === 'live') {
        text = 'mpv 事件（本次运行）：\n' + this.liveLines.map((l) =>
          `${new Date(l.at).toLocaleString('zh-CN', { hour12: false })} [${l.level}] ${l.text}`).join('\n')
      } else {
        text = (this.fileLog && this.fileLog.lines || []).join('\n')
      }
    } else {
      const i = this.info
      text = i ? [
        '版本: ' + i.version,
        'Electron: ' + i.electron + ' Chromium: ' + i.chrome + ' Node: ' + i.node,
        '数据目录: ' + i.dataDir,
        'mpv 引擎: ' + i.mpvExe + (i.mpvExeExists ? '' : '（不存在）'),
        '引擎状态: ' + (i.mpvRunning ? '运行中' : '未运行') + (i.exclusiveOutput ? ' / 独占已开启' : ''),
        '输出设备: ' + (i.audioDevice || '系统默认'),
        '曲库: ' + i.trackCount + ' 首 / ' + i.failureCount + ' 失败'
      ].join('\n') : ''
    }
    if (!text) { toast('没有可复制的内容'); return }
    const ok = await this.writeClipboard(text)
    toast(ok ? '已复制到剪贴板' : '复制失败')
  },

  /** file:// 页面里 navigator.clipboard / execCommand 都不可靠，优先走主进程 */
  async writeClipboard(text) {
    try {
      const r = await window.api.diagCopy(text)
      if (r && r.ok) return true
    } catch {}
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {}
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch { return false }
  }
}
