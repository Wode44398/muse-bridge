// 轻量 toast（即时反馈，3 秒自隐）的统一入口：状态只有一份，App 根常驻的 <Toast /> 渲染。
// kind：'ok'（默认）| 'err'。本模块不 import 任何东西，谁都能静态 import 它而不成环。
export const toast = $state({ text: '', kind: 'ok' });
let _timer = null;
export function showToast(text, kind = 'ok') {
  toast.text = String(text || ''); toast.kind = kind;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { toast.text = ''; }, 3000);
}
