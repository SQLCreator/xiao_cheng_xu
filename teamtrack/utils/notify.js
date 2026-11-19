/**
 * 订阅消息授权封装
 * 模板ID 统一维护在 cloudfunctions/notify/templates.js，
 * 前端通过 notify 云函数读取，避免两处维护。
 */

const cloud = require('./cloud')

const CONFIG_KEY = 'notifyTemplates'
const CACHE_TTL = 24 * 60 * 60 * 1000

// { taskAssigned: '模板ID', reviewNeeded: '...', reviewResult: '...' }
let _templates = null

// 模板配置是否有效（空对象视为未配置，不能当作缓存命中）
function hasTemplates(tpls) {
  if (!tpls) return false
  return Object.keys(tpls).some(key => !!tpls[key])
}

/**
 * 预取模板ID（页面 onLoad / app 启动时调用）
 * requestSubscribeMessage 必须在点击事件里同步调用，所以不能等到点击时再请求网络
 */
function prefetch(force) {
  if (!force && hasTemplates(_templates)) return Promise.resolve(_templates)

  if (!force) {
    try {
      const cached = wx.getStorageSync(CONFIG_KEY)
      if (cached && cached.time && Date.now() - cached.time < CACHE_TTL && hasTemplates(cached.data)) {
        _templates = cached.data
        return Promise.resolve(_templates)
      }
    } catch (e) {}
  }

  return cloud.callFunction('notify', { action: 'config' })
    .then(res => {
      const tpls = (res && res.templates) || {}
      _templates = tpls
      // 只在拿到有效模板时写缓存，避免把"未配置"缓存 24 小时
      if (hasTemplates(tpls)) {
        try {
          wx.setStorageSync(CONFIG_KEY, { data: tpls, time: Date.now() })
        } catch (e) {}
      }
      return _templates
    })
    .catch(() => _templates || {})
}

function templateIdsOf(types) {
  const tpls = _templates || {}
  const ids = []
  ;(types || []).forEach(t => {
    const id = tpls[t]
    if (id && ids.indexOf(id) === -1) ids.push(id)
  })
  return ids
}

/**
 * 查询剩余可发送条数（一次性订阅：授权一次只能收到一条）
 * @param {string[]} types
 * @returns {Promise<number>}
 */
function getQuota(types) {
  return cloud.callFunction('notify', { action: 'quota', types: types || [] })
    .then(res => Number(res && res.total) || 0)
    .catch(() => 0)
}

/**
 * 申请订阅授权，必须在用户点击事件中调用
 * @param {string[]} types taskAssigned / reviewNeeded / reviewResult
 * @returns {Promise<{enabled:boolean, ok:boolean, accepted:string[]}>}
 */
function request(types) {
  const ids = templateIdsOf(types)
  // 模板未配置时静默跳过，不影响主流程
  if (ids.length === 0) {
    return Promise.resolve({ enabled: false, ok: false, accepted: [] })
  }

  return new Promise(resolve => {
    wx.requestSubscribeMessage({
      tmplIds: ids.slice(0, 3),
      success: (res) => {
        const accepted = ids.filter(id => res[id] === 'accept')
        const done = () => resolve({ enabled: true, ok: accepted.length > 0, accepted })
        if (accepted.length > 0) {
          // 上报授权额度，上报完成再返回，页面可立即刷新剩余条数
          cloud.callFunction('notify', { action: 'grant', templateIds: accepted }).then(done).catch(done)
        } else {
          done()
        }
      },
      fail: () => resolve({ enabled: true, ok: false, accepted: [] })
    })
  })
}

module.exports = {
  prefetch,
  getQuota,
  request
}