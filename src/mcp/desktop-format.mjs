// 桌面控制工具（本机 localPc、远程 remotePc；dimensio 的 LocalPC 用同一套措辞）的结果排版与坐标规则。
// 执行层在 runtime/remote-control-desktop.mjs，这里只负责把结果变成给模型看的文字 + 图片。

export const COORD_RULES =
  '坐标规则：x,y 一律是【最近一次 screenshot 那张图里读到的像素】（图左上角为 0,0），缩放与屏幕位置由工具换算，' +
  '不用自己乘倍数；超出那张图的范围会直接报错。窗口截图（window=hwnd）之后窗口被挪动也照样点得准。' +
  'zoom 只是把一块区域放大看清，坐标仍按 screenshot 那张图。能用 uia_tree 的 ref 就别用坐标：click 传 ref 会点那个控件的中心。';

const POINTER_LABEL = { move: '移到', click: '点击', double_click: '双击', triple_click: '三击', right_click: '右键', scroll: '滚动' };

export const VERIFY_RULES =
  '每次点击/滚动/输入/按键/uia_action 后，工具会等界面稳定并附上「结果」：开关了哪些窗口、前台和焦点换到哪、被点控件的状态变化、打字后的回读；' +
  '什么都没变会明确提示。想让工具替你核对，就加 expect（window 出现某窗口 / gone 某窗口消失 / focus 焦点控件 / value 焦点框内容含 / text 前台窗口里出现某文字 / changed 有无变化），' +
  '它会一直等到满足或超时（expect_timeout_ms，默认 3 秒），不符合就报错；batch 里任一步不符合就停。只求快可传 verify:false 跳过确认。';

const STATE_NAME = { toggle: '勾选', expand: '展开', selected: '选中', enabled: '可用', value: '值', name: '名称' };
const STATE_VALUE = { On: '是', Off: '否', Indeterminate: '半选', Expanded: '展开', Collapsed: '收起', PartiallyExpanded: '部分展开', LeafNode: '无子项', true: '是', false: '否' };
const NO_CHANGE = {
  pointer: '画面、窗口、焦点和被点控件的状态都没有变化——可能没点中，或这个控件本来就不改画面；要等慢慢出现的结果（迟到的弹窗）用 expect 或 wait_for_window',
  scroll: '滚动后画面没有变化——可能已经到头，或这里不能滚动',
  type: '输入后画面、焦点都没有变化——字可能没进任何输入框',
  key: '按键后画面、窗口和焦点都没有变化（复制这类快捷键本来就不改画面，可忽略）',
  uia_action: '执行后画面、窗口和控件状态都没有变化',
};
const EXPECT_LABEL = { window: '有窗口含', gone: '窗口消失', focus: '焦点控件含', value: '焦点框内容含', text: '前台窗口里出现', changed: '画面/窗口' };

const elLabel = (e) => (e ? `${e.type || '控件'}${e.name ? `「${e.name}」` : e.automationId ? `(${e.automationId})` : ''}` : '控件');
const stateVal = (v) => (v == null || v === '' ? '空' : STATE_VALUE[String(v)] ?? `「${v}」`);

function expectLine(c) {
  const want = c.key === 'changed' ? (c.want ? '有变化' : '没有变化') : `「${c.want}」`;
  let got = '';
  if (!c.ok) {
    if (c.key === 'value' && c.unreadable) got = '（读不到焦点控件的内容）';
    else if (c.key === 'gone' && c.got) got = `（还在：「${c.got}」）`;
    else if (c.key === 'changed') got = c.got ? '（实际有变化）' : '（实际没有变化）';
    else if (c.got) got = `（实际：「${c.got}」）`;
  }
  return `${EXPECT_LABEL[c.key] || c.key}${want}——${c.ok ? '符合' : '不符合' + got}`;
}

