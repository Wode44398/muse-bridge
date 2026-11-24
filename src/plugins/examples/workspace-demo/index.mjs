// 工作区插槽示例插件：把一个文件夹标成「Antigravity 与 Claude 共用」，各分页按自己的设计语言画出来。
// 每样能力用一次：ctx.ui.workspaceDecor（全部字段）、workspaceAction（带开关的确认框、撤销、编辑态的次要按钮）、
// refreshDecor、ctx.claude.memoryInfo、给 agy 的提示（turn.cwd）、两个 agent 的 turn.start / turn.end。
// 「在干活」两路来源：真有一轮在这个文件夹里跑；或者演示开关开着时每 20 秒在 Claude / Antigravity / 都不 之间轮换一次。

const AGENTS = ['agy', 'claude'];
const NAMES = { agy: 'Antigravity', claude: 'Claude' };
const sameDir = (a, b) => {
  const na = String(a || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const nb = String(b || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return !!na && (/^[A-Za-z]:/.test(na) ? na.toLowerCase() === nb.toLowerCase() : na === nb);
};
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export function apply(ctx) {
  ctx.onConfig(() => {});   // 设置都在用到时现读
  // 共用的文件夹：[{ path, askFirst, at }]，存在 ctx.store
  const folders = () => ctx.store.get('folders', []);
  const save = (list) => ctx.store.set('folders', list);
  const find = (p) => folders().find((f) => sameDir(f.path, p)) || null;
  if (!ctx.store.get('seeded', false)) {
    const seed = String(ctx.config.seedFolder || '').trim() || ctx.runtime.programRoot || process.cwd();
    save([{ path: seed, askFirst: false, at: Date.now() }]);
    ctx.store.set('seeded', true);
  }

  // 真在跑的轮：会话 id → { agent, cwd, since, text }
  const live = new Map();
  // 最近的会话（给 sessions / peerSessions 用）：会话 id → { agent, cwd, title, at }
  const recent = new Map();
  const onTurn = (live0) => (e) => {
    if (!AGENTS.includes(e.agent) || !e.cwd || !find(e.cwd)) return;
    const key = e.agent + ':' + (e.sessionId || 'new');
    if (live0) live.set(key, { agent: e.agent, cwd: e.cwd, since: e.at, text: String(e.message || '').slice(0, 40) || '在干活' });
    else {
      for (const k of [...live.keys()]) if (k.startsWith(e.agent + ':') && live.get(k).cwd === e.cwd) live.delete(k);
      if (e.sessionId) recent.set(e.sessionId, { agent: e.agent, cwd: e.cwd, title: String(e.result || '').slice(0, 30) || '（没有回复）', at: e.at });
      if (recent.size > 50) recent.delete(recent.keys().next().value);
    }
    ctx.ui.refreshDecor('collab');
  };
  ctx.events.on('turn.start', onTurn(true));
  ctx.events.on('turn.end', onTurn(false));

  // 演示：每 20 秒轮换一次「谁在干活」
  let tick = 0;
  let demoSince = Date.now();
  ctx.setInterval(() => {
    if (!ctx.config.demoBusy) return;
    tick = (tick + 1) % 3;
    demoSince = Date.now();
    ctx.ui.refreshDecor('collab');
  }, 20_000);
  const demoBusy = () => (ctx.config.demoBusy ? [['claude'], ['agy'], []][tick] : []);

  ctx.ui.workspaceDecor({
    id: 'collab',
    agents: ['agy', 'claude'],
    async list(who, { agent }) {
      const other = agent === 'agy' ? 'claude' : 'agy';
      return Promise.all(folders().map(async (f) => {
        const mem = await ctx.claude.memoryInfo(f.path, { who });
        const runs = [...live.values()].filter((r) => sameDir(r.cwd, f.path));
        const busy = [...new Set([...runs.map((r) => r.agent), ...demoBusy()])];
        const run = runs[0] || (busy.length ? { agent: busy[0], since: demoSince, text: busy[0] === 'claude' ? '正在出 apk 验脚注窄屏' : '正在整理共用记忆' } : null);
        const memText = mem?.exists ? `记忆 ${mem.files} 篇` : '还没有记忆';
        const mine = [...recent.entries()].filter(([, s]) => sameDir(s.cwd, f.path));
        return {
          path: f.path,
          panel: true,
          peers: ['agy', 'claude'],
          busy,
          note: `与 ${NAMES[other]} 共用 · ${memText}`,
          ...(run ? { status: { agent: run.agent, text: run.text, since: run.since, open: { action: 'collab-edit' } } } : {}),
          footer: { icon: 'book', text: `共用记忆 ${mem?.files || 0} 篇${f.askFirst ? ' · 往来先问你' : ''}`, ...(mem?.index ? { open: { url: '/' } } : {}) },
          card: {
            title: `与 ${NAMES[other]} 共用`,
            subtitle: f.path,
            sections: [
              {
                label: '共用记忆',
                link: { label: '协作设置', open: { action: 'collab-edit' } },
                rows: [
                  { icon: 'book', agent: 'claude', text: mem?.dir || '（找不到记忆目录）', meta: mem?.index ? 'MEMORY.md' : '', mono: true },
                  { icon: 'clock', agent: busy[0] || '', live: busy.length > 0, text: busy.length ? `${NAMES[busy[0]]} 在干活` : '眼下没人在干活', since: run?.since || 0 },
                ],
              },
              ...(mine.length ? [{ label: '最近的会话', rows: mine.slice(-3).map(([id, s]) => ({ agent: s.agent, text: s.title, meta: new Date(s.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), open: { session: { agent: s.agent, id } } })) }] : []),
            ],
            foot: { text: f.askFirst ? '它们互相发消息前会先问你' : '往来不用你批', link: { label: '协作设置', open: { action: 'collab-edit' } } },
          },
          // 本页会话行首「谁开的」：演示里把对方在这个文件夹开的会话都标出来
          sessions: mine.filter(([, s]) => s.agent === agent).map(([id]) => ({ agent, id, by: other })),
          peerSessions: [{ agent: other, items: mine.filter(([, s]) => s.agent === other).slice(-20).map(([id, s]) => ({ id, title: s.title, meta: '', live: [...live.keys()].includes(other + ':' + id) })) }],
        };
      }));
    },
  });

  const dialogFor = (who, { path }, editing) => {
    const f = find(path);
    return {
      title: editing ? '协作设置' : '和对方共用这个文件夹',
      subtitle: `${baseName(path)} · ${path}`,
      hero: { peers: ['agy', 'claude'] },
      sections: [{
        label: '共用之后',
        items: [
          { icon: 'book', agent: 'claude', title: '开工前先读对方的记忆', desc: '两边都按同一份记忆索引干活', chip: { ok: true, code: 'memory\\MEMORY.md', text: '自动找到' } },
          { icon: 'users', title: '互相能看到对方在这里的会话', desc: '在各自的侧栏里单独列一组' },
        ],
      }],
      fields: [{ id: 'askFirst', type: 'switch', label: '它们互相发消息前先问我', desc: '关着时往来不用你批', value: f ? !!f.askFirst : false }],
      ok: editing ? '保存' : '设为协作空间',
      cancel: '取消',
      ...(editing ? { extra: { label: '取消协作', action: 'collab-off', danger: true } } : {}),
    };
  };

  ctx.ui.workspaceAction({
    id: 'collab-on', label: '设为协作工作空间', icon: 'users', when: 'plain', decor: 'collab',
    dialog: (who, v) => dialogFor(who, v, false),
    handler(who, { path, values }) {
      if (!find(path)) save([...folders(), { path, askFirst: !!values.askFirst, at: Date.now() }]);
      return { toast: `「${baseName(path)}」设为协作工作空间了`, decorChanged: true, undo: { label: '撤销', action: 'collab-off' } };
    },
  });
  ctx.ui.workspaceAction({
    id: 'collab-edit', label: '协作设置', icon: 'settings', when: 'decorated',
    dialog: (who, v) => dialogFor(who, v, true),
    handler(who, { path, values }) {
      save(folders().map((f) => (sameDir(f.path, path) ? { ...f, askFirst: !!values.askFirst } : f)));
      return { toast: '协作设置已保存', decorChanged: true };
    },
  });
  ctx.ui.workspaceAction({
    id: 'collab-off', label: '取消协作', icon: 'users', when: 'decorated', danger: true,
    handler(who, { path }) {
      const had = find(path);
      save(folders().filter((f) => !sameDir(f.path, path)));
      return had
        ? { toast: `「${baseName(path)}」不再共用`, decorChanged: true, undo: { label: '撤销', action: 'collab-on' } }
        : '这个文件夹本来就没共用';
    },
  });

  // 给 agy 的提示：只在共用的文件夹里给（turn.cwd = 要挂载的那个会话的目录）
  ctx.claude.prompt((turn) => {
    const f = turn.cwd ? find(turn.cwd) : null;
    return f ? `这个文件夹（${f.path}）与 Claude 共用：开工前先读 Claude 的记忆索引。` : '';
  }, { agents: ['agy'] });
}
