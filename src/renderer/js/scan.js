'use strict'
/** v3.3.24 渲染层拆分：从 app.js 原样搬出（全局 script 模式，无注入成本）。 */
/* ================= 扫描 ================= */

let scanning = false
let draftDirs = []

function openDirModal() {
  if (scanning) { toast('正在扫描，请稍候'); return }
  draftDirs = (state.settings.musicDirs || []).slice()
  const chk = document.getElementById('chkWatchFolders')
  if (chk) chk.checked = state.settings.watchFolders !== false
  UI.showDirModal(draftDirs)
}

function bindDirModal() {
  document.getElementById('btnDirClose').addEventListener('click', () => UI.hideDirModal())
  document.getElementById('dirModal').addEventListener('click', (e) => {
    if (e.target.id === 'dirModal') UI.hideDirModal()
  })
  document.getElementById('btnDirAdd').addEventListener('click', async () => {
    const picked = await window.api.pickDirs()
    if (!picked || !picked.length) return
    for (const d of picked) {
      if (!draftDirs.some((x) => x.toLowerCase() === d.toLowerCase())) draftDirs.push(d)
    }
    UI.renderDirList(draftDirs)
  })
  UI.els.dirList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rm]')
    if (!btn) return
    draftDirs.splice(Number(btn.dataset.rm), 1)
    UI.renderDirList(draftDirs)
  })
  document.getElementById('btnDirSave').addEventListener('click', async () => {
    if (!draftDirs.length) { toast('请至少添加一个文件夹'); return }
    UI.hideDirModal()
    state.settings.musicDirs = draftDirs.slice()
    const chk = document.getElementById('chkWatchFolders')
    const watchFolders = chk ? chk.checked : true
    state.settings.watchFolders = watchFolders
    await window.api.patchSettings({ musicDirs: draftDirs.slice(), watchFolders })
    await doScan()
  })
}

async function doScan() {
  if (scanning) return
  // 与响度分析互斥（共用扫描遮罩，同时跑会互相覆盖进度并提前关遮罩）
  if (state.analyzing) { toast('正在分析响度，稍后再扫描'); return }
  scanning = true
  UI.showScan('正在扫描音乐文件夹…', 'scan')
  try {
    const dirs = state.settings.musicDirs && state.settings.musicDirs.length
      ? state.settings.musicDirs
      : await window.api.pickDirs()
    if (!dirs.length) { UI.hideScan('scan'); scanning = false; return }
    if (dirs !== state.settings.musicDirs) {
      state.settings.musicDirs = dirs
      await window.api.patchSettings({ musicDirs: dirs })
    }
    const res = await window.api.scan(dirs)
    // v3.3.17：已有扫描在跑时主进程立刻返回 skipped，真正那轮还在后台继续。
    // 以前照样提示「扫描完成」并收起遮罩，用户看到的是半成品数据。
    if (res && res.skipped) {
      toast('已有扫描在进行，完成后自动刷新', 2500)
      UI.hideScan('scan')
      return
    }
    // v3.3.20：主进程在目录不可用时返回 ok:false —— 以前被当成正常结果，
    // 继续走 listTracks + 提示「扫描完成」，用户以为扫过了其实一张没进来。
    if (res && res.ok === false) {
      UI.hideScan('scan')
      toast('扫描未执行：' + (res.error || '音乐目录不可用'), 4000)
      return
    }
    const tracks = await window.api.listTracks()
    setTracks(tracks)
    updateNavCounts()
    renderView()
    UI.hideScan('scan')
    const bits = []
    if (res.added) bits.push('新增 ' + res.added)
    if (res.updated) bits.push('更新 ' + res.updated)
    if (res.removed) bits.push('移除 ' + res.removed)
    if (res.failed) bits.push(res.failed + ' 个解析失败（标题栏诊断按钮可看明细）')
    // 目录不可访问时主进程会跳过清理，必须告诉用户「不是曲库没了，是盘没连上」
    if (res.missingRoots && res.missingRoots.length) {
      bits.push(res.missingRoots.length + ' 个目录不可访问，已跳过清理')
    }
    toast(`扫描完成：${res.total} 首` + (bits.length ? `（${bits.join('，')}）` : ''), bits.length > 1 ? 4000 : 1800)
  } catch (err) {
    console.error('[scan]', err)
    UI.hideScan('scan')
    toast('扫描失败：' + err.message)
  } finally {
    scanning = false
    UI.hideScan('scan')
    // 诊断面板开着时同步刷新失败清单（扫描往往就是用户打开面板的原因）
    if (typeof Diag !== 'undefined' && Diag.isOpen()) Diag.loadFailures()
  }
}

