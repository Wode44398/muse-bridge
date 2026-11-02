// 「改到核心」示例插件（插件接口四期）：每样新能力用一次，写法都在手册 plugins 章「改到核心」。
// 热更新：改设置不重启插件（ctx.onConfig），回调里现读 ctx.config。

const DANGEROUS = [/\brm\s+-[a-z]*r[a-z]*f\b/i, /\bgit\s+push\b.*--force\b/i, /\bformat\s+[a-z]:/i, /\bmkfs\b/i, /Remove-Item\b.*-Recurse\b.*-Force\b/i];
const GIT_READ = /^\s*git\s+(status|diff|log|show)\b[^;&|]*$/;

export function apply(ctx) {
  ctx.onConfig(() => {});   // 设置都在回调里现读，改了不用重启
  const cfg = () => ctx.config;
  const recent = [];        // 最近的对话（主页卡片用）
  let failures = 0;

  // ── 订阅事件 ──
  ctx.events.on('turn.end', (e) => {
    recent.unshift({ at: e.at, ok: e.ok, stopped: !!e.stopped, agent: e.agent, ms: e.durationMs, tools: (e.tools || []).length });
    recent.length = Math.min(recent.length, 20);
    if (!e.ok && !e.stopped) {
      failures += 1;
      if (cfg().notifyFailures) ctx.notify({ title: '对话出错了', body: (e.error || '').slice(0, 120), level: 'warn' });
    }
  });

  // ── 拦截与改写 Claude ──
  ctx.claude.hook('PreToolUse', (input) => {
    if (!cfg().blockDangerous) return;
    const cmd = String(input.tool_input?.command || '');
    if (DANGEROUS.some((re) => re.test(cmd))) return { decision: 'deny', reason: `「${ctx.meta.name}」插件拦下了危险命令：${cmd.slice(0, 80)}` };
  }, { matcher: 'Bash|PowerShell', who: 'all' });

  ctx.claude.permission(({ tool, input }) => {
    if (cfg().autoAllowGitRead && tool === 'Bash' && GIT_READ.test(String(input?.command || ''))) return 'allow';
  });

  ctx.claude.input(({ message }) => {
    if (!cfg().maskPhones) return;
    const masked = message.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '<手机号>');
    return masked === message ? undefined : { message: masked };
  });

  ctx.claude.options(() => (cfg().appendNote.trim() ? { append: cfg().appendNote.trim() } : undefined));

  // ── 两个 agent 都能用的工具，结果画成卡片 ──
  ctx.tools.add({
    name: 'recent_turns',
    description: '看最近几轮对话的结果（成功与否、用了多久、调了几次工具）',
    access: 'read',
    render: 'card',
    params: { limit: { type: 'integer', min: 1, max: 20, default: 5, desc: '看几条' } },
    handler: ({ limit }) => {
      const list = recent.slice(0, limit);
      return {
        card: {
          title: `最近 ${list.length} 轮对话`, subtitle: `出错 ${failures} 次`, tone: failures ? 'warn' : 'ok',
          fields: list.map((r) => ({ label: new Date(r.at).toLocaleTimeString('zh-CN'), value: `${r.agent} · ${r.ok ? '成功' : r.stopped ? '停了' : '出错'} · ${Math.round(r.ms / 1000)} 秒 · ${r.tools} 次工具` })),
        },
      };
    },
  });

  // ── 界面 ──
  ctx.ui.homeCard({
    id: 'turns', title: '最近对话', icon: 'checklist', order: 10,
    data: () => ({
      tone: failures ? 'warn' : 'ok',
      text: recent.length ? `最近 ${recent.length} 轮，出错 ${failures} 次` : '还没有对话',
      items: recent.slice(0, 3).map((r) => ({ label: new Date(r.at).toLocaleTimeString('zh-CN'), value: `${r.agent} · ${r.ok ? '成功' : r.stopped ? '停了' : '出错'}` })),
    }),
  });
  ctx.ui.command({ name: 'review', description: '让 Claude 审一遍当前改动', template: '审一遍工作区里还没提交的改动：先 git diff 看清楚，再按严重程度列出问题。' });
  ctx.ui.command({ name: 'turns', description: '看最近几轮对话', handler: () => ({ toast: recent.length ? `最近 ${recent.length} 轮，出错 ${failures} 次` : '还没有对话' }) });
  ctx.ui.messageAction({ id: 'count', label: '统计字数', roles: ['assistant', 'user'], handler: (who, { text }) => `这条消息 ${[...text].length} 个字` });

  // ── 通知渠道（示例：只记日志；换成飞书 / Telegram 的接口就是真的渠道）──
  ctx.notify.channel({ id: 'log', label: '插件日志', send: ({ title, body, level }) => ctx.log(`[通知渠道] ${level} ${title} ${body}`) });

  ctx.status(() => ({ tone: failures ? 'warn' : 'ok', text: `记下了 ${recent.length} 轮对话，出错 ${failures} 次`, items: [] }));
}
