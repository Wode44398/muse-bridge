// dimensio for Edge —— 页面覆盖层（只注入「dimensio」标签组里、正被附着的标签）
//
// 三样东西，全在一个 closed shadow root 里、整层 pointer-events:none、对读屏隐藏：
//   · 氛围灯：视口四边一圈朱色的内发光，agent 在操作时缓慢呼吸
//   · 指针：墨色箭头 + 纸色描边 + 「dimensio」小签，先走到目标再点，按下时一圈朱色涟漪
//   · 底部胶囊：「dimensio 正在操作此页 · 停止」——唯一接收点击的地方
// 配色取 dimensio 的纸墨令牌：纸 #F4F1EA、墨 #171614，朱 #C8412B 只给「正在发生」。
// agent 截图前后台会发 dx:hide / dx:show，截图里不会有这一层。

(() => {
  if (window.__dimensioAgentOverlay) return;
  window.__dimensioAgentOverlay = true;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const state = { attached: false, acting: false, x: -1, y: -1, shown: false, idleTimer: 0 };

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; font: 500 13px/1.2 "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }

/* 氛围灯：细亮边 + 近光用内阴影；远光用四边各自的线性渐变——大半径内阴影会在四角围出一个圆角框的轮廓 */
.glow { position: fixed; inset: 0; opacity: 0; transition: opacity .6s cubic-bezier(.2,.7,.2,1);
  box-shadow:
    inset 0 0 0 1.5px rgba(200, 65, 43, .62),
    inset 0 0 18px 2px rgba(200, 65, 43, .30); }
.glow::after { content: ""; position: fixed; inset: 0;
  /* 缓出色标：线性渐变在终点处斜率突变，会看出一道框线（马赫带） */
  --fade: rgba(228, 85, 58, .14), rgba(228, 85, 58, .075) 22px, rgba(228, 85, 58, .035) 46px, rgba(228, 85, 58, .012) 72px, rgba(228, 85, 58, 0) 100px;
  background:
    linear-gradient(to bottom, var(--fade)),
    linear-gradient(to top, var(--fade)),
    linear-gradient(to right, var(--fade)),
    linear-gradient(to left, var(--fade)); }
.acting .glow { opacity: 1; animation: breathe 3.2s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: .72; } 50% { opacity: 1; } }

/* 指针：箭头尖端对准 (x, y)。transform 过渡的时长按距离算，写在元素 style 上 */
.cursor { position: fixed; left: 0; top: 0; width: 0; height: 0; opacity: 0;
  transition: opacity .35s ease; will-change: transform; }
.cursor.on { opacity: 1; }
.cursor svg { position: absolute; left: -1.5px; top: -1.5px; width: 22px; height: 26px; overflow: visible;
  filter: drop-shadow(0 2px 3px rgba(40, 37, 33, .28)); }
.tag { position: absolute; left: 17px; top: 21px; display: flex; align-items: center; gap: 5px; white-space: nowrap;
  padding: 3px 8px 3px 6px; border-radius: 999px; background: #171614; color: #F4F1EA;
  font-size: 11px; letter-spacing: .01em; box-shadow: 0 2px 6px rgba(40, 37, 33, .25); }
.tag i { width: 6px; height: 6px; border-radius: 50%; background: #E4553A; }
.ring { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
  border: 2px solid #C8412B; opacity: 0; pointer-events: none; }
.ring.go { animation: ring .5s cubic-bezier(.2,.7,.2,1); }
@keyframes ring { from { transform: scale(.35); opacity: .85; } to { transform: scale(1.6); opacity: 0; } }

/* 底部胶囊：浮起的纸面 + 细线 + 上沿高光 + 暖墨投影 */
.pill { position: fixed; left: 50%; bottom: 22px; display: flex; align-items: center; gap: 10px;
  padding: 6px 6px 6px 14px; border-radius: 999px; color: #171614;
  background: rgba(250, 248, 243, .94); border: 1px solid rgba(23, 22, 20, .10);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .8), 0 10px 30px rgba(40, 37, 33, .18), 0 1px 3px rgba(40, 37, 33, .12);
  backdrop-filter: blur(10px) saturate(1.1);
  transform: translate(-50%, 16px); opacity: 0; pointer-events: none;
  transition: transform .45s cubic-bezier(.2,.8,.2,1), opacity .3s ease; }
.acting .pill { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #C8412B; box-shadow: 0 0 0 0 rgba(200, 65, 43, .45);
  animation: pulse 1.8s ease-out infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(200, 65, 43, .45); } 80%, 100% { box-shadow: 0 0 0 7px rgba(200, 65, 43, 0); } }
.label b { font-weight: 600; }
.stop { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 999px; background: #171614; color: #F4F1EA;
  font: 600 12px/1 "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
  transition: background .15s ease, transform .15s ease; }
.stop:hover { background: #2a2824; }
.stop:active { transform: scale(.96); }
.stop:focus-visible { outline: 2px solid #C8412B; outline-offset: 2px; }

.hidden { visibility: hidden !important; }
@media (prefers-reduced-motion: reduce) {
  .acting .glow, .dot { animation: none; }
  .cursor { transition: none !important; }
}
`;

  const host = document.createElement("dimensio-agent");
  host.setAttribute("aria-hidden", "true");
  for (const [k, v] of Object.entries({
    all: "initial",
    position: "fixed",
    inset: "0",
    "z-index": "2147483647",
    "pointer-events": "none",
    display: "block",
    contain: "strict",
  })) host.style.setProperty(k, v, "important");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${CSS}</style>
<div class="layer">
  <div class="glow"></div>
  <div class="cursor">
    <div class="ring"></div>
    <svg viewBox="0 0 22 26" aria-hidden="true">
      <path d="M1.5 1.5 L1.5 19.2 L6.1 15 L9.3 22.2 L12.4 20.8 L9.3 13.8 L15.6 13.8 Z"
        fill="#171614" stroke="#F4F1EA" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>
    <div class="tag"><i></i>dimensio</div>
  </div>
  <div class="pill" role="status">
    <span class="dot"></span>
    <span class="label"><b>dimensio</b> 正在操作此页</span>
    <button class="stop" type="button">停止</button>
  </div>
</div>`;
  const layer = root.querySelector(".layer");
  const cursor = root.querySelector(".cursor");
  const ring = root.querySelector(".ring");
  root.querySelector(".stop").addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "dx:stop" }).catch(() => {});
  });

  // 挂到 <html> 上；SPA 把它拔掉就挂回去
  const mount = () => {
    const el = document.documentElement;
    if (!el) return false;
    if (host.parentNode !== el) el.appendChild(host);
    return true;
  };
  if (!mount()) {
    const mo = new MutationObserver(() => {
      if (mount()) mo.disconnect();
    });
    mo.observe(document, { childList: true });
  }
  const keep = () => {
    if (document.documentElement) {
      new MutationObserver(() => {
        if (host.parentNode !== document.documentElement) mount();
      }).observe(document.documentElement, { childList: true });
    } else setTimeout(keep, 50);
  };
  keep();

  function render() {
    layer.classList.toggle("acting", state.acting);
    const showCursor = state.attached && state.shown && state.x >= 0;
    cursor.classList.toggle("on", showCursor);
  }

  function place(x, y, ms) {
    cursor.style.transition = `transform ${ms}ms cubic-bezier(.22,.8,.24,1), opacity .35s ease`;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  }

  // 指针走到 (x, y)；返回动画时长，后台据此等它落位再真的点下去
  function moveTo(x, y) {
    let ms = 0;
    if (state.x < 0 || !state.shown) {
      // 第一次出现：从目标附近淡入，不从左上角飞过来
      place(x + 18, y + 26, 0);
      void cursor.offsetWidth;
      ms = reduced ? 0 : 260;
    } else {
      const d = Math.hypot(x - state.x, y - state.y);
      ms = reduced || d < 2 ? 0 : Math.round(Math.min(560, 170 + d * 0.38));
    }
    state.x = x;
    state.y = y;
    state.shown = true;
    render();
    place(x, y, ms);
    clearTimeout(state.idleTimer);
    return ms;
  }

  function press() {
    ring.classList.remove("go");
    void ring.offsetWidth;
    ring.classList.add("go");
  }

  function setState(s) {
    const wasActing = state.acting;
    state.attached = Boolean(s?.attached);
    state.acting = Boolean(s?.acting);
    if (!state.attached) state.shown = false;
    // 停手后指针再留一会儿再淡出。只在「又动起来」时取消淡出——同样的状态重推一遍不能把定时器清掉
    if (state.acting) clearTimeout(state.idleTimer);
    if (wasActing && !state.acting) {
      clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        state.shown = false;
        render();
      }, 2500);
    }
    render();
  }

  const nextFrame = () =>
    new Promise((r) => {
      const t = setTimeout(r, 60);
      requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(t), r())));
    });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg?.type) {
      case "dx:ping":
        reply({ ok: true });
        return;
      case "dx:state":
        setState(msg);
        reply({ ok: true });
        return;
      case "dx:move": {
        const ms = moveTo(Number(msg.x), Number(msg.y));
        // 后台标签的定时器会被节流到 1s——看不见就不必等动画
        if (!ms || document.hidden) reply({ ok: true });
        else setTimeout(() => reply({ ok: true }), ms);
        return true;
      }
      case "dx:press":
        if (state.x !== Number(msg.x) || state.y !== Number(msg.y)) moveTo(Number(msg.x), Number(msg.y));
        press();
        reply({ ok: true });
        return;
      case "dx:hide":
        layer.classList.add("hidden");
        nextFrame().then(() => reply({ ok: true }));
        return true;
      case "dx:show":
        layer.classList.remove("hidden");
        reply({ ok: true });
        return;
    }
  });

  chrome.runtime.sendMessage({ type: "dx:hello" }).then(setState).catch(() => {});
})();
