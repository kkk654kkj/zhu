'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 列表多选（v1.7） ================= */

function paintSelection() {
  // v3.3.63：卡片视图的行元素是 .mc 而不是 .tr —— 以前只刷 .tr，网格里 Ctrl 多选后
  // 卡片表面没有任何高亮，但「已选 N 首」已经在计数，批量收藏/删歌单会作用到
  // 用户看不见的选中项上（同文件里 ui.js 的另两处早就是双选择器了）
  document.querySelectorAll('#tableBody .tr, #tableBody .mc').forEach((row) => {
    row.classList.toggle('selected', state.selected.has(row.dataset.id))
  })
  // 多选工具条（v2.6）：有选中才浮现
  const bar = document.getElementById('selBar')
  const n = state.selected.size
  bar.hidden = n === 0
  document.getElementById('selCount').textContent = '已选 ' + n + ' 首'
}

function clearSelection() {
  if (!state.selected.size && state.selAnchor == null) return
  state.selected.clear()
  state.selAnchor = null
  paintSelection()
}

function toggleSelection(id, index) {
  if (state.selected.has(id)) state.selected.delete(id)
  else state.selected.add(id)
  state.selAnchor = index
  paintSelection()
}

/** Shift 范围选：从上一次点击处到当前行（含两端） */
function selectRange(index) {
  const from = state.selAnchor == null ? index : state.selAnchor
  const [a, b] = from <= index ? [from, index] : [index, from]
  for (let i = a; i <= b; i++) {
    const t = state.visible[i]
    if (t) state.selected.add(t.id)
  }
  paintSelection()
}

/** 当前选中的曲目（右键批量操作 / 拖拽用） */
function selectedTracks() {
  return Array.from(state.selected).map((id) => state.byId.get(id)).filter(Boolean)
}

function applySettings() {
  const s = state.settings
  if (s.lyricFontSize) UI.setLyricFontSize(s.lyricFontSize)
  // v2.8.25：主题色统一走 Theme（支持预设名 / auto / 裸 hex 三种存量值）
  if (s.accent) {
    if (typeof Theme !== 'undefined') Theme.apply(s.accent, false)
    else document.documentElement.style.setProperty('--accent', s.accent)
  }
  player && player.setFadeMs(s.fadeMs ?? 350)
}

