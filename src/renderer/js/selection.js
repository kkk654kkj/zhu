'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 列表多选（v1.7） ================= */

function paintSelection() {
  document.querySelectorAll('#tableBody .tr').forEach((row) => {
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
  if (s.accent) document.documentElement.style.setProperty('--accent', s.accent)
  player && player.setFadeMs(s.fadeMs ?? 350)
}

