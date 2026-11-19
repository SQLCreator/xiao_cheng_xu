/**
 * 权限判定（纯函数，前端用于控制按钮显隐；云函数内各自做同样的校验）
 *
 * 角色约定：
 *   captainId   —— 队伍所有者（旧数据叫「队长」，新场景叫「负责人」）
 *   adminIds[]  —— 管理员，可代为管理项目
 *   assignees[] —— 任务负责人，可多人协作
 */

function isOwner(team, openid) {
  return !!team && !!openid && team.captainId === openid
}

function isAdmin(team, openid) {
  return !!team && !!openid && Array.isArray(team.adminIds) && team.adminIds.indexOf(openid) !== -1
}

/** 可管理队伍（改阶段、指派、验收、解散） */
function canManageTeam(team, openid) {
  return isOwner(team, openid) || isAdmin(team, openid)
}

/** 是否为任务负责人（兼容旧的单人 assigneeId 与新的 assignees） */
function isAssignee(task, openid) {
  if (!task || !openid) return false
  if (task.assigneeId === openid) return true
  if (Array.isArray(task.assignees) && task.assignees.some(a => a && a.openid === openid)) {
    return true
  }
  return false
}

/** 任务负责人列表，统一成 [{ openid, nickName }] */
function assigneeList(task) {
  if (!task) return []
  if (Array.isArray(task.assignees) && task.assignees.length > 0) {
    return task.assignees.filter(a => a && a.openid)
  }
  if (task.assigneeId) {
    return [{ openid: task.assigneeId, nickName: task.assigneeName || '负责人' }]
  }
  return []
}

/** 任务是否走指派制 */
function isAssignMode(task) {
  return !!task && task.assignMode === 'assign'
}

module.exports = {
  isOwner,
  isAdmin,
  canManageTeam,
  isAssignee,
  assigneeList,
  isAssignMode
}
