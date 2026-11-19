// 云函数：claimTask
// 领取任务（抢单）
// 事务内同时完成「任务 pending → in_progress」与 users/members 进行中任务数 +1，
// 并发下只有一个请求能抢占成功，且不会出现状态改了但计数没加（或反之）的部分成功
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

  const taskId = event.taskId
  if (!taskId) return { code: -1, message: '缺少任务 ID' }

  try {
    // 事务外先做一次校验，主要用于返回友好提示并获取 title/teamId
    let task
    try {
      const taskRes = await db.collection('tasks').doc(taskId).get()
      task = taskRes.data
    } catch (e) {
      return { code: -1, message: '任务不存在' }
    }
    if (!task) return { code: -1, message: '任务不存在' }

    if (task.status !== 'pending') {
      return { code: -1, message: '任务已被领取' }
    }

    // 指派制任务不允许自行领取，需要负责人指派
    if (task.assignMode === 'assign') {
      return { code: -1, message: '该任务为指派制，请联系负责人指派' }
    }

    // 已经指派了成员的，不能再被抢占
    if (Array.isArray(task.assignees) && task.assignees.length > 0) {
      return { code: -1, message: '任务已有负责人' }
    }

    // 事务内只能使用 doc 操作，先解析 users / members 的文档
    let user = null
    try {
      const userRes = await db.collection('users').where({ openid }).limit(1).get()
      user = userRes.data[0] || null
    } catch (e) {}
    const nickName = (user && user.nickName) || '微信用户'

    let memberDoc = null
    try {
      const memberRes = await db.collection('members')
        .where({ openid, teamId: task.teamId })
        .limit(1)
        .get()
      memberDoc = memberRes.data[0] || null
    } catch (e) {}

    // 只有任务所属队伍的成员才能领取，避免跨队抢单
    if (!memberDoc) {
      return { code: -403, message: '你不在该团队中，无法领取任务' }
    }

    try {
      await db.runTransaction(async transaction => {
        const freshRes = await transaction.collection('tasks').doc(taskId).get()
        const fresh = freshRes.data
        if (!fresh || fresh.status !== 'pending') {
          throw new Error('TASK_ALREADY_CLAIMED')
        }
        if (fresh.assignMode === 'assign') {
          throw new Error('TASK_ASSIGN_ONLY')
        }
        if (Array.isArray(fresh.assignees) && fresh.assignees.length > 0) {
          throw new Error('TASK_ALREADY_CLAIMED')
        }

        await transaction.collection('tasks').doc(taskId).update({
          data: {
            status: 'in_progress',
            assigneeId: openid,
            assigneeName: nickName,
            assignees: [{ openid, nickName }],
            claimedAt: new Date()
          }
        })

        if (user) {
          await transaction.collection('users').doc(user._id).update({
            data: { ongoingTasks: _.inc(1) }
          })
        }
        if (memberDoc) {
          await transaction.collection('members').doc(memberDoc._id).update({
            data: { ongoingTasks: _.inc(1) }
          })
        }
      })
    } catch (e) {
      const msg = String((e && (e.message || e.errMsg)) || '')
      if (msg.indexOf('TASK_ALREADY_CLAIMED') !== -1) {
        return { code: -1, message: '任务已被他人领取，请刷新后重试' }
      }
      if (msg.indexOf('TASK_ASSIGN_ONLY') !== -1) {
        return { code: -1, message: '该任务为指派制，请联系负责人指派' }
      }
      console.error('[claimTask] 事务执行失败', e)
      return { code: -1, message: '领取失败，请稍后重试' }
    }

    // 回查最新统计，前端用此直接更新缓存
    let updatedUser = null
    if (user) {
      try {
        const refreshed = await db.collection('users').doc(user._id).get()
        updatedUser = refreshed.data
      } catch (e) {}
    }

    // 记录动态（带 teamId 以便首页按队伍过滤）
    try {
      await db.collection('activities').add({
        data: {
          type: 'claim',
          userId: openid,
          userName: nickName,
          taskTitle: task.title,
          taskId,
          teamId: task.teamId,
          time: new Date()
        }
      })
    } catch (e) {}

    return { code: 0, message: '抢单成功', data: { user: updatedUser } }
  } catch (err) {
    return { code: -1, message: '领取失败: ' + err.message }
  }
}