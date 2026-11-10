'use strict'
/**
 * 长音轨断点续播（v1.6）
 *
 * 只对超过 10 分钟的音轨生效（有声书 / 讲座 / 交响乐）。普通歌曲每次从头放
 * 才是用户的正常预期，所以不做「所有歌曲都记住位置」。
 *
 * 位置存在 settings.resumePos，随 data\ 目录一起迁移。
 */

const RESUME_MIN_DURATION = 600   // 秒
const RESUME_MIN_POS = 30         // 少于 30 秒当作「刚开头」，不记

/** 播放器在切歌 / 暂停 / 定时保存时调用，把位置写进设置（带去抖与变化阈值） */
function rememberResume(id, pos) {
  // 第四轮 §4.6：NaN / 负数没有校验 —— NaN 落盘会变成 JSON null，读回来又是 NaN
  if (!Number.isFinite(pos) || pos < 0) return
  const t = state.byId.get(id)
  if (!t) return
  const dur = t.duration || 0
  if (!dur || dur < RESUME_MIN_DURATION) return
  if (pos < RESUME_MIN_POS || pos > dur - 20) {
    // 刚开头或快听完了：清掉记录，下次从头开始
    if (state.resumePos[id] !== undefined) {
      delete state.resumePos[id]
      saveSettings({ resumePos: state.resumePos })
    }
    return
  }
  // 变化不到 25 秒不写盘：saveSession 每 10 秒一次，没必要每次全量写 settings.json
  if (Math.abs((state.resumePos[id] || 0) - pos) < 25) return
  state.resumePos[id] = Math.round(pos)
  saveSettings({ resumePos: state.resumePos })
}

/** 换曲时调用：有断点就 seek 过去（duration 未知时 player.seek 会挂起等 loadedmetadata） */
function restoreResumePos(track) {
  if (state.restoringSession) return   // 启动恢复由 session.currentTime 负责，别叠加
  const pos = state.resumePos[track.id]
  if (!pos) return
  const dur = track.duration || 0
  if (!dur || dur < RESUME_MIN_DURATION) return
  if (pos < RESUME_MIN_POS || pos > dur - 20) return
  player.seek(pos)
  toast('已从 ' + fmtTime(pos) + ' 继续播放')
}