// 结果确认 → 一段文字（没有 verify 字段＝老客户端或 verify:false，返回空串）
export function verifyText(v, action) {
  if (!v) return '';
  const kind = POINTER_LABEL[action] && action !== 'scroll' ? 'pointer' : action;
  const parts = [];
  for (const w of v.opened || []) parts.push(`打开了窗口「${w.title}」${w.process ? `(${w.process})` : ''}`);
  for (const t of v.closed || []) parts.push(`关掉了窗口「${t}」`);
  if (v.foreground) parts.push(`前台换成「${v.foreground.title || v.foreground.process}」`);
  if (v.focus) parts.push(`焦点移到 ${elLabel(v.focus)}`);
  if (v.control?.gone) parts.push(`${elLabel(v.control)}不见了`);
  for (const c of v.control?.changes || []) parts.push(`${elLabel(v.control)}的${STATE_NAME[c.key] || c.key}：${stateVal(c.from)} → ${stateVal(c.to)}`);
  let s = v.changed
    ? `结果：${parts.join('；') || '画面有变化'}${v.stable ? `（${v.settledMs}ms 后界面稳定）` : ''}`
    : `注意：${NO_CHANGE[kind] || NO_CHANGE.pointer}（观察了 ${v.settledMs}ms）`;
  if (!v.stable) s += `；界面一直在变（动画/视频/加载中？），已等 ${v.settledMs}ms，结果可能还没出来`;
  const rb = v.readback;
  if (rb) {
    if (rb.password) s += '\n回读：密码框，不读内容';
    else if (rb.ok === true) s += `\n回读：输入框里有刚输入的内容（现在是「${rb.value}」）`;
    else if (rb.ok === false) s += `\n回读：焦点控件里没有刚输入的文字（现在是「${rb.value ?? ''}」）——字可能打到了别处${rb.enter ? '，或回车已经把内容提交/清空了' : ''}`;
    else s += '\n回读：读不到焦点控件的内容（网页、自绘控件常见），需要的话截图确认';
  }
  if (v.expect) s += `\n预期${v.expect.ok ? '全部符合' : '不符合'}：${v.expect.checks.map(expectLine).join('；')}`;
  return s;
}
// 预期不符时整个工具结果标成出错，模型不会当成功接着往下做
export const verifyFailed = (r) => Boolean(r?.verify?.expect && r.verify.expect.ok === false);

export function formatWindows(items) {
  if (!items?.length) return '没有发现可见顶层窗口。';
  return items.map((w, i) =>
    `${i + 1}. [hwnd ${w.hwnd}] ${w.title || '(无标题)'} — ${w.process || 'unknown'} pid=${w.pid}` +
    `  rect=(${w.x},${w.y}) ${w.w}×${w.h}${w.className ? `  class=${w.className}` : ''}`,
  ).join('\n');
}

export function formatUia(result) {
  const lines = (result.nodes || []).map((n) => {
    const indent = '  '.repeat(Math.min(12, Number(n.level) || 0));
    const bits = [
      `[ref${n.ref}]`, n.controlType || 'Control', n.name ? `"${n.name}"` : '',
      n.automationId ? `id=${n.automationId}` : '',
      n.w || n.h ? `${n.w}×${n.h}` : '',
      n.enabled === false ? 'disabled' : '', n.offscreen ? 'offscreen' : '',
    ].filter(Boolean);
    return indent + bits.join(' ');
  });
  const head = result.window
    ? `窗口：[hwnd ${result.window.hwnd}] ${result.window.title || '(无标题)'} — ${result.window.process || 'unknown'}`
    : '窗口：未知';
  return `${head}\nUI Automation 元素（ref 只对最近一次 uia_tree 有效；要点某个元素就 click 传 ref，或 uia_action invoke/set_value）：\n${lines.join('\n') || '(无可访问元素)'}` +
    (result.truncated ? '\n\n（结果已截断；缩小 depth/max 或指定更具体窗口。）' : '');
}

// 新版执行层回 fw/fh（坐标帧＝图片像素）；老版本远程客户端只有原图 w/h + 原点
export function shotText(r) {
  if (r.fw) {
    const where = r.window ? `窗口 hwnd ${r.window}` : '屏幕';
    return `截图 ${r.fw}×${r.fh}（${where}实际 ${r.w}×${r.h} 像素）。之后 click/move/scroll/zoom 的 x,y 直接用这张图里的像素。`;
  }
  return `屏幕 ${r.w}×${r.h}（原点 ${r.ox},${r.oy}）。旧版客户端：坐标是原始屏幕像素、以本图左上角为 0,0；图片若被缩小显示，要按比例换算回原图像素。`;
}

const image = (r) => ({ type: 'image', data: r.image, mimeType: r.mimeType || 'image/jpeg' });

