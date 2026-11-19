// pages/createTeam/createTeam.js
const DB = require('../../utils/db')
const sceneUtil = require('../../utils/scene')
const theme = require('../../utils/theme')

Page({
  data: {
    theme: theme.get(),
    form: {
      name: '',
      category: '',
      description: '',
      deadline: ''
    },
    // 统一文案（不分场景）
    scene: sceneUtil.getScene(),
    templates: [],
    templateIndex: 0,
    today: '',
    submitting: false
  },
  onShow() {
    theme.sync(this)
  },

  onLoad() {
    const today = new Date().toISOString().split('T')[0]
    const scene = this.data.scene
    wx.setNavigationBarTitle({ title: scene.createLabel })
    this.setData({
      today,
      templates: scene.templates
    })
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onTemplateChange(e) {
    const index = e.detail.value
    this.setData({
      templateIndex: index,
      'form.category': this.data.templates[index]
    })
  },

  onDateChange(e) {
    this.setData({ 'form.deadline': e.detail.value })
  },

  onCancel() {
    wx.navigateBack()
  },

  async onSubmit() {
    const { name, category, description, deadline } = this.data.form
    const scene = this.data.scene

    if (!name.trim()) {
      wx.showToast({ title: `请输入${scene.teamLabel}名称`, icon: 'none' })
      return
    }
    if (!category) {
      wx.showToast({ title: scene.categoryPlaceholder, icon: 'none' })
      return
    }
    if (!description.trim()) {
      wx.showToast({ title: '请输入项目描述', icon: 'none' })
      return
    }
    if (!deadline) {
      wx.showToast({ title: '请选择截止日期', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    try {
      await DB.createTeam({
        ...this.data.form,
        milestones: scene.milestones,
        memberCount: 1,
        progress: 0
      })
      wx.showToast({ title: '创建成功！', icon: 'success' })
      setTimeout(() => {
        wx.navigateBack()
      }, 1500)
    } catch (err) {
      wx.showToast({ title: '创建失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
