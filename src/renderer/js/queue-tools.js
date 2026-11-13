'use strict'
/**
 * 联网版 v3.3.44 · 播放队列编辑工具：清空播放队列 / 单独移除一首
 *
 * 设计约束（与仓库既有不变量一致）：
 *  - 队列抽屉是两版共用 UI，本功能只给联网版：ui.js / app.js / player.js /
 *    app.css 与 index.html 的静态结构一律不动，DOM 全部由本文件运行时挂载，
 *    样式只写在 online-only 的 css/queue-tools.css。
 *  - 无打包器、无内联脚本（CSP script-src 'self'），经典全局脚本，放在 app.js 之后。
 *  - app.js 在 #queueBody 上挂的是冒泡期「点行即播放」。这里用**捕获期**拦住行尾 ×，
 *    否则点「移除」会顺带把那首歌重新播一遍。
 *  - UI.renderQueue 改队列时会整块重建 innerHTML，靠 MutationObserver 给新行补 ×；
 *    observe 不带 subtree，补按钮不会自激。
 */
const QT = (() => {
  const $ = (id) => document.getElementById(id)
  let body = null
  let countEl = null
  let clearBtn = null
  let observer = null

  const queueLen = () =>
    (typeof player !== 'undefined' && player && player.tracks) ? player.tracks.length : 0

  function updateCount() {
    const n = queueLen()
    if (countEl) countEl.textContent = n ? n + ' 首' : '空'
    if (clearBtn) clearBtn.disabled = n === 0
  }

  function decorateItem(item) {
    if (!item || item.dataset.qi == null || item.querySelector('.qi-x')) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'qi-x'
    btn.dataset.qr = item.dataset.qi
    btn.title = '从播放队列移除'
    btn.setAttribute('aria-label', '从播放队列移除')
    btn.textContent = '×'
    item.appendChild(btn)
  }

  /**
   * 会话持久化。saveSession() 在空队列时会早退；而 clearQueue() 内部的 stop()
   * 又是在 tracks 清空**之前**触发 state-change → saveSession，把旧队列写回会话。
   * 所以清空 / 删到空时必须显式写一份空会话，否则重启后整队「复活」。
   */
  function persistQueue() {
    try {
      if (!window.api || !window.api.setSession) return
      if (!queueLen()) {
        window.api.setSession({
          queueIds: [], index: -1, currentId: null, currentTime: 0,
          mode: (typeof player !== 'undefined' && player) ? player.mode : 'list'
        }).catch(() => {})
      } else if (typeof saveSession === 'function') {
        saveSession()
      }
    } catch (e) { console.warn('[queue-tools] persistQueue', e) }
  }

  /** 清空 / 删到空时不会发 track-change，播放条、行高亮、歌词、媒体会话要自己归零 */
  function resetPlaybackUi() {
    try {
      if (typeof state !== 'undefined') state.currentId = null
      // UI.setRowPlaying(id, false) 的语义是「只给 id 那一行加 playing」，
      // 传旧 id + false 反而会把高亮留在旧行上；这里直接清干净。
      UI._tCurrentId = null
      document.querySelectorAll('#tableBody .tr.playing').forEach((el) => el.classList.remove('playing'))
      if (typeof Online !== 'undefined' && Online && typeof Online.markPlaying === 'function') Online.markPlaying(null)
      UI.renderNowPlaying(null, false)
      UI.renderLyric(null, '')
      UI.setProgress(0, 0)
      if (typeof pushDesktopLyric === 'function') pushDesktopLyric(true)
      if (typeof syncMediaSessionState === 'function') syncMediaSessionState(false)
      try { if ('mediaSession' in navigator) navigator.mediaSession.metadata = null } catch {}
    } catch (e) { console.warn('[queue-tools] resetPlaybackUi', e) }
  }

  function onBodyClick(e) {
    const x = e.target && e.target.closest && e.target.closest('.qi-x')
    if (!x) return
    e.preventDefault()
    e.stopPropagation()   // 截断冒泡，app.js 的「点行即播放」不会再执行
    if (typeof player === 'undefined' || !player || typeof player.removeFromQueue !== 'function') return
    const raw = x.dataset.qr != null ? x.dataset.qr : (x.parentElement && x.parentElement.dataset.qi)
    const i = Number(raw)
    if (!Number.isInteger(i) || i < 0 || i >= player.tracks.length) return
    const wasCurrent = i === player.index
    player.removeFromQueue(i)
    if (!queueLen()) resetPlaybackUi()
    persistQueue()
    if (typeof toast === 'function') toast(wasCurrent ? '已移除正在播放的歌曲' : '已从播放队列移除')
  }

  function onBodyDragStart(e) {
    // 行本身 draggable="true"，从 × 上按下不该启动整行拖拽
    if (e.target && e.target.closest && e.target.closest('.qi-x')) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  function onClearClick(e) {
    e.preventDefault()
    e.stopPropagation()
    const n = queueLen()
    if (!n) { if (typeof toast === 'function') toast('播放队列已经是空的'); return }
    if (typeof player === 'undefined' || !player || typeof player.clearQueue !== 'function') return
    player.clearQueue()
    resetPlaybackUi()
    persistQueue()
    if (typeof toast === 'function') toast('已清空播放队列（' + n + ' 首）')
  }

  function mount() {
    const head = document.querySelector('#queuePanel .qp-head')
    body = $('queueBody')
    if (!head || !body) return

    countEl = head.querySelector('.qp-count')
    clearBtn = head.querySelector('.qp-clear')
    if (!clearBtn) {
      const right = document.createElement('div')
      right.className = 'qp-tools'
      countEl = document.createElement('span')
      countEl.className = 'qp-count'
      countEl.id = 'queueCount'
      clearBtn = document.createElement('button')
      clearBtn.type = 'button'
      clearBtn.className = 'mini-btn qp-clear'
      clearBtn.id = 'btnQueueClear'
      clearBtn.title = '清空播放队列（不会删除曲库文件）'
      clearBtn.textContent = '清空'
      right.appendChild(countEl)
      right.appendChild(clearBtn)
      const closeBtn = $('btnQueueClose')
      if (closeBtn) right.appendChild(closeBtn)   // 挪进同一行，关闭按钮事件不受影响
      head.appendChild(right)
    }

    body.addEventListener('click', onBodyClick, true)
    body.addEventListener('dragstart', onBodyDragStart, true)
    clearBtn.addEventListener('click', onClearClick)

    observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!n || n.nodeType !== 1) continue
          if (n.classList && n.classList.contains('qp-item')) decorateItem(n)
          else if (n.querySelectorAll) n.querySelectorAll('.qp-item[data-qi]').forEach(decorateItem)
        }
      }
      updateCount()
    })
    observer.observe(body, { childList: true, subtree: false })
    body.querySelectorAll('.qp-item[data-qi]').forEach(decorateItem)
    updateCount()
  }

  const start = () => {
    try { mount() } catch (e) { console.warn('[queue-tools] mount', e) }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

  return { mount, updateCount, queueLen, persistQueue, resetPlaybackUi }
})()
