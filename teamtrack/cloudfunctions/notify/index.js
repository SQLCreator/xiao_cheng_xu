// 云函数：notify
// 订阅消息通知统一出口
// action = 'config'  前端拉取已配置的模板ID
// action = 'grant'   前端 requestSubscribeMessage 授权成功后上报，累加可发送次数
// action = 'send'    其他云函数内部调用，向指定 openid 推送
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const TEMPLATES = require('./templates')

const db = cloud.database()
const _ = db.command
const QUOTA_COLLECTION = 'notifyQuota'

// 内部调用密钥：send 只允许云函数内部使用，客户端无法获知
const INTERNAL_KEY = 'teamtrack_notify_internal_v1'

// 开发阶段跳转到开发版，正式发布后改成 'formal'
const MP_STATE = 'developer'

// 通知类型 -> 模板键（joinResult 复用审批结果模板）
const TYPE_MAP = {
  taskAssigned: 'taskAssigned',
  reviewNeeded: 'reviewNeeded',
  reviewResult: 'reviewResult',
  joinResult: 'reviewResult'
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmtTime(input) {
  const t = input ? new Date(input) : new Date()
  if (!t || isNaN(t.getTime())) return ''
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) +
    ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes())
}

// 订阅消息 thing 类型最长 20 个字符，超出会被微信拒绝
function cut(str, max) {
  const limit = max || 20
  const s = String(str == null ? '' : str).trim()
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s
}

/**
 * 按业务字段生成各模板需要的值
 */
function buildValues(type, payload) {
  const p = payload || {}
  const time = fmtTime(p.time)
  if (type === 'taskAssigned') {
    return {
      title: cut(p.taskTitle),
      team: cut(p.teamName || '团队'),
      time,
      remark: cut(p.remark || '你有一项新任务，请及时查看')
    }
  }
  if (type === 'reviewNeeded') {
    return {
      title: cut(p.taskTitle),
      team: cut(p.teamName || '团队'),
      time,
      remark: cut(p.remark || ((p.userName || '成员') + '已提交，待你验收'))
    }
  }
  if (type === 'reviewResult' || type === 'joinResult') {
    return {
      title: cut(p.taskTitle || p.teamName || '团队'),
      result: cut(p.result || '已处理'),
      time,
      remark: cut(p.remark || '')
    }
  }
  return null
}

// ---------- 订阅额度（一次性订阅：用户授权一次可发一条） ----------

async function findQuotaDoc(openid) {
  const res = await db.collection(QUOTA_COLLECTION).where({ openid }).get()
  if (res.data && res.data.length > 0) return res.data[0]
  const addRes = await db.collection(QUOTA_COLLECTION).add({
    data: { openid, quotas: {}, updatedAt: new Date() }
  })
  return { _id: addRes._id, openid, quotas: {} }
}

async function getQuota(openid, templateId) {
  try {
    const doc = await findQuotaDoc(openid)
    const quotas = doc.quotas || {}
    return Number(quotas[templateId] || 0)
  } catch (e) {
    return 0
  }
}

async function addQuota(openid, templateIds) {
  const doc = await findQuotaDoc(openid)
  const patch = { updatedAt: new Date() }
  templateIds.forEach(tid => {
    if (tid) patch['quotas.' + tid] = _.inc(1)
  })
  await db.collection(QUOTA_COLLECTION).doc(doc._id).update({ data: patch })
}

async function decQuota(openid, templateId) {
  try {
    const doc = await findQuotaDoc(openid)
    await db.collection(QUOTA_COLLECTION).doc(doc._id).update({
      data: { ['quotas.' + templateId]: _.inc(-1), updatedAt: new Date() }
    })
  } catch (e) {}
}

// ---------- 发送 ----------

