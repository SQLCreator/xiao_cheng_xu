// 云函数：reviewTask
// 负责人验收任务：pass=true 通过（计贡献），pass=false 驳回（退回进行中）
// 通过路径使用事务：任务状态与贡献结算要么全部成功，要么全部回滚，重复调用不会重复加分
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()
  const _ = db.command

  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }
  const { taskId, comment } = event
  const pass = event.pass === true

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

    if (task.status !== 'reviewing') {
      return { code: -1, message: '只有待验收的任务可以验收' }
    }

    // 权限：队伍负责人或管理员
    let team
    try {
      const teamRes = await db.collection('teams').doc(task.teamId).get()
      team = teamRes.data
    } catch (e) {
      return { code: -1, message: '队伍不存在' }
    }
    if (!team) return { code: -1, message: '队伍不存在' }

    const isManager = team.captainId === openid ||
      (Array.isArray(team.adminIds) && team.adminIds.indexOf(openid) !== -1)
    if (!isManager) {
      return { code: -1, message: '只有负责人可以验收' }
    }

    // 驳回：条件更新，保证并发下只有一次生效；成功后再生效通知与动态
    if (!pass) {
      const updateRes = await db.collection('tasks').where({
        _id: taskId,
        status: 'reviewing'
      }).update({
        data: {
          status: 'in_progress',
          reviewComment: comment || '',
          reviewerId: openid,
          reviewedAt: new Date(),
          rejectCount: _.inc(1)
        }
      })
      if (!updateRes.stats || updateRes.stats.updated === 0) {
        return { code: -1, message: '该任务已被处理，请刷新后重试' }
      }

      // 订阅消息：通知任务负责人验收未通过（失败不影响主流程）
      try {
        const targets = (Array.isArray(task.assignees) && task.assignees.length > 0)
          ? task.assignees.map(a => a && a.openid).filter(Boolean)
          : [task.assigneeId].filter(Boolean)
        await cloud.callFunction({
          name: 'notify',
          data: {
            internalKey: 'teamtrack_notify_internal_v1',
            type: 'reviewResult',
            to: targets,
            exclude: openid,
            payload: {
              taskId,
              taskTitle: task.title,
              result: '未通过',
              remark: comment || '请修改后重新提交'
            }
          }
        })
      } catch (e) {}

      try {
        await db.collection('activities').add({
          data: {
            type: 'reject',
            userId: openid,
            userName: '负责人',
            taskTitle: task.title,
            taskId,
            teamId: task.teamId,
            detail: comment || '',
            time: new Date()
          }
        })
      } catch (e) {}
      return { code: 0, message: '已驳回' }
    }

    // 通过：结算贡献
    const assignees = Array.isArray(task.assignees) && task.assignees.length > 0
      ? task.assignees.filter(a => a && a.openid)
      : (task.assigneeId ? [{ openid: task.assigneeId }] : [])
    if (assignees.length === 0) {
      return { code: -1, message: '任务没有负责人，无法结算' }
    }

    const points = Number(task.points) || 0
    const base = Math.floor(points / assignees.length)
    const shares = assignees.map((a, i) => base + (i === 0 ? points - base * assignees.length : 0))

    // 事务内只能使用 doc 操作，先解析 users / members 的文档 ID
    const userDocs = []
    const memberDocs = []
    for (const a of assignees) {
      const [uRes, mRes] = await Promise.all([
        db.collection('users').where({ openid: a.openid }).limit(1).get(),
        db.collection('members').where({ openid: a.openid, teamId: task.teamId }).limit(1).get()
      ])
      userDocs.push(uRes.data[0] || null)
      memberDocs.push(mRes.data[0] || null)
    }

    try {
      await db.runTransaction(async transaction => {
        const freshRes = await transaction.collection('tasks').doc(taskId).get()
        if (!freshRes.data || freshRes.data.status !== 'reviewing') {
          throw new Error('TASK_ALREADY_REVIEWED')
        }

        await transaction.collection('tasks').doc(taskId).update({
          data: {
            status: 'completed',
            completedAt: new Date(),
            reviewComment: comment || '',
            reviewerId: openid,
            reviewedAt: new Date()
          }
        })

        for (let i = 0; i < assignees.length; i++) {
          const statData = {
            contribution: _.inc(shares[i]),
            completedTasks: _.inc(1),
            ongoingTasks: _.inc(-1)
          }
          if (userDocs[i]) {
            await transaction.collection('users').doc(userDocs[i]._id).update({ data: statData })
          }
          if (memberDocs[i]) {
            await transaction.collection('members').doc(memberDocs[i]._id).update({ data: statData })
          }
        }
      })
    } catch (e) {
      const msg = String((e && (e.message || e.errMsg)) || '')
      if (msg.indexOf('TASK_ALREADY_REVIEWED') !== -1) {
        return { code: -1, message: '该任务已被验收，请刷新后重试' }
      }
      console.error('[reviewTask] 事务执行失败', e)
      return { code: -1, message: '验收失败，请稍后重试' }
    }

    try {
      await db.collection('activities').add({
        data: {
          type: 'complete',
          userId: openid,
          userName: '负责人',
          taskTitle: task.title,
          taskId,
          teamId: task.teamId,
          detail: '验收通过',
          time: new Date()
        }
      })
    } catch (e) {}

    // 订阅消息：通知任务负责人验收通过（失败不影响主流程）
    try {
      await cloud.callFunction({
        name: 'notify',
        data: {
          internalKey: 'teamtrack_notify_internal_v1',
          type: 'reviewResult',
          to: assignees.map(a => a.openid),
          exclude: openid,
          payload: {
            taskId,
            taskTitle: task.title,
            result: '已通过',
            remark: comment || ('获得 ' + points + ' 贡献值')
          }
        }
      })
    } catch (e) {}

    return { code: 0, data: { points }, message: '验收通过，任务已完成' }
  } catch (err) {
    return { code: -1, message: '验收失败: ' + err.message }
  }
}