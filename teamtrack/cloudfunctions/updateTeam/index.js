// 云函数：updateTeam
// 队长更新队伍信息（目前仅支持 currentStep 时间线进度）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }
  const { teamId, currentStep, joinMode } = event

  if (!teamId) {
    return { code: -1, message: '缺少队伍 ID' }
  }

  try {
    // 1. 查询队伍并鉴权（仅队长可修改）
    let team
    try {
      const teamRes = await db.collection('teams').doc(teamId).get()
      team = teamRes.data
    } catch (e) {
      return { code: -1, message: '队伍不存在' }
    }

    if (!team) {
      return { code: -1, message: '队伍不存在' }
    }

    // 负责人（所有者或管理员）可修改
    const canManage = team.captainId === openid ||
      (Array.isArray(team.adminIds) && team.adminIds.indexOf(openid) !== -1)
    if (!canManage) {
      return { code: -1, message: '只有负责人可以修改进度' }
    }

    // 2. 组装要更新的字段
    const data = {}

    if (currentStep !== undefined) {
      const maxStep = (Array.isArray(team.milestones) && team.milestones.length > 0)
        ? team.milestones.length
        : 6
      const step = Number(currentStep)
      if (!Number.isInteger(step) || step < 1 || step > maxStep) {
        return { code: -1, message: '步骤值无效' }
      }
      data.currentStep = step
    }

    if (joinMode !== undefined) {
      if (joinMode !== 'open' && joinMode !== 'approval') {
        return { code: -1, message: '入队方式无效' }
      }
      data.joinMode = joinMode
    }

    if (Object.keys(data).length === 0) {
      return { code: -1, message: '没有需要更新的内容' }
    }

    // 3. 更新团队
    await db.collection('teams').doc(teamId).update({ data })

    return {
      code: 0,
      data,
      message: '已更新'
    }
  } catch (err) {
    return {
      code: -1,
      message: '更新失败: ' + err.message
    }
  }
}
