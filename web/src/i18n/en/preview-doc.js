// 英文界面文案 · 文档类预览（PDF 阅读器、Word/PPT/Excel 预览、服务端转换进度）（键 = 中文原文，见 lib/i18n.js）
export default {
  // —— PDF 阅读器 ——
  '页面': 'Pages',
  '缩略图': 'Thumbnails',
  '书签': 'Bookmarks',
  '没有标题': 'No headings',
  '页面缩略图': 'Page thumbnails',
  '第 {n} 页': 'Page {n}',
  '页码': 'Page number',
  '上一页': 'Previous page',
  '下一页': 'Next page',
  '正在载入 {p}%': 'Loading {p}%',
  '缩放': 'Zoom',
  '自动缩放': 'Automatic zoom',
  '适应宽度': 'Fit width',
  '适应页面': 'Fit page',
  '实际大小': 'Actual size',
  '向左旋转': 'Rotate left',
  '向右旋转': 'Rotate right',
  '双页视图': 'Two-page view',
  '打印': 'Print',
  '正在准备打印…': 'Preparing to print…',
  '打印失败': 'Couldn’t print',
  '页面大小': 'Page size',
  '生成工具': 'Producer',
  'PDF 版本': 'PDF version',
  '表单': 'Forms',
  '含表单（只读显示）': 'Has forms (shown read-only)',
  '横向': 'Landscape',
  '没有可搜索的文字（可能是扫描件）': 'No searchable text (it may be a scan)',
  '文件已损坏或不是有效的 PDF': 'The file is damaged or isn’t a valid PDF',
  '文件不存在或已被移动': 'The file doesn’t exist or has been moved',
  '网络中断，PDF 没有下载完': 'The connection dropped before the PDF finished downloading',

  // —— 密码 ——
  '此文档受密码保护': 'This document is password protected',
  '输入密码以打开「{name}」': 'Enter the password to open “{name}”',
  '输入密码以打开': 'Enter the password to open it',
  '输入密码': 'Enter password',
  '密码不正确，请重试': 'Incorrect password. Try again.',

  // —— 查找 ——
  '查找': 'Find',
  '无结果': 'No results',
  '在文档中查找': 'Find in document',
  '区分大小写': 'Match case',
  '关闭查找': 'Close find',

  // —— Word ——
  '字数': 'Words',
  '快速预览：由浏览器直接排版，字体、分页与原文件可能不同。':
    'Quick preview: laid out by the browser, so fonts and page breaks may differ from the original file.',
  // 手机窄屏 docx：阅读视图（重排）↔ 打印版式（服务端 PDF）
  '阅读视图': 'Reading view',
  '打印版式': 'Print layout',
  '阅读视图（按屏幕宽度重排）': 'Reading view (reflowed to the screen width)',
  '阅读视图：按屏幕宽度重排，字体与分页和原文件可能不同；要看原版式可在 ⋮ 里切到「打印版式」。':
    'Reading view: reflowed to fit the screen, so fonts and page breaks may differ from the original. Switch to Print layout in the ⋮ menu to see the original layout.',
  '阅读视图：按屏幕宽度重排，字体与分页和原文件可能不同。':
    'Reading view: reflowed to fit the screen, so fonts and page breaks may differ from the original.',

  // —— 演示文稿 ——
  '幻灯片': 'Slides',
  '放映': 'Present',
  '从当前页放映': 'Present from current slide',
  '演讲者备注': 'Speaker notes',
  '这一页没有备注': 'This slide has no notes',
  '这张图片的格式无法在网页里显示': 'This image format can’t be shown in a browser',
  '放映结束，单击退出': 'End of slideshow. Click to exit.',
  '退出放映': 'Exit slideshow',
  '系列': 'Series',
  '这个演示文稿里没有幻灯片': 'This presentation has no slides',

  // —— 表格 ——
  '工作表': 'Sheets',
  '当前工作表': 'Current sheet',
  '{name}（隐藏）': '{name} (hidden)',
  '冻结窗格': 'Freeze panes',
  '网格线': 'Gridlines',
  '复制所选单元格': 'Copy selected cells',
  '数据范围': 'Data range',
  '{r} 行 × {c} 列': '{r} rows × {c} columns',
  '完整大小': 'Full size',
  '{n} 个工作表': { one: '{n} sheet', other: '{n} sheets' },
  '公式栏': 'Formula bar',
  '名称框': 'Name box',
  '无效的单元格地址': 'Invalid cell reference',
  '求和': 'Sum',
  '平均值': 'Average',
  '计数': 'Count',
  '选区太大，无法复制': 'The selection is too large to copy',
  '选中的单元格是空的': 'The selected cells are empty',
  '已复制 {n} 个单元格': { one: 'Copied {n} cell', other: 'Copied {n} cells' },
  '正在读取表格…': 'Reading spreadsheet…',
  '表格受密码保护': 'This spreadsheet is password protected',
  '网页里打不开加密的表格，请下载后用 Excel 或 WPS 打开。':
    'Encrypted spreadsheets can’t be opened in a browser. Download it and open it in Excel or WPS.',
  '表格太大，只显示前 {r} 行 × {c} 列': 'The spreadsheet is too large. Showing only the first {r} rows × {c} columns.',

  // —— 服务端转换 ——
  '预览方式': 'Preview mode',
  '快速预览（未经服务端转换）': 'Quick preview (not converted on the server)',
  '先看快速预览': 'Show quick preview',
  '原版式 PDF 已转换好': 'The original-layout PDF is ready',
  '服务端转换没成功，先用快速预览显示': 'Server conversion failed, showing the quick preview instead',
  '转换出的 PDF 打不开，先用快速预览显示': 'The converted PDF couldn’t be opened, showing the quick preview instead',
  '正在转换': 'Converting',
  '排队中': 'Queued',
  '正在转换 · 已用 {n} 秒': { one: 'Converting · {n} second', other: 'Converting · {n} seconds' },
  '排队中 · 前面还有 {n} 个': { one: 'Queued · {n} file ahead', other: 'Queued · {n} files ahead' },
  '第一次打开要先把文档转成 PDF，转好后再打开会直接显示。':
    'The first time, the document has to be converted to PDF. After that it opens right away.',
  '第一次打开要先把演示文稿转成 PDF，转好后再打开会直接显示。':
    'The first time, the presentation has to be converted to PDF. After that it opens right away.',
  '文件读取失败': 'Couldn’t read the file',
  '这里打不开 {ext} 文件': '{ext} files can’t be opened here',
  '{ext} 要在服务端转换后才能预览。可以用其它应用打开，或放进工作空间再看。':
    '{ext} files need to be converted on the server before they can be previewed. Open it in another app, or put it in the workspace and try again.',
  '服务端没有安装 LibreOffice': 'LibreOffice isn’t installed on the server',
  '{ext} 文件需要 LibreOffice 转换后才能预览。装好后重新打开即可。':
    '{ext} files need LibreOffice to convert them before they can be previewed. Install it, then open the file again.',
  '转换失败': 'Conversion failed',
  'LibreOffice 没能转换这个文件，它可能已损坏或设置了密码。':
    'LibreOffice couldn’t convert this file. It may be damaged or password protected.',
  '重新转换': 'Convert again',
  '转换超时': 'Conversion timed out',
  '文件较大或服务端繁忙，稍后再试一次。': 'The file is large or the server is busy. Try again later.',
  '无法连接服务端': 'Can’t reach the server',
}
