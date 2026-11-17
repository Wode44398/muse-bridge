// 特征测试（插件系统启动的形态）的布置：起插件内核，登记几个「内置功能」的替身和一个什么都贡献一点的探针插件。
//
// pluginOn(id) 在内核启动后看的是「这个插件在不在、启没启用」——登记了替身的功能算开着，没登记的算关着，
// 这样内置工具「按插件开关给不给」的两条路都走得到。

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { kernel } from '../../plugins/state.mjs';
import { installMixins } from '../../plugins/host.mjs';

/** 探针插件订阅到的 bridge 事件（turn.start / turn.end / tool.end）。事件是下一个事件循环才送到的，场景收尾时再取。 */
export const pluginEvents = [];

// 算开着的内置功能；其余（浏览器、终端、工作区协同、拉取请求、手机文件 / 操控……）算关着
const BUILTIN_ON = ['session-tools', 'agent-api', 'visualize'];

export async function setup({ dirs }) {
  const extraDir = path.join(dirs.tmp, 'plugin-extra-dir');
  mkdirSync(extraDir, { recursive: true });
  installMixins();
  await kernel.start();
  const add = (id, apply) => kernel.register({ id, name: id, source: 'local', dir: dirs.tmp, pluginApi: 3, load: async () => ({ apply }) });
  for (const id of BUILTIN_ON) await add(id, () => {});
  await add('char-probe', (ctx) => {
    ctx.claude.tool({ name: 'echo', description: '回显', params: { text: { type: 'string', required: true } }, access: 'read', handler: ({ text }) => text });
    ctx.claude.tool({ name: 'write_note', description: '记一条', params: {}, handler: () => 'ok' });
    ctx.claude.tool({ name: 'for_members', description: '成员也给', params: {}, who: 'members', handler: () => 'ok' });
    ctx.claude.prompt('【探针】这段提示来自插件。');
    ctx.claude.prompt((turn) => (turn.ctx.kind === 'user' ? '【探针】成员也看得到的提示。' : ''), { who: 'members' });
    ctx.claude.mcp('probe-stdio', () => ({ type: 'stdio', command: 'node', args: ['-e', '0'] }));
    ctx.claude.hook('PreToolUse', (input) => (/danger/.test(String(input.tool_input?.command || '')) ? { decision: 'deny', reason: '插件不许跑这个' } : undefined), { matcher: 'Bash' });
    // 交给插件的这一轮带着 getGen（启动方案里就给出去、真调用时才取）：把取到的会话写进回话，取不到这条回话就没了
    ctx.claude.hook('Stop', (input, turn) => ({ context: '插件：收尾前再想想（这一轮的会话 ' + String(turn.getGen().sessionId) + '）' }));
    ctx.claude.permission(({ tool, input }) => {
      if (tool !== 'Bash') return undefined;
      if (input.command === 'ls') return 'allow';
      if (input.command === 'rm -rf /') return { deny: true, message: '插件的审批策略不许删根目录' };
      return undefined;
    });
    ctx.claude.input(({ message }) => (message.startsWith('/probe') ? { append: '（插件补的一句）' } : undefined));
    ctx.claude.options((turn) => ({
      env: { PROBE_FLAG: '1', PROBE_API_KEY: '不许插件改的' },
      settings: { probeSetting: true },
      agents: { 'probe-agent': { description: '探针子 agent', prompt: '你是探针。', tools: ['Read'] }, 'Bad Name': { description: 'x', prompt: 'y' } },
      additionalDirectories: [extraDir],
      append: '【探针】每轮参数追加的提示。',
      ...(/换模型/.test(turn.message || '') ? { model: 'claude-sonnet-4-6', effort: 'low' } : {}),
      ...(/坏模型/.test(turn.message || '') ? { model: 'not-a-model', effort: 'ultra-max' } : {}),
    }));
    ctx.events.on('*', (payload, name) => { pluginEvents.push([name, payload]); });
  });
  return async () => { await kernel.stop(); };
}
