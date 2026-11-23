export const isMac = navigator.platform.startsWith('Mac') && navigator.maxTouchPoints < 2
export const isAndroid = /Android/i.test(navigator.userAgent)
