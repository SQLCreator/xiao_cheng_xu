/**
 * 统一文案配置
 * 不分场景模块：竞赛团队、企业项目组、自由小组共用一套中性叫法。
 * 页面通过 getScene() 取值，wxml 里用 {{scene.xxx}} 绑定。
 */

const SCENE = {
  name: '团队',
  productName: '队迹协作工具',

  teamLabel: '团队',
  teamListTitle: '我的团队',
  memberLabel: '成员',
  ownerLabel: '负责人',
  joinLabel: '加入团队',
  createLabel: '创建团队',
  inviteLabel: '团队邀请码',

  timelineLabel: '项目阶段',
  categoryLabel: '类型',
  categoryPlaceholder: '请选择类型',
  namePlaceholder: '如：官网改版项目',
  descPlaceholder: '简要描述目标与交付范围',

  // 任务
  claimLabel: '领取',
  claimDone: '领取成功',
  assignMode: 'claim',
  requireReview: false,
  assignLabel: '指派成员',
  unassignedLabel: '待指派',
  submitReviewLabel: '提交验收',
  passLabel: '通过验收',
  rejectLabel: '驳回',
  contributionLabel: '贡献值',

  pointsEnabled: true,

  // 创建团队时可选的项目类型
  templates: ['产品研发', '竞赛比赛', '市场运营', '学习成长', '其他'],

  // 新团队的默认阶段（团队创建后会存成快照，后续可单独调整）
  milestones: ['启动', '规划', '执行', '评审', '验收', '交付'],

  // 任务分类与分值
  categories: ['开发', '设计', '文档', '调研', '其他'],
  pointsOptions: [10, 20, 30, 40, 50, 60]
}

/**
 * 获取文案配置
 */
function getScene() {
  return SCENE
}

/**
 * 队伍所属场景（已统一，保留函数以兼容现有调用）
 */
function getTeamScene() {
  return SCENE
}

/**
 * 团队类型的展示名，兼容旧数据的 competition 字段
 */
function categoryOf(team) {
  if (!team) return ''
  return team.category || team.competition || ''
}

/**
 * 生成时间线数据
 * 优先用团队自己的 milestones，否则用默认阶段；currentStep 为 1 起始的序号
 */
function buildTimeline(team) {
  const milestones = (team && Array.isArray(team.milestones) && team.milestones.length > 0)
    ? team.milestones
    : SCENE.milestones
  const currentStep = (team && team.currentStep) || 1

  return milestones.map((title, index) => {
    const step = index + 1
    const done = step < currentStep
    const current = step === currentStep
    return {
      step,
      title,
      done,
      current,
      statusText: current ? '进行中' : (done ? '已完成' : '待开始')
    }
  })
}

module.exports = {
  SCENE,
  getScene,
  getTeamScene,
  categoryOf,
  buildTimeline
}
