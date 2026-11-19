/**
 * 待办聚合
 * 把小程序的订阅消息限制绕开：不依赖推送，进入小程序即可看到「今天该做什么」
 * 同时为 tabBar 任务入口提供红点数量
 */

const permission = require('./permission')
const util = require('./util')

const MAX_ITEMS = 3
const TAB_INDEX_TASKS = 1

function isOverdue(task, now) {
  if (!task || !task.deadline || task.status === 'completed') return false
  const time = new Date(task.deadline).getTime()
  return Number.isFinite(time) && time < now
}

/**
 * 计算当前用户待办
 * @param {Array} tasks 当前队伍任务
 * @param {Object} team 当前队伍
 * @param {string} openid 当前用户
 * @param {{canManage?:boolean}} [options] 可显式传入管理权限，避免为拿 team 再发一次请求
 * @returns {{count:number, items:Array}}
 */
function build(tasks, team, openid, options) {
  const now = Date.now()
  const canManage = options && typeof options.canManage === 'boolean'
    ? options.canManage
    : permission.canManageTeam(team, openid)
  const items = []

  ;(tasks || []).forEach(task => {
    if (!task || task.status === 'completed') return

    let type = ''
    if (task.status === 'reviewing' && canManage) {
      type = 'review'
    } else if (isOverdue(task, now) && (canManage || permission.isAssignee(task, openid))) {
      type = 'overdue'
    } else if (permission.isAssignee(task, openid)) {
      type = 'submit'
    }
    if (!type) return

    const countdown = util.getCountdown(task.deadline) || {}
    const assignees = permission.assigneeList(task).map(a => a.nickName).filter(Boolean)

    items.push({
      key: task._id + '_' + type,
      taskId: task._id,
      title: task.title || '未命名任务',
      type,
      typeText: type === 'review'
        ? '待验收'
        : (type === 'overdue'
          ? '已逾期'
          : (task.status === 'pending' ? '待开始' : '待提交')),
      tagClass: 'todo-tag-' + type,
      metaText: [
        type === 'review' ? '队友已提交，等你确认' : (assignees.length ? '负责人：' + assignees.join('、') : ''),
        countdown.text || '',
        task.points ? task.points + ' 分' : ''
      ].filter(Boolean).join(' · '),
      urgent: !!countdown.urgent,
      expired: !!countdown.expired
    })
  })

  // 逾期优先，其次待验收，最后待提交；同类型内紧急的靠前
  const rank = { overdue: 0, review: 1, submit: 2 }
  items.sort((a, b) => {
    if (rank[a.type] !== rank[b.type]) return rank[a.type] - rank[b.type]
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1
    return 0
  })

  return {
    count: items.length,
    items: items.slice(0, MAX_ITEMS)
  }
}

/**
 * 同步任务 tab 红点
 * @param {number} count
 */
function syncBadge(count) {
  try {
    if (count > 0) {
      wx.setTabBarBadge({
        index: TAB_INDEX_TASKS,
        text: count > 99 ? '99+' : String(count),
        fail: () => {}
      })
    } else {
      wx.removeTabBarBadge({ index: TAB_INDEX_TASKS, fail: () => {} })
    }
  } catch (e) {}
}

module.exports = {
  build,
  syncBadge
}