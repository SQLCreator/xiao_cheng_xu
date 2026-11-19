// 云函数：uploadDeliverable
// 记录交付物信息（文件已通过客户端 wx.cloud.uploadFile 上传到云存储）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()
  const _ = db.command

  // 仅信任云端注入的 openid，不接受客户端传入
  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }

  try {
    const { taskId, fileName, fileID, size, isLink, linkUrl } = event

    // 获取用户名
    let userName = '微信用户'
    try {
      const userRes = await db.collection('users').where({ openid }).get()
      if (userRes.data.length > 0) {
        userName = userRes.data[0].nickName
      }
    } catch (e) {}

    // 查询任务以获取 teamId 和标题；任务不存在则拒绝写入，避免产生无归属的交付物
    let task = null
    try {
      const taskRes = await db.collection('tasks').doc(taskId).get()
      task = taskRes.data
    } catch (e) {}
    if (!task) {
      return { code: -1, message: '任务不存在' }
    }

    // 只有任务所属队伍的成员才能上传交付物，防止跨队写入
    const memberRes = await db.collection('members')
      .where({ teamId: task.teamId, openid })
      .limit(1)
      .get()
    if (!memberRes.data || memberRes.data.length === 0) {
      return { code: -403, message: '你不在该团队中，无法上传交付物' }
    }

    // 版本号：在事务里对任务文档的 deliverableSeq 原子自增，
    // 避免并发上传读到相同条数而出现重复版本号
    let version = 1
    try {
      const nextVersion = await db.runTransaction(async transaction => {
        const taskRef = transaction.collection('tasks').doc(taskId)
        const taskRes = await taskRef.get()
        const data = taskRes.data || {}
        const next = (data.deliverableSeq || data.deliverables || 0) + 1
        await taskRef.update({ data: { deliverableSeq: next } })
        return next
      })
      if (!Number.isFinite(nextVersion)) throw new Error('NO_VERSION')
      version = nextVersion
    } catch (e) {
      // 事务失败时退回按条数计算，不阻断上传
      try {
        const existing = await db.collection('deliverables').where({ taskId }).get()
        version = existing.data.length + 1
      } catch (_) {}
    }

    // 写入交付物记录
    const record = await db.collection('deliverables').add({
      data: {
        taskId,
        teamId: task.teamId,
        userId: openid,
        userName,
        fileName,
        fileID: fileID || '',
        fileUrl: linkUrl || '',
        isLink: !!isLink,
        version,
        size: size || '未知',
        // 交付物验收状态：pending | approved | rejected（由负责人逐份验收）
        reviewStatus: 'pending',
        uploadedAt: new Date()
      }
    })

    // 更新任务的交付物计数
    try {
      if (task) {
        await db.collection('tasks').doc(taskId).update({
          data: { deliverables: _.inc(1) }
        })

        // 记录动态（带 teamId）
        await db.collection('activities').add({
          data: {
            type: 'upload',
            userId: openid,
            userName,
            taskTitle: task.title,
            taskId,
            teamId: task.teamId,
            time: new Date()
          }
        })
      }
    } catch (e) {}

    return {
      code: 0,
      data: { _id: record._id, version },
      message: '上传成功'
    }
  } catch (err) {
    // 记录写入失败时清理客户端已上传的云存储文件，避免产生孤儿文件
    // 仅允许删除本任务目录下的文件，防止借 fileID 删除他人文件
    try {
      const failedTaskId = event && event.taskId
      const failedFileID = event && event.fileID
      if (failedTaskId && failedFileID &&
        String(failedFileID).indexOf('/deliverables/' + failedTaskId + '/') !== -1) {
        await cloud.deleteFile({ fileList: [failedFileID] })
      }
    } catch (e) {}

    return {
      code: -1,
      message: '上传失败: ' + err.message
    }
  }
}