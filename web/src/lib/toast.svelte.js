// 轻量 toast（即时反馈，3 秒自隐）的统一入口。状态只有一份，由 App 根挂的 <Toast /> 渲染。
export const toast = $state({ text: '', kind: 'ok' });
let _timer = null;
export function showToast(text, kind = 'ok') {
  toast.text = String(text || ''); toast.kind = kind;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { toast.text = ''; }, 3000);
}
