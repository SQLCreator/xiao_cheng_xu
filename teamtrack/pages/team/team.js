// pages/team/team.js - 队伍详情页（显示当前队伍信息）
const DB = require('../../utils/db')
const sceneUtil = require('../../utils/scene')
const permission = require('../../utils/permission')
const report = require('../../utils/report')
const notify = require('../../utils/notify')
const theme = require('../../utils/theme')

Page({
  data: {
    theme: theme.get(),
    team: null,
    members: [],
    inviteCode: '------',
    isCaptain: false,
    scene: sceneUtil.getScene(),
    timeline: [],
    // 入队审批
    joinMode: 'open',
    joinRequests: [],
    loading: true
  },

  onLoad() {
    // 预取订阅消息模板ID：加入队伍时才能同步拉起授权弹窗
    notify.prefetch()
    this.loadData()
  },

  onShow() {
    theme.sync(this)
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      const [team, members] = await Promise.all([
        DB.getTeam(),
        DB.getMembers()
      ])

      if (!team) {
        this.setData({ team: null, loading: false })
        return
      }

      // 计算队伍进度（用于"完成度"显示，与时间线无关）
      const tasks = await DB.getTasks({ status: 'all' })
      const completedCount = tasks.filter(t => t.status === 'completed').length
      team.progress = tasks.length > 0
        ? Math.round((completedCount / tasks.length) * 100)
        : 0

      // 判断当前用户是否可管理（所有者或管理员）
      const openid = wx.getStorageSync('openid')
      const isCaptain = permission.canManageTeam(team, openid)

      // 时间线：读取队伍自定义阶段（兼容旧数据的默认阶段），按 currentStep 计算状态
      const scene = sceneUtil.getTeamScene(team)
      const timeline = sceneUtil.buildTimeline(team)
      team.categoryText = sceneUtil.categoryOf(team)

      const maxContribution = Math.max(...members.map(m => m.contribution || 0), 1)
      const processedMembers = members.map(m => ({
        ...m,
        percentage: Math.round(((m.contribution || 0) / maxContribution) * 100)
      }))

      this.setData({
        team,
        members: processedMembers,
        inviteCode: team.inviteCode || '------',
        isCaptain,
        scene,
        timeline,
        joinMode: team.joinMode === 'approval' ? 'approval' : 'open',
        loading: false
      })

      // 负责人额外拉取待审批申请
      if (isCaptain) {
        this.loadJoinRequests(team._id)
      }
    } catch (err) {
      console.error('加载团队信息失败', err)
      this.setData({ loading: false })
    }
  },

  // ============ 入队审批 ============

  async loadJoinRequests(teamId) {
    try {
      const list = await DB.getJoinRequests(teamId)
      this.setData({ joinRequests: list || [] })
    } catch (e) {
      this.setData({ joinRequests: [] })
    }
  },

  // 切换入队方式：审批 / 免审批
  async onToggleJoinMode(e) {
    if (!this.data.isCaptain) return
    const next = e.detail.value ? 'approval' : 'open'
    const prev = this.data.joinMode
    if (next === prev) return
    try {
      wx.showLoading({ title: '更新中...' })
      await DB.updateTeam(this.data.team._id, { joinMode: next })
      wx.hideLoading()
      this.setData({ joinMode: next })
      wx.showToast({
        title: next === 'approval' ? '已开启入队审批' : '已改为邀请码直接加入',
        icon: 'none'
      })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '设置失败', icon: 'none' })
    }
  },

  onApproveJoin(e) {
    this.doReviewJoin(e.currentTarget.dataset.id, true)
  },

  onRejectJoin(e) {
    this.doReviewJoin(e.currentTarget.dataset.id, false)
  },

  async doReviewJoin(requestId, pass) {
    if (!requestId) return
    wx.showLoading({ title: '处理中...' })
    try {
      await DB.reviewJoin(requestId, pass)
      wx.hideLoading()
      wx.showToast({ title: pass ? '已通过' : '已拒绝', icon: 'success' })
      this.loadData()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  },

  // ============ 报表导出（负责人） ============

  onExport() {
    if (!this.data.team) return
    wx.showActionSheet({
      itemList: ['任务清单', '成员贡献', '本周周报'],
      success: (res) => this.doExport(res.tapIndex)
    })
  },

  async doExport(index) {
    const team = this.data.team
    wx.showLoading({ title: '生成报表...', mask: true })
    try {
      const [tasks, members] = await Promise.all([
        DB.getTasks({ status: 'all' }, team._id),
        DB.getMembers(team._id)
      ])
      const dateStr = report.today()
      const safeTeam = (team.name || '团队').replace(/[\\/:*?"<>|]/g, '_')

      let fileName = ''
      let content = ''
      if (index === 1) {
        fileName = `${safeTeam}_成员贡献_${dateStr}.csv`
        content = report.buildMembersCsv(team, members)
      } else if (index === 2) {
        fileName = `${safeTeam}_周报_${dateStr}.csv`
        content = report.buildWeeklyCsv(team, tasks, members)
      } else {
        fileName = `${safeTeam}_任务清单_${dateStr}.csv`
        content = report.buildTasksCsv(team, tasks)
      }

      wx.hideLoading()
      await report.exportCsv(fileName, content)
    } catch (err) {
      wx.hideLoading()
      wx.showModal({
        title: '导出失败',
        content: (err && err.message) || '请稍后重试',
        showCancel: false,
        confirmColor: '#FF6B35'
      })
    }
  },

  // 负责人重算成员统计（修复历史数据）
  onRecalcStats() {
    if (!this.data.team) return
    wx.showModal({
      title: '重算成员统计',
      content: '将根据当前任务数据重新计算每位成员的贡献值与完成数，用于修正历史数据。确定继续吗？',
      confirmColor: '#FF6B35',
      success: async (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '重算中...', mask: true })
        try {
          const result = await DB.recalcTeamStats(this.data.team._id)
          wx.hideLoading()
          const changed = (result && result.changedMembers) || 0
          wx.showToast({
            title: changed > 0 ? `已修正 ${changed} 位成员` : '统计已一致',
            icon: 'none'
          })
          this.loadData()
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: err.message || '重算失败', icon: 'none' })
        }
      }
    })
  },

  // 队长点击时间线设置当前步骤
  onTimelineTap(e) {
    if (!this.data.isCaptain) {
      wx.showToast({ title: `只有${this.data.scene.ownerLabel}可以修改进度`, icon: 'none' })
      return
    }
    const step = e.currentTarget.dataset.step
    const title = e.currentTarget.dataset.title
    const currentStep = (this.data.team && this.data.team.currentStep) || 1

    if (step === currentStep) {
      wx.showToast({ title: '已是当前步骤', icon: 'none' })
      return
    }

    const action = step < currentStep ? '回退' : '推进'
    wx.showModal({
      title: `${action}到第${step}步`,
      content: `确定将当前进度设置为「${title}」吗？`,
      confirmColor: '#FF6B35',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '更新中...', mask: true })
          try {
            await DB.updateTeam(this.data.team._id, { currentStep: step })
            wx.hideLoading()
            wx.showToast({ title: '已更新', icon: 'success' })
            this.loadData()
          } catch (err) {
            wx.hideLoading()
            wx.showToast({ title: err.message || '更新失败', icon: 'none' })
          }
        }
      }
    })
  },

  // 复制邀请码
  copyCode() {
    if (this.data.inviteCode === '------') {
      wx.showToast({ title: '暂无邀请码', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => {
        wx.showToast({ title: '邀请码已复制', icon: 'success' })
      }
    })
  },

  // 邀请成员 - 通过分享小程序卡片
  onInvite() {
    if (!this.data.team) {
      wx.showToast({ title: `请先创建${this.data.scene.teamLabel}`, icon: 'none' })
      return
    }
    // 触发分享（需要 button open-type="share"）
    wx.showModal({
      title: '邀请成员',
      content: `邀请码：${this.data.inviteCode}\n\n点击右上角"..."→"转发"或下方"邀请成员"按钮分享给好友，好友打开后输入邀请码即可申请加入${this.data.scene.teamLabel}。`,
      showCancel: false,
      confirmColor: '#FF6B35',
      confirmText: '知道了'
    })
  },

  // 加入其他队伍
  onJoinTeam() {
    // 顺带订阅「入队审批结果」提醒（模板未配置时静默跳过）
    notify.request(['reviewResult']).finally(() => this.showJoinTeamModal())
  },

  showJoinTeamModal() {
    wx.showModal({
      title: `加入${this.data.scene.teamLabel}`,
      editable: true,
      placeholderText: '请输入6位邀请码',
      confirmColor: '#FF6B35',
      success: async (res) => {
        if (res.confirm && res.content) {
          const code = res.content.trim().toUpperCase()
          if (code.length !== 6) {
            wx.showToast({ title: '邀请码格式错误', icon: 'none' })
            return
          }
          wx.showLoading({ title: '加入中...' })
          try {
            const result = await DB.joinTeam(code)
            wx.hideLoading()
            if (result && result.pending) {
              wx.showModal({
                title: '申请已提交',
                content: `已向「${result.teamName || ''}」提交加入申请，等待${this.data.scene.ownerLabel}审批。`,
                showCancel: false,
                confirmColor: '#FF6B35'
              })
              return
            }
            wx.showToast({ title: '加入成功！', icon: 'success' })
            this.loadData()
          } catch (err) {
            wx.hideLoading()
            wx.showToast({ title: err.message || '加入失败', icon: 'none' })
          }
        }
      }
    })
  },

  // 跳转到队伍管理（多队伍切换）
  goTeamsPage() {
    wx.navigateTo({ url: '/pages/teams/teams' })
  },

  // 跳转到队友详情页
  goMemberDetail(e) {
    const item = e.currentTarget.dataset.item || {}
    const openid = item.openid || item.userId || ''
    if (!openid) {
      wx.showToast({ title: '无法查看该成员', icon: 'none' })
      return
    }
    const tid = this.data.team && this.data.team._id
    const params = [
      'openid=' + openid,
      'nickName=' + encodeURIComponent(item.nickName || ''),
      'role=' + (item.role || 'member'),
      'contribution=' + (item.contribution || 0),
      'completedTasks=' + (item.completedTasks || 0),
      'percentage=' + (item.percentage || 0),
      'teamId=' + (tid || '')
    ].join('&')
    wx.navigateTo({ url: '/pages/memberDetail/memberDetail?' + params })
  },

  // 分享邀请
  onShareAppMessage() {
    const team = this.data.team || {}
    return {
      title: `邀请你加入「${team.name || this.data.scene.productName}」${this.data.scene.teamLabel}`,
      path: `/pages/index/index?inviteCode=${this.data.inviteCode}`,
      imageUrl: ''
    }
  },

  async onRefresh() {
    await this.loadData()
  }
})