// 云函数：joinTeam
// 通过邀请码加入团队
// - team.joinMode === 'approval'：先创建入队申请，等负责人审批
// - 其他（含老数据未设置）：直接加入
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
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
    const inviteCode = (event.inviteCode || '').toUpperCase().trim()

    if (!inviteCode) {
      return { code: -1, message: '邀请码不能为空' }
    }

    // 查询团队
    const teamRes = await db.collection('teams').where({ inviteCode }).get()

    if (teamRes.data.length === 0) {
      return { code: -1, message: '邀请码无效' }
    }

    const team = teamRes.data[0]

    // 邀请码有效期校验（历史队伍无 expire 字段时保持可用）
    if (isInviteCodeExpired(team)) {
      return { code: -1, message: '邀请码已过期，请联系负责人获取新的邀请码' }
    }

    // 检查是否已加入
    const memberRes = await db.collection('members').where({
      teamId: team._id,
      openid
    }).get()

    if (memberRes.data.length > 0) {
      return { code: -1, message: '你已加入该团队' }
    }

    // 获取用户信息（必须已注册，不应在此自动创建）
    let user = null
    try {
      const userRes = await db.collection('users').where({ openid }).get()
      if (userRes.data.length > 0) {
        user = userRes.data[0]
      }
    } catch (e) {}

    if (!user) {
      return { code: -1, message: '请先完成注册（登录并设置昵称）' }
    }

    // 需要审批：写入申请记录
    if (team.joinMode === 'approval') {
      const pendingRes = await db.collection('joinRequests').where({
        teamId: team._id,
        openid,
        status: 'pending'
      }).get()

      if (pendingRes.data.length > 0) {
        return {
          code: 0,
          data: { pending: true, teamId: team._id, teamName: team.name },
          message: '申请已提交，等待负责人审批'
        }
      }

      await db.collection('joinRequests').add({
        data: {
          teamId: team._id,
          teamName: team.name,
          openid,
          userId: user._id,
          nickName: user.nickName,
          avatarUrl: user.avatarUrl || '',
          status: 'pending',
          createdAt: new Date()
        }
      })

      return {
        code: 0,
        data: { pending: true, teamId: team._id, teamName: team.name },
        message: '申请已提交，等待负责人审批'
      }
    }

    // 免审批：直接加入
    // 成员记录使用 teamId + openid 派生的固定 _id：
    // 并发调用时只有一次能写入成功，避免同一用户重复入队、memberCount 多加
    try {
      await db.collection('members').add({
        data: {
          _id: buildMemberId(team._id, openid),
          teamId: team._id,
          userId: user._id,
          openid,
          nickName: user.nickName,
          avatarUrl: user.avatarUrl || '',
          role: 'member',
          contribution: 0,
          completedTasks: 0,
          ongoingTasks: 0,
          joinDate: new Date()
        }
      })
    } catch (e) {
      if (isDuplicateKey(e)) {
        return { code: -1, message: '你已加入该团队' }
      }
      throw e
    }

    // 更新团队成员数
    await db.collection('teams').doc(team._id).update({
      data: { memberCount: db.command.inc(1) }
    })

    return {
      code: 0,
      data: { pending: false, teamId: team._id, teamName: team.name },
      message: '加入成功'
    }
  } catch (err) {
    return {
      code: -1,
      message: '加入失败: ' + err.message
    }
  }
}

function isInviteCodeExpired(team) {
  if (!team || !team.inviteCodeExpireAt) return false
  const expireAt = new Date(team.inviteCodeExpireAt).getTime()
  return Number.isFinite(expireAt) && expireAt < Date.now()
}

// 成员记录固定 _id：同一队伍 + 同一用户唯一（md5 定长 32 位，满足 _id 长度限制）
function buildMemberId(teamId, openid) {
  return crypto.createHash('md5').update(teamId + '|' + openid).digest('hex')
}

// 判断是否为 _id 重复写入错误（并发重复入队）
function isDuplicateKey(err) {
  if (!err) return false
  const code = err.errCode || err.code
  if (code === -502001 || code === 11000) return true
  const msg = String(err.errMsg || err.message || '')
  return /duplicate|E11000|already exists|已存在|重复|冲突/i.test(msg)
}
