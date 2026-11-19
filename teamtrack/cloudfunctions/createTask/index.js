// 云函数：createTask
// 创建任务
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  // 仅信任云端注入的 openid，不接受客户端传入
  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }

  try {
    const teamId = event.teamId
    if (!teamId) return { code: -1, message: '缺少队伍 ID' }
    if (!String(event.title || '').trim()) return { code: -1, message: '任务标题不能为空' }

    // 只有队伍成员才能发布任务，避免往任意队伍塞任务
    const memberRes = await db.collection('members')
      .where({ teamId, openid })
      .limit(1)
      .get()
    if (!memberRes.data || memberRes.data.length === 0) {
      return { code: -403, message: '你不在该团队中，无法发布任务' }
    }

    // 1. 先查 user 拿 userName（供 task 冗余 createdByName 和 activity 复用）
    let userName = '微信用户'
    try {
      const userRes = await db.collection('users').where({ openid }).get()
      if (userRes.data.length > 0) {
        userName = userRes.data[0].nickName
      }
    } catch (e) {}

    // 积分由客户端提交，限制在合理区间，避免刷分
    const rawPoints = event.points == null ? 10 : Number(event.points)
    const points = Number.isFinite(rawPoints) ? Math.max(0, Math.min(100, rawPoints)) : 0

    // 2. 创建任务（冗余 createdByName 便于前端直接展示）
    const result = await db.collection('tasks').add({
      data: {
        teamId,
        title: event.title,
        description: event.description,
        category: event.category || '其他',
        status: 'pending',
        // 执行方式：claim=领取制，assign=指派制（需负责人指派成员）
        assignMode: event.assignMode === 'assign' ? 'assign' : 'claim',
        // 完成是否需要验收（验收通过后才计入贡献）
        requireReview: !!event.requireReview,
        assigneeId: null,
        assigneeName: null,
        assignees: [],
        deadline: event.deadline,
        points,
        deliverables: 0,
        createdBy: openid,
        createdByName: userName,
        attachments: event.attachments || [],
        createdAt: new Date()
      }
    })

    // 3. 记录动态（复用已查到的 userName）
    try {
      await db.collection('activities').add({
        data: {
          type: 'create',
          userId: openid,
          userName,
          taskTitle: event.title,
          taskId: result._id,
          teamId: event.teamId,
          time: new Date()
        }
      })
    } catch (e) {}

    return {
      code: 0,
      data: { taskId: result._id },
      message: '任务发布成功'
    }
  } catch (err) {
    return {
      code: -1,
      message: '发布失败: ' + err.message
    }
  }
}
