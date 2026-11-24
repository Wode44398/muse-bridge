// 插件工作区外观里两个 agent 的标志（agy 侧）：
//   · agy 圆里的标志用液态引擎（antigravity-logo.js）的 static 态离线画成一段 svg——侧栏里一屏可能有几十颗，
//     不必每颗都起一个控制器；要动（对话框里的升现、在跑）时才用 AgyWorkingMark / 引擎控制器。
//   · 单色版（菜单图标）同一个 static 轮廓、fill=currentColor。
// 引擎 120KB，AgyPage 空闲时预取；没到之前返回 ''，调用方 await ensureAgyLogo() 再画一次。

let uid = 0;
let loading = null;

const api = () => globalThis.AntigravityLogo || null;

export function agyLogoReady() {
  return !!api();
}

export function ensureAgyLogo() {
  if (api()) return Promise.resolve(true);
  if (!loading) loading = import('./antigravity-logo.js').then(() => !!api()).catch(() => false);
  return loading;
}

/**
 * agy 官方标志 static 态的整段 svg。mono=true → 单色（currentColor）。
 * 每次调用换一个 uid：svg 里的 mask / 渐变按 id 引用，同页多颗时 id 不能撞（折叠的组里那颗 display:none 会让引用失效）。
 */
export function agyLogoSvg(size = 16, { mono = false } = {}) {
  const a = api();
  if (!a) return '';
  try {
    return a.renderSVG('static', 0, { uid: 'agpm' + (++uid), size, palette: mono ? 'currentColor' : 'spectral', glow: '' });
  } catch {
    return '';
  }
}
