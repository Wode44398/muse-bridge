// 工作区浏览器按会话各开一份（服务端能力位 browser-session，见 server/cdp.ts 的「浏览器池」）——前端这一半：
//   · browserScope()：面板 / 胶囊此刻对着哪个会话的浏览器 = 前台会话的 id（还没有 id 的新对话 = ""，用默认那份）。
//   · app.browser / app.browserTabs 只代表【前台会话】的浏览器：切会话先清掉上一个会话的，再问一次服务端。挂载状态灯
//     （工作区「浏览器」标签上的小点、输入框上方的「Agent 浏览器」胶囊）因此只在本会话有标签时亮；之后靠全局事件
//     browser_mount 与面板直播流的 tabs 事件跟着变。全局通道重连（snapshot）时再问一次：断开期间的事件都错过了。
//   · browserMount.isolated：前台会话开没开隔离存储（面板空态里的开关、地址栏的「隔离」标记）。
// 旧后端（没有这个能力位）全进程只有一个浏览器：什么都不改，照旧。
import { untrack } from "svelte";
import * as api from "./api.ts";
import { app, sessHooks } from "./state.svelte.ts";

export const browserSessionSupported = (): boolean => Boolean(app.compat?.caps?.includes("browser-session"));
export const browserScope = (): string => app.chat.id ?? "";

export const browserMount = $state({ sid: "", isolated: false });

let asked = 0;
export async function refreshBrowserMount(sid = browserScope()): Promise<void> {
  if (!browserSessionSupported()) return;
  const mine = ++asked;
  try {
    const s = await api.browserState(sid);
    if (mine !== asked || sid !== browserScope()) return; // 问的期间又切了会话 / 又问了一次
    browserMount.sid = sid;
    browserMount.isolated = s.isolated === true;
    const tabs = s.alive ? (s.tabs ?? []) : [];
    app.browserTabs = tabs;
    const url = tabs.find((x) => x.active)?.url ?? s.url ?? "";
    if (!tabs.length) app.browser = null;
    else if (app.browser?.url !== url) app.browser = { url };
  } catch {
    /* 连不上：保持现状，下次切会话 / 重连再问 */
  }
}

function onGlobal(ev: any): boolean {
  if (ev?.e === "browser_mount") {
    if (browserSessionSupported() && ev.sessionId === browserScope()) {
      browserMount.isolated = ev.isolated === true;
      if (!ev.mounted) {
        app.browser = null;
        app.browserTabs = [];
      } else if (!app.browser) {
        void refreshBrowserMount(); // 亮灯之外还要地址与标签
      }
    }
    return true;
  }
  if (ev?.e === "snapshot") void refreshBrowserMount();
  return false; // snapshot 还要交给原来的处理
}
sessHooks.global.push(onGlobal);

// App 挂载时开：前台会话换了就重新对一次（上一个会话的标签 / 地址别冒充这个会话的）
export function startBrowserMount(): () => void {
  return $effect.root(() => {
    $effect(() => {
      const sid = browserScope();
      if (!browserSessionSupported()) return;
      untrack(() => {
        if (browserMount.sid !== sid) {
          browserMount.sid = sid;
          browserMount.isolated = false;
          app.browser = null;
          app.browserTabs = [];
        }
        void refreshBrowserMount(sid);
      });
    });
  });
}
