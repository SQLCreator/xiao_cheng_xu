// 云函数：submitTask
// 任务负责人提交验收（in_progress -> reviewing）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }
  const { taskId, note } = event

  if (!taskId) return { code: -1, message: '缺少任务 ID' }

  try {
    let task
    try {
      const taskRes = await db.collection('tasks').doc(taskId).get()
      task = taskRes.data
    } catch (e) {
      return { code: -1, message: '任务不存在' }
    }
    if (!task) return { code: -1, message: '任务不存在' }

    if (task.status !== 'in_progress') {
      return { code: -1, message: '只有进行中的任务可以提交验收' }
    }

    // 只有负责人本人可以提交
    const isAssignee = task.assigneeId === openid ||
      (Array.isArray(task.assignees) && task.assignees.some(a => a && a.openid === openid))
    if (!isAssignee) {
      return { code: -1, message: '只有任务负责人可以提交验收' }
    }

    await db.collection('tasks').doc(taskId).update({
      data: {
        status: 'reviewing',
        submitNote: note || '',
        submittedAt: new Date()
      }
    })

    try {
      await db.collection('activities').add({
        data: {
          type: 'submit',
          userId: openid,
          userName: '成员',
          taskTitle: task.title,
          taskId,
          teamId: task.teamId,
          time: new Date()
        }
      })
    } catch (e) {}

    // 订阅消息：提醒队伍负责人/管理员验收（失败不影响提交）
    try {
      const teamRes = await db.collection('teams').doc(task.teamId).get()
      const team = teamRes.data || {}
      const me = (Array.isArray(task.assignees) ? task.assignees : [])
        .find(a => a && a.openid === openid)
      const targets = [team.captainId].concat(Array.isArray(team.adminIds) ? team.adminIds : [])
      await cloud.callFunction({
        name: 'notify',
        data: {
          internalKey: 'teamtrack_notify_internal_v1',
          type: 'reviewNeeded',
          to: targets,
          exclude: openid,
          payload: {
            taskId,
            taskTitle: task.title,
            teamName: team.name,
            userName: (me && me.nickName) || '成员',
            time: new Date(),
            remark: '已提交验收，待你处理'
          }
        }
      })
    } catch (e) {}

    return { code: 0, message: '已提交，等待验收' }
  } catch (err) {
    return { code: -1, message: '提交失败: ' + err.message }
  }
}
