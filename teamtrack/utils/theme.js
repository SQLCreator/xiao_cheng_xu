// utils/theme.js - 日间/夜间主题
// 主题色变量定义在 app.wxss（--bg / --card / --text ...），
// 页面根节点加 theme-{{theme}} 即可切换；这里负责持久化 + 原生外观（导航栏/背景/底部标签栏）。

const STORAGE_KEY = 'themeMode'
const DEFAULT_MODE = 'dark'

const MODES = {
  dark: {
    bg: '#0F0F1A',
    navFront: '#ffffff',
    tabBg: '#1A1A2E',
    tabColor: '#A0A0B0',
    tabBorder: 'black',
    loadingStyle: 'light'
  },
  light: {
    bg: '#F5F6FA',
    navFront: '#000000',
    tabBg: '#FFFFFF',
    tabColor: '#6E6E85',
    tabBorder: 'white',
    loadingStyle: 'dark'
  }
}

/**
 * 读取当前主题：'dark' | 'light'
 */
function get() {
  try {
    const mode = wx.getStorageSync(STORAGE_KEY)
    return mode === 'light' ? 'light' : DEFAULT_MODE
  } catch (e) {
    return DEFAULT_MODE
  }
}

/**
 * 保存主题
 */
function set(mode) {
  const next = mode === 'light' ? 'light' : 'dark'
  try {
    wx.setStorageSync(STORAGE_KEY, next)
  } catch (e) {}
  return next
}

/**
 * 把主题应用到原生外观（页面背景、导航栏、底部标签栏）
 * 页面 onShow 时调用一次即可
 */
function apply(mode) {
  const key = MODES[mode] ? mode : get()
  const cfg = MODES[key]

  try {
    wx.setBackgroundColor({
      backgroundColor: cfg.bg,
      backgroundColorTop: cfg.bg,
      backgroundColorBottom: cfg.bg,
      fail() {}
    })
  } catch (e) {}

  try {
    wx.setNavigationBarColor({
      frontColor: cfg.navFront,
      backgroundColor: cfg.bg,
      animation: { duration: 0, timingFunc: 'linear' },
      fail() {}
    })
  } catch (e) {}

  try {
    // 下拉刷新指示器颜色（日间用深色、夜间用浅色，否则在深色背景上看不见）
    wx.setBackgroundTextStyle({
      textStyle: cfg.loadingStyle,
      fail() {}
    })
  } catch (e) {}

  try {
    // 非 tab 页面调用会失败，忽略即可
    wx.setTabBarStyle({
      color: cfg.tabColor,
      selectedColor: '#FF6B35',
      backgroundColor: cfg.tabBg,
      borderStyle: cfg.tabBorder,
      fail() {}
    })
  } catch (e) {}

  return key
}

/**
 * 页面 onShow 通用逻辑：同步 data.theme + 原生外观，返回当前主题
 */
function sync(page) {
  const mode = get()
  if (page && page.setData) {
    page.setData({ theme: mode })
  }
  apply(mode)
  return mode
}

module.exports = {
  get,
  set,
  apply,
  sync
}