async function sendOne(openid, templateKey, values, page) {
  const tpl = TEMPLATES[templateKey]
  if (!tpl || !tpl.templateId) return { openid, skipped: 'NO_TEMPLATE' }

  const fields = tpl.fields || {}
  const data = {}
  Object.keys(fields).forEach(key => {
    const field = fields[key]
    const value = values[key]
    if (field && value !== undefined && value !== '') data[field] = value
  })
  if (Object.keys(data).length === 0) return { openid, skipped: 'NO_FIELDS' }

  const left = await getQuota(openid, tpl.templateId)
  if (left <= 0) return { openid, skipped: 'NO_QUOTA' }

  await cloud.openapi.subscribeMessage.send({
    touser: openid,
    templateId: tpl.templateId,
    page: page || tpl.page || '',
    data,
    miniprogramState: MP_STATE,
    lang: 'zh_CN'
  })
  await decQuota(openid, tpl.templateId)
  return { openid, ok: true }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  // 服务端内部调用时 OPENID 为空；额度记录只使用云端注入的 openid，不接受客户端传入
  const openid = wxContext.OPENID || ''
  const action = event.action || 'send'

  // send 仅限云函数内部调用，防止客户端伪造推送给任意 openid
  if (action === 'send' && event.internalKey !== INTERNAL_KEY) {
    return { code: -403, message: '无权调用通知发送' }
  }

  // 1. 前端拉取模板ID（前端不硬编码，改模板只改 templates.js）
  if (action === 'config') {
    const templates = {}
    Object.keys(TEMPLATES).forEach(key => {
      const id = TEMPLATES[key].templateId
      if (id) templates[key] = id
    })
    return { code: 0, data: { templates }, message: 'ok' }
  }

  // 2. 查询剩余可发送条数（一次性订阅：授权一次只能发一条）
  if (action === 'quota') {
    if (!openid) return { code: -1, message: '参数不足' }
    const types = Array.isArray(event.types) && event.types.length ? event.types : Object.keys(TEMPLATES)
    const quotas = {}
    let total = 0
    for (const key of types) {
      const tpl = TEMPLATES[key]
      if (!tpl || !tpl.templateId) continue
      // 多个类型可能共用同一模板，只统计一次
      if (quotas[tpl.templateId] !== undefined) continue
      const left = await getQuota(openid, tpl.templateId)
      quotas[tpl.templateId] = left
      total += left
    }
    return { code: 0, data: { total, quotas }, message: 'ok' }
  }

  // 3. 记录授权额度
  if (action === 'grant') {
    const list = Array.isArray(event.templateIds) ? event.templateIds : []
    if (!openid || list.length === 0) {
      return { code: -1, message: '参数不足' }
    }
    try {
      await addQuota(openid, list)
      return { code: 0, data: { granted: list.length }, message: 'ok' }
    } catch (err) {
      return { code: -1, message: '记录授权失败: ' + err.message }
    }
  }

  // 4. 其他云函数内部调用：批量推送
  const type = event.type
  const templateKey = TYPE_MAP[type]
  if (!templateKey) return { code: -1, message: '未知通知类型' }

  const payload = event.payload || {}
  const values = buildValues(type, payload)
  if (!values) return { code: -1, message: '未知通知类型' }

  const exclude = event.exclude || ''
  const list = (Array.isArray(event.to) ? event.to : [event.to]).filter(id => !!id && id !== exclude)
  const unique = list.filter((id, idx) => list.indexOf(id) === idx)
  if (unique.length === 0) return { code: 0, data: { results: [] }, message: '无接收人' }

  const page = (TEMPLATES[templateKey].page || '').replace('{taskId}', payload.taskId || '')
  const results = []
  for (const id of unique) {
    try {
      results.push(await sendOne(id, templateKey, values, page))
    } catch (err) {
      // 43101 用户未订阅/额度用完，属正常情况，不抛出
      console.error('[notify] 发送失败', type, id, err && (err.errCode || err.message))
      results.push({ openid: id, error: err.errCode || err.message })
    }
  }

  return { code: 0, data: { results }, message: 'ok' }
}