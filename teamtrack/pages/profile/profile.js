// pages/profile/profile.js
const DB = require('../../utils/db')
const auth = require('../../utils/auth')
const sceneUtil = require('../../utils/scene')
const notify = require('../../utils/notify')
const theme = require('../../utils/theme')

Page({
  data: {
    theme: theme.get(),
    scene: sceneUtil.getScene(),
    user: {},
    isLoggedIn: false,
    // 剩余可发送的订阅消息条数（一次性订阅，授权一次只能发一条）
    notifyQuota: 0,
    // 注册流程状态：'' | 'nickName'
    registerStep: '',
    tempNickName: ''
  },

  onLoad() {
    this._loaded = false
    // 预取订阅消息模板ID（点击"消息提醒"时才能同步拉起授权弹窗）
    notify.prefetch()
    this.init()
  },

  onShow() {
    theme.sync(this)
    this.setData({ scene: sceneUtil.getScene() })
    // onLoad 已执行过，onShow 刷新最新统计数据
    if (this._loaded) {
      if (auth.isLoggedIn()) {
        this.loadUser()
        this.loadNotifyQuota()
      } else {
        this.setData({ user: {}, isLoggedIn: false, notifyQuota: 0 })
      }
    }
  },

  async init() {
    this._loaded = true
    // 优先使用缓存
    const cached = auth.getCachedUser()
    if (cached) {
      this.setData({ user: cached, isLoggedIn: true })
      this.loadUser()  // 拉取最新用户信息（含 contribution 等统计字段，由 users 表维护）
    } else {
      // 未登录（或已退出），不自动调用 login 云函数
      this.setData({ user: {}, isLoggedIn: false })
    }
  },

  // 拉取最新用户信息并刷新展示
  async loadUser() {
    if (!auth.isLoggedIn()) return
    try {
      const user = await auth.refreshUser()
      if (user) {
        this.setData({ user, isLoggedIn: true })
      }
    } catch (err) {
      console.error('加载用户信息失败', err)
    }
  },

  /**
   * 点击"微信登录"按钮：
   * 调用 login 云函数检测是否已注册
   * - 已注册：直接登录成功
   * - 未注册：进入注册流程，设置昵称
   */
  async onLogin() {
    wx.showLoading({ title: '登录中...', mask: true })
    try {
      const result = await auth.login()
      wx.hideLoading()

      if (result.isNew) {
        // 新用户：进入昵称设置
        this.setData({ registerStep: 'nickName' })
        return
      }

      // 老用户：直接登录
      const user = result.user
      this.setData({ user, isLoggedIn: true })
      wx.showToast({ title: '登录成功', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      if (err.message && err.message.indexOf('取消') === -1) {
        wx.showToast({ title: err.message || '登录失败', icon: 'none' })
      }
    }
  },

  onNickNameInput(e) {
    this.setData({ tempNickName: e.detail.value })
  },

  /**
   * 提交注册
   */
  async onSubmitRegister() {
    const { tempNickName } = this.data
    const nickName = (tempNickName || '').trim()
    if (!nickName) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }

    try {
      const user = await auth.register({ nickName })
      this.setData({
        user,
        isLoggedIn: true,
        registerStep: '',
        tempNickName: ''
      })
      wx.showToast({ title: '注册成功！', icon: 'success' })
    } catch (err) {
      if (err.message && err.message.indexOf('取消') === -1) {
        wx.showToast({ title: err.message || '注册失败', icon: 'none' })
      }
    }
  },

  onEditNickName() {
    wx.showModal({
      title: '修改昵称',
      editable: true,
      placeholderText: '请输入新的昵称',
      content: this.data.user.nickName || '',
      confirmColor: '#FF6B35',
      success: async (res) => {
        if (res.confirm && res.content) {
          const nickName = res.content.trim()
          await auth.updateUser({ nickName })
          this.setData({ 'user.nickName': nickName })
          wx.showToast({ title: '修改成功', icon: 'success' })
        }
      }
    })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将清除本地团队数据，确定要退出吗？',
      confirmColor: '#FF6B35',
      success: (res) => {
        if (res.confirm) {
          auth.logout()
          this.setData({
            user: {},
            isLoggedIn: false,
            notifyQuota: 0,
            registerStep: '',
            tempNickName: ''
          })
          wx.showToast({ title: '已退出登录', icon: 'success' })
          // 跳转到登录页（当前 profile 即登录页）
          // 不切换 tab，让用户看到登录入口
        }
      }
    })
  },

  goMyTasks() {
    wx.switchTab({ url: '/pages/tasks/tasks' })
  },

  goMyStats() {
    wx.navigateTo({ url: '/pages/myStats/myStats' })
  },

  goTeam() {
    wx.navigateTo({ url: '/pages/team/team' })
  },

  goTeams() {
    wx.navigateTo({ url: '/pages/teams/teams' })
  },

  /**
   * 刷新剩余可发送的订阅消息条数
   */
  async loadNotifyQuota() {
    if (!auth.isLoggedIn()) return
    const total = await notify.getQuota(['taskAssigned', 'reviewNeeded', 'reviewResult'])
    this.setData({ notifyQuota: total })
  },

  /**
   * 开启订阅消息提醒（一次性订阅，点一次可收一条对应通知）
   */
  onEnableNotify() {
    notify.request(['taskAssigned', 'reviewNeeded', 'reviewResult']).then(res => {
      if (!res.enabled) {
        // 模板ID还没取到（首次启动或云函数刚部署），强制刷新后引导用户再点一次
        notify.prefetch(true)
        wx.showToast({ title: '正在获取消息模板，请再点一次', icon: 'none' })
        return
      }
      if (res.ok) {
        wx.showToast({ title: '已开启 ' + res.accepted.length + ' 项提醒', icon: 'success' })
        this.loadNotifyQuota()
      } else {
        wx.showToast({ title: '未开启，可在弹窗中选择允许', icon: 'none' })
      }
    })
  },

  /**
   * 切换主题外观（日间 / 夜间）
   */
  onSwitchTheme(e) {
    const mode = e.currentTarget.dataset.mode
    if (!mode || mode === this.data.theme) return
    theme.set(mode)
    this.setData({ theme: mode })
    theme.apply(mode)
    wx.showToast({
      title: mode === 'light' ? '已切换为日间模式' : '已切换为夜间模式',
      icon: 'none',
      duration: 1200
    })
  },

  showAbout() {
    wx.showModal({
      title: '关于队迹协作工具',
      content: '队迹协作工具 TeamTrack v1.1.0\n\n面向团队与项目组的轻量协作工具，解决进度不透明、责任不清、任务难复盘的问题。\n\n核心功能：任务领取与指派、进度追踪、验收与贡献记录、团队管理、任务附件与文件版本管理（基于微信云开发）。',
      showCancel: false,
      confirmColor: '#FF6B35'
    })
  },

  showHelp() {
    wx.showModal({
      title: '使用帮助',
      content: '1. 负责人创建团队，获得邀请码\n2. 成员通过邀请码加入团队\n3. 负责人发布任务，设置截止时间、执行方式与是否需要验收\n4. 成员领取任务，或由负责人指派成员\n5. 完成任务后上传交付物（支持文件/链接/图片）\n6. 需要验收的任务由负责人通过或驳回\n7. 查看排行榜了解团队贡献分布',
      showCancel: false,
      confirmColor: '#FF6B35'
    })
  }
})
