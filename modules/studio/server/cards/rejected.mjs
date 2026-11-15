// 上游拒收过的取值（方案 §11.4）。
//
// 模型卡上的选项是「按规格给的」：内置卡照官方文档、同族继承照模型名、通用卡照惯例。但一个 OpenAI 兼容的中转站到底认不认
// svg / gif / 审核档位，没有任何接口能问（/v1/models 只有模型名），官方直连也有按项目开权限的（svg）。零成本能做的只有：
// 上游**明确点名拒收**某个取值时记下来（按 服务 + 模型），目录把那一项标成 rejected，界面标出来、报错写成人话；
// 之后同一个取值成功过一次就自动解除（服务升级了 / 权限开了）。
//
// 只认「请求本身不合规」的状态码（400 / 415 / 422），而且上游报错里要点到这个参数的字段名或取值——
// 鉴权、额度、内容审核、超时一律不算；点不到名的也不算（宁可不记，不乱记）。

const BAD_REQUEST = new Set([400, 415, 422]);
const snake = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const statusOf = (e, msg) => Number(e?.status) || Number((/(?:^|\D)(4\d\d)(?=\D|$)/.exec(msg) || [])[1]) || 0;

/**
 * 这次失败是不是上游在拒收某个参数取值：回 { key, value, label, optionLabel } 或 null。
 * card：模型卡；sent：这次规范化后发出去的参数；err：适配器抛的错（message / status / detail）。
 * 只看枚举类（enum / size 的字符串档）且不是默认值的参数。
 */
export function detectRejected(card, sent = {}, err) {
  const msg = [err?.message, err?.detail].filter(Boolean).join(' ');
  if (!msg || !BAD_REQUEST.has(statusOf(err, msg))) return null;
  const low = msg.toLowerCase();
  const cands = [];
  for (const s of card?.params || []) {
    if (s.type !== 'enum' && s.type !== 'size') continue;
    const v = sent[s.key];
    if (typeof v !== 'string' || v === '' || v === s.default) continue;
    const o = (s.options || []).find((x) => x.value === v);
    if (!o) continue;
    cands.push({ key: s.key, value: v, label: s.label || s.key, optionLabel: o.label ?? v });
  }
  if (!cands.length) return null;
  const quoted = (v) => new RegExp(`['"\`‘“]${esc(v.toLowerCase())}['"\`’”]`).test(low);
  // ① 报错里带引号点了取值（Invalid value: 'svg'），且这个取值在这次请求里只属于一个参数
  const byValue = cands.filter((c) => c.value.length >= 2 && quoted(c.value));
  if (byValue.length === 1) return byValue[0];
  // ② 点了字段名（output_format / outputFormat / 点路径的末段）：只有一个候选参数对得上时才认
  const names = (c) => [c.key, snake(c.key), c.key.split('.').pop(), snake(c.key.split('.').pop())].map((x) => x.toLowerCase()).filter((x) => x.length >= 4);
  const byName = cands.filter((c) => names(c).some((n) => new RegExp(`(^|[^a-z0-9_])${esc(n)}([^a-z0-9_]|$)`).test(low)));
  if (byName.length === 1) return byName[0];
  return null;
}

/** 写进任务报错的头一行（前端 errBrief 认这个开头，后面跟上游原话当详情） */
export const rejectedLine = (r) => `这个服务不收「${r.label}：${r.optionLabel}」`;

/** 目录用：把拒收过的选项标上 rejected（rej = { <参数键>: [取值…] }） */
export function markRejected(params, rej) {
  if (!rej || !Object.keys(rej).length) return params;
  return params.map((s) => {
    const bad = rej[s.key];
    if (!Array.isArray(bad) || !bad.length || !Array.isArray(s.options)) return s;
    return { ...s, options: s.options.map((o) => (bad.includes(o.value) ? { ...o, rejected: true } : o)) };
  });
}
