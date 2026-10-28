// 轻量 toast（即时反馈，3 秒自隐）的统一入口：状态只有一份，App 根常驻的 <Toast /> 渲染。
// kind：'ok'（默认）| 'err'。本模块不 import 任何东西，谁都能静态 import 它而不成环。
//
// 红字报错（kind='err'）右侧带「问 Claude」：点了开一个新的 Claude 对话、把报错填进输入框（用户确认后由 Claude 诊断、上报）。
// 动作由 App 启动时经 setErrorToastAction 注册（导航与输入栏都在别的模块里，这里不 import）；没注册或这台没开 Claude 时不出按钮。
// 带按钮的提示多留几秒，来得及点。
export const toast = $state({ text: '', kind: 'ok', action: false });
let _timer = null;
let _errAction = null;
export function setErrorToastAction(fn) { _errAction = typeof fn === 'function' ? fn : null; }
export function showToast(text, kind = 'ok') {
  toast.text = String(text || ''); toast.kind = kind;
  toast.action = kind === 'err' && !!_errAction && !!toast.text;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { toast.text = ''; }, toast.action ? 6000 : 3000);
}
export function runToastAction() {
  const text = toast.text;
  toast.text = '';
  if (_timer) clearTimeout(_timer);
  try { _errAction && _errAction(text); } catch {}
}
