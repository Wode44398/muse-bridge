// 聊天正文 markdown 链接的点击分流。
//
// 模型在最终回答里写的「产物链接」多是裸文件路径（C:\...\报告.csv / 相对路径）——
// 浏览器把它按相对 URL 解析成 http://<host>/C:\... 整页跳走。
// 这里统一委托拦截：
//   · 路径式链接 → 调用方给的 resolveInternal（Thread 里映射到附件卡 → openPreview）
//   · 同源 /api/*artifact* 链接 → 同样交 resolveInternal（模型偶尔写完整 URL）
//   · 真外链 http(s) → 放行（md.js 已加 target=_blank）
//   · mailto/tel → 放行原生为
// md.js 只给真外链加 target=_blank，路径式链接没有 target——不拦截就是整页跳走，
// 所以任何 {@html renderMarkdown()} 容器都应挂上这里的 onMdClick。

const PATHISH = /^([A-Za-z]:[\\/]|\\\\|\.{0,2}[\\/])/;   // 盘符 / UNC / 相对路径

// e：click 事件（挂在渲染容器上，内部委托找 <a>）。
// resolveInternal(href, a)：调用方处理内部链接，返回 true=已接管；不传或返回 false=吞掉点击
// （绝不让 SPA 整页跳走——宁可无动作也不能把应用导航去 404）。
export function onMdClick(e, resolveInternal) {
  const a = e.target?.closest?.('a[href]');
  if (!a) return;
  const raw = a.getAttribute('href') || '';
  if (/^(mailto:|tel:)/i.test(raw)) return;   // 系统协议：原生行为
  if (/^https?:\/\//i.test(raw)) {
    let u = null;
    try { u = new URL(raw); } catch { /* 解析不了当外链处理 */ }
    // 同源的 artifact/file 链接＝内部产物写成了完整 URL，走应用内预览
    if (u && u.origin === location.origin && /\/(artifact|api\/file)\b/.test(u.pathname)) {
      e.preventDefault();
      resolveInternal?.(raw, a);
      return;
    }
    return;   // 真外链：md.js 已加 target=_blank，放行
  }
  // 路径式 / 相对链接：绝不让页面跳走；能解析成产物就应用内预览
  e.preventDefault();
  resolveInternal?.(raw, a);
}
