// 设置子页里懒加载的核心正文（模型中心首页 HubHome）：取过一次就同步可用。
// 页面用 {#if bodies.hubHome} 直接挂，不再经 {#await} —— 那一拍里页面只有头图、正文后补进来。
export const bodies = $state({ hubHome: null });
let hubP = null;
export function loadHubHome() {
  return (hubP ||= import('../../components/modelhub/HubHome.svelte').then(
    (m) => (bodies.hubHome = m.default),
    (e) => { hubP = null; throw e; },
  ));
}