function onScanProgress(p) {
  if (p.phase === 'collect') { UI.updateScan({ phase: 'collect', done: 0, total: 0 }); return }
  UI.updateScan({
    phase: 'parse',
    done: p.done,
    total: p.total,
    name: p.track ? p.track.title : ''
  })
}

/**
 * 主进程侧的扫描结束通知（首次启动自动建库、解析器升级重建曲库都会走这里）。
 * 自己发起的 doScan 有 await 兜着，这条只处理"后台扫描完成"的情况。
 */
async function onScanDone(res) {
  if (scanning) return
  // 第四轮 §4.4 #3：分析进行中不能重建表格/覆盖遮罩进度（两者共用一块遮罩）
  // v3.3.20：但不能把这次扫描结果直接扔掉 —— 分析结束后要补一次渲染，
  // 否则分析了 5 分钟期间新增的歌永远不出现（只能手动再扫或重启）。
  if (state.analyzing) { state.scanDonePending = true; return }
  // 目录不可访问时主进程会跳过清理，这种 scan-done 不能动队列
  if (res && res.skipped) return
  try {
    const tracks = await window.api.listTracks()
    setTracks(tracks)
    // 队列里已失效的曲目要剔除，否则点播放会指向不存在的文件。
    // v3.3.7：在线曲目（id 形如 on:src:id）永远不在 byId 里，必须放行 ——
    // 以前任何一次后台扫描都会把在线歌整批踢出队列、打断正在播的在线音乐
    if (player && player.tracks.length) {
      const curTrack = player.current
      const kept = player.tracks.filter((t) => state.byId.has(t.id) || t.online)
      if (kept.length !== player.tracks.length) {
        // v3.3.13：用对象引用定位 —— 队列含重复 id 时 findIndex(id) 会指向错误副本
        const idx = kept.indexOf(curTrack)
        if (idx < 0) {
          // 只有「当前曲确实被剔除」才重建队列（换曲、重排洗牌池）
          cancelSkipTimer()
          if (kept.length) player.setQueue(kept, Math.max(0, Math.min(player.index, kept.length - 1)), false)
          else player.stop()
        } else {
          // 当前曲还在：直接换 tracks，不打断播放。
          // v3.3.17：洗牌池里存的是**下标**，裁剪后所有下标都平移了 ——
          // 不重建的话随机模式会指向错的歌（同一首连播、有的整轮不出现）。
          // 第四轮 §4.4 #2：以前这里给的是「顺序下标」，随机模式整轮变顺序播放。
          // 用 _buildShufflePool() 真正重洗，并保持 index 指向同一首歌。
          // 同时用 byId 里的新对象替换旧引用，否则队列/播放条元数据与表格不一致。
          const newIdx = kept.indexOf(curTrack)
          player.tracks = kept.map((t) => state.byId.get(t.id) || t)
          player.index = newIdx >= 0 ? newIdx : idx
          player._buildShufflePool()
          player.emit('queue-change', player.tracks, player.index)
        }
      }
    }
    updateNavCounts()
    renderView()
    if (typeof Diag !== 'undefined' && Diag.isOpen()) Diag.loadFailures()
  } catch (err) {
    console.error('[scan-done]', err)
  }
}

