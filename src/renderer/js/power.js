'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 睡眠定时（v2.2：入口从托盘移到 app 内播放条） ================= */

const sleepUi = { minutes: 0, endsAt: null, tick: null }

/** 主进程推来的最新定时状态 → 刷新按钮高亮 / 选项勾选 / 倒计时 */
function renderSleepState(st) {
  sleepUi.minutes = (st && Number(st.minutes)) || 0
  sleepUi.endsAt = (st && st.endsAt) || null
  document.getElementById('btnSleep').classList.toggle('active', sleepUi.minutes > 0)
  document.querySelectorAll('#sleepOpts .sp-chip').forEach((chip) => {
    chip.classList.toggle('on', Number(chip.dataset.min) === sleepUi.minutes)
  })
  updateSleepCountdown()
  clearInterval(sleepUi.tick)
  sleepUi.tick = null
  const sleepPanel = document.getElementById('sleepPanel')
  // 面板收起时倒计时没人看，别留一个每秒空转的定时器
  if (sleepUi.minutes > 0 && sleepPanel && !sleepPanel.hidden) {
    sleepUi.tick = setInterval(updateSleepCountdown, 1000)
  }
}

function updateSleepCountdown() {
  const el = document.getElementById('sleepCount')
  if (!sleepUi.minutes || !sleepUi.endsAt) {
    el.textContent = '未设置'
    el.classList.add('off')
    return
  }
  el.classList.remove('off')
  const left = Math.max(0, Math.round((sleepUi.endsAt - Date.now()) / 1000))
  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  const s = left % 60
  el.textContent = h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0')
}

function toggleSleepPanel(show) {
  const panel = document.getElementById('sleepPanel')
  const target = show === undefined ? panel.hidden : !!show
  panel.hidden = !target
  if (target) {
    updateSleepCountdown()
    if (sleepUi.minutes > 0 && !sleepUi.tick) sleepUi.tick = setInterval(updateSleepCountdown, 1000)
  } else if (sleepUi.tick) {
    clearInterval(sleepUi.tick)
    sleepUi.tick = null
  }
}

/* ================= 播放结束后关机 / 设备热插拔（v2.1） ================= */

let powerCountdownTimer = null
const POWER_TEXT = { shutdown: '关机', hibernate: '休眠', quit: '关闭播放器' }

function showPowerCountdown(kind, seconds) {
  clearInterval(powerCountdownTimer)
  let left = seconds
  const tick = () => {
    if (left <= 0) { clearInterval(powerCountdownTimer); powerCountdownTimer = null; return }
    toast(`队列已播完：${left} 秒后${POWER_TEXT[kind] || '执行动作'}（Esc 或托盘菜单可取消）`, 1200)
    left--
  }
  tick()
  powerCountdownTimer = setInterval(tick, 1000)
}

async function cancelPowerCountdown() {
  clearInterval(powerCountdownTimer)
  powerCountdownTimer = null
  const ok = await window.api.powerCancel().catch(() => false)
  toast(ok ? '已取消' : '没有待执行的关机任务')
}

