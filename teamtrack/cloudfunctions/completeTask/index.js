// 云函数：completeTask
// 完成任务（仅适用于不需要验收的任务）
// 多人协作时按人数平分分值，users 与 members 两处统计同步
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()
  const _ = db.command

  // 仅信任云端注入的 openid，不接受客户端传入
  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }

  try {
    // 获取任务信息
    const taskRes = await db.collection('tasks').doc(event.taskId).get()
    const task = taskRes.data

    if (task.status !== 'in_progress') {
      return { code: -1, message: '任务状态异常' }
    }

    // 需要验收的任务必须走 submitTask + reviewTask，不能直接完成
    if (task.requireReview) {
      return { code: -1, message: '该任务需要验收，请提交验收' }
    }

    const teamId = task.teamId
    const points = Number(task.points) || 0

    // 负责人（兼容单人 assigneeId 与多人 assignees）
    const assignees = Array.isArray(task.assignees) && task.assignees.length > 0
      ? task.assignees.filter(a => a && a.openid)
      : (task.assigneeId ? [{ openid: task.assigneeId, nickName: task.assigneeName }] : [])

    if (assignees.length === 0) {
      return { code: -1, message: '任务没有负责人' }
    }

    // 只有任务负责人本人可以完成，防止任意成员代完成并刷分
    if (!assignees.some(a => a.openid === openid)) {
      return { code: -1, message: '只有任务负责人可以完成任务' }
    }

    // 条件更新：并发/重复提交时只有一次能成功，避免重复加分
    const updateRes = await db.collection('tasks').where({
      _id: event.taskId,
      status: 'in_progress'
    }).update({
      data: {
        status: 'completed',
        completedAt: new Date()
      }
    })
    if (!updateRes.stats || updateRes.stats.updated === 0) {
      return { code: -1, message: '任务状态已变更，请刷新后重试' }
    }

    // 平分分值（余数给第一位）
    const base = Math.floor(points / assignees.length)
    let updatedUser = null

    for (let i = 0; i < assignees.length; i++) {
      const a = assignees[i]
      const share = base + (i === 0 ? points - base * assignees.length : 0)

      try {
        const userRes = await db.collection('users').where({ openid: a.openid }).get()
        if (userRes.data.length > 0) {
          const uid = userRes.data[0]._id
          await db.collection('users').doc(uid).update({
            data: {
              contribution: _.inc(share),
              completedTasks: _.inc(1),
              ongoingTasks: _.inc(-1)
            }
          })
          // 操作者本人的最新统计回传前端，省一次刷新
          if (a.openid === openid) {
            const refreshed = await db.collection('users').doc(uid).get()
            updatedUser = refreshed.data
          }
        }
      } catch (e) {
        console.warn('[completeTask] 更新用户统计失败', e)
      }

      try {
        await db.collection('members').where({
          openid: a.openid,
          teamId
        }).update({
          data: {
            contribution: _.inc(share),
            completedTasks: _.inc(1),
            ongoingTasks: _.inc(-1)
          }
        })
      } catch (e) {
        console.warn('[completeTask] 更新成员统计失败', e)
      }
    }

    // 记录动态（带 teamId 以便首页按团队过滤）
    try {
      const me = assignees.find(a => a.openid === openid)
      await db.collection('activities').add({
        data: {
          type: 'complete',
          userId: openid,
          userName: (me && me.nickName) || '成员',
          taskTitle: task.title,
          taskId: event.taskId,
          teamId,
          time: new Date()
        }
      })
    } catch (e) {}

    return { code: 0, message: '任务已完成', data: { points, user: updatedUser } }
  } catch (err) {
    return { code: -1, message: '操作失败: ' + err.message }
  }
}
