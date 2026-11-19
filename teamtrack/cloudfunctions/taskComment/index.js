// 云函数：taskComment
// 任务评论：action = 'add' 发表评论，action = 'list' 拉取评论列表
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  // 仅信任云端注入的 openid，不接受客户端传入
  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序', data: [] }
  }
  const action = event.action || 'add'
  const taskId = event.taskId

  if (!taskId) return { code: -1, message: '缺少任务 ID' }

  try {
    // 评论绑定任务，先确认任务存在且调用者属于该任务的队伍
    let task
    try {
      const taskRes = await db.collection('tasks').doc(taskId).get()
      task = taskRes.data
    } catch (e) {}
    if (!task) return { code: -1, message: '任务不存在' }

    const memberRes = await db.collection('members')
      .where({ teamId: task.teamId, openid })
      .limit(1)
      .get()
    if (!memberRes.data || memberRes.data.length === 0) {
      return { code: -403, message: '你不在该团队中，无法查看或发表评论', data: [] }
    }

    // 拉取评论列表（按时间正序，最多 100 条）
    if (action === 'list') {
      const res = await db.collection('comments')
        .where({ taskId })
        .orderBy('createdAt', 'asc')
        .limit(100)
        .get()
      return { code: 0, data: res.data || [], message: 'ok' }
    }

    // 发表评论
    const content = String(event.content || '').trim()
    if (!content) return { code: -1, message: '评论内容不能为空' }
    if (content.length > 500) return { code: -1, message: '评论最多 500 字' }

    // 取当前用户昵称（评论冗余存储，前端直接展示）
    let userName = '微信用户'
    try {
      const userRes = await db.collection('users').where({ openid }).get()
      if (userRes.data.length > 0) {
        userName = userRes.data[0].nickName
      }
    } catch (e) {}

    const createdAt = new Date()
    const result = await db.collection('comments').add({
      data: {
        taskId,
        teamId: task.teamId,
        openid,
        userName,
        content,
        createdAt
      }
    })

    // 记录动态（失败不影响评论）
    try {
      await db.collection('activities').add({
        data: {
          type: 'comment',
          userId: openid,
          userName,
          taskTitle: task.title,
          taskId,
          teamId: task.teamId,
          detail: content.slice(0, 30),
          time: createdAt
        }
      })
    } catch (e) {}

    return {
      code: 0,
      data: { commentId: result._id, userName, content, createdAt },
      message: '评论成功'
    }
  } catch (err) {
    return { code: -1, message: '操作失败: ' + err.message }
  }
}