// 云函数：getTeamData
// 队伍数据统一读取入口：服务端校验成员身份后再返回，客户端不再直读数据库
// event:
//   kind: 'all'(默认) | 'team' | 'members' | 'tasks' | 'task' | 'activities'
//   teamId: 目标队伍；不传则取当前用户加入的第一个队伍
//   taskId: kind = 'task' 时必填
//   status: kind = 'tasks' 时可选，按任务状态过滤
//   assigneeOpenid: kind = 'tasks' 时可选，只看某成员负责的任务
//   limit: kind = 'activities' 时可选，默认 20，最大 100
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const EMPTY = { team: null, members: [], tasks: [], activities: [] }

exports.main = async (event = {}, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()

  // 仅信任云端注入的 openid，不接受客户端传入
  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序', data: null }
  }

  const kind = event.kind || 'all'

  // 云数据库单次最多返回 100 条，这里分页拉全量（上限 1000 条）
  const fetchAll = async (buildQuery) => {
    const out = []
    while (out.length < 1000) {
      const res = await buildQuery().skip(out.length).limit(100).get()
      const list = res.data || []
      out.push(...list)
      if (list.length < 100) break
    }
    return out
  }

  const isMember = async (teamId) => {
    try {
      const res = await db.collection('members')
        .where({ teamId, openid })
        .limit(1)
        .get()
      return !!(res.data && res.data.length > 0)
    } catch (e) {
      return false
    }
  }

  try {
    // 单任务读取：成员身份用任务所属队伍判定
    if (kind === 'task') {
      const taskId = event.taskId
      if (!taskId) return { code: -1, message: '缺少任务 ID', data: null }

      let task = null
      try {
        const taskRes = await db.collection('tasks').doc(taskId).get()
        task = taskRes.data
      } catch (e) {}
      if (!task) return { code: -1, message: '任务不存在或无权查看', data: null }

      if (!(await isMember(task.teamId))) {
        return { code: -403, message: '你不在该团队中，无法查看任务', data: null }
      }
      return { code: 0, data: { task } }
    }

    // 其余 kind 都以队伍为范围
    let team = null
    if (event.teamId) {
      if (!(await isMember(event.teamId))) {
        return { code: -403, message: '你不在该团队中，无法查看数据', data: null }
      }
      try {
        const teamRes = await db.collection('teams').doc(event.teamId).get()
        team = teamRes.data
      } catch (e) {}
      if (!team) return { code: -1, message: '队伍不存在', data: null }
    } else {
      // 默认取当前用户第一个加入的队伍
      let teamId = null
      try {
        const memberRes = await db.collection('members').where({ openid }).limit(1).get()
        teamId = memberRes.data && memberRes.data.length ? memberRes.data[0].teamId : null
      } catch (e) {}
      if (!teamId) return { code: 0, data: EMPTY }
      try {
        const teamRes = await db.collection('teams').doc(teamId).get()
        team = teamRes.data
      } catch (e) {}
      if (!team) return { code: 0, data: EMPTY }
    }

    if (kind === 'team') {
      return { code: 0, data: { team } }
    }

    if (kind === 'members') {
      let members = []
      try {
        members = await fetchAll(() => db.collection('members').where({ teamId: team._id }))
      } catch (e) {}
      return { code: 0, data: { members } }
    }

    if (kind === 'tasks') {
      let tasks = []
      try {
        // 仅按 teamId 查询并在内存中过滤，避免复合索引依赖
        tasks = await fetchAll(() => db.collection('tasks')
          .where({ teamId: team._id })
          .orderBy('createdAt', 'desc'))
      } catch (e) {}
      if (event.status && event.status !== 'all') {
        tasks = tasks.filter(t => t.status === event.status)
      }
      if (event.assigneeOpenid) {
        const target = event.assigneeOpenid
        tasks = tasks.filter(t =>
          t.assigneeId === target ||
          (Array.isArray(t.assignees) && t.assignees.some(a => a && a.openid === target)))
      }
      return { code: 0, data: { tasks } }
    }

    if (kind === 'activities') {
      const limit = Math.max(1, Math.min(100, Number(event.limit) || 20))
      let activities = []
      try {
        const actsRes = await db.collection('activities')
          .where({ teamId: team._id })
          .orderBy('time', 'desc')
          .limit(limit)
          .get()
        activities = actsRes.data || []
      } catch (e) {}
      return { code: 0, data: { activities } }
    }

    // kind = 'all'：一次性返回完整数据
    let members = []
    try { members = await fetchAll(() => db.collection('members').where({ teamId: team._id })) } catch (e) {}
    let tasks = []
    try { tasks = await fetchAll(() => db.collection('tasks').where({ teamId: team._id })) } catch (e) {}
    let activities = []
    try {
      const actsRes = await db.collection('activities')
        .where({ teamId: team._id })
        .orderBy('time', 'desc')
        .limit(20)
        .get()
      activities = actsRes.data || []
    } catch (e) {}

    return { code: 0, data: { team, members, tasks, activities } }
  } catch (err) {
    return {
      code: -1,
      message: '获取数据失败: ' + err.message,
      data: null
    }
  }
}