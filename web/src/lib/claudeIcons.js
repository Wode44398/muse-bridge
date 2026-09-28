// Claude 分页（官方 /code 页复刻）组件用的图标。
//
// 官方 /code 页的图标不是 SVG，而是 Anthropicons-Variable 图标字体的码位（组件
// `<span data-cds="Icon">{String.fromCodePoint(cp)}</span>`）。bridge 随「code 状态栏芯片」
// 已经带上了同一份字体（app.css @font-face，asset hash c0f671921 与官方 bundle 一致，
// `.ic` 类即用它），所以组件里优先用字体字形——这是 1:1 的那条路。
//
// 同时给出一套 Phosphor 风格的 16×16 描边 SVG path 作后备（无字体环境 / 需要 SVG 的
// 场合，如 <svg> 里内联），viewBox 0 0 16 16，stroke 绘制（fill:none）。
//
// 例外（2026-09-02 实测）：bridge 那份字体【没有 U+E11C AgentsSimple】——canvas 墨水探针=0，
// 页面上渲染成一片空白（其余码位 caret/Check/Warning/X 都有墨）。AgentsSimple 一律走
// iconSvg（AgentRow / TaskSheet 已如此），别用 glyph('AgentsSimple')。
//
// 用法：
//   <span class="ic" aria-hidden="true">{glyph('CaretRight')}</span>   ← 字体字形（推荐）
//   {@html iconSvg('Warning', 16, 'my-class')}                          ← SVG 后备
//   {@html iconSvg('AgentsSimple', 16)}                                 ← 这枚只能走 SVG

// 官方码位（agent-tool-card.md §10 / fallback-banner.md §7 / workflow-panel.md §5）
export const ICON_CP = {
  AgentsSimple: 0xe11c,   // 57628：任务卡左图标 / 面板空态
  CaretRight: 0xe02a,     // 57386：可点开 / 收起态
  CaretDown: 0xe027,      // 57383：展开态
  Check: 0xe03b,          // 57403：agent 行 done
  Stop: 0xe0ea,           // 57578：停止按钮
  Warning: 0xe109,        // 57609：模型切换卡首行
  X: 0xe10f,              // 57615：Dismiss
  Info: 0xe08f,           // 57487：Banner neutral 默认图标
  Copy: 0xe056,           // 57430：复制
  CheckCircle: 0xe03c,    // 57404
  CheckCircleFilled: 0xe03d,
  DotsCircle: 0xe060,     // 57440
  Spinner: 0xe0e5,        // 57573
};

// 取字形字符；未知名字给个 □ 占位而不是抛错（模板里调用不该炸页面）。
export function glyph(name) {
  const cp = ICON_CP[name];
  return String.fromCodePoint(cp || 0x25a1);
}

// 官方 Icon 组件按尺寸插值的字重（可变字体 wght 400–700 ≈ 描边粗细）：sm(16px) 官方定
// 533.3；更小的字号需要相对更粗的描边才看得清。组件 CSS 里直接用这两档即可。
export const ICON_WEIGHT = { 12: 620, 14: 570, 16: 533, 20: 500, 24: 480 };

// —— Phosphor 风格描边 path（viewBox 0 0 16 16，stroke-width 1.25，round cap/join）——
export const CaretRight = 'M6 3.25 10.75 8 6 12.75';
export const CaretDown = 'M3.25 6 8 10.75 12.75 6';
export const Check = 'M2.75 8.5 6.25 12 13.25 4.5';
export const X = 'M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5';
export const Stop = 'M4.5 4.5h7v7h-7z';
export const Warning = 'M8 2.25 14.25 13.25H1.75ZM8 6.25v3.25M8 11.5h.01';
export const Info = 'M8 14.25A6.25 6.25 0 1 0 8 1.75a6.25 6.25 0 0 0 0 12.5ZM8 7.25v4M8 5h.01';
export const Copy = 'M5.5 5.5V3.25h7.25v7.25H10.5M3.25 5.5h7.25v7.25H3.25Z';
// 三节点小网络（AgentsSimple）：左上/左下两个节点连到右侧一个
export const AgentsSimple = 'M5.5 4.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0ZM5.5 11.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0ZM14 8a1.75 1.75 0 1 1-3.5 0A1.75 1.75 0 0 1 14 8ZM5.4 5.3l5.2 2M5.4 10.7l5.2-2';

export const ICON_PATH = { AgentsSimple, CaretRight, CaretDown, Check, Stop, Warning, X, Info, Copy };

// 生成一枚内联 SVG 字符串（{@html} 用）。size 像素；cls 挂到 <svg> 上。
export function iconSvg(name, size = 16, cls = '') {
  const d = ICON_PATH[name];
  if (!d) return '';
  const c = cls ? ` class="${cls}"` : '';
  return `<svg${c} width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
