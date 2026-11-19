// 云函数：recalcTeamStats
// 依据任务数据重算本团队成员的统计，用于修复历史数据
// （早期版本的多人协作任务没有正确计入第二位及之后的负责人）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const db = cloud.database()
  const _ = db.command

  const openid = wxContext.OPENID
  if (!openid) {
    return { code: -401, message: '登录态无效，请重新进入小程序' }
  }
  const { teamId } = event

  if (!teamId) return { code: -1, message: '缺少团队 ID' }

  try {
    // 1. 权限：负责人或管理员
    let team
    try {
      const teamRes = await db.collection('teams').doc(teamId).get()
      team = teamRes.data
    } catch (e) {
      return { code: -1, message: '团队不存在' }
    }
    const canManage = team && (team.captainId === openid ||
      (Array.isArray(team.adminIds) && team.adminIds.indexOf(openid) !== -1))
    if (!canManage) {
      return { code: -1, message: '只有负责人可以重算统计' }
    }

    // 2. 拉取成员与任务（单次最多 100 条，分页拉全量，避免大团队统计被截断）
    const fetchAll = async (collection) => {
      const out = []
      while (out.length < 1000) {
        const res = await db.collection(collection)
          .where({ teamId })
          .skip(out.length)
          .limit(100)
          .get()
        const list = res.data || []
        out.push(...list)
        if (list.length < 100) break
      }
      return out
    }
    const [members, tasks] = await Promise.all([fetchAll('members'), fetchAll('tasks')])

    // 3. 按任务重算：已完成按人数平分，进行中每人 +1
    const stats = {}
    const ensure = (id) => {
      if (!stats[id]) stats[id] = { contribution: 0, completed: 0, ongoing: 0 }
      return stats[id]
    }

    tasks.forEach(t => {
      const assignees = Array.isArray(t.assignees) && t.assignees.length > 0
        ? t.assignees.filter(a => a && a.openid)
        : (t.assigneeId ? [{ openid: t.assigneeId }] : [])
      if (assignees.length === 0) return

      if (t.status === 'completed') {
        const points = Number(t.points) || 0
        const base = Math.floor(points / assignees.length)
        assignees.forEach((a, i) => {
          const s = ensure(a.openid)
          s.contribution += base + (i === 0 ? points - base * assignees.length : 0)
          s.completed += 1
        })
      } else if (t.status === 'in_progress' || t.status === 'reviewing') {
        // 待验收仍占用「进行中」名额，与 submitTask 的计数口径保持一致
        assignees.forEach(a => { ensure(a.openid).ongoing += 1 })
      }
    })

    // 4. 逐成员对比新旧值，写回 members 并调整 users 的全局累计
    let changedMembers = 0
    for (const m of members) {
      const next = stats[m.openid] || { contribution: 0, completed: 0, ongoing: 0 }
      const oldContribution = m.contribution || 0
      const oldCompleted = m.completedTasks || 0
      const oldOngoing = m.ongoingTasks || 0

      const diffContribution = next.contribution - oldContribution
      const diffCompleted = next.completed - oldCompleted
      const diffOngoing = next.ongoing - oldOngoing

      if (diffContribution === 0 && diffCompleted === 0 && diffOngoing === 0) continue

      try {
        await db.collection('members').doc(m._id).update({
          data: {
            contribution: next.contribution,
            completedTasks: next.completed,
            ongoingTasks: next.ongoing
          }
        })
      } catch (e) {
        console.warn('[recalcTeamStats] 更新成员失败', m.openid, e)
        continue
      }

      try {
        const userRes = await db.collection('users').where({ openid: m.openid }).get()
        if (userRes.data.length > 0) {
          await db.collection('users').doc(userRes.data[0]._id).update({
            data: {
              contribution: _.inc(diffContribution),
              completedTasks: _.inc(diffCompleted),
              ongoingTasks: _.inc(diffOngoing)
            }
          })
        }
      } catch (e) {
        console.warn('[recalcTeamStats] 调整用户统计失败', m.openid, e)
      }

      changedMembers += 1
    }

    return {
      code: 0,
      data: { changedMembers, totalMembers: members.length, totalTasks: tasks.length },
      message: changedMembers > 0 ? `已修正 ${changedMembers} 位成员的统计` : '统计数据已一致'
    }
  } catch (err) {
    return { code: -1, message: '重算失败: ' + err.message }
  }
}
