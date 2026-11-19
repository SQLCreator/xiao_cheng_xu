// 云函数：createTeam
// 创建队伍，并自动将创建者设为队长
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 邀请码有效期（30 天）
const INVITE_CODE_TTL = 30 * 24 * 60 * 60 * 1000
const INVITE_CODE_MAX_RETRY = 5

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  // 仅信任云端注入的 openid，不接受客户端传入
  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }

  try {
    // 1. 先校验用户已注册，避免先建队伍后报错留下无主队伍
    let user = null
    try {
      const userRes = await db.collection('users').where({ openid }).limit(1).get()
      user = userRes.data[0] || null
    } catch (e) {
      console.warn('[createTeam] 查询用户失败', e)
    }
    if (!user) {
      return { code: -1, message: '请先完成注册（登录并设置昵称）' }
    }

    // 2. 生成未被占用的邀请码（冲突时重试）
    let inviteCode = ''
    for (let i = 0; i < INVITE_CODE_MAX_RETRY; i++) {
      const candidate = generateInviteCode()
      const exists = await db.collection('teams').where({ inviteCode: candidate }).limit(1).get()
      if (!exists.data || exists.data.length === 0) {
        inviteCode = candidate
        break
      }
    }
    if (!inviteCode) {
      return { code: -1, message: '邀请码生成失败，请稍后重试' }
    }

    const now = new Date()

    // 3. 创建队伍
    const teamResult = await db.collection('teams').add({
      data: {
        name: event.name,
        // category：团队类型（研发 / 竞赛 / 运营等，由前端选择）
        category: event.category || event.competition || '',
        // 阶段快照：创建后固定，后续可在团队内单独调整
        milestones: Array.isArray(event.milestones) ? event.milestones : [],
        description: event.description || '',
        deadline: event.deadline || '',
        captainId: openid,
        memberCount: 1,
        progress: 0,
        currentStep: 1,
        // 入队方式：approval=需负责人审批，open=邀请码直接加入
        joinMode: event.joinMode || 'approval',
        inviteCode,
        inviteCodeExpireAt: new Date(now.getTime() + INVITE_CODE_TTL),
        createdAt: now
      }
    })

    // 4. 添加队长为队伍成员；失败则清理刚创建的队伍，避免留下无成员队伍
    try {
      await db.collection('members').add({
        data: {
          teamId: teamResult._id,
          userId: user._id,
          openid,
          nickName: user.nickName,
          avatarUrl: user.avatarUrl || '',
          role: 'captain',
          contribution: 0,
          completedTasks: 0,
          ongoingTasks: 0,
          joinDate: new Date()
        }
      })
    } catch (e) {
      console.error('[createTeam] 添加队长失败，回滚队伍', e)
      try {
        await db.collection('teams').doc(teamResult._id).remove()
      } catch (e2) {}
      return { code: -1, message: '创建失败，请稍后重试' }
    }

    // 5. 不再全局修改 users.role：角色属于成员维度（members.role），
    //    避免用户加入多个队伍时全局角色互相覆盖

    return {
      code: 0,
      data: {
        teamId: teamResult._id,
        inviteCode
      },
      message: '队伍创建成功'
    }
  } catch (err) {
    return {
      code: -1,
      message: '创建失败: ' + err.message
    }
  }
}

function generateInviteCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}