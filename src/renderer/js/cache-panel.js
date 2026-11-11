'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本） （联网专属，master 不加载）*/

/* ================= 在线缓存面板（v3.1） ================= */

function toggleCachePanel(show) {
  const panel = document.getElementById('cachePanel')
  const target = show === undefined ? panel.hidden : !!show
  panel.hidden = !target
  if (target) {
    const dl = document.getElementById('dlPanel')
    if (dl) dl.hidden = true
    refreshCachePanel()
  }
}


/** 面板上的「共几首 / 占多少」+ 目录 + 开关状态 */
async function refreshCachePanel() {
  const info = await window.api.onlineCacheInfo().catch(() => null)
  if (!info) return
  const usage = document.getElementById('cacheUsage')
  usage.textContent = info.count ? `${info.count} 首 · ${fmtSize(info.size)}` : '还没有缓存'
  usage.classList.toggle('off', !info.count)
  const p = document.getElementById('cachePath')
  p.textContent = info.dir
  p.title = info.dir
  document.getElementById('cacheOn').checked = info.enabled
  const sel = document.getElementById('cacheLimit')
  const lim = String(info.limitMB || 0)
  if (!Array.from(sel.options).some((o) => o.value === lim)) {
    const opt = document.createElement('option')
    opt.value = lim
    opt.textContent = lim === '0' ? '不限' : Math.round(Number(lim) / 1024) + ' GB'
    sel.appendChild(opt)
  }
  sel.value = lim
  return info
}

