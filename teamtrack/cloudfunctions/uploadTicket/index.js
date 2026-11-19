// 云函数：uploadTicket
// 为「电脑端上传」生成一次性上传码。
// 小程序端 action=create 生成；H5 通过 webUpload 云函数用上传码换取任务信息并提交交付物。
//
// 数据集合：uploadTickets（首次写入时自动尝试创建）
// {
//   _id: 上传码,
//   taskId, teamId, taskTitle,
//   userId, userName,          // 生成者，H5 提交时以此身份记账
//   createdAt, expiresAt,
//   used, usedAt, deliverableId
// }
const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const COLLECTION = 'uploadTickets'
const TICKET_TTL = 2 * 60 * 60 * 1000 // 2 小时
// 去掉容易混淆的 0/O/1/I
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function genCode() {
  const bytes = crypto.randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return code
}

async function ensureCollection(db) {
  try {
    await db.createCollection(COLLECTION)
  } catch (e) {
    // 已存在时忽略
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const db = cloud.database()
  const action = (event && event.action) || 'create'

  // 只信任云端注入的 openid
  if (!OPENID) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }

  try {
    if (action !== 'create') {
      return { code: -1, message: '未知操作' }
    }

    const taskId = event && event.taskId
    if (!taskId) {
      return { code: -1, message: '缺少任务 ID' }
    }

    let task = null
    try {
      task = (await db.collection('tasks').doc(taskId).get()).data
    } catch (e) {}
    if (!task) {
      return { code: -1, message: '任务不存在' }
    }
    if (task.status === 'completed') {
      return { code: -1, message: '任务已完成，无需再上传' }
    }

    // 与 uploadDeliverable 保持一致：任务所属队伍的成员可以上传
    const memberRes = await db.collection('members')
      .where({ teamId: task.teamId, openid: OPENID })
      .limit(1)
      .get()
    if (!memberRes.data || memberRes.data.length === 0) {
      return { code: -403, message: '你不在该团队中，无法上传交付物' }
    }

    let userName = '微信用户'
    try {
      const userRes = await db.collection('users').where({ openid: OPENID }).limit(1).get()
      if (userRes.data.length > 0) {
        userName = userRes.data[0].nickName || userName
      }
    } catch (e) {}

    const now = Date.now()
    const base = {
      taskId,
      teamId: task.teamId,
      taskTitle: task.title || '未命名任务',
      userId: OPENID,
      userName,
      createdAt: new Date(now),
      expiresAt: new Date(now + TICKET_TTL),
      used: false,
      usedAt: null,
      deliverableId: ''
    }

    // 上传码碰撞时重试；集合不存在时先建集合
    let code = ''
    for (let i = 0; i < 5; i++) {
      const candidate = genCode()
      try {
        await db.collection(COLLECTION).doc(candidate).set({ data: base })
        code = candidate
        break
      } catch (e) {
        const errCode = String(e.errCode || '')
        const errMsg = String(e.message || '')
        if (errCode === '-502005' || errMsg.indexOf('collection') !== -1 || errMsg.indexOf('COLLECTION') !== -1) {
          await ensureCollection(db)
        }
      }
    }

    if (!code) {
      return { code: -1, message: '生成上传码失败，请稍后再试' }
    }

    return {
      code: 0,
      data: {
        code,
        taskId,
        taskTitle: base.taskTitle,
        expireAt: now + TICKET_TTL,
        expireHours: 2
      }
    }
  } catch (err) {
    return { code: -1, message: '生成上传码失败: ' + (err.message || '') }
  }
}