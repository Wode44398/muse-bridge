// 英文界面文案 · 应用内对话框（lib/dialogs.js 的默认按钮、components/DialogHost.svelte，
// 以及改走 uiConfirm 的调用点新用到的按钮名）。键 = 中文原文，见 lib/i18n.js。
// 与其他分区重复的键英文必须一致（i18n-check 会报冲突）。
export default {
  // —— 默认按钮（uiAlert / uiConfirm 没传 okLabel / cancelLabel 时） ——
  '确定': 'OK',
  '取消': 'Cancel',
  // —— 合并的重复提示：「×3」旁给读屏的说明 ——
  '重复 {n} 次': 'Repeated {n} times',
  // —— 调用点的确认钮（GLOSSARY §1.6：确认钮重复动作本身，不写 OK） ——
  '离开': 'Leave',
  '关掉': 'Turn off',
};
