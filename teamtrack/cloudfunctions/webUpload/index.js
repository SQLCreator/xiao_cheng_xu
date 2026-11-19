// 云函数：webUpload
// 电脑端（H5）上传入口。部署后需在云开发控制台「HTTP 访问服务」绑定本函数，
// 例如路径 /webUpload，最终地址形如 https://<环境ID>.service.tcloudbase.com/webUpload
//
// 协议（JSON）：
//   { action: 'info', code }
//     → { code: 0, data: { taskTitle, userName, expireAt, expired, used } }
//   { action: 'submit', code, type: 'file', fileName, contentBase64 }
//   { action: 'submit', code, type: 'link', fileName, linkUrl }
//     → { code: 0, data: { version, fileName } }
//
// 安全设计：
//   - 上传码由 uploadTicket 云函数签发，绑定任务与用户，2 小时过期、一次性使用
//   - HTTP 请求没有 openid，交付物归属以上传码内的 userId 为准
//   - 文件走 base64 上传，受 HTTP 访问服务请求体上限约束，大文件请改用在线链接
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const COLLECTION_TICKETS = 'uploadTickets'
// HTTP 访问服务请求体上限约 5MB，base64 会膨胀 1/3，这里限制原始文件 3MB
const MAX_FILE_BYTES = 3 * 1024 * 1024

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
}

function ok(data) {
  return { code: 0, data: data || {}, message: 'ok' }
}

function fail(message, code) {
  return { code: typeof code === 'number' ? code : -1, message }
}

function httpReply(payload) {
  return {
    statusCode: 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS),
    body: JSON.stringify(payload),
    isBase64Encoded: false
  }
}

// HTTP 访问服务会把请求包成 { httpMethod, headers, body, queryStringParameters }；
// 直接调用（调试）时 body 可能是对象
function parseBody(event) {
  let raw = event && event.body
  if (raw == null) return event || {}
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, 'base64').toString('utf8')
  }
  if (typeof raw !== 'string') return raw || {}
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function dateStamp() {
  const d = new Date()
  const pad = n => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 80)
  return cleaned || '未命名文件'
}

async function getTicket(db, code) {
  try {
    const res = await db.collection(COLLECTION_TICKETS).doc(code).get()
    if (!res.data) return null
    // doc().get() 部分场景不返回 _id，这里补齐，后续标记已使用要用
    res.data._id = res.data._id || code
    return res.data
  } catch (e) {
    return null
  }
}

function ticketState(ticket) {
  if (!ticket) return 'missing'
  if (ticket.used) return 'used'
  const expiresAt = ticket.expiresAt instanceof Date
    ? ticket.expiresAt.getTime()
    : new Date(ticket.expiresAt || 0).getTime()
  if (!expiresAt || expiresAt < Date.now()) return 'expired'
  return 'active'
}

function stateMessage(state) {
  if (state === 'used') return '该上传码已使用，请在手机上重新生成'
  if (state === 'expired') return '上传码已过期，请在手机上重新生成'
  return '上传码不存在，请检查后重试'
}

// 版本号：与 uploadDeliverable 一致，在事务里对任务文档原子自增
async function nextVersion(db, taskId) {
  try {
    const v = await db.runTransaction(async transaction => {
      const taskRef = transaction.collection('tasks').doc(taskId)
      const taskRes = await taskRef.get()
      const data = taskRes.data || {}
      const next = (data.deliverableSeq || data.deliverables || 0) + 1
      await taskRef.update({ data: { deliverableSeq: next } })
      return next
    })
    if (Number.isFinite(v)) return v
  } catch (e) {}
  try {
    const existing = await db.collection('deliverables').where({ taskId }).get()
    return existing.data.length + 1
  } catch (e) {
    return 1
  }
}

async function writeDeliverable(db, ticket, payload) {
  const taskId = ticket.taskId
  let task = null
  try {
    task = (await db.collection('tasks').doc(taskId).get()).data
  } catch (e) {}
  if (!task) {
    const err = new Error('任务不存在或已被删除')
    err.code = -1
    throw err
  }

  const version = await nextVersion(db, taskId)
  const record = await db.collection('deliverables').add({
    data: {
      taskId,
      teamId: task.teamId || ticket.teamId,
      userId: ticket.userId,
      userName: ticket.userName || '微信用户',
      fileName: payload.fileName,
      fileID: payload.fileID || '',
      fileUrl: payload.fileUrl || '',
      isLink: !!payload.isLink,
      version,
      size: payload.size || '未知',
      reviewStatus: 'pending',
      uploadedAt: new Date(),
      // 标记来源，便于区分小程序端 / 电脑端上传
      source: 'web'
    }
  })

  try {
    const _ = db.command
    await db.collection('tasks').doc(taskId).update({
      data: { deliverables: _.inc(1) }
    })
    await db.collection('activities').add({
      data: {
        type: 'upload',
        userId: ticket.userId,
        userName: ticket.userName || '微信用户',
        taskTitle: task.title,
        taskId,
        teamId: task.teamId,
        time: new Date()
      }
    })
  } catch (e) {}

  return { record, version }
}

