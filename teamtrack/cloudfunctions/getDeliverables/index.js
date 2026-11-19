// 云函数：getDeliverables
// 交付物读取统一走服务端：先校验团队成员身份，再按角色过滤
// guest（外部协作）只能读取本人上传的交付物，客户端不再承担过滤职责
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序', data: [] }
  }

  let { teamId, taskId, userId } = event
  const limit = Math.min(Math.max(Number(event.limit) || 100, 1), 100)

  try {
    // 1. 确定所属团队：任务维度先校验任务归属，团队维度直接使用 teamId
    if (taskId) {
      let task = null
      try {
        const taskRes = await db.collection('tasks').doc(taskId).get()
        task = taskRes.data
      } catch (e) {
        return { code: -1, message: '任务不存在', data: [] }
      }
      if (!task) return { code: -1, message: '任务不存在', data: [] }
      if (teamId && task.teamId !== teamId) {
        return { code: -403, message: '无权查看该任务的交付物', data: [] }
      }
      teamId = task.teamId
    }

    if (!teamId) return { code: -1, message: '缺少团队 ID', data: [] }

    // 2. 校验当前用户属于该团队
    const memberRes = await db.collection('members')
      .where({ teamId, openid })
      .limit(1)
      .get()
    const me = memberRes.data[0]
    if (!me) {
      return { code: -403, message: '你不在该团队中', data: [] }
    }

    // 3. 组装查询条件：任务维度用 taskId（兼容历史数据缺 teamId），团队维度用 teamId
    const where = taskId ? { taskId } : { teamId }

    if (me.role === 'guest') {
      // 外部协作不允许查看他人交付物，忽略传入的 userId
      if (userId && userId !== openid) {
        return { code: 0, data: [], role: me.role }
      }
      where.userId = openid
    } else if (userId) {
      where.userId = userId
    }

    const res = await db.collection('deliverables')
      .where(where)
      .orderBy('uploadedAt', 'desc')
      .limit(limit)
      .get()

    return { code: 0, data: res.data || [], role: me.role }
  } catch (err) {
    return { code: -1, message: '获取交付物失败: ' + (err.message || ''), data: [] }
  }
}