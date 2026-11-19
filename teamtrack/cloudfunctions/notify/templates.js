// 订阅消息模板配置
// 获取方式：mp.weixin.qq.com → 功能 → 订阅消息 → 我的模板 → 选用模板后点「详情」
// 把「模板ID」和「关键词/字段名」填到下面即可，前端无需改动（前端通过 notify 云函数读取本文件）
//
// fields 是「业务字段 → 模板字段」的映射，例如模板详情里写的是
//   任务名称 {{thing1.DATA}}  所属团队 {{thing2.DATA}}  时间 {{time3.DATA}}  备注 {{thing4.DATA}}
// 那么 fields 就写 { title: 'thing1', team: 'thing2', time: 'time3', remark: 'thing4' }
module.exports = {
  // ① 任务指派通知（负责人把任务指派给成员时）
  taskAssigned: {
    templateId: 'Wu8KP8uhi0KrfSElFxFCksVb6PCHY8k0GHOIWa3BYe0',
    page: 'pages/taskDetail/taskDetail?id={taskId}',
    fields: { title: 'thing1', team: 'thing2', time: 'time3', remark: 'thing4' }
  },

  // ② 待验收提醒（成员提交验收后提醒负责人）
  reviewNeeded: {
    templateId: 'Wu8KP8uhi0KrfSElFxFCksVb6PCHY8k0GHOIWa3BYe0',
    page: 'pages/taskDetail/taskDetail?id={taskId}',
    fields: { title: 'thing1', team: 'thing2', time: 'time3', remark: 'thing4' }
  },

  // ③ 审批结果通知（任务验收通过/驳回、入队申请通过/拒绝）
  reviewResult: {
    templateId: 'Wu8KP8uhi0KrfSElFxFCksVb6PCHY8k0GHOIWa3BYe0',
    page: 'pages/taskDetail/taskDetail?id={taskId}',
    fields: { title: 'thing1', result: 'thing2', time: 'time3', remark: 'thing4' }
  }
}