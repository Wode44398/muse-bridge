// 英文界面文案 · 文本类预览（DocViewer 的代码/文本/表格分支、CodeView、TableView、HtmlView 源码态、分享页的不可预览提示）
// 键 = 中文原文，见 lib/i18n.js。措辞对齐 VS Code（Find / Go to Line / Word Wrap / Reopen with Encoding）。
export default {
  // —— 工具与菜单 ——
  '完成编辑': 'Done Editing',
  '查看原文': 'View Raw',
  '格式化显示': 'Formatted View',
  '表格视图': 'Table View',
  '筛选行': 'Filter rows',
  '筛选行…': 'Filter Rows…',
  '查找': 'Find',
  '查找…': 'Find…',
  '跳到行…': 'Go to Line…',
  '自动换行': 'Word Wrap',
  '字号::放大': 'Zoom In',
  '字号::缩小': 'Zoom Out',
  '默认大小': 'Reset Size',
  '编码': 'Encoding',
  '通过编码重新打开': 'Reopen with Encoding',
  '复制全文': 'Copy All',
  '查看页面': 'View Page',
  '以文本方式打开': 'Open as Text',
  '无法预览': 'Can’t Preview',
  '下载完整文件': 'Download Full File',

  // —— 查找条 / 跳行条（CodeView、TableView） ——
  '区分大小写': 'Match case',
  '全字匹配': 'Match whole word',
  '正则表达式': 'Use regular expression',
  '正则有误': 'Invalid regex',
  '无结果': 'No results',
  '请输入行号': 'Enter a line number',
  '跳到行（1–{n}）': 'Go to line (1–{n})',
  '跳转': 'Go',
  '字号 {n}%': 'Text size {n}%',

  // —— 表格（TableView） ——
  '{n} 行': { one: '{n} row', other: '{n} rows' },
  '{r} 行 × {c} 列': '{r} rows × {c} columns',
  '没有匹配的行': 'No matching rows',
  '没有数据行': 'No data rows',
  '点格子查看完整内容': 'Tap a cell to see its full content',
  '点格子查看完整内容，Shift 扩选，Ctrl+C 复制': 'Click a cell to see its full content. Shift extends the selection, Ctrl+C copies.',
  '仅显示前 {n} 行': 'Showing the first {n} rows',

  // —— 大文件截断 ——
  '文件较大，仅显示前 {shown}（共 {total}），不可编辑': 'Large file: showing the first {shown} of {total}. Editing is off.',
  '仅显示前 {shown}，不可编辑': 'Showing the first {shown}. Editing is off.',
  '仅显示前 {n}（共 {total}）': 'Showing the first {n} of {total}',
  '仅显示前 {n}': 'Showing the first {n}',

  // —— 编码与保存 ——
  '有未保存的修改，先保存再换编码': 'Save your changes before reopening with another encoding',
  '需要先确认转成 UTF-8': 'Confirm the conversion to UTF-8 first',
  '这个文件是 {enc} 编码，保存后会转成 UTF-8（其他只认 {enc} 的程序可能读成乱码）。': 'This file uses {enc}. Saving converts it to UTF-8, so apps that only read {enc} may show garbled text.',
  '转成 UTF-8 并保存': 'Convert to UTF-8 and Save',

  // —— Markdown 阅读态 ——
  '这一项没法在阅读态勾选，请到编辑态修改': 'This item can’t be checked in reading view. Switch to editing to change it.',
  '无法打开这个链接': 'Can’t open this link',

  // —— 分享页 ——
  '这种文件无法在线预览，已开始下载': 'This file can’t be previewed online, so it’s downloading instead',
};
