// 工作区「开着哪几张卡」的状态变换（纯函数，四个 agent 分页共用）。
//
// 状态的形状：{ views, view, last, multi, max }
//   views = 此刻开着的卡（按打开先后）；view = 最近打开 / 聚焦的那一张（手机一次一张、视图上报只认它）；
//   last  = 整个收起前开着的那几张（不带参数再打开时原样摆回来）；
//   multi = 允许几张卡同时开（宿主按形态定）；max = 放大铺满的那张（'' = 没有）。
// 每个函数回一份补丁（只含要改的字段），由调用方写回响应式状态。

const cleanMax = (max, views) => (max && views.includes(max) ? max : '');

// 打开一张卡。view 缺省 / 不认识：整个收着且有上次的记录 → 摆回上次那几张；否则回落最近那张、再回落 fallback。
// 多卡形态下是「加一张」，不顶掉别的。回的 again = 这张本来就开着（宿主可以闪一下提示）。
export function openPatch(s, view, { known, fallback }) {
  if (!known(view)) {
    const last = s.views.length ? [] : s.last.filter(known);
    if (last.length) {
      const keep = known(s.view) && last.includes(s.view) ? s.view : last[last.length - 1];
      const views = s.multi ? last : [keep];
      return { views, view: keep, max: '', again: false };
    }
    view = known(s.view) ? s.view : fallback;
  }
  const again = s.views.includes(view);
  const views = s.multi ? (again ? s.views : [...s.views, view]) : [view];
  // 放大着别的卡时点开这一张：放大态让给它，不然新卡被藏在后面等于没开
  return { views, view, max: s.max === view ? cleanMax(s.max, views) : '', again };
}

// 整个收起：记下此刻开着的，下次不带参数打开时摆回来
export function closeAllPatch(s) {
  return { views: [], max: '', last: s.views.length ? [...s.views] : s.last };
}

// 关掉一张卡；关的是最后一张 = 整个收起。没开着这张回 null。
export function closeViewPatch(s, view) {
  if (!s.views.includes(view)) return null;
  const rest = s.views.filter((v) => v !== view);
  if (!rest.length) return closeAllPatch(s);
  return { views: rest, view: s.view === view ? rest[rest.length - 1] : s.view, max: cleanMax(s.max, rest) };
}

// 宿主形态变了（进分屏 / 窗口缩窄 / 折叠屏）：不许多卡时只留最近那张
export function multiPatch(s, on) {
  on = !!on;
  if (s.multi === on) return null;
  if (on || s.views.length < 2) return { multi: on };
  const keep = s.views.includes(s.view) ? s.view : s.views[s.views.length - 1];
  return { multi: on, views: [keep], view: keep, max: cleanMax(s.max, [keep]) };
}

// 门禁把开着的卡藏掉了（没有命令行的身份没有终端 / 浏览器、插件撤掉了它的卡）：跟着收掉。
// 一张都不剩时回落第一张可用的；连可用的都没有就整个收起。
export function prunePatch(s, ok) {
  if (!s.views.length) return null;
  const rest = s.views.filter((v) => ok.includes(v));
  if (rest.length === s.views.length) return null;
  if (!rest.length) return ok.length ? { views: [ok[0]], view: ok[0], max: '' } : { views: [], max: '' };
  return { views: rest, view: rest.includes(s.view) ? s.view : rest[rest.length - 1], max: cleanMax(s.max, rest) };
}
