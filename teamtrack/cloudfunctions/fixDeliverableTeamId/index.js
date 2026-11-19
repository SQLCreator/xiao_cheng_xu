// 云函数：fixDeliverableTeamId（已停用）
//
// 该函数原本用于一次性回填 deliverables.teamId，修复工作已于 2026-11-18 完成：
//   apply 执行：scanned=2 / fixed=2；随后复跑预演：scanned=0，无残留。
//
// 为防止任意小程序用户调用该函数写入或删除数据，现已下线为固定返回，
// 不再读取 event、也不再执行任何数据库操作。
exports.main = async () => ({
  code: -410,
  message: '该修复函数已停用，不再执行任何操作'
})