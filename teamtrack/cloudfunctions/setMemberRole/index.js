// 云函数：setMemberRole
// 负责人调整成员角色：member（正式成员）/ guest（外部协作，只能看自己的交付物）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }
  const { teamId, targetOpenid, role } = event

  if (!teamId || !targetOpenid) return { code: -1, message: '参数缺失' }
  if (role !== 'member' && role !== 'guest') {
    return { code: -1, message: '角色无效' }
  }

  try {
    // 1. 权限：负责人或管理员
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
      return { code: -1, message: '只有负责人可以调整成员角色' }
    }

    // 2. 不允许修改负责人自己
    if (team.captainId === targetOpenid) {
      return { code: -1, message: '不能修改负责人的角色' }
    }

    // 3. 更新成员角色
    const res = await db.collection('members').where({
      teamId,
      openid: targetOpenid
    }).update({
      data: { role }
    })

    if (!res.stats || res.stats.updated === 0) {
      return { code: -1, message: '该成员不存在' }
    }

    return {
      code: 0,
      data: { role },
      message: role === 'guest' ? '已设为外部协作' : '已设为正式成员'
    }
  } catch (err) {
    return { code: -1, message: '设置失败: ' + err.message }
  }
}
