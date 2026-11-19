// 云函数：reviewDeliverable
// 负责人逐份验收交付物：approve / reject
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
  const { deliverableId, comment } = event
  const pass = event.pass === true

  if (!deliverableId) return { code: -1, message: '缺少交付物 ID' }

  try {
    // 1. 交付物
    let deliverable
    try {
      const res = await db.collection('deliverables').doc(deliverableId).get()
      deliverable = res.data
    } catch (e) {
      return { code: -1, message: '交付物不存在' }
    }
    if (!deliverable) return { code: -1, message: '交付物不存在' }

    // 2. 找到所属团队（兼容历史数据缺 teamId 的情况）
    let teamId = deliverable.teamId
    if (!teamId && deliverable.taskId) {
      try {
        const taskRes = await db.collection('tasks').doc(deliverable.taskId).get()
        teamId = taskRes.data && taskRes.data.teamId
      } catch (e) {}
    }
    if (!teamId) return { code: -1, message: '无法确定所属团队' }

    // 3. 权限：负责人或管理员
    let team
    try {
      const teamRes = await db.collection('teams').doc(teamId).get()
      team = teamRes.data
    } catch (e) {
      return { code: -1, message: '团队不存在' }
    }
    const canManage = team && (team.captainId === openid ||
      (Array.isArray(team.adminIds) && team.adminIds.indexOf(openid) !== -1))
    if (!canManage) {
      return { code: -1, message: '只有负责人可以验收交付物' }
    }

    // 4. 条件更新：以读取到的状态作为条件，并发/重复验收只有一次生效
    const guard = deliverable.reviewStatus
      ? { _id: deliverableId, reviewStatus: deliverable.reviewStatus }
      : { _id: deliverableId, reviewStatus: _.exists(false) }

    const updateRes = await db.collection('deliverables').where(guard).update({
      data: {
        reviewStatus: pass ? 'approved' : 'rejected',
        reviewComment: comment || '',
        reviewerId: openid,
        reviewedAt: new Date()
      }
    })
    if (!updateRes.stats || updateRes.stats.updated === 0) {
      return { code: -1, message: '该交付物已被验收，请刷新后重试' }
    }

    return {
      code: 0,
      data: { reviewStatus: pass ? 'approved' : 'rejected' },
      message: pass ? '已通过' : '已驳回'
    }
  } catch (err) {
    return { code: -1, message: '验收失败: ' + err.message }
  }
}
