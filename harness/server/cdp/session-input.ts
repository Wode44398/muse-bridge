// CdpSession 的输入层：指针回显、点击 / 长按 / 拖拽 / 双指、悬停与聚焦、输入与填值、上传、观看者、按键、滚动、视口与触屏、投屏订阅。
import { type BrowserViewer, type CastFrame, delay, KEY_DEFS, mobileUserAgent, type PointerEcho } from "./shared.ts";
import { CdpSessionPage } from "./session-page.ts";

export abstract class CdpSessionInput extends CdpSessionPage {
  subscribePointer(cb: (p: PointerEcho) => void): () => void {
    this.pointerSubs.add(cb);
    return () => this.pointerSubs.delete(cb);
  }

  private echoPointer(kind: PointerEcho["kind"], x: number, y: number, source: PointerEcho["source"]): void {
    for (const cb of this.pointerSubs) {
      try {
        cb({ kind, x: Math.round(x), y: Math.round(y), source });
      } catch {
        /* subscriber's problem */
      }
    }
  }

  async dispatchClick(
    x: number,
    y: number,
    opts: { button?: "left" | "right"; clickCount?: number; modifiers?: number; source?: "agent" | "user" } = {},
  ): Promise<void> {
    const button = opts.button ?? "left";
    const clickCount = opts.clickCount ?? 1;
    const modifiers = opts.modifiers ?? 0;
    // 触屏仿真（resize 到手机 / 平板档）下左键改发真触摸：此时开着 setEmitTouchEventsForMouse，合成的 mousePressed 被转成
    // touchstart 后回执要等整个手势结束才回，而 mouseReleased 要等这个回执才发——互等 30 秒超时，页面永远等不到 click
    // （agent 与用户在面板里手点都一样；bridge 10-07 踩过）。dispatchTouchEvent 是触屏下的正路，手势识别照常合成 click。
    if (this.emu.mobile && button === "left" && !modifiers) {
      for (let i = 0; i < clickCount; i++) {
        await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      this.echoPointer("click", x, y, opts.source ?? "agent");
      return;
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
    }
    this.echoPointer("click", x, y, opts.source ?? "agent");
  }

  async clickRef(ref: number, opts: { button?: "left" | "right"; clickCount?: number } = {}): Promise<void> {
    const c = await this.refCenter(ref);
    await this.dispatchClick(c.x, c.y, opts);
  }

  async clickCoord(
    x: number,
    y: number,
    opts: { button?: "left" | "right"; clickCount?: number; source?: "agent" | "user" } = {},
  ): Promise<void> {
    await this.dispatchClick(x, y, opts);
  }

  // Click by visible text (best match among interactive elements) — the escape
  // hatch when the model skipped ReadPage.
  async clickText(text: string): Promise<void> {
    const c = await this.findTextPoint(text);
    await this.dispatchClick(c.x, c.y);
  }

  // 按可见文本找可交互元素（滚进视口），返回中心点 CSS 坐标；找不到抛错。
  async findTextPoint(text: string): Promise<{ x: number; y: number }> {
    const needle = JSON.stringify(text.toLowerCase());
    const c = await this.eval(
      `(()=>{const n=${needle};const sel='a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],label';
       const nodes=Array.from(document.querySelectorAll(sel)).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
       const t=el=>(el.getAttribute('aria-label')||el.value||el.innerText||el.textContent||el.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim().toLowerCase();
       let hit=nodes.find(el=>t(el)===n)||nodes.find(el=>t(el).includes(n));
       if(!hit)return null;hit.scrollIntoView({block:'center'});const r=hit.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
    if (!c) throw new Error(`no clickable element matching text "${text}" — try another word, or Browser(find) / ReadPage for a ref`);
    await delay(60); // 等 scrollIntoView 落定再点
    return c;
  }

  // ── 手势：长按 / 拖拽 / 双指缩放 ──────────────────────────────────────────
  // 触屏档（emu.mobile）走真触摸事件，浏览器自己的手势管线照常判；鼠标档：按下 → 插值移动（带 buttons）→ 松开。

  async longPress(x: number, y: number, holdMs = 800): Promise<void> {
    const hold = Math.max(100, Math.min(10_000, Number(holdMs) || 800));
    if (this.emu.mobile) {
      // 不能用 dispatchTouchEvent：注入的触摸绕过浏览器侧的手势识别，按多久都只合成 tap。触屏档开着
      // setEmitTouchEventsForMouse，鼠标事件经触摸仿真器转成触摸、由它做手势识别，长按真补 contextmenu。这对事件的
      // 回执要等整个手势收尾、而收尾又在等回执——互相挂住（见 dispatchClick），所以两下都不 await，回执超时静默丢掉。
      const quiet = (type: string, buttons: number) =>
        this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 }, hold + 3_000).catch(() => {});
      void quiet("mousePressed", 1);
      await delay(hold);
      void quiet("mouseReleased", 0);
      await delay(150);
    } else {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await delay(hold);
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    }
    this.echoPointer("click", x, y, "agent");
  }

  // 返回 { html5 }：鼠标档里起点是 HTML5 可拖元素时，开 setInterceptDrags 把系统拖放接住，改发 dragEnter / dragOver / drop——
  // 不接的话 headless 里 dragstart 之后永远等不到 drop，有头视图（桌面壳）还会进系统拖放循环把窗口卡住。
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    { steps = 16, holdMs = 0 }: { steps?: number; holdMs?: number } = {},
  ): Promise<{ html5: boolean }> {
    const n = Math.max(2, Math.min(60, Math.round(Number(steps) || 16)));
    const hold = Math.max(0, Math.min(5_000, Number(holdMs) || 0));
    const at = (i: number) => ({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
    if (this.emu.mobile) {
      // 触点带显式 id、抬起时点名：不带 id 的触点在 CDP 那边会残留，下一场双指里冒出第三根手指
      const pt = (p: { x: number; y: number }) => [{ x: p.x, y: p.y, id: 0 }];
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(from) });
      if (hold) await delay(hold);
      for (let i = 1; i <= n; i++) {
        await this.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(at(i)) });
        await delay(16);
      }
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: pt(to) });
      this.echoPointer("move", to.x, to.y, "agent");
      return { html5: false };
    }
    const draggable = await this.eval(
      `(()=>{const e=document.elementFromPoint(${from.x},${from.y});if(!e)return false;
      const d=e.closest('[draggable]');if(d)return d.getAttribute('draggable')!=='false';
      if(e.closest('a[href],img'))return true;const s=getSelection();return !!(s&&!s.isCollapsed&&s.containsNode(e,true));})()`,
    ).catch(() => false);
    let intercept = false;
    if (draggable) {
      intercept = await this.send("Input.setInterceptDrags", { enabled: true }).then(() => true, () => false);
      if (!intercept) {
        throw new Error("the drag starts on an HTML5-draggable element, but this browser does not accept drag interception (old desktop shell?) — not dragging, to avoid wedging the window");
      }
    }
    let data: unknown = null;
    this.onDragIntercepted = (p) => {
      data = p?.data || null;
    };
    try {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
      if (hold) await delay(hold);
      let i = 1;
      for (; i <= n && !data; i++) {
        const p = at(i);
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 });
        await delay(16);
      }
      if (data) {
        // 拖放从第 i-1 步接管：dragEnter 落在当时的位置，dragOver 走完剩下的路，最后在终点 drop
        const start = at(i - 1);
        await this.send("Input.dispatchDragEvent", { type: "dragEnter", x: start.x, y: start.y, data });
        for (; i <= n; i++) {
          const p = at(i);
          await this.send("Input.dispatchDragEvent", { type: "dragOver", x: p.x, y: p.y, data });
          await delay(16);
        }
        await this.send("Input.dispatchDragEvent", { type: "dragOver", x: to.x, y: to.y, data });
        await this.send("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
      }
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    } finally {
      this.onDragIntercepted = null;
      if (intercept) await this.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
    }
    this.echoPointer("move", to.x, to.y, "agent");
    return { html5: Boolean(data) };
  }

  // 双指缩放：以 (x,y) 为中心，两指从 ±r 开到 ±r×scale（scale>1 放大、<1 捏合）。只在触屏档有意义。
  async pinch(x: number, y: number, scale = 2, { steps = 12, radius = 60 }: { steps?: number; radius?: number } = {}): Promise<void> {
    if (!this.emu.mobile) throw new Error('pinch only works in touch mode — Browser(resize, preset:"mobile") first');
    const s = Math.max(0.1, Math.min(10, Number(scale) || 2));
    const n = Math.max(2, Math.min(60, Math.round(Number(steps) || 12)));
    const pts = (r: number) => [{ x: x - r, y, id: 0 }, { x: x + r, y, id: 1 }];
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(radius) });
    for (let i = 1; i <= n; i++) {
      await this.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(radius * (1 + ((s - 1) * i) / n)) });
      await delay(16);
    }
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: pts(radius * s) });
  }

  async hoverRef(ref: number): Promise<void> {
    const c = await this.refCenter(ref);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
    this.echoPointer("move", c.x, c.y, "agent");
  }

  async hoverCoord(x: number, y: number, source: "agent" | "user" = "agent"): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    this.echoPointer("move", x, y, source);
  }

  async focusRef(ref: number): Promise<void> {
    const { backendId } = this.refInfo(ref);
    await this.send("DOM.focus", { backendNodeId: backendId });
  }

  // 聚焦目标（ref 或 CSS selector；都没给就保持当前焦点）。
  async focusTarget(target?: { ref?: number; selector?: string }): Promise<void> {
    if (target?.ref != null) {
      await this.focusRef(target.ref);
    } else if (target?.selector) {
      const ok = await this.eval(
        `(()=>{const e=document.querySelector(${JSON.stringify(target.selector)});if(!e)return false;e.focus();return true;})()`,
      );
      if (!ok) throw new Error(`no element matching selector ${target.selector}`);
    }
  }

  // Focus a target (by ref or CSS selector) and type text into it.
  async typeText(text: string, target?: { ref?: number; selector?: string }): Promise<void> {
    await this.focusTarget(target);
    await this.send("Input.insertText", { text });
  }

  // ref（ReadPage / find 的句柄）或 CSS selector → 元素的 objectId。
  async objectFor(target: { ref?: number; selector?: string } = {}): Promise<string> {
    if (target.ref != null) {
      const { backendId } = this.refInfo(target.ref);
      const { object } = await this.send("DOM.resolveNode", { backendNodeId: backendId });
      if (!object?.objectId) throw new Error(`ref${target.ref}: element is gone (page changed since ReadPage)`);
      return String(object.objectId);
    }
    if (target.selector) {
      const r = await this.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(target.selector)})`, returnByValue: false });
      if (r?.exceptionDetails) throw new Error(`invalid CSS selector ${JSON.stringify(target.selector)}`);
      if (!r?.result?.objectId) throw new Error(`no element matching selector ${target.selector}`);
      return String(r.result.objectId);
    }
    throw new Error("needs ref or selector");
  }

  // 直接设表单控件的值（对齐 bridge 的 set_value / Claude Code 桌面端 Browser 的 form_input）：原生 <select> 的下拉层
  // 截图里看不见、点开也选不了；date / time / range / color 打字进不去。按控件类型设值，走原型上的 value setter
  // （React 等受控组件认这个），再派发 input + change。
  async setValue(
    target: { ref?: number; selector?: string },
    value: unknown,
  ): Promise<{ ok: boolean; kind?: string; desc?: string; now?: string; why?: string; options?: string[] }> {
    const objectId = await this.objectFor(target);
    const r = await this.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      arguments: [{ value }],
      functionDeclaration: `function(v){
        const el = this, tag = el.tagName, desc = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.name ? '[name=' + e.name + ']' : '');
        const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        const truthy = (x) => x === true || /^(true|1|on|yes|checked)$/i.test(String(x));
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        if (el.disabled) return { ok: false, why: desc(el) + ' is disabled' };
        if (tag === 'SELECT') {
          const opts = [...el.options], want = Array.isArray(v) ? v.map(String) : [String(v)];
          const pick = (w) => opts.find((o) => o.value === w) || opts.find((o) => o.text.trim() === w.trim()) || opts.find((o) => o.text.toLowerCase().includes(w.trim().toLowerCase()));
          const hits = want.map(pick);
          if (hits.some((h) => !h)) return { ok: false, why: 'no option matches "' + want.join('", "') + '"', options: opts.slice(0, 30).map((o) => o.text.trim() + (o.value !== o.text.trim() ? ' (' + o.value + ')' : '')) };
          if (el.multiple) opts.forEach((o) => { o.selected = hits.includes(o); }); else el.value = hits[0].value;
          fire();
          return { ok: true, kind: 'select', desc: desc(el), now: [...el.selectedOptions].map((o) => o.text.trim()).join(', ') };
        }
        if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
          const on = truthy(v);
          if (el.checked !== on) { el.click(); if (el.checked !== on) { el.checked = on; fire(); } }
          return { ok: true, kind: el.type, desc: desc(el), now: el.checked ? 'checked' : 'unchecked' };
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          if (el.type === 'file') return { ok: false, why: 'file inputs take Browser(upload)' };
          const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          el.focus();
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
          fire();
          const ok = el.value === String(v) || el.type === 'range' || el.type === 'number';
          return { ok, kind: el.type || 'textarea', desc: desc(el), now: el.value, why: ok ? '' : 'the control turned the value into "' + el.value + '" (wrong format? date = YYYY-MM-DD, time = HH:MM, color = #rrggbb)' };
        }
        if (el.isContentEditable) {
          el.focus();
          const sel = getSelection(); const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
          if (!document.execCommand('insertText', false, String(v))) el.textContent = String(v);
          return { ok: true, kind: 'contenteditable', desc: desc(el), now: el.textContent.slice(0, 80) };
        }
        return { ok: false, why: desc(el) + ' is not a settable form control (select / input / textarea / contenteditable) — use click for buttons' };
      }`,
    });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "set_value failed");
    return r?.result?.value || { ok: false, why: "no result" };
  }


  // 往 <input type=file> 塞本机文件（DOM.setFileInputFiles）：隐藏的 input 同样有效，Chrome 照常派发 input / change。
  // 目标 = ref / CSS selector / 默认「此刻看得见的那部分页面里」的第一个文件框（后台常驻分页里的不算）。先验目标真是
  // file input，再塞，再回读文件名——不接受多选的框只保留第一个。
  async setInputFiles(
    files: string[],
    target: { ref?: number; selector?: string } = {},
  ): Promise<{ names: string[]; target: string; multiple: boolean; dropped: boolean }> {
    let objectId = "";
    let chosenNote = "";
    if (target.ref != null || target.selector) {
      objectId = await this.objectFor(target);
    } else {
      const pick = await this.send("Runtime.evaluate", {
        returnByValue: false,
        expression: `(() => {
          const all = [...document.querySelectorAll('input[type=file]')];
          const shown = (el) => { const p = el.parentElement; if (!p) return false;
            try { return p.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); } catch { return p.getClientRects().length > 0; } };
          const vis = all.filter(shown);
          const desc = (el) => { const bits = []; let n = el.parentElement;
            for (let k = 0; n && k < 3; k++, n = n.parentElement) { const c = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).find((x) => !/^svelte-/.test(x)) : ''; bits.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : c ? '.' + c : '')); }
            return (el.multiple ? 'multiple ' : '') + (el.accept ? 'accept=' + el.accept + ' ' : '') + 'in ' + bits.join(' < '); };
          const el = vis[0] || null;
          window.__dimensioUploadPick = { total: all.length, visible: vis.length, chosen: el ? desc(el) : '', others: vis.slice(1, 5).map(desc) };
          return el;
        })()`,
      });
      objectId = String(pick?.result?.objectId ?? "");
      const meta = await this.send("Runtime.evaluate", { expression: "window.__dimensioUploadPick", returnByValue: true }).then(
        (x) => x?.result?.value || {},
        () => ({}),
      );
      if (!objectId) {
        throw new Error(
          meta.total
            ? `the page has ${meta.total} file input(s), but all of them are in parts that are not shown (background tabs / collapsed panels) — open the upload UI first, or pass selector / ref`
            : "the page has no <input type=file>",
        );
      }
      chosenNote = ` (picked the file input in the visible part of the page: ${meta.chosen}${meta.others?.length ? `; ${meta.others.length} more visible: ${meta.others.join(" | ")} — pass selector / ref to pick another` : ""})`;
    }
    const probe = await this.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration:
        "function(){ const ok = this instanceof HTMLInputElement && this.type === 'file'; return { ok, tag: this.tagName, type: this.type || '', multiple: !!this.multiple, id: this.id || '', name: this.name || '' }; }",
    });
    const info = probe?.result?.value || {};
    if (!info.ok) {
      throw new Error(`the target is not an <input type=file> (it is ${info.tag || "?"}${info.type ? " type=" + info.type : ""}) — find the file input with ReadPage / find, or pass selector`);
    }
    const list = info.multiple ? files : files.slice(0, 1);
    await this.send("DOM.setFileInputFiles", { files: list, objectId });
    const after = await this.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: "function(){ return [...(this.files || [])].map((f) => f.name); }",
    });
    const label = info.id ? `#${info.id}` : info.name ? `input[name=${info.name}]` : "input[type=file]";
    return { names: after?.result?.value || [], target: label + chosenNote, multiple: Boolean(info.multiple), dropped: !info.multiple && files.length > 1 };
  }

  // ── 面板观看者 ────────────────────────────────────────────────────────────
  addViewer(kind: BrowserViewer["kind"]): () => void {
    const id = ++this.viewerSeq;
    this.viewers.set(id, { kind, since: Date.now() });
    return () => {
      this.viewers.delete(id);
    };
  }

  viewerList(): BrowserViewer[] {
    return [...this.viewers.values()];
  }

  // 桌面壳：当前标签此刻是不是挂在面板里、窗口有没有显示（broker GET target/<id>/view）。旧壳没有这条 → null。
  async shellViewState(): Promise<{ mounted?: boolean; windowShown?: boolean; focused?: boolean; parent?: string } | null> {
    if (!this.desktopBroker || !this.activeTargetId) return null;
    try {
      const res = await fetch(`${this.desktopBroker}/target/${encodeURIComponent(this.activeTargetId)}/view`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const payload = (await res.json()) as any;
      return payload?.ok ? payload : null;
    } catch {
      return null;
    }
  }

  // Press a key or combo ("enter", "ctrl+a", "shift+tab"). Named keys per
  // KEY_DEFS; single characters allowed as the base key of a combo.
  async pressKey(spec: string): Promise<void> {
    const parts = spec.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error("empty key spec");
    let modifiers = 0;
    const mods: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
    while (parts.length > 1 && mods[parts[0]] != null) modifiers |= mods[parts.shift()!];
    const base = parts.join("+");
    let k = KEY_DEFS[base];
    if (!k && base.length === 1) {
      const ch = base;
      const upper = ch.toUpperCase();
      k = {
        key: modifiers & 8 ? upper : ch,
        code: /[a-z]/.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : upper,
        keyCode: upper.charCodeAt(0),
        text: modifiers & ~8 ? undefined : modifiers & 8 ? upper : ch,
      };
    }
    if (!k) {
      throw new Error(`unsupported key "${spec}" (named: ${Object.keys(KEY_DEFS).join("|")}; or a single char, with ctrl/alt/shift/meta+ prefixes)`);
    }
    const ev = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    // Printable keys need `text` on keyDown to actually input/submit.
    const withText = k.text && !(modifiers & ~8) ? { ...ev, text: k.text, unmodifiedText: k.text } : ev;
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...withText });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...ev });
  }

  async scrollBy(dy: number, dx = 0): Promise<void> {
    await this.eval(`window.scrollBy(${Math.round(dx)}, ${Math.round(dy)})`);
    await delay(200);
  }

  async setViewport(width: number, height: number, mobile = false): Promise<void> {
    const w = Math.round(width);
    const h = Math.round(height);
    // 触屏仿真（手机 / 平板档）：touch 事件 + 移动端 UA + maxTouchPoints，与几何无关，headless 与桌面壳通用。
    // （设备指标覆盖里仍然 mobile:false——那会顺带打开 viewport-meta 语义，没 meta 的页面按 980px 排版，见下。）
    await this.applyTouch(Boolean(mobile), Math.min(w, h) < 600);
    // 桌面壳模式：视口由壳的 WebContentsView 几何决定（面板挂载时按 contain 缩放
    // 摆位 + zoomFactor，见 client/desktop main.cjs 的 mountBrowser）。这里再叠一层
    // 设备指标模拟只会打架：实测 override(1280×900) 撞上 zoom 0.5 会得到 2560×1800
    // 的 CSS 视口，而且 override 比控件大时 Chromium 把画面钉在左上角裁掉——那正是
    // 「预览显示不全」的病根。所以只记录期望视口并广播，让壳去把画面缩到框里。
    if (!this.desktopBroker) {
      // mobile:true is broken on Edge headless=new (viewport comes out scaled by
      // ~2.6 regardless of scale/deviceScaleFactor — verified empirically), so we
      // always emulate with mobile:false. Width-driven responsive layouts and
      // media queries still behave correctly; only touch-event emulation is lost.
      await this.send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    this.viewport = { width: w, height: h };
    this.notifyViewport();
    // S10 顺手：桌面壳模式以前只记录 + 广播，面板没开 / 手机远端在看 / agent 后台跑时 resize 等于没发生（页面 innerWidth
    // 纹丝不动）。与 bridge 的 cdp.mjs 同一条路：壳的 broker PUT target/<id>/viewport 改逻辑视口；旧壳回裸 404，就只记录。
    if (this.desktopBroker && this.activeTargetId) {
      await fetch(`${this.desktopBroker}/target/${encodeURIComponent(this.activeTargetId)}/viewport`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width: w, height: h }),
        signal: AbortSignal.timeout(4000),
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    }
    await delay(300); // let responsive layout settle
  }

  private async applyTouch(mobile: boolean, phone: boolean): Promise<void> {
    this.emu = { mobile };
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 }).catch(() => {});
    await this.send("Emulation.setEmitTouchEventsForMouse", { enabled: mobile, configuration: "mobile" }).catch(() => {});
    // 桌面档把 navigator.maxTouchPoints 盖成 0：主机若是触屏本，真值是 10，页面会按触屏设备走
    const src = "try{Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0,configurable:true})}catch(e){}";
    const id = this.touch0.get(this.activeTargetId);
    if (!mobile) {
      if (!id) {
        const r = await this.send("Page.addScriptToEvaluateOnNewDocument", { source: src }).catch(() => null);
        if (r?.identifier) this.touch0.set(this.activeTargetId, String(r.identifier));
      }
      await this.send("Runtime.evaluate", { expression: src }).catch(() => {});
    } else {
      if (id) {
        await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }).catch(() => {});
        this.touch0.delete(this.activeTargetId);
      }
      await this.send("Runtime.evaluate", { expression: "delete navigator.maxTouchPoints" }).catch(() => {});
    }
    if (mobile || this.uaOverridden) {
      if (!this.baseUa) {
        this.baseUa = String(await this.send("Browser.getVersion", {}).then((v) => v?.userAgent ?? "", () => ""));
        if (!this.baseUa) this.baseUa = String(await this.eval("navigator.userAgent").catch(() => ""));
      }
      const ua = mobile ? mobileUserAgent(this.baseUa, phone) : this.baseUa;
      if (ua) await this.send("Emulation.setUserAgentOverride", { userAgent: ua, ...(mobile ? { platform: "Linux armv8l" } : {}) }).catch(() => {});
      this.uaOverridden = mobile;
    }
  }

  // 视口变化广播：面板的设备三档钮点亮靠它，桌面壳还要靠它重新摆放原生视图
  // （agent 自己调 Browser(resize) 时用户那边也得跟上）。
  subscribeViewport(cb: (v: { width: number; height: number }) => void): () => void {
    this.viewportSubs.add(cb);
    return () => this.viewportSubs.delete(cb);
  }

  private notifyViewport(): void {
    const snap = { ...this.viewport };
    for (const cb of this.viewportSubs) {
      try {
        cb(snap);
      } catch {
        /* subscriber's problem */
      }
    }
  }


  // Subscribe to live screencast frames. Returns an unsubscribe fn. The cast
  // itself starts with the first subscriber and stops with the last.
  async subscribeCast(cb: (f: CastFrame) => void): Promise<() => void> {
    this.castSubs.add(cb);
    if (this.lastFrame) {
      try {
        cb(this.lastFrame); // immediate first paint for late joiners
      } catch {
        /* ignore */
      }
    }
    if (!this.casting) {
      try {
        await this.startCast();
      } catch (e) {
        this.castSubs.delete(cb);
        throw e;
      }
    }
    return () => {
      this.castSubs.delete(cb);
      if (this.castSubs.size === 0 && this.casting) {
        this.casting = false;
        this.send("Page.stopScreencast", {}).catch(() => {});
      }
    };
  }

  // Raw wheel at page coordinates — scrolls whatever container is under the
  // pointer (window.scrollBy can't reach inner scrollables).
  async wheel(x: number, y: number, deltaY: number, deltaX = 0): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  }
}
