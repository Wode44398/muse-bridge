// 「这个对话连着哪台电脑」的显示口径：宽屏输入框底栏的电脑芯片、手机档仪表菜单里的「运行环境」行共用。
// 纯函数：设备列表、当前选择（设备 id / 'none' / ''=自动）、本机设备 id 进，{ kind, name, tone } 出。
//   kind：unset 还没法定（自动、但在线的不止一台或一台都没有）| none 不连 | missing 选的那台已不在
//         | mine 这台电脑 | named 别的某台
//   tone：on 在线 | off 离线 | idle 没有具体哪一台

export function agyDeviceView(list, pick, mine) {
  const all = Array.isArray(list) ? list : [];
  let cur = null;
  if (pick === 'none') return { kind: 'none', name: '', tone: 'idle' };
  if (pick) {
    cur = all.find((d) => d.id === pick) || null;
    if (!cur) return { kind: 'missing', name: '', tone: 'idle' };
  } else {
    // 自动：先认发起端这台，再认唯一在线的那台
    if (mine) cur = all.find((d) => d.id === mine) || null;
    if (!cur) {
      const online = all.filter((d) => d.online);
      cur = online.length === 1 ? online[0] : null;
    }
  }
  if (!cur) return { kind: 'unset', name: '', tone: 'idle' };
  return {
    kind: cur.id && cur.id === mine ? 'mine' : 'named',
    name: cur.name || '',
    tone: cur.id ? (cur.online ? 'on' : 'off') : 'idle',
  };
}

// t 由调用方传入（组件里的 t 是响应式的；这里写字面量，文案扫描照样认得到）
export function agyDeviceText(view, t) {
  switch (view?.kind) {
    case 'none': return t('不连电脑');
    case 'missing': return t('设备已不在');
    case 'mine': return t('这台电脑');
    case 'named': return view.name || t('电脑');
    default: return t('选电脑');
  }
}
