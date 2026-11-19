// 云函数：getJoinRequests
// 负责人查看团队的待审批入队申请
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序', data: [] }
  }
  const { teamId } = event

  if (!teamId) return { code: -1, message: '缺少团队 ID', data: [] }

  try {
    // 鉴权：负责人或管理员
    let team
    try {
      const teamRes = await db.collection('teams').doc(teamId).get()
      team = teamRes.data
    } catch (e) {
      return { code: -1, message: '团队不存在', data: [] }
    }
    const canManage = team && (team.captainId === openid ||
      (Array.isArray(team.adminIds) && team.adminIds.indexOf(openid) !== -1))
    if (!canManage) {
      return { code: -1, message: '只有负责人可以查看申请', data: [] }
    }

    const res = await db.collection('joinRequests')
      .where({ teamId, status: 'pending' })
      .orderBy('createdAt', 'desc')
      .get()

    return { code: 0, data: res.data || [] }
  } catch (err) {
    return { code: -1, message: err.message, data: [] }
  }
}
