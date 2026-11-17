// CdpSession 的输入方法（方法体原样，由 cdp.mjs 装回 CdpSession.prototype）：指针回显、点击 / 悬停 / 长按 / 拖拽 / 双指、聚焦与输入、按键、滚动、填值与上传。
import { parseKeySpec } from '../cdp-input.mjs';
import { delay } from './shared.mjs';

export class CdpInputMethods {
  subscribePointer(cb) {
    this.pointerSubs.add(cb);
    return () => this.pointerSubs.delete(cb);
  }

  echoPointer(kind, x, y, source) {
    for (const cb of this.pointerSubs) {
      try { cb({ kind, x: Math.round(x), y: Math.round(y), source }); } catch { /* subscriber's problem */ }
    }
  }

  async dispatchClick(x, y, opts = {}) {
    const button = opts.button ?? 'left';
    const clickCount = opts.clickCount ?? 1;
    const modifiers = opts.modifiers ?? 0;
    // 触屏仿真（resize mobile）下左键点击改发真触摸：此时开着 setEmitTouchEventsForMouse，
    // 合成的 mousePressed 被转成 touchstart 后回执要等整个手势结束才回，而 mouseReleased 要等
    // 这个回执才发——互等 30 秒超时，页面只收到 touchstart、永远等不到 click（agent 和用户在面板
    // 里手点都一样）。dispatchTouchEvent 是触屏下的正路，手势识别照常合成 click。
    if (this.emu?.mobile && button === 'left' && !modifiers) {
      for (let i = 0; i < clickCount; i++) {
        await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      this.echoPointer('click', x, y, opts.source ?? 'agent');
      return;
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
    }
    this.echoPointer('click', x, y, opts.source ?? 'agent');
  }

  async clickRef(ref, opts = {}) {
    const c = await this.refCenter(ref);
    await this.dispatchClick(c.x, c.y, opts);
  }

  async clickCoord(x, y, opts = {}) {
    await this.dispatchClick(x, y, opts);
  }

  // 按可见文本点击（可交互元素里最佳匹配）——模型跳过 read_page 时的逃生门。
  async clickText(text) {
    const c = await this.findTextPoint(text);
    await this.dispatchClick(c.x, c.y);
  }

  // 按可见文本找可交互元素（滚进视口），返回中心点 CSS 坐标；找不到抛错。
  async findTextPoint(text) {
    const needle = JSON.stringify(text.toLowerCase());
    const c = await this.eval(
      `(()=>{const n=${needle};const sel='a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],label';
       const nodes=Array.from(document.querySelectorAll(sel)).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
       const t=el=>(el.getAttribute('aria-label')||el.value||el.innerText||el.textContent||el.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim().toLowerCase();
       let hit=nodes.find(el=>t(el)===n)||nodes.find(el=>t(el).includes(n));
       if(!hit)return null;hit.scrollIntoView({block:'center'});const r=hit.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
    if (!c) throw new Error(`页面上没有文字是「${text}」的可点击元素——换个词，或用 find / read_page 拿 ref`);
    await delay(60);   // 等 scrollIntoView 落定再点
    return c;
  }

  async hoverRef(ref) {
    const c = await this.refCenter(ref);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    this.echoPointer('move', c.x, c.y, 'agent');
  }

  async hoverCoord(x, y, source = 'agent') {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    this.echoPointer('move', x, y, source);
  }

  // ── 手势：长按 / 拖拽 / 双指缩放 ──────────────────────────────────────────
  // 触屏档（emu.mobile）一律走真触摸事件，浏览器自己的手势管线照常判：按住真等 holdMs，长按就补
  // contextmenu、不合成 click；拖动是 touchMove 序列；双指是两个触点同帧移动（不会合成 click）。
  // 鼠标档：按下 → 插值移动（带 buttons）→ 松开。

  async longPress(x, y, holdMs = 800) {
    const hold = Math.max(100, Math.min(10_000, Number(holdMs) || 800));
    if (this.emu?.mobile) {
      // 不能用 dispatchTouchEvent：注入的触摸绕过了浏览器侧的手势识别，按多久都只合成 tap（click），
      // 永远等不到长按 → contextmenu（无头 / 壳实测一致）。触屏档开着 setEmitTouchEventsForMouse，
      // 鼠标事件经触摸仿真器转成触摸、由它做手势识别，长按真补 contextmenu。代价是这对事件的 CDP 回执
      // 要等整个手势收尾、而收尾又在等回执——互相挂住（见 dispatchClick），所以两下都不 await，
      // 回执超时静默丢掉；事件本身照常送达，之后的点击 / 触摸不受影响（实测连按两次再点一下都正常）。
      const quiet = (type, buttons) => this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 }, hold + 3_000).catch(() => {});
      quiet('mousePressed', 1);
      await delay(hold);
      quiet('mouseReleased', 0);
      await delay(150);
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await delay(hold);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    }
    this.echoPointer('click', x, y, 'agent');
  }

  // 返回 { html5 }：鼠标档里起点是 HTML5 可拖元素时，开 setInterceptDrags 把系统拖放接住，改发
  // dragEnter/dragOver/drop。不接的话有头视图（桌面壳）里 Chromium 会进系统拖放循环、等真鼠标松开，
  // 后面的事件全发不进去；headless 里则 dragstart 之后永远等不到 drop。接不住（旧壳没放行这两个
  // 方法）又遇上可拖元素就直说，别硬拖把壳卡住。
  async drag(from, to, { steps = 16, holdMs = 0 } = {}) {
    const n = Math.max(2, Math.min(60, Math.round(Number(steps) || 16)));
    const hold = Math.max(0, Math.min(5_000, Number(holdMs) || 0));
    const at = (i) => ({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
    if (this.emu?.mobile) {
      // 触点带显式 id、抬起时点名：不带 id 的触点在 CDP 那边会残留，下一场双指里冒出第三根手指
      const pt = (p) => [{ x: p.x, y: p.y, id: 0 }];
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) });
      if (hold) await delay(hold);
      for (let i = 1; i <= n; i++) {
        await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(at(i)) });
        await delay(16);
      }
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: pt(to) });
      this.echoPointer('move', to.x, to.y, 'agent');
      return { html5: false };
    }
    const draggable = await this.eval(`(()=>{const e=document.elementFromPoint(${from.x},${from.y});if(!e)return false;
      const d=e.closest('[draggable]');if(d)return d.getAttribute('draggable')!=='false';
      if(e.closest('a[href],img'))return true;const s=getSelection();return !!(s&&!s.isCollapsed&&s.containsNode(e,true));})()`).catch(() => false);
    let intercept = false;
    if (draggable) {
      intercept = await this.send('Input.setInterceptDrags', { enabled: true }).then(() => true, () => false);
      if (!intercept) throw new Error('起点是可拖拽元素（HTML5 拖放），但当前浏览器不接受拖放拦截（桌面壳版本过旧，更新客户端后可用）——没有硬拖，免得卡住窗口');
    }
    let data = null;
    this.onDragIntercepted = (p) => { data = p?.data || null; };
    try {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      if (hold) await delay(hold);
      let i = 1;
      for (; i <= n && !data; i++) {
        const p = at(i);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
        await delay(16);
      }
      if (data) {
        // 拖放从第 i-1 步接管：dragEnter 落在当时的位置，dragOver 走完剩下的路，最后在终点 drop
        const start = at(i - 1);
        await this.send('Input.dispatchDragEvent', { type: 'dragEnter', x: start.x, y: start.y, data });
        for (; i <= n; i++) {
          const p = at(i);
          await this.send('Input.dispatchDragEvent', { type: 'dragOver', x: p.x, y: p.y, data });
          await delay(16);
        }
        await this.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
        await this.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
      }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    } finally {
      this.onDragIntercepted = null;
      if (intercept) await this.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
    this.echoPointer('move', to.x, to.y, 'agent');
    return { html5: Boolean(data) };
  }

  // 双指缩放：以 (x,y) 为中心，两指从 ±r 开到 ±r×scale（scale>1 放大、<1 捏合）。只在触屏档有意义。
  async pinch(x, y, scale = 2, { steps = 12, radius = 60 } = {}) {
    if (!this.emu?.mobile) throw new Error('pinch 只在触屏档可用——先 resize(preset:"mobile") 或 resize(mobile:true)');
    const s = Math.max(0.1, Math.min(10, Number(scale) || 2));
    const n = Math.max(2, Math.min(60, Math.round(Number(steps) || 12)));
    const pts = (r) => [{ x: x - r, y, id: 0 }, { x: x + r, y, id: 1 }];
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(radius) });
    for (let i = 1; i <= n; i++) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(radius * (1 + ((s - 1) * i) / n)) });
      await delay(16);
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: pts(radius * s) });
  }

  async focusRef(ref) {
    const { backendId } = this.refInfo(ref);
    await this.send('DOM.focus', { backendNodeId: backendId });
  }

  // 聚焦目标（ref 或 CSS selector；都没给则保持当前焦点）。
  async focusTarget(target) {
    if (target?.ref != null) {
      await this.focusRef(target.ref);
    } else if (target?.selector) {
      const ok = await this.eval(
        `(()=>{const e=document.querySelector(${JSON.stringify(target.selector)});if(!e)return false;e.focus();return true;})()`,
      );
      if (!ok) throw new Error(`no element matching selector ${target.selector}`);
    }
  }

  // 聚焦目标后输入文本。
  async typeText(text, target) {
    await this.focusTarget(target);
    await this.send('Input.insertText', { text });
  }

  // 按键或组合键（"enter"、"ctrl+a"、"shift+tab"）；解析细节集中在 cdp-input.mjs。
  async pressKey(spec) {
    const { key, modifiers } = parseKeySpec(spec);
    const ev = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers,
    };
    // 可打印键的 keyDown 必须带 text 才会真正输入/提交。
    const withText = key.text && !(modifiers & ~8)
      ? { ...ev, text: key.text, unmodifiedText: key.text }
      : ev;
    await this.send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...withText });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  }

  async scrollBy(dy, dx = 0) {
    await this.eval(`window.scrollBy(${Math.round(dx)}, ${Math.round(dy)})`);
    await delay(200);
  }


  // 往 <input type=file> 塞本机文件（DOM.setFileInputFiles）：隐藏的 input 同样有效，
  // Chrome 会照常派发 input/change。目标 = ref（read_page 句柄）/ CSS selector / 默认第一个
  // file input。先验目标真是 file input，再塞，再回读文件名——不接受多选的框只保留第一个。
  // ref（read_page / find 的句柄）或 CSS selector → 元素的 objectId。
  async objectFor(target = {}) {
    if (target.ref != null) {
      const { backendId } = this.refInfo(target.ref);
      const { object } = await this.send('DOM.resolveNode', { backendNodeId: backendId });
      if (!object?.objectId) throw new Error(`ref${target.ref}: element is gone (page changed since read_page)`);
      return object.objectId;
    }
    if (target.selector) {
      const r = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(target.selector)})`, returnByValue: false });
      if (!r?.result?.objectId) throw new Error(`no element matching selector ${target.selector}`);
      return r.result.objectId;
    }
    throw new Error('需要 ref 或 selector');
  }

  // 直接设表单控件的值（对齐 Claude Code 桌面端 Browser 的 form_input）：原生 <select> 的下拉层截图里看不见、
  // 点开也选不了；date / time / range / color 打字进不去（10-26 实测日期框 type 后仍是空）。这里按控件类型设值，
  // 走原型上的 value setter（React 等受控组件认这个），再派发 input + change。
  async setValue(target, value) {
    const objectId = await this.objectFor(target);
    const r = await this.send('Runtime.callFunctionOn', {
      objectId, returnByValue: true, arguments: [{ value }],
      functionDeclaration: `function(v){
        const el = this, tag = el.tagName, desc = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.name ? '[name=' + e.name + ']' : '');
        const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        const truthy = (x) => x === true || /^(true|1|on|yes|checked)$/i.test(String(x));
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        if (el.disabled) return { ok: false, why: desc(el) + ' 是禁用状态' };
        if (tag === 'SELECT') {
          const opts = [...el.options], want = Array.isArray(v) ? v.map(String) : [String(v)];
          const pick = (w) => opts.find((o) => o.value === w) || opts.find((o) => o.text.trim() === w.trim()) || opts.find((o) => o.text.toLowerCase().includes(w.trim().toLowerCase()));
          const hits = want.map(pick);
          if (hits.some((h) => !h)) return { ok: false, why: '没有匹配「' + want.join('、') + '」的选项', options: opts.slice(0, 30).map((o) => o.text.trim() + (o.value !== o.text.trim() ? ' (' + o.value + ')' : '')) };
          if (el.multiple) opts.forEach((o) => { o.selected = hits.includes(o); }); else el.value = hits[0].value;
          fire();
          return { ok: true, kind: 'select', desc: desc(el), now: [...el.selectedOptions].map((o) => o.text.trim()).join('、') };
        }
        if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
          const on = truthy(v);
          if (el.checked !== on) { el.click(); if (el.checked !== on) { el.checked = on; fire(); } }
          return { ok: true, kind: el.type, desc: desc(el), now: el.checked ? '已勾选' : '未勾选' };
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          if (el.type === 'file') return { ok: false, why: '文件框请用 upload' };
          const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          el.focus();
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
          fire();
          const ok = el.value === String(v) || el.type === 'range' || el.type === 'number';
          return { ok, kind: el.type || 'textarea', desc: desc(el), now: el.value, why: ok ? '' : '控件把值改成了「' + el.value + '」（格式不对？date 要 YYYY-MM-DD、time 要 HH:MM、color 要 #rrggbb）' };
        }
        if (el.isContentEditable) {
          el.focus();
          const sel = getSelection(); const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
          if (!document.execCommand('insertText', false, String(v))) el.textContent = String(v);
          return { ok: true, kind: 'contenteditable', desc: desc(el), now: el.textContent.slice(0, 80) };
        }
        return { ok: false, why: desc(el) + ' 不是可设值的表单控件（select / input / textarea / contenteditable）——按钮类用 click' };
      }`,
    });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'set_value 失败');
    return r?.result?.value || { ok: false, why: '没有返回结果' };
  }


  async setInputFiles(files, target = {}) {
    let objectId;
    let chosenNote = '';
    if (target.ref != null) {
      const { backendId } = this.refInfo(target.ref);
      const { object } = await this.send('DOM.resolveNode', { backendNodeId: backendId });
      objectId = object?.objectId;
    } else if (target.selector) {
      const sel = target.selector;
      const r = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})`, returnByValue: false });
      objectId = r?.result?.objectId;
      if (!objectId) throw new Error(`no element matching selector ${sel}`);
    } else {
      // 没指定目标：只在【看得见的那部分页面】里找。文件框本身几乎都是隐藏的，所以看它父元素
      // 在不在渲染（display:none / content-visibility:hidden 的分页都算不在）——SPA 常把别的分页
      // 留在后台常驻，document 里的第一个文件框往往属于用户此刻根本没在看的页面（2026-10-07 实遇：
      // 塞进了后台 Claude 页的附件框，30MB 超限弹 alert 把整个页面挡死）。看得见的有多个时
      // 取第一个并在结果里列出其余，让 agent 需要时改用 selector / ref。
      const pick = await this.send('Runtime.evaluate', {
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
          window.__bridgeUploadPick = { total: all.length, visible: vis.length, chosen: el ? desc(el) : '', others: vis.slice(1, 5).map(desc) };
          return el;
        })()`,
      });
      objectId = pick?.result?.objectId;
      const meta = await this.send('Runtime.evaluate', { expression: 'window.__bridgeUploadPick', returnByValue: true }).then((x) => x?.result?.value || {}, () => ({}));
      if (!objectId) {
        throw new Error(meta.total
          ? `页面上有 ${meta.total} 个文件输入框，但都在当前看不见的部分（后台分页 / 已收起的面板）——先把要上传的界面打开，或用 selector / ref 明确指定`
          : '页面上没有 <input type=file>');
      }
      chosenNote = `（自动选了当前可见部分的文件框：${meta.chosen}${meta.others?.length ? `；可见的还有 ${meta.others.length} 个：${meta.others.join(' | ')}，要换就给 selector / ref` : ''}）`;
    }
    if (!objectId) throw new Error('目标元素已不在页面上（read_page 之后页面变了）');
    const probe = await this.send('Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: "function(){ const ok = this instanceof HTMLInputElement && this.type === 'file'; return { ok, tag: this.tagName, type: this.type || '', multiple: !!this.multiple, id: this.id || '', name: this.name || '' }; }",
    });
    const info = probe?.result?.value || {};
    if (!info.ok) throw new Error(`目标不是 <input type=file>（是 ${info.tag || '?'}${info.type ? ' type=' + info.type : ''}）——用 read_page/find 找到文件输入框，或给 selector`);
    const list = info.multiple ? files : files.slice(0, 1);
    await this.send('DOM.setFileInputFiles', { files: list, objectId });
    const after = await this.send('Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: 'function(){ return [...(this.files || [])].map((f) => f.name); }',
    });
    const label = info.id ? `#${info.id}` : (info.name ? `input[name=${info.name}]` : 'input[type=file]');
    return { names: after?.result?.value || [], target: label + chosenNote, multiple: !!info.multiple, dropped: !info.multiple && files.length > 1 };
  }
}