function bindCachePanel() {
  document.getElementById('btnCacheClose').addEventListener('click', () => toggleCachePanel(false))
  // 第四轮 §4.4 #6：三处都是「乐观赋值 + 吞掉写盘失败仍 toast 成功」——
  // 设置没落盘，界面却告诉用户改好了。改成先 await 判成败，失败则回滚输入控件。
  document.getElementById('cacheOn').addEventListener('change', async (e) => {
    const on = e.target.checked
    const prev = state.settings.onlineCacheOn
    const ok = await window.api.patchSettings({ onlineCacheOn: on }).then(() => true, () => false)
    if (!ok) { e.target.checked = prev !== false; toast('设置保存失败，缓存开关未生效'); return }
    state.settings.onlineCacheOn = on
    toast(on ? '已开启在线缓存' : '已关闭在线缓存')
  })
  document.getElementById('cacheLimit').addEventListener('change', async (e) => {
    const mb = Number(e.target.value) || 0
    const prev = state.settings.onlineCacheLimitMB
    const ok = await window.api.patchSettings({ onlineCacheLimitMB: mb }).then(() => true, () => false)
    if (!ok) { e.target.value = prev || ''; toast('设置保存失败，缓存上限未生效'); refreshCachePanel(); return }
    state.settings.onlineCacheLimitMB = mb
    toast(mb ? '缓存上限：' + (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB') : '缓存不设上限')
    refreshCachePanel()
  })
  document.getElementById('cachePickDir').addEventListener('click', async () => {
    const info = await window.api.onlinePickCacheDir().catch(() => null)
    if (!info || !info.dir) return
    const prev = state.settings.onlineCacheDir
    const ok = await window.api.patchSettings({ onlineCacheDir: info.dir }).then(() => true, () => false)
    if (!ok) { toast('缓存目录保存失败（保持原目录）'); return }
    state.settings.onlineCacheDir = info.dir || prev
    toast('缓存目录：' + info.dir, 3000)
    refreshCachePanel()
  })
  document.getElementById('cacheOpenDir').addEventListener('click', () => window.api.onlineOpenCacheDir().catch(() => {}))
  document.getElementById('cacheClear').addEventListener('click', async () => {
    const info = await refreshCachePanel()
    if (info && !info.count) { toast('缓存已经是空的'); return }
    // 第四轮 §4.4 #6：清缓存不可撤销，必须二次确认（以前点一下就直接全删）
    if (!window.confirm('确定清空在线缓存？此操作不可撤销。')) return
    const r = await window.api.onlineCacheClear().catch(() => null)
    toast(r ? `已清理 ${r.removed} 首缓存` : '清理失败')
    refreshCachePanel()
  })

  // 高级音源（ChKSz apikey）：用户自己的账号，存本地 settings.json
  const paintKeyState = async () => {
    const st = await window.api.onlineExtraKeyGet().catch(() => null)
    const el = document.getElementById('keyState')
    if (!st || !el) return
    el.textContent = st.set ? '已设置 ' + st.masked : '未设置（QQ/酷狗 只能 320k）'
    el.style.color = st.set ? 'var(--accent)' : ''
  }
  document.getElementById('keySave').addEventListener('click', async () => {
    const input = document.getElementById('chkszKey')
    const k = input.value.trim()
    if (!k) { toast('先粘贴 apikey'); return }
    document.getElementById('keySave').textContent = '验证中…'
    const r = await window.api.onlineExtraKeySet(k).catch((err) => ({ ok: false, error: err.message }))
    document.getElementById('keySave').textContent = '保存并验证'
    if (r && r.ok) {
      input.value = ''
      toast(r.gotUrl ? 'key 有效，已启用' : 'key 有效（这首取不到，可能额度或版权），已启用')
      paintKeyState()
    } else {
      toast('没通过：' + ((r && r.error) || '未知错误'), 3500)
    }
  })
  document.getElementById('keyReg').addEventListener('click', () => window.api.onlineOpenChksz().catch(() => {}))
  document.getElementById('keyClear').addEventListener('click', async () => {
    await window.api.onlineExtraKeySet('').catch(() => {})
    document.getElementById('chkszKey').value = ''
    toast('已清除高级音源')
    paintKeyState()
  })
  paintKeyState()

  // 青听网关（v3.2）：默认开，关掉就只剩 GDStudio（网易）
  const paintQing = async () => {
    const st = await window.api.onlineQingGet().catch(() => null)
    const el = document.getElementById('qingOn')
    if (!st || !el) return
    el.checked = st.on !== false
    document.getElementById('qingState').textContent = st.on !== false ? '已启用' : '已关闭'
  }
  document.getElementById('qingOn').addEventListener('change', async (e) => {
    const on = e.target.checked
    await window.api.onlineQingSet(on).catch(() => {})
    document.getElementById('qingState').textContent = on ? '已启用' : '已关闭'
    toast(on ? '青听网关已启用（QQ/酷我/酷狗 也能无损）' : '已关闭青听网关，只走网易线路')
  })
  document.getElementById('qingTest').addEventListener('click', async () => {
    const btn = document.getElementById('qingTest')
    const el = document.getElementById('qingState')
    btn.textContent = '测试中…'
    el.textContent = ''
    const r = await window.api.onlineQingTest().catch((err) => ({ ok: false, error: err.message }))
    btn.textContent = '测试线路'
    if (r && r.ok) {
      el.textContent = '线路正常 · ' + r.ms + 'ms'
      el.style.color = 'var(--accent)'
    } else {
      el.textContent = '不通：' + ((r && r.error) || '未知错误')
      el.style.color = '#e06666'
    }
  })
  paintQing()
}

async function refreshAudioDevices() {
  if (audioDevicesLoading) return
  audioDevicesLoading = true
  const body = document.getElementById('audioDevices')
  body.innerHTML = '<span class="ap-loading">正在检测输出设备…</span>'
  const res = await window.api.mpvDevices().catch((err) => ({ ok: false, error: err.message }))
  audioDevicesLoading = false
  if (!res || !res.ok) {
    body.innerHTML = '<span class="ap-loading">检测失败：' + esc((res && res.error) || '未知错误') + '</span>'
    return
  }
  audioDevicesCache = res.devices || []
  paintAudioPanel()
}

function paintAudioPanel() {
  const cur = state.settings.audioDevice || ''
  const body = document.getElementById('audioDevices')
  const chip = (label, name) =>
    '<button class="sp-chip' + (name === cur ? ' on' : '') + '" data-dev="' + esc(name) + '">' +
    esc(label) + (name === cur ? '（当前）' : '') + '</button>'
  let html = chip('跟随系统默认设备', '')
  for (const d of audioDevicesCache) {
    html += chip(d.description || d.name, d.name)
  }
  if (!audioDevicesCache.length) {
    html += '<span class="ap-loading">没有检测到可用设备</span>'
  }
  body.innerHTML = html
}

/** 选中设备（'' = 跟随系统默认）。保存并即时切（独占没开时只保存，开启后生效）。 */
async function setAudioDevice(name) {
  name = name || ''
  const r = await window.api.mpvSetDevice(name).catch((err) => ({ ok: false, error: err.message }))
  // v3.3.17：主进程会在新设备起不来时自动退回原设备并回传 reverted。
  // 以前只看 ok/applied，界面提示「已切换」、面板还把失败设备标成「（当前）」，
  // 用户以为换了设备其实还在旧的上面。
  if (r && r.reverted) {
    state.settings.audioDevice = r.device || ''
    toast(r.error || '该设备不可用，已退回原设备', 3500)
  } else if (!r || !r.ok) {
    toast('切换输出设备失败：' + ((r && r.error) || '未知错误'), 3000)
  } else {
    state.settings.audioDevice = name
    toast(r.applied ? '输出设备已切换' : '输出设备已保存（开启独占后生效）')
  }
  paintAudioPanel()
}

