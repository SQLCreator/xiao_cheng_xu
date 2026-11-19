/**
 * 报表导出
 * 生成 CSV（Excel 可直接打开），写入本地临时目录后通过微信「发送给朋友」导出。
 * 纯函数构建内容，便于后续复用到其他页面。
 */

// 单元格转义：统一加引号，内部引号翻倍，去掉换行
function cell(value) {
  const s = value == null ? '' : String(value)
  const clean = s.replace(/"/g, '""').replace(/\r?\n/g, ' ')
  return `"${clean}"`
}

// 行数组 -> CSV 文本（带 BOM，避免 Excel 打开中文乱码）
function toCsv(rows) {
  const body = rows.map(r => r.map(cell).join(',')).join('\r\n')
  return '\uFEFF' + body
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmtDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return String(value)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fmtDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return String(value)
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function today() {
  return fmtDate(new Date())
}

// 任务负责人展示名（兼容多人）
function assigneeText(task) {
  if (Array.isArray(task.assignees) && task.assignees.length > 0) {
    return task.assignees.map(a => (a && a.nickName) || '成员').join('、')
  }
  return task.assigneeName || ''
}

const STATUS_TEXT = {
  pending: '待领取',
  in_progress: '进行中',
  reviewing: '待验收',
  completed: '已完成',
  expired: '已逾期'
}

/**
 * 任务清单
 */
function buildTasksCsv(team, tasks) {
  const rows = [
    ['任务标题', '类型', '状态', '负责人', '截止日期', '分值', '交付物数', '发布人', '创建时间']
  ]
  ;(tasks || []).forEach(t => {
    rows.push([
      t.title || '',
      t.category || '',
      STATUS_TEXT[t.status] || t.status || '',
      assigneeText(t),
      t.deadline || '',
      t.points || 0,
      t.deliverables || 0,
      t.createdByName || '',
      fmtDate(t.createdAt)
    ])
  })
  // 表头信息
  const header = [
    [`团队：${(team && team.name) || ''}`, `导出时间：${fmtDateTime(new Date())}`],
    [`任务总数：${(tasks || []).length}`]
  ]
  return toCsv(header.concat([[]]).concat(rows))
}

/**
 * 成员贡献
 */
function buildMembersCsv(team, members) {
  const rows = [
    ['成员', '角色', '贡献值', '已完成任务', '进行中任务', '加入时间']
  ]
  ;(members || []).forEach(m => {
    rows.push([
      m.nickName || '',
      m.role === 'captain' ? '负责人' : '成员',
      m.contribution || 0,
      m.completedTasks || 0,
      m.ongoingTasks || 0,
      fmtDate(m.joinDate)
    ])
  })
  const header = [
    [`团队：${(team && team.name) || ''}`, `导出时间：${fmtDateTime(new Date())}`],
    [`成员数：${(members || []).length}`]
  ]
  return toCsv(header.concat([[]]).concat(rows))
}

/**
 * 周报：概要 + 近 7 天完成的任务
 */
function buildWeeklyCsv(team, tasks, members) {
  const list = tasks || []
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000

  const completedThisWeek = list.filter(t => {
    if (t.status !== 'completed') return false
    const ts = t.completedAt ? new Date(t.completedAt).getTime() : 0
    return ts && ts >= since
  })

  const summary = [
    ['团队', (team && team.name) || ''],
    ['统计周期', `${fmtDate(since)} 至 ${fmtDate(new Date())}`],
    ['任务总数', list.length],
    ['已完成', list.filter(t => t.status === 'completed').length],
    ['进行中', list.filter(t => t.status === 'in_progress').length],
    ['待验收', list.filter(t => t.status === 'reviewing').length],
    ['待领取', list.filter(t => t.status === 'pending').length],
    ['成员数', (members || []).length],
    ['本周完成任务数', completedThisWeek.length]
  ]

  const rows = [
    ['本周完成的任务', '类型', '负责人', '完成时间', '分值']
  ]
  completedThisWeek.forEach(t => {
    rows.push([
      t.title || '',
      t.category || '',
      assigneeText(t),
      fmtDateTime(t.completedAt),
      t.points || 0
    ])
  })

  return toCsv(summary.concat([[]]).concat(rows))
}

/**
 * 写入本地并唤起微信「发送给朋友」导出
 * @param {string} fileName 带 .csv 后缀
 * @param {string} content CSV 文本
 */
function exportCsv(fileName, content) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager()
    const safeName = (fileName || 'report.csv').replace(/[\\/:*?"<>|]/g, '_')
    const filePath = `${wx.env.USER_DATA_PATH}/${safeName}`

    fs.writeFile({
      filePath,
      data: content,
      encoding: 'utf-8',
      success: () => {
        if (typeof wx.shareFileMessage !== 'function') {
          return reject(new Error('当前微信版本不支持导出文件，请升级微信'))
        }
        wx.shareFileMessage({
          filePath,
          fileName: safeName,
          success: () => resolve(filePath),
          fail: (err) => {
            // 用户主动取消不算异常
            if (err && err.errMsg && err.errMsg.indexOf('cancel') !== -1) {
              return resolve(filePath)
            }
            reject(new Error(err && err.errMsg ? err.errMsg : '导出失败'))
          }
        })
      },
      fail: (err) => reject(new Error(err && err.errMsg ? err.errMsg : '文件写入失败'))
    })
  })
}

module.exports = {
  buildTasksCsv,
  buildMembersCsv,
  buildWeeklyCsv,
  exportCsv,
  today
}
