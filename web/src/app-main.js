// 完整 app 的挂载（由 main.js 在界面语言与字典就绪后动态加载，见 lib/i18n.js）。
import { mount } from 'svelte';
import { IS_SHARE } from './lib/share.js';
import { IS_CSNAP } from './lib/csnap.js';
import App from './App.svelte';
import SharePage from './components/SharePage.svelte';
import SnapPage from './components/SnapPage.svelte';

// /w/<token> = 公开只读分享工作空间，挂轻量 SharePage（复用 FilesPanel + 预览查看器）；
// /c/<token> = 公开聊天快照，挂 SnapPage（阉割版 Claude 分页：只有对话，复用 Thread/Composer）；
// 其余照常挂完整 App。两种公开模式都不跑 App 的登录/恢复 boot。
const Root = IS_SHARE ? SharePage : (IS_CSNAP ? SnapPage : App);

export default mount(Root, { target: document.getElementById('app') });
