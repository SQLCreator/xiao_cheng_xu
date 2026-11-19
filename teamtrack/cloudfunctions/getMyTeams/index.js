// 云函数：getMyTeams
// 获取当前用户加入的所有团队
// 统计口径：以 members 表为准（领取/完成/验收/退出都会同步维护），
// 不再从 tasks 反算，避免多人协作时只算到第一位负责人。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()
  const _ = db.command

  // 仅信任云端注入的 openid，不接受客户端传入
  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, data: [], message: '登录态无效，请重新进入小程序' }
  }

  try {
    // 1. 查询用户加入的所有团队成员记录
    const memberRes = await db.collection('members').where({ openid }).get()
    const memberships = memberRes.data

    if (memberships.length === 0) {
      return { code: 0, data: [] }
    }

    // 2. 批量查询团队信息
    const teamIds = memberships.map(m => m.teamId)
    const teamsResult = await db.collection('teams')
      .where({ _id: _.in(teamIds) })
      .get()

    // 3. 组装团队信息（统计取 members 表中本人在该团队的字段）
    const teams = teamsResult.data.map(team => {
      const myMember = memberships.find(m => m.teamId === team._id) || {}
      return {
        ...team,
        myRole: myMember.role || 'member',
        myContribution: myMember.contribution || 0,
        myCompletedTasks: myMember.completedTasks || 0,
        myOngoingTasks: myMember.ongoingTasks || 0
      }
    })

    return { code: 0, data: teams }
  } catch (err) {
    console.error('[getMyTeams] 获取失败', err)
    return { code: -1, data: [], message: err.message }
  }
}
