// pages/taskDetail/taskDetail.js
const DB = require('../../utils/db')
const util = require('../../utils/util')
const auth = require('../../utils/auth')
const sceneUtil = require('../../utils/scene')
const permission = require('../../utils/permission')
const notify = require('../../utils/notify')
const theme = require('../../utils/theme')
const config = require('../../utils/config')

Page({
  data: {
    theme: theme.get(),
    scene: sceneUtil.getScene(),
    task: null,
    deliverables: [],
    taskAttachments: [],
    countdown: {},
    uploading: false,
    // 权限与协作状态
    openid: '',
    isManager: false,
    isAssignee: false,
    assignees: [],
    canSubmit: false,
    canReview: false,
    // 指派面板
    assignPanelVisible: false,
    memberOptions: [],
    selectedOpenids: [],
    assigning: false,
    // 评论
    comments: [],
    commentInput: '',
    sendingComment: false
  },

  onLoad(options) {
    this.taskId = options.id
    // 预取订阅消息模板ID：提交验收时才能同步拉起授权弹窗
    notify.prefetch()
    this.loadDetail()
  },

  onShow() {
    theme.sync(this)
    if (this.taskId) this.loadDetail()
  },

  async loadDetail() {
    try {
      const task = await DB.getTaskDetail(this.taskId)
      const deliverables = await DB.getDeliverables(this.taskId)
      const commentList = await DB.getComments(this.taskId)
      const countdown = util.getCountdown(task.deadline)

      const fileIcons = {
        docx: { text: 'W', color: 'rgba(30, 144, 255, 0.2)' },
        doc: { text: 'W', color: 'rgba(30, 144, 255, 0.2)' },
        pdf: { text: 'P', color: 'rgba(255, 71, 87, 0.2)' },
        fig: { text: 'F', color: 'rgba(255, 107, 53, 0.2)' },
        psd: { text: 'P', color: 'rgba(0, 60, 255, 0.2)' },
        xlsx: { text: 'X', color: 'rgba(0, 200, 100, 0.2)' },
        pptx: { text: 'P', color: 'rgba(255, 80, 0, 0.2)' },
        zip: { text: 'Z', color: 'rgba(0, 212, 170, 0.2)' },
        rar: { text: 'Z', color: 'rgba(0, 212, 170, 0.2)' },
        png: { text: 'I', color: 'rgba(150, 100, 255, 0.2)' },
        jpg: { text: 'I', color: 'rgba(150, 100, 255, 0.2)' },
        jpeg: { text: 'I', color: 'rgba(150, 100, 255, 0.2)' },
        default: { text: '📄', color: 'rgba(255, 255, 255, 0.08)' }
      }

      const processedDels = deliverables.map(d => {
        const ext = (d.fileName || '').split('.').pop().toLowerCase()
        const icon = fileIcons[ext] || fileIcons.default
        return {
          ...d,
          iconText: icon.text,
          iconColor: icon.color,
          reviewStatusText: d.reviewStatus === 'approved' ? '已通过'
            : (d.reviewStatus === 'rejected' ? '已驳回' : '待验收'),
          reviewStatusClass: d.reviewStatus === 'approved' ? 'tag-green'
            : (d.reviewStatus === 'rejected' ? 'tag-red' : 'tag-yellow')
        }
      })

      const processedAttachments = (task.attachments || []).map(a => {
        const ext = (a.fileName || '').split('.').pop().toLowerCase()
        const icon = fileIcons[ext] || fileIcons.default
        return { ...a, iconText: icon.text, iconColor: icon.color }
      })

      this.setData({
        task: {
          ...task,
          statusText: util.getStatusText(task.status),
          statusClass: util.getStatusClass(task.status)
        },
        deliverables: processedDels,
        taskAttachments: processedAttachments,
        comments: (commentList || []).map(c => ({
          ...c,
          timeText: util.formatDateTime(c.createdAt)
        })),
        countdown
      })

      // 已看过讨论，清掉任务列表上的「新讨论」角标
      DB.markCommentsRead(this.taskId)

      await this.applyPermission(task)
    } catch (err) {
      console.error('加载详情失败', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  /**
   * 计算当前用户对该任务的权限与可执行操作
   * - 负责人（captain/admin）可指派、验收
   * - 任务成员可提交验收
   */
  async applyPermission(task) {
    const openid = wx.getStorageSync('openid') || ''
    let team = null
    try {
      team = await DB.getTeam(task.teamId)
    } catch (e) {}

    const isManager = permission.canManageTeam(team, openid)
    const isAssignee = permission.isAssignee(task, openid)
    const assignees = permission.assigneeList(task)
    const requireReview = !!task.requireReview

    this.setData({
      scene: sceneUtil.getTeamScene(team),
      openid,
      isManager,
      isAssignee,
      assignees,
      canSubmit: isAssignee && task.status === 'in_progress' && requireReview,
      canReview: isManager && task.status === 'reviewing'
    })
  },

  // ============ 评论 ============

  onCommentInput(e) {
    this.setData({ commentInput: e.detail.value })
  },

  async onSubmitComment() {
    const content = (this.data.commentInput || '').trim()
    if (!content) {
      wx.showToast({ title: '请输入评论内容', icon: 'none' })
      return
    }
    if (this.data.sendingComment) return
    this.setData({ sendingComment: true })
    try {
      const res = await DB.addComment(this.taskId, content)
      const comment = {
        _id: res.commentId,
        userName: res.userName || '我',
        content: res.content || content,
        createdAt: res.createdAt || new Date()
      }
      comment.timeText = util.formatDateTime(comment.createdAt)
      this.setData({
        comments: this.data.comments.concat([comment]),
        commentInput: '',
        sendingComment: false
      })
      wx.showToast({ title: '已评论', icon: 'success' })
    } catch (e) {
      this.setData({ sendingComment: false })
      wx.showToast({ title: e.message || '评论失败', icon: 'none' })
    }
  },

  // ============ 指派成员 ============

  async onOpenAssign() {
    const task = this.data.task
    if (!task) return
    try {
      wx.showLoading({ title: '加载成员...' })
      const members = await DB.getMembers(task.teamId)
      const selected = this.data.assignees.map(a => a.openid)
      const memberOptions = (members || []).map(m => ({
        openid: m.openid,
        nickName: m.nickName || '成员',
        roleLabel: m.role === 'captain' ? this.data.scene.ownerLabel : this.data.scene.memberLabel,
        checked: selected.indexOf(m.openid) !== -1
      }))
      wx.hideLoading()
      this.setData({
        assignPanelVisible: true,
        memberOptions,
        selectedOpenids: selected
      })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '成员加载失败', icon: 'none' })
    }
  },

  onCloseAssign() {
    this.setData({ assignPanelVisible: false })
  },

  // 阻止点击面板内部时冒泡到遮罩
  noop() {},

  onToggleMember(e) {
    const openid = e.currentTarget.dataset.openid
    const selectedOpenids = this.data.selectedOpenids.slice()
    const idx = selectedOpenids.indexOf(openid)
    if (idx === -1) {
      selectedOpenids.push(openid)
    } else {
      selectedOpenids.splice(idx, 1)
    }
    const memberOptions = this.data.memberOptions.map(m => ({
      ...m,
      checked: selectedOpenids.indexOf(m.openid) !== -1
    }))
    this.setData({ selectedOpenids, memberOptions })
  },

  async onConfirmAssign() {
    const { selectedOpenids, memberOptions } = this.data
    if (selectedOpenids.length === 0) {
      wx.showToast({ title: '请至少选择一位成员', icon: 'none' })
      return
    }
    const assignees = selectedOpenids.map(id => {
      const m = memberOptions.find(x => x.openid === id) || {}
      return { openid: id, nickName: m.nickName || '成员' }
    })

    this.setData({ assigning: true })
    wx.showLoading({ title: '指派中...', mask: true })
    try {
      await DB.assignTask(this.taskId, assignees)
      wx.hideLoading()
      wx.showToast({ title: '指派成功', icon: 'success' })
      this.setData({ assignPanelVisible: false, assigning: false })
      this.loadDetail()
    } catch (e) {
      wx.hideLoading()
      this.setData({ assigning: false })
      wx.showToast({ title: e.message || '指派失败', icon: 'none' })
    }
  },

  // ============ 验收流程 ============

  onSubmitReview() {
    // 顺带订阅「验收结果」提醒，这样验收后能收到通知（模板未配置时静默跳过）
    notify.request(['reviewResult']).finally(() => this.showSubmitReviewModal())
  },

  showSubmitReviewModal() {
    wx.showModal({
      title: this.data.scene.submitReviewLabel,
      editable: true,
      placeholderText: '补充说明（可选）',
      confirmColor: '#FF6B35',
      success: async (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '提交中...' })
        try {
          await DB.submitTask(this.taskId, res.content || '')
          wx.hideLoading()
          wx.showToast({ title: '已提交验收', icon: 'success' })
          this.loadDetail()
        } catch (e) {
          wx.hideLoading()
          wx.showToast({ title: e.message || '提交失败', icon: 'none' })
        }
      }
    })
  },

  onReviewPass() {
    this.doReview(true)
  },

  onReviewReject() {
    this.doReview(false)
  },

  doReview(pass) {
    const scene = this.data.scene
    wx.showModal({
      title: pass ? scene.passLabel : scene.rejectLabel,
      editable: true,
      placeholderText: pass ? '验收意见（可选）' : '请填写驳回原因',
      confirmColor: pass ? '#00D4AA' : '#FF4757',
      success: async (res) => {
        if (!res.confirm) return
        const comment = res.content || ''
        if (!pass && !comment.trim()) {
          wx.showToast({ title: '请填写驳回原因', icon: 'none' })
          return
        }
        wx.showLoading({ title: '处理中...' })
        try {
          await DB.reviewTask(this.taskId, pass, comment)
          wx.hideLoading()
          wx.showToast({ title: pass ? '验收通过' : '已驳回', icon: 'success' })
          this.loadDetail()
        } catch (e) {
          wx.hideLoading()
          wx.showToast({ title: e.message || '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onClaim() {
    const task = this.data.task || {}
    if (task.assignMode === 'assign') {
      wx.showToast({ title: '该任务为指派制，请联系负责人', icon: 'none' })
      return
    }
    const scene = this.data.scene
    wx.showModal({
      title: `确认${scene.claimLabel}`,
      content: '领取后需按时完成并提交交付物，确定领取该任务吗？',
      confirmColor: '#FF6B35',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '领取中...' })
          try {
            await DB.claimTask(this.taskId)
            wx.hideLoading()
            wx.showToast({ title: `${scene.claimLabel}成功！`, icon: 'success' })
            this.loadDetail()
          } catch (e) {
            wx.hideLoading()
            wx.showToast({ title: e.message || `${scene.claimLabel}失败`, icon: 'none' })
          }
        }
      }
    })
  },

  // ============ 交付物逐份验收 ============

  onApproveDeliverable(e) {
    this.doReviewDeliverable(e.currentTarget.dataset.id, true)
  },

  onRejectDeliverable(e) {
    this.doReviewDeliverable(e.currentTarget.dataset.id, false)
  },

  doReviewDeliverable(deliverableId, pass) {
    if (!deliverableId) return
    wx.showModal({
      title: pass ? '通过该交付物' : '驳回该交付物',
      editable: true,
      placeholderText: pass ? '验收意见（可选）' : '请填写驳回原因',
      confirmColor: pass ? '#00D4AA' : '#FF4757',
      success: async (res) => {
        if (!res.confirm) return
        const comment = res.content || ''
        if (!pass && !comment.trim()) {
          wx.showToast({ title: '请填写驳回原因', icon: 'none' })
          return
        }
        wx.showLoading({ title: '处理中...' })
        try {
          await DB.reviewDeliverable(deliverableId, pass, comment)
          wx.hideLoading()
          wx.showToast({ title: pass ? '已通过' : '已驳回', icon: 'success' })
          this.loadDetail()
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: err.message || '操作失败', icon: 'none' })
        }
      }
    })
  },

  // ============ 交付物上传 ============

  onUpload() {
    wx.showActionSheet({
      itemList: ['选择文件上传', '填写在线文档链接', '图片上传'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.chooseFile()
        } else if (res.tapIndex === 1) {
          this.inputLink()
        } else if (res.tapIndex === 2) {
          this.chooseImage()
        }
      }
    })
  },

  // 选择文件（微信内置选择器，真机顶部有「聊天/收藏/手机文件」tab可切换来源）
  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'all',
      success: (res) => {
        const file = res.tempFiles[0]
        this.doUpload(file.name, file.path, file.size)
      },
      fail: (err) => {
        if (err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '选择文件失败', icon: 'none' })
        }
      }
    })
  },

  // 拍照/相册上传
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles[0]
        const fileName = `图片_${Date.now()}.${file.tempFilePath.split('.').pop()}`
        this.doUpload(fileName, file.tempFilePath, file.size)
      }
    })
  },

  // 填写在线文档链接
  inputLink() {
    wx.showModal({
      title: '在线文档链接',
      editable: true,
      placeholderText: '请粘贴文档链接（如腾讯文档、飞书等）',
      confirmColor: '#FF6B35',
      success: (res) => {
        if (res.confirm && res.content) {
          const link = res.content.trim()
          const fileName = '在线文档_' + new Date().toLocaleDateString() + '.link'
          // 链接类型无需上传文件，直接记录
          this.doUploadLink(fileName, link)
        }
      }
    })
  },

  // 执行真实文件上传
  async doUpload(fileName, filePath, fileSize) {
    if (this.data.uploading) return
    this.setData({ uploading: true })

    wx.showLoading({ title: '上传中...', mask: true })

    try {
      const task = this.data.task

      // 格式化文件大小
      let sizeStr = '未知'
      if (fileSize) {
        if (fileSize < 1024) sizeStr = fileSize + ' B'
        else if (fileSize < 1024 * 1024) sizeStr = (fileSize / 1024).toFixed(1) + ' KB'
        else sizeStr = (fileSize / 1024 / 1024).toFixed(1) + ' MB'
      }

      await DB.uploadDeliverable({
        taskId: task._id,
        taskTitle: task.title,
        fileName,
        filePath
      })

      wx.hideLoading()
      wx.showToast({ title: '上传成功！', icon: 'success' })
      this.loadDetail()
    } catch (err) {
      console.error('上传失败', err)
      wx.hideLoading()
      wx.showToast({ title: err.message || '上传失败', icon: 'none' })
    } finally {
      this.setData({ uploading: false })
    }
  },

  // 上传在线链接（不入云存储，仅记录）
  async doUploadLink(fileName, link) {
    wx.showLoading({ title: '提交中...' })
    try {
      const task = this.data.task

      // 直接调用云函数记录（链接类型，不走云存储）
      await DB.uploadDeliverable({
        taskId: task._id,
        taskTitle: task.title,
        fileName: fileName,
        filePath: null,
        isLink: true,
        linkUrl: link
      })

      wx.hideLoading()
      wx.showToast({ title: '提交成功！', icon: 'success' })
      this.loadDetail()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '提交失败', icon: 'none' })
    }
  },

  // ============ 电脑端上传 ============
  // 微信端选不了电脑本地文件，改为签发一次性上传码，在电脑浏览器提交
  onPcUpload() {
    if (this.data.uploading) return
    wx.showLoading({ title: '生成上传码...' })
    DB.createUploadTicket(this.taskId)
      .then(ticket => {
        wx.hideLoading()
        this.showUploadTicket(ticket)
      })
      .catch(err => {
        wx.hideLoading()
        wx.showToast({ title: err.message || '生成失败', icon: 'none' })
      })
  },

  showUploadTicket(ticket) {
    if (!ticket || !ticket.code) {
      wx.showToast({ title: '生成上传码失败', icon: 'none' })
      return
    }
    const base = String(config.WEB_UPLOAD_BASE || '').replace(/\/+$/, '')
    const url = base ? base + '/?code=' + ticket.code : ''
    const lines = [
      '上传码：' + ticket.code,
      '有效期 ' + (ticket.expireHours || 2) + ' 小时，仅可使用一次'
    ]
    if (url) {
      lines.push('在电脑浏览器打开：\n' + url)
    } else {
      lines.push('电脑端上传页尚未开通，可先在小程序内直接上传')
    }

    wx.showModal({
      title: '电脑端上传',
      content: lines.join('\n'),
      confirmText: url ? '复制链接' : '知道了',
      confirmColor: '#FF6B35',
      success: res => {
        if (!res.confirm || !url) return
        wx.setClipboardData({
          data: url,
          success: () => {
            wx.showToast({ title: '链接已复制', icon: 'success' })
          }
        })
      }
    })
  },

  // 统一预览方法：归一化参数 { fileName, fileID, fileUrl, isLink }
  async previewFile(file) {
    // 1. 在线链接类型：复制链接或直接打开
    if (file.isLink && file.fileUrl) {
      this.openLink(file.fileUrl)
      return
    }
    // 兼容旧数据：链接存在 fileName 中（"名称 | 链接"）
    if (!file.fileID && file.fileName && file.fileName.indexOf(' | ') !== -1) {
      const link = file.fileName.split(' | ')[1]
      this.openLink(link)
      return
    }

    // 2. 无 fileID 且无链接
    if (!file.fileID) {
      if (file.fileUrl) {
        this.openLink(file.fileUrl)
        return
      }
      wx.showToast({ title: '该文件无预览内容', icon: 'none' })
      return
    }

    // 3. 图片类型：使用 wx.previewImage 全屏预览
    const imgExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
    const ext = (file.fileName || '').split('.').pop().toLowerCase()
    if (imgExt.indexOf(ext) !== -1) {
      wx.showLoading({ title: '加载图片...' })
      try {
        const cloud = require('../../utils/cloud')
        const tempUrl = await cloud.getTempFileURL(file.fileID)
        wx.hideLoading()
        wx.previewImage({
          current: tempUrl,
          urls: [tempUrl]
        })
      } catch (err) {
        wx.hideLoading()
        this.showFileError(err.message || '图片加载失败')
      }
      return
    }

    // 4. 其他文件：弹窗选择"在线预览"或"保存到本地"
    const tapIndex = await new Promise(resolve => {
      wx.showActionSheet({
        itemList: ['在线预览', '保存到本地'],
        success: (res) => resolve(res.tapIndex),
        fail: () => resolve(-1)
      })
    })
    if (tapIndex === -1) return

    const saveToAlbum = tapIndex === 1
    wx.showLoading({ title: saveToAlbum ? '保存中...' : '下载文件...', mask: true })
    try {
      const cloud = require('../../utils/cloud')
      const tempUrl = await cloud.getTempFileURL(file.fileID)
      wx.downloadFile({
        url: tempUrl,
        success: (res) => {
          wx.hideLoading()
          if (res.statusCode !== 200) {
            this.showFileError('下载失败（HTTP ' + res.statusCode + '）')
            return
          }
          if (saveToAlbum) {
            this.saveToLocal(res.tempFilePath, ext)
          } else {
            wx.openDocument({
              filePath: res.tempFilePath,
              showMenu: true,
              fail: () => {
                this.showFileError('无法预览此格式，可尝试"保存到本地"')
              }
            })
          }
        },
        fail: (err) => {
          wx.hideLoading()
          this.showFileError(err.errMsg || '下载失败')
        }
      })
    } catch (err) {
      wx.hideLoading()
      this.showFileError(err.message || '获取文件失败')
    }
  },

  // 预览/下载交付物（归一化后调 previewFile）
  onPreviewDeliverable(e) {
    const d = e.currentTarget.dataset.item || {}
    this.previewFile({
      fileName: d.fileName,
      fileID: d.fileID,
      fileUrl: d.fileUrl,
      isLink: !!d.isLink
    })
  },

  // 预览任务附件（附件用 type==='link' 标识链接，归一化为 isLink）
  onPreviewAttachment(e) {
    const a = e.currentTarget.dataset.item || {}
    this.previewFile({
      fileName: a.fileName,
      fileID: a.fileID,
      fileUrl: a.fileUrl,
      isLink: a.type === 'link'
    })
  },

  // 保存到本地（图片走相册，其他文件走文档管理器）
  saveToLocal(tempFilePath, ext) {
    const imgExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
    if (imgExt.indexOf(ext) !== -1) {
      wx.saveImageToPhotosAlbum({
        filePath: tempFilePath,
        success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
        fail: (err) => {
          if (err.errMsg && err.errMsg.indexOf('auth deny') !== -1) {
            wx.showModal({
              title: '需要相册权限',
              content: '请在设置中开启"保存到相册"权限',
              confirmText: '去设置',
              confirmColor: '#FF6B35',
              success: (r) => { if (r.confirm) wx.openSetting() }
            })
          } else {
            this.showFileError(err.errMsg || '保存失败')
          }
        }
      })
    } else {
      // 非图片：用 openDocument 让用户通过右上角菜单保存/转发
      wx.openDocument({
        filePath: tempFilePath,
        showMenu: true,
        success: () => wx.showToast({ title: '点击右上角可保存', icon: 'none' }),
        fail: () => this.showFileError('无法打开此格式')
      })
    }
  },

  // 统一的文件错误提示（带具体原因）
  showFileError(msg) {
    wx.showModal({
      title: '文件访问失败',
      content: msg + '\n\n可能原因：\n1. 云存储权限未设为"所有用户可读"\n2. 文件已被删除',
      showCancel: true,
      cancelText: '关闭',
      confirmText: '查看设置',
      confirmColor: '#FF6B35',
      success: (res) => {
        if (res.confirm) {
          // 引导用户去检查云存储权限
          wx.showModal({
            title: '云存储权限设置',
            content: '请前往微信开发者工具 → 云开发 → 存储 → 权限设置，将规则改为：所有用户可读，仅创建者可写',
            showCancel: false,
            confirmColor: '#FF6B35'
          })
        }
      }
    })
  },

  // 打开在线链接
  openLink(link) {
    wx.showModal({
      title: '在线文档链接',
      content: link,
      confirmText: '复制链接',
      confirmColor: '#FF6B35',
      success: (res) => {
        if (res.confirm) {
          wx.setClipboardData({
            data: link,
            success: () => wx.showToast({ title: '链接已复制', icon: 'success' })
          })
        }
      }
    })
  },

  async onComplete() {
    const task = this.data.task || {}
    // 需要验收的任务不能自行标记完成，必须走验收流程
    if (task.requireReview) {
      this.onSubmitReview()
      return
    }
    wx.showModal({
      title: '确认完成',
      content: '确定要标记该任务为已完成吗？完成后将获得任务分值。',
      confirmColor: '#FF6B35',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' })
          try {
            const res = await DB.updateTaskStatus(this.taskId, 'completed')
            // 乐观更新：立即更新本地任务状态
            const t = this.data.task
            if (t) {
              this.setData({
                task: { ...t, status: 'completed', statusText: '已完成', statusClass: 'status-completed' }
              })
            }
            // 云函数已返回最新用户统计，直接更新缓存，省一次 getUserStats 调用
            if (res && res.user) {
              auth.setCachedUser(res.user)
            }
            wx.hideLoading()
            wx.showToast({ title: '任务已完成！', icon: 'success' })
            this.loadDetail()
          } catch (e) {
            wx.hideLoading()
            wx.showToast({ title: e.message || '操作失败', icon: 'none' })
          }
        }
      }
    })
  }
})