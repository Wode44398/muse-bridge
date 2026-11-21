// Claude 输入栏右下角那颗键的造型与编排（components/claude/SendKey.svelte 的另一半：它出结构和样式，这里管「什么时候变成什么样」）。
//
// 两颗键、两个槽：停止在左，发送在右。只有停止时停止键就在最右；两颗都在时停止让到左边，发送永远在最右。
// 每颗键两层：底层（淡底 + 灰图标）和墨层（实底 + 反色图标）。墨层按一个圆裁出来——圆从键底往上走是「墨漫上来」，
// 圆缩到正中是「墨汇成一点」。图标是八根从同一点发出的线 + 支点上的圆点：箭头用三根，星芒八根全开，方块从圆点长出来。
//
// 造型全靠类名和 data-ic 切换，过渡写在 CSS 里（每个造型自带时长、曲线、错开量），所以随时能被打断、从当前的样子接着走。
// 这里只做两件事：apply(状态) 把键摆成该有的样子；fx(哪一种) 演「发出去的那一下」——那一下是有先后的几步，CSS 自己排不出来。
// 设计稿与逐帧说明：bridge前端设计/claude-send-key-demo。

const WAIT = ['dot', 'w1', 'w2', 'w3', 'w4', 'w5', 'w4', 'w3', 'w2', 'w1'];   // 等待：圆点 → 小十字 → 八芒，来回呼吸（终端那组 · ✢ ✳ ✶ ✻ ✽）
const LOOSE = new Set(['square', 'dot', 'w1', 'w2', 'w3', 'w4', 'w5']);          // 没有箭头的造型：从它们回到箭头要演「长出来」
const STOP_LOOK = { ic: 'square', soft: true };

// 最近一次「发出去的那一下」。新对话发第一句时，欢迎页的输入栏会换成对话页的那一条（两条交叉淡化），
// 新挂上来的这颗键拿它接着演到同一个时间点，两颗键同步，看不出换过。
let lastFx = null;
export function resumableFx(k = 1) {
  if (!lastFx) return null;
  const elapsed = (performance.now() - lastFx.start) / k;
  return elapsed < lastFx.total ? { ...lastFx, elapsed } : null;
}

export const reducedMotion = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// 键该排成哪一种：send 只有发送键 / stop 只有停止键 / steer 两颗并排
export const modeOf = (st) => (st.busy ? (st.has ? 'steer' : 'stop') : 'send');

// 发送键的造型。upload：null 没在传；0–1 进度；-1 在传但不知道进度（墨慢慢爬到一半等着）
export function sendLook(st) {
  if (st.verifying && !st.busy) return { waiting: true, dis: true };
  if (!st.has) return { dis: true };
  if (st.upload != null) return st.upload < 0 ? { lvl: 0.5, indet: true, dis: true } : { lvl: +(0.06 + Math.min(1, st.upload) * 0.86).toFixed(3), dis: true };
  return { armed: true, ic: st.busy && st.ctrl ? 'queue' : 'arrow' };
}

export class SendKeyMotion {
  // els：{ root, send, stop, sendSlot, stopSlot }；speed() 返回慢放倍数（调试用，平时是 1）
  constructor(els, { speed } = {}) {
    Object.assign(this, els);
    this.speed = speed || (() => 1);
    this.timers = [];
    this.fxKind = null;     // 正在演哪一种「发出去的那一下」
    this.want = null;       // 演的过程中攒下的最新状态，演完对账
    this.m = 'none';
    this.stopWaiting = false;
    this._side = new Map(); // 每颗键自己的小定时器（呼吸、长出来的标记）
    this.look(this.send, { dis: true });
    this.look(this.stop, STOP_LOOK);
    this.mode('none');
  }

  side(b) { let s = this._side.get(b); if (!s) this._side.set(b, (s = {})); return s; }

  // 摆造型：ic = arrow | queue | spark | square | dot；armed 墨满；lvl 墨位（附件在传）；soft 淡实底；bloom 陶土色；waiting 灰星芒呼吸
  look(b, o = {}) {
    const s = this.side(b), k = this.speed(), prev = b.dataset.ic;
    if (o.waiting) {
      if (!s.spin) { let i = 0; b.dataset.ic = 'dot'; s.spin = setInterval(() => { i = (i + 1) % WAIT.length; b.dataset.ic = WAIT[i]; }, 120 * k); }
    } else {
      if (s.spin) { clearInterval(s.spin); s.spin = 0; }
      const ic = o.ic || 'arrow';
      if ((ic === 'arrow' || ic === 'queue') && LOOSE.has(prev)) { b.classList.add('grow'); clearTimeout(s.grow); s.grow = setTimeout(() => b.classList.remove('grow'), 460 * k); }
      if (ic === 'queue' && prev !== 'queue') { b.classList.add('fresh'); clearTimeout(s.fresh); s.fresh = setTimeout(() => b.classList.remove('fresh'), 300 * k); }
      b.dataset.ic = ic;
    }
    for (const c of ['armed', 'soft', 'bloom', 'dis', 'indet']) b.classList.toggle(c, !!o[c]);
    b.classList.toggle('up', o.lvl != null);
    b.classList.toggle('mute', !!o.waiting);
    b.classList.remove('conv', 'dock');
    if (o.lvl != null) b.style.setProperty('--csk-lv', o.lvl); else b.style.removeProperty('--csk-lv');
    b.style.removeProperty('--csk-tw'); b.style.removeProperty('--csk-ts');
    b.setAttribute('aria-disabled', o.dis ? 'true' : 'false');
  }

