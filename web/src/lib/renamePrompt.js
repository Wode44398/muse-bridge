// 应用级改名框：askRename(旧名, { title, hint, touch, dark, isDir }) → Promise<新名 | null>（取消或没改 = null）。
// 组件按需动态加载、mount 到 document.body，结算后立刻卸载（退场动画在组件里播完才结算）。
// 用在全屏查看器之上（查看器里的「重命名」）：工作空间页面自己的弹层在 .ws-root / .fd-root 的层叠上下文里，
// 压不过 z-index 300 的查看器。
import { mount, unmount } from 'svelte';
import { pointer } from './layout.svelte.js';

const themeDark = () => typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light';

export async function askRename(name, { title = '', hint = '', touch, dark, isDir = false } = {}) {
  if (typeof document === 'undefined') return null;
  let Comp;
  try { Comp = (await import('../components/RenamePrompt.svelte')).default; } catch { return null; }
  return new Promise((resolve) => {
    let inst = null;
    const onDone = (value) => {
      resolve(value ?? null);
      const cur = inst;
      inst = null;
      if (cur) queueMicrotask(() => { try { unmount(cur); } catch {} });
    };
    inst = mount(Comp, {
      target: document.body,
      props: { name: String(name || ''), title, hint, touch: touch ?? !pointer.fine, dark: dark ?? themeDark(), isDir, onDone },
    });
  });
}
