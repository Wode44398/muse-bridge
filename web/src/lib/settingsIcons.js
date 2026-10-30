// 设置页行首线稿图标（v5「墨与象牙」）：24 网格、1.6 描边、圆头圆角，同一套几何母题——
// 圆角 2.2~2.8 的矩形、整圆、短横。只用 currentColor，不上色块：颜色只留给各 agent 自己的品牌标。
// 取代原先的彩色 SF Symbol 方块（彩虹色 + 拼凑字形是「AI 味」的主要来源）。
export const SI = {
  // 通用：两根推子
  general: '<path d="M4 8h8.5M17.5 8H20M4 16h2.5M11.5 16H20"/><circle cx="15" cy="8" r="2.5"/><circle cx="9" cy="16" r="2.5"/>',
  // 外观：半实心圆（明暗）
  appearance: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  // 壁纸：画框 + 远近两道山 + 太阳
  wallpaper: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M3.8 16.2l4.3-4.3a1.5 1.5 0 0 1 2.1 0l5.6 5.6"/><path d="M13.7 15.3l1.5-1.5a1.5 1.5 0 0 1 2.1 0l3 3"/><circle cx="15.6" cy="9.4" r="1.4"/>',
  // 流体壁纸：两道波
  flux: '<path d="M3.5 9.5c1.4 0 2.1-1.5 4.25-1.5S10.6 9.5 12 9.5s2.1-1.5 4.25-1.5 2.85 1.5 4.25 1.5"/><path d="M3.5 15.5c1.4 0 2.1-1.5 4.25-1.5s2.85 1.5 4.25 1.5 2.1-1.5 4.25-1.5 2.85 1.5 4.25 1.5"/>',
  // 扩展：三块方 + 一枚圆
  extensions: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/><circle cx="16.5" cy="7.5" r="3.5"/>',
  // 额度与注册：表盘
  policy: '<path d="M4 16.5a8 8 0 1 1 16 0"/><path d="M12 16.5l3.6-4.2"/><circle cx="12" cy="16.5" r="1.3" fill="currentColor" stroke="none"/>',
  // 服务端控制台：两层机架
  server: '<rect x="4" y="4.5" width="16" height="6.5" rx="2"/><rect x="4" y="13" width="16" height="6.5" rx="2"/><path d="M7.6 7.75h.01M7.6 16.25h.01" stroke-width="2.4"/><path d="M11 7.75h5.5M11 16.25h5.5"/>',
  // 手机操控
  phone: '<rect x="6.5" y="3" width="11" height="18" rx="2.8"/><path d="M10.5 18h3"/>',
  // 本机 Agent：显示器
  localpc: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2.2"/><path d="M12 16v3.5M8.5 19.5h7"/>',
  // 远程控制：显示器里一枚指针
  remote: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2.2"/><path d="M12 16v3.5M8.5 19.5h7"/><path d="M10.2 7.6l4.4 1.7-1.9.75-.75 1.9z" fill="currentColor"/>',
  // 通用兜底标（没有品牌标的 agent 行用）：圆 + 一道高光
  orb: '<circle cx="12" cy="12" r="8"/><path d="M8.3 10.6a4.2 4.2 0 0 1 3.4-3"/>',
  // Agent 接入：一把钥匙（给别的 agent 的密钥）
  agentapi: '<circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H20M16.6 12v3M19.6 12v2.2"/>',
  // 提交反馈：对话气泡
  feedback: '<path d="M7 4.5h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-5.2l-4.3 3.3v-3.3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z"/><path d="M8.5 9.5h7M8.5 12.5h4"/>',
  // 软件更新：落入托盘的箭头
  update: '<path d="M12 4.5v9.5M8 10.5l4 4 4-4"/><path d="M4.5 15.5v1.5a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5v-1.5"/>',
  // 关于：圆里一个 i（月桥标已是 dimensio 的品牌标，这里不再借用）
  about: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5"/><path d="M12 7.9h.01" stroke-width="2.3"/>',
  // 快捷键：键帽
  keys: '<rect x="3" y="6" width="18" height="12" rx="2.6"/><path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01" stroke-width="2.1"/><path d="M8 14h8"/>',
  // 连接与更新：地球
  connect: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.3 2.2 3.4 4.9 3.4 8s-1.1 5.8-3.4 8c-2.3-2.2-3.4-4.9-3.4-8s1.1-5.8 3.4-8z"/>',
  // 编辑 / 删除（号池行的悬停动作）
  edit: '<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="M12.5 7.5l4 4"/>',
  trash: '<path d="M5 7h14M10 4h4"/><path d="M7 7l.8 11.2a2 2 0 0 0 2 1.8h4.4a2 2 0 0 0 2-1.8L17 7"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  // 刷新（分组标题旁的小动作）
  refresh: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.2 4.6v3.6h-3.6"/>',
  // 上移 / 下移
  up: '<path d="M12 18.5v-13M6.5 11l5.5-5.5 5.5 5.5"/>',
  down: '<path d="M12 5.5v13M6.5 13l5.5 5.5 5.5-5.5"/>',
  // 工作空间：文件夹
  folder: '<path d="M3.5 7.6A2.6 2.6 0 0 1 6.1 5h3.1c.5 0 1 .2 1.3.6l1.3 1.5h6.1a2.6 2.6 0 0 1 2.6 2.6v7.7a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6z"/><path d="M3.5 10.5h17"/>',
  // 扫一扫：四角取景 + 一道扫描线
  scan: '<path d="M4 8.5V7a3 3 0 0 1 3-3h1.5M15.5 4H17a3 3 0 0 1 3 3v1.5M20 15.5V17a3 3 0 0 1-3 3h-1.5M8.5 20H7a3 3 0 0 1-3-3v-1.5"/><path d="M7.5 12h9"/>',
};

// 各 agent 的品牌标（真标，不是自绘字形）：路径相对 BASE_URL；明暗两版的按界面明暗取
export function agentMark(id, dark) {
  switch (id) {
    case 'claude': return 'assets/mascot/claude-菊花-静态.svg';   // i18n-ignore 素材路径
    case 'gemini': return 'assets/icons/gemini.svg';
    case 'codex': return `assets/icons/chatgpt-${dark ? 'light' : 'dark'}.svg`;
    case 'dimensio': return `assets/icons/dimensio-${dark ? 'light' : 'dark'}.svg`;
    default: return '';
  }
}