async function handleSubmit(db, ticket, body) {
  const type = body.type === 'link' ? 'link' : 'file'

  if (type === 'link') {
    const linkUrl = String(body.linkUrl || '').trim()
    if (!/^https?:\/\//i.test(linkUrl)) {
      return fail('请填写以 http:// 或 https:// 开头的链接')
    }
    if (linkUrl.length > 1000) {
      return fail('链接过长，请精简后重试')
    }
    const fileName = safeFileName(body.fileName) === '未命名文件'
      ? '在线文档_' + dateStamp() + '.link'
      : safeFileName(body.fileName)

    const { record, version } = await writeDeliverable(db, ticket, {
      fileName,
      isLink: true,
      fileUrl: linkUrl,
      size: '链接'
    })
    await markUsed(db, ticket._id, record._id)
    return ok({ version, fileName })
  }

  // 文件上传
  let base64 = String(body.contentBase64 || '')
  const commaIndex = base64.indexOf(',')
  if (base64.indexOf('data:') === 0 && commaIndex !== -1) {
    base64 = base64.slice(commaIndex + 1)
  }
  base64 = base64.replace(/\s/g, '')
  if (!base64) {
    return fail('缺少文件内容')
  }

  let buffer = null
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch (e) {
    return fail('文件解码失败，请重试')
  }
  if (!buffer || buffer.length === 0) {
    return fail('文件为空，请重新选择')
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return fail('文件超过 3MB，请改用在线文档链接上传（如腾讯文档、飞书文档）')
  }

  const fileName = safeFileName(body.fileName)
  const cloudPath = 'deliverables/' + ticket.taskId + '/' + Date.now() + '_' + fileName
  let fileID = ''
  try {
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent: buffer })
    fileID = uploaded.fileID
  } catch (e) {
    return fail('文件上传失败: ' + (e.message || e.errMsg || '请稍后重试'))
  }

  try {
    const { record, version } = await writeDeliverable(db, ticket, {
      fileName,
      fileID,
      size: formatFileSize(buffer.length)
    })
    await markUsed(db, ticket._id, record._id)
    return ok({ version, fileName })
  } catch (err) {
    // 写库失败时清理刚上传的文件，避免孤儿文件
    try {
      if (fileID) await cloud.deleteFile({ fileList: [fileID] })
    } catch (e) {}
    return fail(err.message || '保存交付物失败')
  }
}

// 原子置为已使用，避免同一上传码被并发提交两次
async function markUsed(db, code, deliverableId) {
  try {
    const res = await db.collection(COLLECTION_TICKETS)
      .where({ _id: code, used: false })
      .update({ data: { used: true, usedAt: new Date(), deliverableId } })
    return !res.stats || res.stats.updated === 1
  } catch (e) {
    return false
  }
}

async function handle(payload) {
  const db = cloud.database()
  const action = payload.action || 'info'
  const code = String(payload.code || '').trim().toUpperCase()

  // 排除易混淆字符：0 O 1 I
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    return fail('上传码格式不正确')
  }

  const ticket = await getTicket(db, code)
  const state = ticketState(ticket)
  if (state !== 'active') {
    return fail(stateMessage(state))
  }

  if (action === 'info') {
    return ok({
      taskTitle: ticket.taskTitle || '未命名任务',
      userName: ticket.userName || '',
      expireAt: ticket.expiresAt instanceof Date
        ? ticket.expiresAt.getTime()
        : new Date(ticket.expiresAt || 0).getTime(),
      expired: false,
      used: false,
      maxFileMB: Math.round(MAX_FILE_BYTES / 1024 / 1024)
    })
  }

  if (action === 'submit') {
    const body = Object.assign({}, payload)
    // ticket._id 为上传码，写库与标记需要用到
    return await handleSubmit(db, ticket, body)
  }

  return fail('未知操作')
}

exports.main = async (event, context) => {
  const isHttp = !!(event && (event.httpMethod || event.headers))

  if (isHttp && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }
  }

  let payload = parseBody(event)
  if (payload === null) {
    return isHttp ? httpReply(fail('请求格式错误，需为 JSON')) : fail('请求格式错误，需为 JSON')
  }

  // 允许 GET /webUpload?code=XXX 直接查任务信息
  if (isHttp && event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {}
    payload = { action: 'info', code: q.code, taskId: q.taskId }
  }

  let result
  try {
    result = await handle(payload)
  } catch (err) {
    result = fail('处理失败: ' + (err.message || ''))
  }
  return isHttp ? httpReply(result) : result
}