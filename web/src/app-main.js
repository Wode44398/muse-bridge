// 完整 app 的挂载（由 main.js 在界面语言与字典就绪后动态加载，见 lib/i18n.js）。
import { mount } from 'svelte';
import { IS_SHARE } from './lib/share.js';
import { IS_CSNAP } from './lib/csnap.js';
import App from './App.svelte';
import SharePage from './components/SharePage.svelte';
import SnapPage from './components/SnapPage.svelte';

// 桌面壳只靠 feature detect 激活；同一份 bundle 在网页与 Android 中不加任何类。
if (window.BridgeDesktop) document.documentElement.dataset.desktop = '1';
import './lib/nativeMenu.js';   // 桌面壳原生右键菜单（无桥=空操作）
import './lib/scrollbars.js';   // Edge 同款滚动条：滚动或鼠标移到滚条上才显形，停下隐身

// /w/<token> = 公开只读分享工作空间，挂轻量 SharePage（复用 FilesPanel + 预览查看器）；
// /c/<token> = 公开聊天快照，挂 SnapPage（阉割版 Claude 分页：只有对话，复用 Thread/Composer）；
// 其余照常挂完整 App。两种公开模式都不跑 App 的登录/LAN/恢复 boot。
const Root = IS_SHARE ? SharePage : (IS_CSNAP ? SnapPage : App);

// dev-only：?dkit 挂桌面基件画廊、?dglass 挂玻璃双引擎画廊（都不跑 App）。
// DEV 守卫下 prod 构建整段死代码消除。
let app;
const devQ = import.meta.env.DEV ? new URLSearchParams(location.search) : null;
if (devQ?.has('dkit')) {
  app = import('./desktop/kit/KitGallery.svelte').then(({ default: KitGallery }) =>
    mount(KitGallery, { target: document.getElementById('app') }));
} else if (devQ?.has('dglass')) {
  app = import('./desktop/glass/GlassGallery.svelte').then(({ default: GlassGallery }) =>
    mount(GlassGallery, { target: document.getElementById('app') }));
} else if (devQ?.has('dvs')) {
  // 原版 liquid-glass vs bridge GL 最终版——可拖对比页
  document.documentElement.dataset.desktop = '1';
  app = import('./desktop/glass/GlassCompare.svelte').then(({ default: GlassCompare }) =>
    mount(GlassCompare, { target: document.getElementById('app') }));
} else if (devQ?.has('dhome')) {
  // 桌面主页单页验收（壁纸+Dock+Ctrl+K；无需登录/后端）
  document.documentElement.dataset.desktop = '1';
  app = Promise.all([import('./desktop/home/DesktopHome.svelte'), import('./lib/state.svelte.js')])
    .then(([{ default: DesktopHome }, { ui }]) => {
      ui.booted = true;
      return mount(DesktopHome, { target: document.getElementById('app') });
    });
} else if (devQ?.has('dsettings')) {
  // 桌面设置逻辑板单页验收（=light 预置亮色）
  document.documentElement.dataset.desktop = '1';
  if (devQ.get('dsettings') === 'light') document.documentElement.dataset.theme = 'light';
  // &dmock：装一只只读假壳（快捷键 / 本机 Agent / 远程控制 / 服务进程 / 开机自启），让这些只在
  // Electron 里出现的分区也能在浏览器里验。设置页在组件初始化时取 window.BridgeDesktop，挂载前装好即可。
  if (devQ.has('dmock') && !window.BridgeDesktop) {
    const ok = (v) => Promise.resolve(v);
    const lp = { mode: 'observe', active: false, shortcut: 'Ctrl+Alt+Shift+F11' };
    const rc = { allowRemote: true, allowDesktop: false, active: false, connected: true, role: 'client', shortcut: 'Ctrl+Alt+Shift+F12' };
    const sc = {
      groups: [{ id: 'ask', label: '呼出' }, { id: 'safety', label: '安全' }],
      items: [
        { id: 'quick-ask', group: 'ask', label: '快速提问', hint: '在任何地方呼出提问框', accelerator: 'Alt+Space', enabled: true },
        { id: 'focus-pending', group: 'ask', label: '跳到在等你回答的那一轮', hint: '', accelerator: 'Ctrl+Alt+J', enabled: true },
        { id: 'stop-local-pc', group: 'safety', label: '本机 Agent 急停', hint: '', accelerator: 'Ctrl+Alt+Shift+F11', enabled: true },
      ],
      duplicates: [],
    };
    window.BridgeDesktop = {
      localPc: { state: () => ok(lp), setMode: (m) => ok(Object.assign(lp, { mode: m })), stop: () => ok(lp) },
      control: { state: () => ok(rc), setAllow: (v) => ok(Object.assign(rc, { allowRemote: v })), setDesktop: (v) => ok(Object.assign(rc, { allowDesktop: v })), stop() {} },
      shortcuts: { state: () => ok(sc), set: () => ok({ ok: true, state: sc }), reset: () => ok(sc) },
      autostart: { state: () => ok({ supported: true, enabled: true }), set: (v) => ok({ supported: true, enabled: v }) },
      serverProcess: { status: () => ok({ health: 'up', server: { pid: 4242 } }), open() {} },
      agent: { setNotify() {} },
    };
  }
  app = Promise.all([import('./desktop/settings/SettingsDesktop.svelte'), import('./lib/state.svelte.js')])
    .then(([{ default: SettingsDesktop }, { setTheme }]) => {
      setTheme(devQ.get('dsettings') === 'light' ? 'light' : 'dark');   // 设置页明暗读 ui.theme
      return mount(SettingsDesktop, { target: document.getElementById('app') });
    });
} else {
  app = mount(Root, { target: document.getElementById('app') });
}

export default app;
