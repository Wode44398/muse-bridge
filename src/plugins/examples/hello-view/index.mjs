// hello-view：声明式应用示例。
//
// 不写页面：view 回一组积木（Block[]），bridge 自己画——网页、桌面、手机 App 一个样，手机 App 也不用跑插件的代码。
// 积木上的按钮 / 开关 / 表单 / 标签页按下去，bridge 调 actions 里的同名函数，再用新 state 调一次 view 重画。
//
// 数据放哪（重要）：
//   ctx.store —— 存在服务器上（插件数据目录的 store.json）。这里的账目按使用者分开存：键里带 who.user。
//   state     —— 只是界面状态（当前标签页），由前端按应用保管、每次随请求带上来。它是前端给的，
//                别拿它判断权限、别放大数据（上限 256 KB）；要长期保存的东西一律存 ctx.store。
//
// 动作的 args：积木里写的 args 之外，bridge 自动并入——标签页 { tab }、列表行 { id }、表单 { values }、开关 { value }。

const CATS = ['餐饮', '交通', '购物', '其它'];
const DAY = 24 * 3600 * 1000;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

export function apply(ctx) {
  // 每个使用者一份：主机的身份上下文没有 user，记作 host
  const keyOf = (who) => 'entries:' + (who.user || 'host');
  const load = (who) => ctx.store.get(keyOf(who), []);
  const save = (who, list) => { ctx.store.set(keyOf(who), list.slice(-500)); };

  ctx.ui.app({
    id: 'ledger',
    title: '记一笔',
    titleEn: 'Ledger',
    icon: { light: 'web/icon-light.svg', dark: 'web/icon-dark.svg' },
    who: 'members',               // 成员也能用（各记各的）
    state: { tab: 'overview' },   // 初始界面状态：新打开的应用从这里开始
    // 角标：今天记了几笔（0 不显示）
    badge: (who) => load(who).filter((e) => dayKey(e.t) === dayKey(Date.now())).length,

    view: (who, { state }) => {
      const list = load(who);
      const tabs = {
        type: 'tabs', value: state.tab, action: 'tab',
        items: [{ id: 'overview', label: '概览' }, { id: 'list', label: '明细' }, { id: 'add', label: '记一笔' }],
      };
      if (state.tab === 'add') return [tabs, addForm()];
      if (state.tab === 'list') return [tabs, entryList(list)];
      return [tabs, ...overview(list)];
    },

    actions: {
      tab: (who, { args, state }) => ({ state: { ...state, tab: String(args.tab || 'overview') } }),
      add: (who, { args, state }) => {
        const v = args.values || {};
        const amount = Number(v.amount);
        if (!Number.isFinite(amount) || amount <= 0) return '金额要是正数';
        const cat = CATS.includes(v.cat) ? v.cat : '其它';
        const note = String(v.note || '').trim().slice(0, 60);
        save(who, [...load(who), { id: Date.now().toString(36), t: Date.now(), amount, cat, note }]);
        // 记完跳回概览：回新 state 就行
        return { state: { ...state, tab: 'overview' }, toast: '记上了：' + cat + ' ' + money(amount) };
      },
      remove: (who, { args }) => {
        save(who, load(who).filter((e) => e.id !== args.id));
        return '删掉了';
      },
      clear: (who, { state }) => {
        save(who, []);
        return { state: { ...state, tab: 'overview' }, toast: '已清空' };
      },
    },
  });

  function overview(list) {
    const now = Date.now();
    const month = dayKey(now).slice(0, 7);
    const mine = list.filter((e) => dayKey(e.t).slice(0, 7) === month);
    const total = mine.reduce((s, e) => s + e.amount, 0);
    const today = list.filter((e) => dayKey(e.t) === dayKey(now)).reduce((s, e) => s + e.amount, 0);
    // 最近 7 天每天合计：柱状图，x 轴是类目（月-日）
    const days = Array.from({ length: 7 }, (_, i) => dayKey(now - (6 - i) * DAY));
    const points = days.map((d) => [d.slice(5), Math.round(list.filter((e) => dayKey(e.t) === d).reduce((s, e) => s + e.amount, 0) * 100) / 100]);
    if (!list.length) {
      return [{ type: 'empty', title: '还没记过账', desc: '切到「记一笔」写下第一笔', icon: 'plus' }];
    }
    return [
      { type: 'stat', items: [
        { label: '本月合计', value: money(total) },
        { label: '本月笔数', value: String(mine.length) },
        { label: '今天', value: money(today), tone: today > 200 ? 'warn' : undefined, hint: '今天超过 200 标黄' },
      ] },
      { type: 'chart', kind: 'bar', height: 200, x: { type: 'category' }, y: { unit: '元' }, series: [{ name: '每天合计', points }] },
      { type: 'section', title: '按类别（本月）', children: [
        { type: 'list', items: CATS.map((c) => ({ title: c, badge: money(mine.filter((e) => e.cat === c).reduce((s, e) => s + e.amount, 0)) })) },
      ] },
    ];
  }

  function entryList(list) {
    return {
      type: 'list', empty: '还没有记录',
      items: list.slice().reverse().slice(0, 100).map((e) => ({
        id: e.id,
        title: e.cat + '  ' + money(e.amount),
        desc: dayKey(e.t) + (e.note ? ' · ' + e.note : ''),
        trailing: { type: 'button', label: '删除', style: 'danger', action: { name: 'remove', confirm: '删掉这一笔？' } },
      })),
    };
  }

  function addForm() {
    return {
      type: 'section', title: '记一笔', desc: '金额必填，类别和备注随意',
      children: [
        { type: 'form', id: 'add',
          fields: {
            amount: { type: 'number', label: '金额', min: 0, placeholder: '0.00', required: true },
            cat: { type: 'string', label: '类别', enum: CATS, widget: 'segmented' },
            note: { type: 'string', label: '备注', placeholder: '可不填' },
          },
          value: { cat: '餐饮' },
          submit: { label: '记上', action: 'add' },
          cancel: '清空',
        },
        { type: 'divider' },
        { type: 'button', label: '清空全部记录', style: 'danger', action: 'clear', confirm: '所有记录都删掉？删了找不回来。' },
      ],
    };
  }
}
