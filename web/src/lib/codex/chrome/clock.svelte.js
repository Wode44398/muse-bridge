// 侧栏行尾「多久以前」用的分钟时钟：有人读才走（第一个读的人启动，页面在后台时不必准）。
export const clock = $state({ now: Date.now() });

let timer = 0;
export function startClock() {
  if (timer) return;
  clock.now = Date.now();
  timer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) clock.now = Date.now(); }, 60_000);
}
