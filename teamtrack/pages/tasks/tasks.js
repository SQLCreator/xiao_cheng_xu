// pages/tasks/tasks.js
const DB = require('../../utils/db')
const util = require('../../utils/util')
const teamSwitcher = require('../../utils/teamSwitcher')
const auth = require('../../utils/auth')
const sceneUtil = require('../../utils/scene')
const theme = require('../../utils/theme')
const todo = require('../../utils/todo')

Page({
  data: {
    theme: theme.get(),
    scene: sceneUtil.getScene(),
    teams: [],
    currentTeamId: null,
    hasTeams: false,
    isLoggedIn: false,
    tasks: [],
    filteredTasks: [],
    currentFilter: 'all',
    keyword: '',
    sortBy: 'created',
    loading: true,
    refreshing: false,
    allCount: 0,
    pendingCount: 0,
    inProgressCount: 0,
    reviewingCount: 0,
    completedCount: 0
  },

  onLoad() {
    this.init()
  },

  onShow() {
    theme.sync(this)
    this.setData({ scene: sceneUtil.getScene() })
    if (!auth.isLoggedIn()) {
      this.resetToLoggedOut()
      return
    }
    this.init()
  },

  resetToLoggedOut() {
    this.setData({
      teams: [],
      currentTeamId: null,
      hasTeams: false,
      isLoggedIn: false,
      tasks: [],
      filteredTasks: [],
      loading: false,
      allCount: 0,
      pendingCount: 0,
      inProgressCount: 0,
      reviewingCount: 0,
      completedCount: 0
    })
    todo.syncBadge(0)
  },

  async init() {
    if (!auth.isLoggedIn()) {
      this.resetToLoggedOut()
      return
    }
    this.setData({ isLoggedIn: true })
    await teamSwitcher.load(this)
    if (this.data.hasTeams) {
      this.loadTasks()
    } else {
      // 无队伍时清空所有任务数据，避免残留
      this.setData({
        loading: false,
        tasks: [],
        filteredTasks: [],
        allCount: 0,
        pendingCount: 0,
        inProgressCount: 0,
        completedCount: 0
      })
      todo.syncBadge(0)
    }
  },

  // 队伍切换回调
  onTeamChanged() {
    this.loadTasks()
  },

  // 切换队伍
  onSwitchTeam(e) {
    const teamId = e.currentTarget.dataset.id
    teamSwitcher.switchTo(this, teamId)
  },

  goTeamsPage() {
    teamSwitcher.goTeamsPage()
  },

  goCreateTeam() {
    teamSwitcher.goCreateTeam()
  },

  async loadTasks() {
    if (!this.data.hasTeams) {
      this.setData({ tasks: [], filteredTasks: [], loading: false })
      return
    }
    // 首次加载显示骨架屏，后续 onShow 刷新静默进行
    const isFirstLoad = !this._tasksLoadedOnce
    this.setData({ loading: isFirstLoad })
    this._tasksLoadedOnce = true
    try {
      const tasks = await DB.getTasks()
      const processed = tasks.map(t => {
        const countdown = util.getCountdown(t.deadline)
        return {
          ...t,
          statusText: util.getStatusText(t.status),
          statusClass: util.getStatusClass(t.status),
          countdownText: countdown.text,
          urgent: countdown.urgent
        }
      })

      const counts = {
        allCount: tasks.length,
        pendingCount: tasks.filter(t => t.status === 'pending').length,
        inProgressCount: tasks.filter(t => t.status === 'in_progress').length,
        reviewingCount: tasks.filter(t => t.status === 'reviewing').length,
        completedCount: tasks.filter(t => t.status === 'completed').length
      }

      this.setData({
        tasks: processed,
        ...counts,
        loading: false
      })

      // 同步任务 tab 红点（用队伍列表里的 myRole 判断管理权限，避免额外请求）
      const currentTeam = (this.data.teams || []).find(t => t._id === this.data.currentTeamId)
      const canManage = !!currentTeam && (currentTeam.myRole === 'captain' || currentTeam.myRole === 'admin')
      const todoData = todo.build(tasks, null, wx.getStorageSync('openid') || '', { canManage })
      todo.syncBadge(todoData.count)

      this.applyFilter()
    } catch (err) {
      console.error('加载任务失败', err)
      this.setData({ loading: false })
    }
  },

  onFilter(e) {
    const filter = e.currentTarget.dataset.filter
    this.setData({ currentFilter: filter })
    this.applyFilter()
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
    this.applyFilter()
  },

  onClearSearch() {
    this.setData({ keyword: '' })
    this.applyFilter()
  },

  onSortChange(e) {
    const sortBy = e.currentTarget.dataset.sort
    if (sortBy === this.data.sortBy) return
    this.setData({ sortBy })
    this.applyFilter()
  },

  applyFilter() {
    const { tasks, currentFilter, keyword, sortBy } = this.data
    let list = tasks
    if (currentFilter !== 'all') {
      list = list.filter(t => t.status === currentFilter)
    }

    // 关键词过滤：任务名称 / 描述 / 分类 / 负责人 / 发布人
    const kw = (keyword || '').trim().toLowerCase()
    if (kw) {
      list = list.filter(t => [t.title, t.description, t.category, t.assigneeName, t.createdByName]
        .some(v => v && String(v).toLowerCase().indexOf(kw) !== -1))
    }

    // 排序
    const sorted = list.slice()
    if (sortBy === 'deadline') {
      sorted.sort((a, b) => {
        const da = a.deadline ? new Date(a.deadline).getTime() : Infinity
        const db = b.deadline ? new Date(b.deadline).getTime() : Infinity
        return da - db
      })
    } else if (sortBy === 'points') {
      sorted.sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0))
    } else {
      // 默认最新发布
      sorted.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    }

    this.setData({ filteredTasks: sorted })
  },

  async onRefresh() {
    this.setData({ refreshing: true })
    await this.loadTasks()
    this.setData({ refreshing: false })
  },

  goTaskDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/taskDetail/taskDetail?id=${id}` })
  },

  goCreateTask() {
    if (!this.data.hasTeams) {
      wx.showToast({ title: `请先创建或加入${this.data.scene.teamLabel}`, icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/createTask/createTask' })
  },

  async onClaimTask(e) {
    const id = e.currentTarget.dataset.id
    // 指派制任务不能自行领取
    const target = this.data.tasks.find(t => t._id === id)
    if (target && target.assignMode === 'assign') {
      wx.showToast({ title: '该任务为指派制，请联系负责人', icon: 'none' })
      return
    }
    wx.showModal({
      title: `确认${this.data.scene.claimLabel}`,
      content: '领取后需按时完成并提交交付物，确定领取该任务吗？',
      confirmColor: '#FF6B35',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '领取中...' })
          try {
            const res = await DB.claimTask(id)
            // 乐观更新：立即更新本地任务状态
            const tasks = this.data.tasks.map(t =>
              t._id === id ? { ...t, status: 'in_progress', statusText: '进行中', statusClass: 'status-in_progress' } : t
            )
            this.setData({ tasks })
            this.applyFilter()
            // 云函数已返回最新用户统计，直接更新缓存，省一次 getUserStats 调用
            if (res && res.user) {
              auth.setCachedUser(res.user)
            }
            wx.hideLoading()
            wx.showToast({ title: `${this.data.scene.claimLabel}成功！`, icon: 'success' })
            this.loadTasks()
          } catch (e) {
            wx.hideLoading()
            wx.showToast({ title: e.message || `${this.data.scene.claimLabel}失败`, icon: 'none' })
          }
        }
      }
    })
  }
})
