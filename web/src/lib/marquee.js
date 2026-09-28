// 会话标题跑马灯（逆向 claude.ai/code 实测规格，2026-07-29）：
// - 溢出的标题默认右缘渐隐（mask 85%→99%），不再用 ellipsis；
// - 指针悬停行且【静止】~150ms 后，内层以 50px/s 匀速滚到尾部——尾部正好停在
//   右侧渐隐区（44px）起点；滚动距离 = 溢出量 + 44px，时长 = 距离/50；
// - 悬停期间 mask 换成两端渐隐（左 12px 只在开滚后出现、右 44→20px 为 ⋮ 按钮留位）；
// - 指针离开：瞬时弹回（官方无回程过渡）。
// 结构约定：node = 外层遮罩（overflow hidden），firstElementChild = 内层滚动条。
// 视觉全部由 CSS 按 data-ov（溢出）/ data-run（滚动中）与 --mq-x/--mq-dur 变量驱动。
export function marquee(node) {
  const inner = node.firstElementChild;
  const row = node.closest('.d-row');
  if (!inner || !row) return {};
  const FADE_R = 44;   // 右侧渐隐区宽（官方 calc(100%-44px)→calc(100%-20px)）
  const SPEED = 50;    // px/s，官方实测 377px/7.54s
  const IDLE = 150;    // 指针静止判定（官方实测 ~150-180ms）
  let idleT = 0, ov = 0;

  const measure = () => {
    ov = inner.scrollWidth - node.clientWidth;
    if (ov > 1) node.dataset.ov = '';
    else { delete node.dataset.ov; stop(); }
  };
  const start = () => {
    if (!(ov > 1)) return;
    const dist = ov + FADE_R;
    node.style.setProperty('--mq-x', dist + 'px');
    node.style.setProperty('--mq-dur', (dist / SPEED).toFixed(2) + 's');
    node.dataset.run = '';
  };
  const stop = () => { delete node.dataset.run; };
  const arm = () => { clearTimeout(idleT); idleT = setTimeout(start, IDLE); };   // 移动重置计时=静止才滚
  const enter = () => { measure(); arm(); };
  const leave = () => { clearTimeout(idleT); stop(); };

  row.addEventListener('pointerenter', enter);
  row.addEventListener('pointermove', arm);
  row.addEventListener('pointerleave', leave);
  const ro = new ResizeObserver(measure);   // 侧栏拉动改宽 → 实时重量溢出
  ro.observe(node);
  const mo = new MutationObserver(() => { stop(); measure(); });   // 标题改名 → 复位重量
  mo.observe(inner, { childList: true, characterData: true, subtree: true });
  measure();

  return { destroy() {
    clearTimeout(idleT); ro.disconnect(); mo.disconnect();
    row.removeEventListener('pointerenter', enter);
    row.removeEventListener('pointermove', arm);
    row.removeEventListener('pointerleave', leave);
  } };
}
