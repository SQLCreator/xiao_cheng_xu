// 云函数：reviewJoin
// 负责人审批入队申请：pass=true 通过（成为成员），false 拒绝
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
  const { requestId } = event
  const pass = event.pass === true

  if (!requestId) return { code: -1, message: '缺少申请 ID' }

  try {
    // 1. 申请记录
    let request
    try {
      const reqRes = await db.collection('joinRequests').doc(requestId).get()
      request = reqRes.data
    } catch (e) {
      return { code: -1, message: '申请不存在' }
    }
    if (!request) return { code: -1, message: '申请不存在' }
    if (request.status !== 'pending') {
      return { code: -1, message: '该申请已处理' }
    }

    // 2. 权限：负责人或管理员
    let team
    try {
      const teamRes = await db.collection('teams').doc(request.teamId).get()
      team = teamRes.data
    } catch (e) {
      return { code: -1, message: '团队不存在' }
    }
    const canManage = team && (team.captainId === openid ||
      (Array.isArray(team.adminIds) && team.adminIds.indexOf(openid) !== -1))
    if (!canManage) {
      return { code: -1, message: '只有负责人可以审批' }
    }

    if (!pass) {
      // 条件更新抢占申请，并发审批时只有一个调用能成功
      const rejected = await db.collection('joinRequests')
        .where({ _id: requestId, status: 'pending' })
        .update({
          data: {
            status: 'rejected',
            reviewedBy: openid,
            reviewedAt: new Date()
          }
        })
      if (!rejected.stats || rejected.stats.updated === 0) {
        return { code: -1, message: '该申请已处理' }
      }
      // 订阅消息：通知申请人未通过（失败不影响审批）
      try {
        await cloud.callFunction({
          name: 'notify',
          data: {
            internalKey: 'teamtrack_notify_internal_v1',
            type: 'joinResult',
            to: [request.openid],
            exclude: openid,
            payload: {
              teamName: team.name,
              result: '未通过',
              remark: '入队申请未通过'
            }
          }
        })
      } catch (e) {}
      return { code: 0, message: '已拒绝该申请' }
    }

    // 3. 通过：先条件更新抢占申请（pending → approved），并发下只有一个调用能继续
    const approved = await db.collection('joinRequests')
      .where({ _id: requestId, status: 'pending' })
      .update({
        data: {
          status: 'approved',
          reviewedBy: openid,
          reviewedAt: new Date()
        }
      })
    if (!approved.stats || approved.stats.updated === 0) {
      return { code: -1, message: '该申请已处理' }
    }

    // 4. 避免重复入队
    const memberRes = await db.collection('members').where({
      teamId: request.teamId,
      openid: request.openid
    }).get()

    if (memberRes.data.length === 0) {
      await db.collection('members').add({
        data: {
          teamId: request.teamId,
          userId: request.userId || '',
          openid: request.openid,
          nickName: request.nickName || '成员',
          avatarUrl: request.avatarUrl || '',
          role: 'member',
          contribution: 0,
          completedTasks: 0,
          ongoingTasks: 0,
          joinDate: new Date()
        }
      })

      await db.collection('teams').doc(request.teamId).update({
        data: { memberCount: _.inc(1) }
      })
    }

    // 5. 动态
    try {
      await db.collection('activities').add({
        data: {
          type: 'join',
          userId: request.openid,
          userName: request.nickName || '成员',
          taskTitle: '',
          taskId: '',
          teamId: request.teamId,
          detail: '已加入团队',
          time: new Date()
        }
      })
    } catch (e) {}

    // 订阅消息：通知申请人已通过（失败不影响审批）
    try {
      await cloud.callFunction({
        name: 'notify',
        data: {
          internalKey: 'teamtrack_notify_internal_v1',
          type: 'joinResult',
          to: [request.openid],
          exclude: openid,
          payload: {
            teamName: team.name,
            result: '已通过',
            remark: '已加入' + team.name
          }
        }
      })
    } catch (e) {}

    return { code: 0, message: '已通过申请' }
  } catch (err) {
    return { code: -1, message: '审批失败: ' + err.message }
  }
}