  mode(m) {
    this.m = m; this.root.dataset.m = m;
    const s = m === 'send' || m === 'steer', t = m === 'stop' || m === 'steer';
    this.sendSlot.classList.toggle('on', s); this.stopSlot.classList.toggle('on', t);
    this.send.tabIndex = s ? 0 : -1; this.stop.tabIndex = t ? 0 : -1;
    this.sendSlot.setAttribute('aria-hidden', s ? 'false' : 'true'); this.stopSlot.setAttribute('aria-hidden', t ? 'false' : 'true');
    this.stop.classList.toggle('stop', t);   // 「.submit.stop 在不在」= 这一刻有没有停止键（沿用旧输入栏的判据）
  }

  // 不演过渡地换一次样子（先悄悄换好，再让下一步从这个样子开始演）
  // 可以套着用（apply 里自己也会 instant）：最外层收工时才放开过渡
  instant(fn) {
    this._ni = (this._ni || 0) + 1;
    this.root.classList.add('noanim');
    try { fn(); } finally {
      if (--this._ni === 0) { void this.root.offsetWidth; this.root.classList.remove('noanim'); }
    }
  }

  apply(st) {
    this.want = st;
    const m = modeOf(st);
    if (this.fxKind) { if (this.fxKind === 'send' && m === 'steer') this.endFx(false); else return; }   // 那一下演完再对账；只有人马上又打字才提前收
    const sWas = this.m === 'send' || this.m === 'steer', sNow = m === 'send' || m === 'steer';
    const sl = sendLook(st);
    if (this.m === 'stop' && m === 'send') {
      // 这一轮结束：停止键原地变回发送键——先悄悄换成「长得和停止键一样」的发送键，再让它长回箭头
      this.instant(() => { this.look(this.send, this.stopWaiting ? { ic: 'dot', soft: true } : STOP_LOOK); this.mode('send'); });
      this.look(this.send, sl);
    } else if (sNow) {
      if (!sWas) this.instant(() => this.look(this.send, { dis: true }));   // 第二颗键出现：先是空键，墨随后漫上来
      this.look(this.send, sl);
    }
    // 反过来：这一轮不是从这颗键发出去的（别处发起、或没演那一下）——空着的发送键原地变成停止键，箭头收成方块
    if (this.m === 'send' && m === 'stop') this.instant(() => { this.look(this.stop, { dis: true }); this.mode('stop'); });
    this.stopWaiting = !!st.stopping;
    this.look(this.stop, { ...STOP_LOOK, waiting: st.stopping, dis: st.stopping });
    this.mode(m);
  }

  // 发出去的那一下。send：墨汇成一点 → 星芒 → 方块，然后悄悄换给停止键；steer：星芒闪一下，键退场；
  // queue：箭头碰一下横线，墨往下退，键退场（这句话没交出去，只是先放着）。viaKey：键盘发的，屏幕上的键先按下去再放。
  // elapsed：从半路接着演（见 resumableFx）——已经过去的几步不演过渡、直接摆好，剩下的照原来的时间点走。
  fx(kind, viaKey = false, elapsed = 0) {
    this.endFx(false);
    if (reducedMotion()) return;
    const S = this.send, k = this.speed();
    this.fxKind = kind;
    const steps = [];
    let t0 = 0;
    const at = (ms, fn) => steps.push([t0 + ms, fn]);
    if (viaKey) { at(0, () => S.classList.add('press')); at(70, () => S.classList.remove('press')); t0 = 70; }
    if (kind === 'queue') {
      let q = 0;
      if (S.dataset.ic !== 'queue') { at(0, () => this.look(S, { armed: true, ic: 'queue' })); q = 240; }
      at(q, () => S.classList.add('dock'));
      at(q + 90, () => S.classList.remove('dock'));
      at(q + 170, () => S.classList.remove('armed'));
      at(q + 380, () => this.endFx());
    } else {
      at(0, () => { S.classList.remove('armed'); S.classList.add('conv', 'soft', 'bloom'); S.dataset.ic = 'spark'; });
      at(280, () => { S.style.setProperty('--csk-tw', '22.5deg'); S.style.setProperty('--csk-ts', '.82'); });   // 星芒照终端的节奏跳两格
      at(390, () => { S.style.setProperty('--csk-tw', '45deg'); S.style.setProperty('--csk-ts', '1'); });
      if (kind === 'steer') at(520, () => this.endFx());
      else {
        at(500, () => { S.dataset.ic = 'square'; S.classList.remove('bloom'); });
        at(800, () => this.endFx());
      }
    }
    if (!elapsed) lastFx = { kind, viaKey, start: performance.now(), total: Math.max(...steps.map((x) => x[0])), owner: this };
    const done = steps.filter((x) => x[0] < elapsed);
    if (done.length) this.instant(() => done.forEach((x) => x[1]()));
    for (const [t, fn] of steps) if (t >= elapsed) this.timers.push(setTimeout(fn, (t - elapsed) * k));
  }

  endFx(reapply = true) {
    if (!this.fxKind) return;
    const kind = this.fxKind; this.fxKind = null;
    this.timers.forEach(clearTimeout); this.timers = [];
    if (lastFx && lastFx.owner === this) lastFx = null;
    this.send.classList.remove('press', 'dock');
    if (kind === 'send') this.instant(() => { this.look(this.stop, STOP_LOOK); this.mode('stop'); this.look(this.send, { dis: true }); });
    if (reapply && this.want) this.apply(this.want);
  }

  // 键盘按下去时屏幕上的键也跟着按一下（Esc → 停止键）
  press(b, ms = 90) { b.classList.add('press'); setTimeout(() => b.classList.remove('press'), ms * this.speed()); }

  destroy() {
    this.timers.forEach(clearTimeout); this.timers = [];
    for (const s of this._side.values()) { clearInterval(s.spin); clearTimeout(s.grow); clearTimeout(s.fresh); }
    this._side.clear();
  }
}
