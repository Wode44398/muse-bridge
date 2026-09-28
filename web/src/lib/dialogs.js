// 统一提示/确认对话框入口（异步签名，调用方统一 await）。
export async function uiAlert(message, { detail = '' } = {}) {
  window.alert(detail ? message + '\n' + detail : message);
}

export async function uiConfirm(message, { detail = '' } = {}) {
  return window.confirm(detail ? message + '\n' + detail : message);
}