function pointerText(r) {
  const label = POINTER_LABEL[r.action] || r.action;
  const at = r.ref != null ? `ref${r.ref}` : Array.isArray(r.at) ? `(${r.at[0]}, ${r.at[1]})` : '';
  return `已${label} ${at}：落在 ${r.landed || '未知位置'}`;
}

// 单个动作结果 → 一行文字（batch 每步也用它）
export function actLine(r) {
  if (!r || typeof r !== 'object') return String(r);
  if (r.error) return `第 ${r.step} 步 ${r.action || ''} 失败：${r.error}`;
  const a = r.action;
  if (POINTER_LABEL[a]) return pointerText(r);
  if (a === 'type') return `已输入 ${r.chars} 个字符${r.foreground ? `（前台：「${r.foreground.title || r.foreground.process}」）` : ''}`;
  if (a === 'key') return `已按 ${r.keys}${r.foreground ? `（前台：「${r.foreground.title || r.foreground.process}」）` : ''}`;
  if (a === 'wait') return '已等待';
  if (a === 'screenshot') return `截图 ${r.size || ''}`;
  if (a === 'zoom') return `放大 region=[${(r.region || []).join(', ')}]`;
  if (a === 'focus_window') return `已切到前台：${r.window?.title || r.window?.hwnd || ''}`;
  if (a === 'uia_action') return `已对 ref${r.ref} 执行 ${r.uiaAction || ''}`;
  return JSON.stringify(r);
}
// 动作行 + 结果确认（单步结果与 batch 每一步共用）
export function actWithVerify(r) {
  const head = actLine(r);
  const v = verifyText(r.verify, r.action);
  return v ? `${head}\n${v}` : head;
}

// 桌面工具的完整 MCP content（文字 + 图片）。action = 调用的动作名，r = 执行层结果
export function desktopContent(action, r) {
  if (action === 'screenshot') return [image(r), { type: 'text', text: shotText(r) }];
  if (action === 'zoom') {
    return [image(r), { type: 'text', text: `region=[${r.region.join(', ')}] 的放大图（${r.fw}×${r.fh}）。仅供看清细节：坐标仍以 screenshot 那张图为准，不要用这张图的像素。` }];
  }
  if (action === 'batch') {
    const out = [];
    const lines = (r.steps || []).map((s) => {
      // 预期不符的那步：动作行 + 结果 + 停下的原因都要给模型看
      if (s.error && s.verify) return `${s.step}. ${actWithVerify({ ...s, error: undefined })}\n   → ${s.error}`;
      return s.error ? actLine(s) : `${s.step}. ${actWithVerify(s).replace(/\n/g, '\n   ')}`;
    });
    out.push({ type: 'text', text: `批处理 ${r.completed}/${r.total} 步完成${r.ok ? '' : '（遇错停止）'}：\n${lines.join('\n')}` });
    for (const img of r.images || []) {
      out.push({ type: 'text', text: img.kind === 'zoom' ? `第 ${img.step} 步放大图（仅看清细节，坐标不按它）：` : `第 ${img.step} 步截图 ${img.fw}×${img.fh}${img === r.images[r.images.length - 1] ? '（批处理结束后它就是新的坐标基准）' : ''}：` });
      out.push(image(img));
    }
    return out;
  }
  if (action === 'cursor') {
    return [{ type: 'text', text: r.x != null ? `光标在最近截图的 (${r.x}, ${r.y})（屏幕绝对 ${r.absX},${r.absY}）` : `光标在屏幕绝对 (${r.absX}, ${r.absY})，不在最近一张截图的范围内（或最近是窗口截图）` }];
  }
  if (action === 'wait_for_window') return [{ type: 'text', text: `等到了（${r.waitedMs}ms）：\n${formatWindows(r.windows || [])}` }];
  const out = [{ type: 'text', text: actWithVerify({ ...r, action: r.action || action }) }];
  if (r.screenshot) { out.push(image(r.screenshot)); out.push({ type: 'text', text: shotText(r.screenshot) }); }
  return out;
}

// 给 MCP 工具用：预期不符/批处理中途失败时整个结果标 isError，模型不会把它当成功
export function desktopResult(action, r) {
  const content = desktopContent(action, r);
  const failed = verifyFailed(r) || (action === 'batch' && r && r.ok === false);
  return failed ? { content, isError: true } : { content };
}
