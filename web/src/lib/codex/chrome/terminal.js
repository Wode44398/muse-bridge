// 线程菜单「在终端里接着跑」：打开工作区的终端卡，把 `codex resume <id>` 敲进去（不替你按回车）。
// 终端卡第一次打开时 PTY 还没起来（面板连上 SSE 才开壳），所以输入要等一会儿、重试到写进去为止。
// 终端被切到「我的电脑」（设备 PTY）时不敲：线程在服务器上，那台电脑上的 codex 找不到它——退回复制命令。

import { api } from '../../api.js';
import { codexDock, openCodexDock } from '../../dock.svelte.js';

const TARGET_KEY = 'bridge.termTarget';   // 与 components/dock/TermPanel.svelte 同一个键
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const resumeCommand = (id) => `codex resume ${id}`;

/** 把命令敲进 Codex 工作区的终端。写进去了回 true；写不进去（没有项目目录、终端在别的电脑上、壳没起来）回 false。 */
export async function typeIntoCodexTerminal(cmd) {
  openCodexDock('term');
  let target = '';
  try { target = localStorage.getItem(TARGET_KEY) || ''; } catch {}
  if (target) return false;
  for (let i = 0; i < 14; i++) {
    await sleep(i ? 300 : 160);
    const ws = codexDock.ws;
    if (!ws) continue;
    try {
      const r = await api.post('/api/claude/term/input', { ws, d: cmd });
      if (r?.ok) return true;
    } catch { return false; }
  }
  return false;
}

/** 复制到剪贴板；不支持时退回隐藏文本框 + execCommand。 */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
