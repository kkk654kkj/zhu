'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（master 版持久化——本地版无下载任务 flush，退出走 flushSaveSettingsForExit）。 */

/* ================= 持久化 ================= */

// v3.3.7：debounce 是「尾触发、参数整体替换」语义 —— 300ms 内两类设置
// （比如 mode-change 后马上拖音量）只有最后一类会落盘，前一类永远丢失。
// 改成先合并再统一发。
// v3.3.13：关窗/重载前必须把攒着的 pending 立即发出（只 cancel 会丢设置），
// 所以这里自管定时器 + flush，不依赖 util.debounce 的 cancel；回包也要增量
// 合并，不能整体替换（全文件多处直接赋值 state.settings.xxx，整体替换会回滚）。
let saveSettingsPending = null
let saveSettingsTimer = null
const SETTINGS_SAVE_MAX_RETRY = 3
let saveSettingsRetries = 0

/** 立即发送 pending（幂等），并取消 debounce 定时器 */
function flushSaveSettings() {
  const patch = saveSettingsPending
  saveSettingsPending = null
  if (saveSettingsTimer) { clearTimeout(saveSettingsTimer); saveSettingsTimer = null }
  if (!patch || !Object.keys(patch).length) return Promise.resolve()
  return window.api.patchSettings(patch).then((s) => {
    saveSettingsRetries = 0   // v3.3.20：落盘成功后清零，下次失败还能重试满额度
    // 第四轮 §4.3 #4：回包是主进程的**全量** settings，以前整个 Object.assign 回来，
    // 会把本次没提交、但渲染层刚直接赋过值的键（applyEq / btnNorm / toggleExclusiveOutputOnce）
    // 一起覆盖回旧值。只同步本次 patch 涉及的键。
    if (s && typeof s === 'object') {
      for (const k of Object.keys(patch)) {
        if (Object.prototype.hasOwnProperty.call(s, k)) state.settings[k] = s[k]
      }
    }
  }).catch(() => {
    // 以前 .catch(()=>{}) 把写盘失败吞得干干净净，用户改了设置却毫无提示
    // v3.3.20：失败不能只弹个 toast 就把 patch 丢掉 —— 界面已是新值、磁盘还是旧值，
    // 本次会话所有改动到下次启动全部回滚。合并回 pending 并有限次重试。
    saveSettingsPending = Object.assign({}, patch, saveSettingsPending || {})
    if (saveSettingsRetries < SETTINGS_SAVE_MAX_RETRY && !saveSettingsTimer) {
      saveSettingsRetries++
      saveSettingsTimer = setTimeout(() => { saveSettingsTimer = null; flushSaveSettings() }, 2000)
    }
    toast('设置保存失败（磁盘只读或被占用？）', 3000)
  })
}

function saveSettings(patch) {
  saveSettingsPending = Object.assign({}, saveSettingsPending || {}, patch || {})
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer)
  saveSettingsTimer = setTimeout(() => { saveSettingsTimer = null; flushSaveSettings() }, 300)
}

/** 重载/关窗前：最多等一小会儿，IPC 卡住也不至于永远不 reload */
async function flushSaveSettingsForExit() {
  await Promise.race([
    flushSaveSettings(),
    new Promise((r) => setTimeout(r, 250))
  ]).catch(() => {})
}

