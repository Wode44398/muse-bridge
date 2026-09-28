// 输入栏「/」命令菜单的数据层：命令表来自后端 /api/commands（本账号最近一轮 init 时经
// SDK supportedCommands() 取的全表 + terminal_slash_commands 段），5 分钟缓存在 status.commands。
// terminal 段（doctor / color 这类绑定本地终端 UX 的命令）一律不列——bridge 的每一端
// 都是远程/手机 UI，SDK 明说该藏；内部命令（__ 开头）同样不列。
import { api } from './api.js';
import { status } from './state.svelte.js';

let loading = null;
export async function loadCommands(force = false) {
  const c = status.commands;
  if (!force && c && Date.now() - (c.fetchedAt || 0) < 300_000) return c;
  if (loading) return loading;
  loading = api.commands()
    .then((d) => {
      status.commands = { list: Array.isArray(d?.commands) ? d.commands : [], terminal: Array.isArray(d?.terminal) ? d.terminal : [], at: d?.at || 0, fetchedAt: Date.now() };
      return status.commands;
    })
    .catch(() => status.commands || null)
    .finally(() => { loading = null; });
  return loading;
}

export function filterCommands(cmds, q) {
  if (!cmds || !Array.isArray(cmds.list)) return [];
  const term = new Set(cmds.terminal || []);
  const list = cmds.list.filter((c) => c && c.name && !term.has(c.name) && !c.name.startsWith('__'));
  const s = String(q || '').toLowerCase();
  // 空查询：内置命令（compact/context/cost/clear…，名字不带冒号）排前，插件技能（xxx:yyy）跟后——
  // 只截前 40 行，不然一百多个技能把内置命令全挤出视野。
  if (!s) return list.slice().sort((a, b) => (a.name.includes(':') ? 1 : 0) - (b.name.includes(':') ? 1 : 0)).slice(0, 40);
  const starts = [], incl = [];
  for (const c of list) {
    const n = c.name.toLowerCase();
    if (n.startsWith(s)) starts.push(c);
    else if (n.includes(s) || String(c.description || '').toLowerCase().includes(s)) incl.push(c);
  }
  return [...starts, ...incl].slice(0, 40);
}
