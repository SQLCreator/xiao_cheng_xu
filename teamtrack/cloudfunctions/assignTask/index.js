// 云函数：assignTask
// 负责人/管理员指派任务成员（可多人协作），也用于改派
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
  const { taskId } = event
  const assignees = Array.isArray(event.assignees)
    ? event.assignees.filter(a => a && a.openid)
    : []

  if (!taskId) return { code: -1, message: '缺少任务 ID' }
  if (assignees.length === 0) return { code: -1, message: '请至少选择一位成员' }

  try {
    // 1. 任务
    let task
    try {
      const taskRes = await db.collection('tasks').doc(taskId).get()
      task = taskRes.data
    } catch (e) {
      return { code: -1, message: '任务不存在' }
    }
    if (!task) return { code: -1, message: '任务不存在' }
    if (task.status === 'reviewing' || task.status === 'completed') {
      return { code: -1, message: '当前状态不能改派' }
    }

    // 2. 队伍与权限：负责人或管理员
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
      return { code: -1, message: '只有负责人可以指派成员' }
    }

    // 被指派人必须是本队成员：既避免跨队指派，也避免污染他人进行中计数
    const targetOpenids = assignees.map(a => a.openid).filter(Boolean)
    if (targetOpenids.length === 0) {
      return { code: -1, message: '请至少选择一位成员' }
    }
    const memberRes = await db.collection('members')
      .where({
        teamId: task.teamId,
        openid: _.in(targetOpenids)
      })
      .get()
    const memberMap = {}
    const memberList = memberRes.data || []
    memberList.forEach(m => { memberMap[m.openid] = m })

    const invalid = assignees.filter(a => !memberMap[a.openid])
    if (invalid.length > 0) {
      return { code: -403, message: '指派对象不属于该队伍，无法指派' }
    }

    // 昵称以成员表为准，避免客户端伪造；同时去重防止计数重复累加
    const seen = new Set()
    const validAssignees = []
    assignees.forEach(a => {
      if (seen.has(a.openid)) return
      seen.add(a.openid)
      validAssignees.push({
        openid: a.openid,
        nickName: memberMap[a.openid].nickName || a.nickName || '成员'
      })
    })

    // 3. 扣回原负责人的进行中计数（改派场景）
    const prev = Array.isArray(task.assignees) && task.assignees.length > 0
      ? task.assignees
      : (task.assigneeId ? [{ openid: task.assigneeId }] : [])
    if (prev.length > 0) {
      for (const p of prev) {
        if (!p.openid) continue
        try {
          await db.collection('users').where({ openid: p.openid }).update({
            data: { ongoingTasks: _.inc(-1) }
          })
          await db.collection('members').where({
            openid: p.openid,
            teamId: task.teamId
          }).update({ data: { ongoingTasks: _.inc(-1) } })
        } catch (e) {}
      }
    }

    // 4. 更新任务
    await db.collection('tasks').doc(taskId).update({
      data: {
        assignMode: 'assign',
        assignees: validAssignees,
        assigneeId: validAssignees[0].openid,
        assigneeName: validAssignees[0].nickName || '负责人',
        status: 'in_progress',
        assignedAt: new Date()
      }
    })

    // 5. 新负责人的进行中计数 +1
    for (const a of validAssignees) {
      try {
        await db.collection('users').where({ openid: a.openid }).update({
          data: { ongoingTasks: _.inc(1) }
        })
      } catch (e) {}
      try {
        await db.collection('members').where({
          openid: a.openid,
          teamId: task.teamId
        }).update({ data: { ongoingTasks: _.inc(1) } })
      } catch (e) {}
    }

    // 6. 动态
    try {
      const names = validAssignees.map(a => a.nickName || '成员').join('、')
      await db.collection('activities').add({
        data: {
          type: 'assign',
          userId: openid,
          userName: '负责人',
          taskTitle: task.title,
          taskId,
          teamId: task.teamId,
          detail: `指派给 ${names}`,
          time: new Date()
        }
      })
    } catch (e) {}

    // 7. 订阅消息：通知被指派人（失败不影响指派结果）
    try {
      await cloud.callFunction({
        name: 'notify',
        data: {
          internalKey: 'teamtrack_notify_internal_v1',
          type: 'taskAssigned',
          to: validAssignees.map(a => a.openid),
          exclude: openid,
          payload: {
            taskId,
            taskTitle: task.title,
            teamName: team.name,
            time: new Date(),
            remark: task.deadline ? '截止 ' + task.deadline : '请及时查看任务详情'
          }
        }
      })
    } catch (e) {}

    return { code: 0, data: { assignees }, message: '指派成功' }
  } catch (err) {
    return { code: -1, message: '指派失败: ' + err.message }
  }
}
