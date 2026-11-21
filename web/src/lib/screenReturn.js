// 「从哪来回哪去」的一次性返回记录——纯逻辑，接线在 screenReturn.svelte.js。
//
// 平时分页之间是「主页上的入口 ↔ 分页」：系统返回（安卓返回键 / 浏览器后退，lib/nav.js 的 closeTopLayer）= 收回入口回主页。
// 只有插件页面替人跳走的那一下（bridge.nav 去会话 / 别的应用、bridge.composer 交给 Claude，lib/pageNav.js）是「页 → 页」：
// 人没经过主页，按返回却落回主页，刚才那个应用（还保活着、状态都在）就得回主页再点一次才回得去。
// 文件预览（nav.file）是盖在页面上的层，本来就回得去，不用记。
//
// 一条记录只认一次、只认一条路：
//   · 到达之前屏还停在来处 → 留着；arriveMs 内没到（跳转被拒、分页没开放、没登录）→ 作废；
//   · 到了以后又去了别处（Claude 页抽屉里的「主页」、左缘右滑回主页、点了别的分页）→ 作废——再按返回照常回主页；
//   · 返回消费一次就没了；来处已经不可用了（应用被撤 / 分页被关，valid() 为假）→ 不回去，照常处理。
// 不用定时器：到点与否在下一次屏变化 / 返回时按时间戳判，测试好注入时钟。

export const ARRIVE_MS = 4000;

export function createScreenReturn({ now = () => Date.now(), arriveMs = ARRIVE_MS } = {}) {
  let rec = null;   // { from, to, arrived, valid, by }
  return {
    /** 页面要替人从 from 跳到 to 了（跳之前调）。from === to 或缺一个就只清掉旧的。回是否记下了。 */
    set(from, to, { valid = null } = {}) {
      rec = null;
      if (!from || !to || from === to) return false;
      rec = { from, to, arrived: false, valid: typeof valid === 'function' ? valid : null, by: now() + arriveMs };
      return true;
    },
    /** 当前屏变了（接线那头每次 ui.screen 变化都喂进来，含第一次） */
    screen(s) {
      const r = rec;
      if (!r) return;
      if (s === r.to) {
        if (r.arrived || now() <= r.by) r.arrived = true;
        else rec = null;            // 过了期限才到：不是这次跳转带过来的
        return;
      }
      if (!r.arrived && s === r.from) { if (now() > r.by) rec = null; return; }   // 还没走
      rec = null;                   // 去了别处 / 到了以后又离开
    },
    /** 系统返回：回该回去的那一页（消费掉，只认一次）；没有可回的回 null */
    take(current) {
      const r = rec;
      // 还没到（跳转还在路上：等应用清单、转场前）：这次返回不归它管，记录留给到达那一下
      if (!r || !r.arrived) return null;
      rec = null;
      if (current !== r.to) return null;
      try { if (r.valid && !r.valid()) return null; } catch { return null; }
      return r.from;
    },
    clear() { rec = null; },
    /** 测试用：当前记录的快照 */
    peek() { return rec ? { from: rec.from, to: rec.to, arrived: rec.arrived } : null; },
  };
}

// —— 「原生返回」——
// 手机 App 里插件页面是另起的原生 WebView（PluginPageActivity）。它经宿主中转（lib/pluginHostRelay.js）替人
// bridge.nav / bridge.composer 时，主界面被切到前台落地，插件页面压在后面还活着（新版 apk 不再关它）。
// 这时在落地那一页按返回该回插件页面，而不是收回入口回主页 / 退后台——人是从插件页面过来的。
// 规则与上面同一套（期限内到达才算、到了以后去了别处即作废、只认一次），只是来处不是一屏而是「原生插件页」：
//   · 目标是屏（会话 → Claude 页、应用、主页）：屏变到那儿才算到；
//   · 目标是层（nav.file 的文件预览、nav.settings 的插件详情）：屏不变，记的时候当场算到，同时记下那一层——
//     返回时那一层还开着就连层一起收掉切回插件页；人已经自己关了那一层 = 去了别处，作废；
//   · 主界面整个切到后台（回了插件页 / 回桌面）= 回了来处，作废；
//   · 落地以后人又在上面开了别的层（抽屉、设置、预览……）：这次返回先照常关那一层，记录留着。
export const NATIVE_PAGE = 'native:plugin-page';
// nav.js closeTopLayer 里这几层的先后（从上到下）：目标层之上的开着 = 人后来另开的
export const NATIVE_LAYERS = ['preview', 'settings', 'login', 'routines', 'drawer'];

export function createNativeReturn(opts) {
  const core = createScreenReturn(opts);
  let layer = null;
  const clear = () => { core.clear(); layer = null; };
  return {
    /** 落地后记（current：此刻的屏，已经在目标上就当场算到）。layer：目标是层时那一层的名字。回是否记下了。 */
    set(to, { layer: l = null, valid = null, current = null } = {}) {
      layer = null;
      const ok = core.set(NATIVE_PAGE, to, { valid });
      if (!ok) return false;
      layer = l && NATIVE_LAYERS.includes(l) ? l : null;
      if (current) this.screen(current);
      return true;
    },
    /** 当前屏变了 */
    screen(s) {
      const p = core.peek();
      if (!p) return;
      // 还没到时主界面停在哪一屏都不是「来处」（来处是原生插件页）：只按期限判，喂来处给它（过了期限就作废）
      core.screen(p.arrived || s === p.to ? s : NATIVE_PAGE);
      if (!core.peek()) layer = null;
    },
    /** 主界面切到后台：到了以后才算「回了来处」（还没到时是原生切前台的过程，不作数） */
    hidden() {
      if (core.peek()?.arrived) clear();
    },
    /**
     * 系统返回：该切回插件页就回 { layer }（layer = 要连带收掉的那一层，没有为 null），只认一次；否则 null。
     * isOpen(name)：那一层此刻开着没（NATIVE_LAYERS 里的名字）。
     */
    take(current, isOpen) {
      const p = core.peek();
      if (!p || !p.arrived) return null;
      const open = (n) => { try { return !!isOpen?.(n); } catch { return false; } };
      const above = layer ? NATIVE_LAYERS.slice(0, NATIVE_LAYERS.indexOf(layer)) : NATIVE_LAYERS;
      if (above.some(open)) return null;               // 人后来另开的层：先照常关它，记录留着
      if (layer && !open(layer)) { clear(); return null; }   // 目标层已经被人关掉了：作废
      const lay = layer;
      layer = null;
      return core.take(current) ? { layer: lay } : null;
    },
    clear,
    /** 测试用 */
    peek() { const p = core.peek(); return p ? { ...p, layer } : null; },
  };
}
