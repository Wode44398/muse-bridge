// 生成工具回执里的「参数没生效」提示：把 cards/report.mjs 的 warnings 写成一句给 agent 看的话。
// 不改变生成行为、不报错——参数被丢 / 回落时 agent 以前完全看不出来（params.output_format 被丢、outputFormat=svg 被改成 png）。

import { onlyKeys } from '../cards/report.mjs';

const MAX_KEYS = 30;
const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const range = (c) => (c.min ?? '') + '–' + (c.max ?? '');
const cond = (when) => Object.entries(when || {}).map(([k, v]) => k + '=' + (Array.isArray(v) ? v.join('/') : String(v))).join(' & ');
const keyList = (keys) => keys.filter((k) => k !== 'extra').slice(0, MAX_KEYS).join(', ') + (keys.length > MAX_KEYS ? ' …' : '');

const ZH = {
  head: '⚠ 以下参数未生效：',
  ignored(list, w) {
    const names = list.map((x) => x.key + (x.suggest ? `（正确键名是 ${x.suggest}）` : '')).join('、');
    const pass = w.extra ? '要把上游参数原样透传，写进 params.extra' : '这个模型不收原样透传的参数';
    return `${names}：该模型卡没有这个参数，已忽略（可用键：${keyList(w.keys)}；${pass}）`;
  },
  changed(c) {
    const name = c.key + (c.as ? `（写作 ${c.as}）` : '');
    if (c.when) return `${name}=${show(c.from)} 只在 ${cond(c.when)} 时生效，这次没有下发`;
    if (c.options) {
      const opts = c.options.length ? `不在可选值 ${c.options.map(show).join('/')} 内` : '这次没有可选值';
      return `${name}=${show(c.from)} ${opts}，` + (c.to !== undefined ? `已按 ${show(c.to)} 生成` : '没有下发（用模型默认）');
    }
    if (c.to !== undefined) return `${name}=${show(c.from)} 超出范围 ${range(c)}，已按 ${show(c.to)} 生成`;
    return `${name}=${show(c.from)} 类型不对，没有下发`;
  },
  sep: '；', end: '。',
};
const EN = {
  head: '⚠ Some params did not take effect: ',
  ignored(list, w) {
    const names = list.map((x) => x.key + (x.suggest ? ` (did you mean ${x.suggest}?)` : '')).join(', ');
    const pass = w.extra ? 'to pass a raw upstream field, put it in params.extra' : 'this model takes no raw passthrough params';
    return `${names}: not a param of this model card, ignored (available keys: ${keyList(w.keys)}; ${pass})`;
  },
  changed(c) {
    const name = c.key + (c.as ? ` (given as ${c.as})` : '');
    if (c.when) return `${name}=${show(c.from)} only applies when ${cond(c.when)}, not sent`;
    if (c.options) {
      const opts = c.options.length ? `is not one of ${c.options.map(show).join('/')}` : 'has no valid option right now';
      return `${name}=${show(c.from)} ${opts} — ` + (c.to !== undefined ? `generated with ${show(c.to)}` : 'not sent (model default used)');
    }
    if (c.to !== undefined) return `${name}=${show(c.from)} is out of range ${range(c)} — generated with ${show(c.to)}`;
    return `${name}=${show(c.from)} has the wrong type, not sent`;
  },
  sep: '; ', end: '.',
};

/** warnings（startJob / runDirect 回的）→ 一段提示；只报调用方在 params 里显式给的键。没有要说的回 ''。 */
export function paramWarningText(flavor, warnings, params) {
  const w = onlyKeys(warnings, params && typeof params === 'object' ? Object.keys(params) : []);
  if (!w) return '';
  const L = flavor === 'desktop' ? EN : ZH;
  const parts = [];
  if (w.ignored.length) parts.push(L.ignored(w.ignored, w));
  for (const c of w.changed) parts.push(L.changed(c));
  return L.head + parts.join(L.sep) + L.end;
}
