// 工具函数

// 格式化日期
function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  const now = new Date()
  const diff = d - now
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))

  if (days < 0) return '已逾期'
  if (days === 0) return '今天截止'
  if (days === 1) return '明天截止'
  if (days <= 7) return `剩余${days}天`

  const month = d.getMonth() + 1
  const day = d.getDate()
  return `${month}月${day}日`
}

// 格式化日期时间
function formatDateTime(date) {
  if (!date) return ''
  const d = new Date(date)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${month}/${day} ${hours}:${minutes}`
}

// 计算倒计时
function getCountdown(deadline) {
  if (!deadline) return ''
  const d = new Date(deadline)
  const now = new Date()
  const diff = d - now

  if (diff < 0) return { text: '已逾期', urgent: true, expired: true }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

  if (days <= 1) return { text: `${days}天${hours}小时`, urgent: true, expired: false }
  return { text: `剩余${days}天`, urgent: false, expired: false }
}

// 生成唯一ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5)
}

// 获取状态文本
function getStatusText(status) {
  const map = {
    pending: '待领取',
    in_progress: '进行中',
    reviewing: '待验收',
    completed: '已完成',
    expired: '已逾期'
  }
  return map[status] || status
}

// 获取状态标签样式
function getStatusClass(status) {
  const map = {
    pending: 'tag-yellow',
    in_progress: 'tag-blue',
    reviewing: 'tag-orange',
    completed: 'tag-green',
    expired: 'tag-red'
  }
  return map[status] || 'tag-blue'
}

module.exports = {
  formatDate,
  formatDateTime,
  getCountdown,
  genId,
  getStatusText,
  getStatusClass
}