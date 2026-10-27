// 统一提示/确认对话框（去 web 化）。
// 桌面壳：dialog.showMessageBox 真系统对话框——window.alert/confirm 在 Electron 里是
// Chromium 弹窗（标题带「127.0.0.1:8787 显示」，一眼网页），window.prompt 干脆没实现。
// 网页/Android：保持原生 alert/confirm（WebView 会渲染成系统样式，本来就没问题）。
import { desktopApp } from './nativeDesktop.js';
import { t } from './i18n.js';

const hasBox = () => Boolean(desktopApp?.messageBox);

export async function uiAlert(message, { type = 'info', detail = '' } = {}) {
  if (hasBox()) { await desktopApp.messageBox({ type, message: String(message), detail: detail || undefined }); return; }
  window.alert(detail ? message + '\n' + detail : message);
}

export async function uiConfirm(message, { detail = '', okLabel = t('确定'), cancelLabel = t('取消'), type = 'question' } = {}) {
  if (hasBox()) {
    const r = await desktopApp.messageBox({
      type, message: String(message), detail: detail || undefined,
      buttons: [okLabel, cancelLabel], defaultId: 0, cancelId: 1,
    });
    return r?.response === 0;
  }
  return window.confirm(detail ? message + '\n' + detail : message);
}
