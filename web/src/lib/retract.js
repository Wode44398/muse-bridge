// 安全栅门撤回（retract 事件）——把本轮已渲染的内容按服务端算出的【区间】删掉。
//
// 服务端（src/runtime/retract-ledger.mjs）按 uuid 记账，算出被拒那截在本轮正文 / 思考 / 工具行里占的区间
// {textFrom,textTo,thinkFrom,thinkTo,toolsFrom,toolsTo}：正文按各 text 段累计字符数计，工具行按服务端发过
// tool 事件的条目序号计。区间之后的内容（回退模型已经流出来的开头）原样保留并前移；截空的 text/tools 段
// 整段删掉（notice/ask/media 原地留）。旧服务端的 {text,thinking,tools} 是「保留长度」尾截，也认。
//
// 工具行序号只数服务端发过 tool 事件的行：task_start 抢在工具事件前合成的 synthetic 行不在服务端计数里，
// 数序号时跳过、也绝不删它（否则会多切掉一条真实工具行，其后到的 tool_done 找不到条目）。
// 上下文压缩条目（t.compact，COMPACT_TOOL）同理：它不是 tool_use，服务端不计数，也不属于被拒那截。
//
// 纯函数、不碰 runes：chat.svelte.js 传进来的 m 是 $state 代理，就地改；forget(entry) 由调用方给
// （清 toolById/taskById 索引、收掉任务抽屉里挂着的条目）。node 单测直接 import。
export function retractSegments(m, ev, forget = () => {}) {
  if (!m || !ev) return;
  if (typeof ev.textFrom === 'number' || typeof ev.thinkFrom === 'number' || typeof ev.toolsFrom === 'number') retractRange(m, ev, forget);
  else retractKeep(m, ev, forget);
  for (let i = m.segments.length - 1; i >= 0; i--) {
    const s = m.segments[i];
    if ((s.kind === 'text' && !s.md) || (s.kind === 'tools' && !s.tools.length)) m.segments.splice(i, 1);
  }
}

const rng = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > a ? [Math.max(0, a), b] : null);

function retractRange(m, ev, forget) {
  const kr = rng(ev.thinkFrom, ev.thinkTo);
  if (kr && typeof m.thinking === 'string' && m.thinking.length > kr[0]) m.thinking = m.thinking.slice(0, kr[0]) + m.thinking.slice(kr[1]);
  const tr = rng(ev.textFrom, ev.textTo);
  if (tr) {
    let off = 0;
    for (const s of m.segments) {
      if (s.kind !== 'text') continue;
      const len = s.md.length;
      const a = Math.max(tr[0], off), b = Math.min(tr[1], off + len);
      if (b > a) s.md = s.md.slice(0, a - off) + s.md.slice(b - off);
      off += len;
    }
  }
  const or = rng(ev.toolsFrom, ev.toolsTo);
  if (or) {
    const victims = [];
    let k = 0;
    for (const s of m.segments) {
      if (s.kind !== 'tools') continue;
      for (let i = 0; i < s.tools.length; i++) {
        const t = s.tools[i];
        if (t.synthetic || t.compact) continue;
        if (k >= or[0] && k < or[1]) victims.push([s, i]);
        k++;
      }
    }
    for (let j = victims.length - 1; j >= 0; j--) {   // 从后往前删，前面的下标不受影响
      const [s, i] = victims[j];
      forget(s.tools[i]);
      s.tools.splice(i, 1);
    }
  }
}

// 旧协议：{text,thinking,tools} = 保留长度，从尾部截
function retractKeep(m, ev, forget) {
  if (typeof ev.thinking === 'number' && typeof m.thinking === 'string' && m.thinking.length > ev.thinking) m.thinking = m.thinking.slice(0, Math.max(0, ev.thinking));
  if (typeof ev.text === 'number') {
    let excess = m.segments.reduce((n, s) => n + (s.kind === 'text' ? s.md.length : 0), 0) - Math.max(0, ev.text);
    for (let i = m.segments.length - 1; i >= 0 && excess > 0; i--) {
      const s = m.segments[i];
      if (s.kind !== 'text') continue;
      const cut = Math.min(excess, s.md.length);
      s.md = s.md.slice(0, s.md.length - cut);
      excess -= cut;
    }
  }
  if (typeof ev.tools === 'number') {
    let excess = m.segments.reduce((n, s) => n + (s.kind === 'tools' ? s.tools.filter((t) => !t.synthetic && !t.compact).length : 0), 0) - Math.max(0, ev.tools);
    for (let i = m.segments.length - 1; i >= 0 && excess > 0; i--) {
      const s = m.segments[i];
      if (s.kind !== 'tools') continue;
      for (let j = s.tools.length - 1; j >= 0 && excess > 0; j--) {
        if (s.tools[j].synthetic || s.tools[j].compact) continue;
        forget(s.tools[j]);
        s.tools.splice(j, 1);
        excess--;
      }
    }
  }
}
