// 把浮层挂到 Studio 外壳根上：侧栏在手机上是带 transform 的抽屉，里面的 position:fixed 会被它圈住
// （菜单只铺满抽屉那一条）。挂到 .studio-root 下仍在 Studio 的 CSS 作用域里，令牌照样生效。
export function portal(node) {
  const host = node.closest('.studio-root') || document.body;
  if (node.parentNode !== host) host.appendChild(node);
  return { destroy() { node.remove(); } };
}
