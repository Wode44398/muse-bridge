// 状态清单：每一项是一段在页面里跑的异步代码（window.__qa 的工具见 helpers.mjs），跑完由 run.mjs 检测 + 截图。
// 字段：id、title（人话）、run（页面里执行的代码字符串）、only(cfg)（这一档才跑）、metrics（临时改视口，如键盘弹起）。
// 新加构件 / 浮层时在这里补一项——检测脚本只看得见被打开过的状态。

const LONG_ZH = '帮我改：项目\t原截图\t现在\n时间\t2026-11-05 06:35:39\t2026-11-05 23:02:58\n浮亏\t−1,397,581.00 USDT\t−3,512,458.40 USDT\n浮亏比例\t−50.50%\t−126.92%\n最新价格\t189.33000\t169.34500\n开仓价格\t201.27644\t201.27644\n杠杆\t8x\t8x\n备注：把右上角的数字全部换成「现在」这一列，字体字号保持原样，不要动其它地方，也不要加水印。';
const LONG_EN = 'Edit this screenshot: replace every number in the "Now" column, keep the original font and size exactly, do not touch anything else and do not add a watermark.\nRow 1: time 2026-11-05 23:02:58\nRow 2: floating loss -3,512,458.40 USDT\nRow 3: ratio -126.92%\nRow 4: last price 169.34500\nRow 5: entry 201.27644\nRow 6: leverage 8x';
const J = (s) => JSON.stringify(s);

// 打开手机抽屉 / 平板推入 / 桌面常驻（侧栏可见）
const SIDE_OPEN = `{ const l = (await import('/src/lib/layout.svelte.js')).layout; if (l.expanded) { __qa.m.studio.side.pinned = true; } else { __qa.m.studio.drawer = true; } await __qa.sleep(380); }`;
const SIDE_CLOSE = `{ const l = (await import('/src/lib/layout.svelte.js')).layout; if (l.expanded) { __qa.m.studio.side.pinned = false; } await __qa.sleep(120); }`;

const pages = ['image', 'video', 'voice', 'music'];
const KIND = { image: 'image', video: 'video', voice: 'speech', music: 'music' };
const AKIND = { image: 'image', video: 'video', voice: 'audio', music: 'music' };
const PROMPT = { image: '雨夜的东京小巷，霓虹灯倒映在积水里，35mm 胶片', video: '镜头缓慢推近灯塔，海浪拍岸，傍晚', voice: '欢迎来到 Media Studio。今天我们用一句话做出一张图、一段视频和一首曲子，再把它们串成一个短片。', music: 'Warm piano and strings, slow tempo, cinematic' };

export const SCENARIOS = [];
const S = (o) => SCENARIOS.push(o);

for (const p of pages) {
  S({ id: `${p}-empty`, title: `${p} 空态（没有作品）`, run: `await __qa.reset({ assets: [], page: '${p}' }); ${SIDE_CLOSE} await __qa.go('${p}');` });
  S({ id: `${p}-history`, title: `${p} 空画布 + 有历史（侧栏收起时画布附最近作品）`, run: `await __qa.reset({ assets: __qa.history(), page: '${p}' }); ${SIDE_CLOSE} await __qa.go('${p}');` });
  S({ id: `${p}-busy`, title: `${p} 生成中`, run: `await __qa.reset({ assets: __qa.history(), page: '${p}' }); ${SIDE_CLOSE} await __qa.go('${p}');
    const j = __qa.job('${KIND[p]}', ${J(PROMPT[p])}); __qa.m.upsertJob(j);
    ${p === 'image' ? `__qa.m.studio.views.image.turns = [{ jobId: j.id, prompt: j.prompt, state: 'running', assets: [], error: '', srcUrl: '' }];` : `__qa.m.studio.views['${p}'].focus = { jobId: j.id };`}
    await __qa.sleep(200);` });
  S({ id: `${p}-error`, title: `${p} 出错（长原因）`, run: `await __qa.reset({ assets: __qa.history(), page: '${p}' }); ${SIDE_CLOSE} await __qa.go('${p}');
    const j = __qa.job('${KIND[p]}', ${J(PROMPT[p])}, { state: 'error', error: '上游返回 400：The prompt could not be submitted. Your prompt may violate our usage guidelines (request id 7f3c9a2e-41b8-4c55-9d0e-aa1b2c3d4e5f). 请换个说法再试。' }); __qa.m.upsertJob(j);
    ${p === 'image' ? `__qa.m.studio.views.image.turns = [{ jobId: j.id, prompt: j.prompt, state: 'error', assets: [], error: j.error, srcUrl: '' }];` : `__qa.m.studio.views['${p}'].focus = { jobId: j.id };`}
    await __qa.sleep(200);` });
  S({ id: `${p}-done`, title: `${p} 完成（画布上一件作品）`, run: `await __qa.reset({ assets: __qa.history(), page: '${p}' }); ${SIDE_CLOSE} await __qa.go('${p}');
    const a = __qa.asset('${AKIND[p]}', ${J(PROMPT[p])}, { model: '${p === 'image' ? 'gemini-3-pro-image' : p === 'video' ? 'veo-3.1-lite-generate-001' : p === 'voice' ? 'gemini-2.5-flash-tts' : 'lyria-002'}', w: ${p === 'video' ? 1280 : 1024}, h: ${p === 'video' ? 720 : 1365} });
    __qa.m.studio.assets.unshift(a);
    ${p === 'image' ? `__qa.m.studio.views.image.turns = [{ jobId: null, prompt: a.prompt, state: 'done', assets: [a], error: '', srcUrl: '' }]; __qa.m.studio.views.image.thread = a.id;` : `__qa.m.studio.views['${p}'].focus = { asset: a };`}
    await __qa.sleep(300);` });
}

S({ id: 'image-chain', title: '图像续改链（三轮 + 第四轮生成中，长提示词气泡）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  const a1 = __qa.asset('image', '一只橘猫趴在窗台上晒太阳，午后，柔光', { w: 1024, h: 1024 });
  const a2 = __qa.asset('image', '改成下雪的傍晚，窗外有路灯', { w: 1024, h: 1024, thread: a1.id, parents: [a1.id] });
  const a3 = __qa.asset('image', ${J(LONG_ZH.slice(0, 120))}, { w: 1024, h: 1536, thread: a1.id, parents: [a2.id] });
  const j = __qa.job('image', '再把猫换成黑色的，眼睛是金色');
  __qa.m.upsertJob(j);
  __qa.m.studio.views.image = { thread: a1.id, turns: [
    { jobId: null, prompt: a1.prompt, state: 'done', assets: [a1], error: '', srcUrl: '' },
    { jobId: null, prompt: a2.prompt, state: 'done', assets: [a2], error: '', srcUrl: '' },
    { jobId: null, prompt: a3.prompt, state: 'done', assets: [a3], error: '', srcUrl: a1.thumb },
    { jobId: j.id, prompt: j.prompt, state: 'running', assets: [], error: '', srcUrl: '' } ] };
  await __qa.sleep(300);` });

S({ id: 'image-longprompt', title: '维护者截图复现：粘贴多行长文 + 一张「改这张图」素材', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  __qa.m.addInput('image', { role: 'edit', url: __qa.svg('截图', 1080, 2400), name: 'Screenshot_20261105_230658.jpg', kind: 'image', upload: '1793891304685-x.jpg' });
  await __qa.sleep(60); __qa.typeText(${J(LONG_ZH)}); await __qa.sleep(250);` });

S({ id: 'image-longprompt-kb', title: '长文 + 键盘弹起（视口只剩 520 高）', metrics: { height: 520, sab: 0 }, run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  __qa.m.addInput('image', { role: 'edit', url: __qa.svg('截图', 1080, 2400), name: 'Screenshot.jpg', kind: 'image', upload: 'x.jpg' });
  await __qa.sleep(60); __qa.typeText(${J(LONG_ZH)}); await __qa.sleep(250);`, only: (c) => c.touch });

S({ id: 'image-atts', title: '4 份素材（改图 + 2 参考 + 上传中）+ 血缘 + 超长文件名', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  const h = __qa.m.studio.assets[0];
  __qa.m.studio.drafts.image.parent = { id: h.id, kind: 'image', thumb: h.thumb, prompt: h.prompt };
  __qa.m.addInput('image', { role: 'edit', url: __qa.svg('a'), name: '一张名字特别特别长的中文素材图片文件名用来测试截断与省略号.png', kind: 'image', path: '素材/a.png' });
  __qa.m.addInput('image', { role: 'ref', url: __qa.svg('b', 720, 1280), name: 'portrait.jpg', kind: 'image', path: '素材/portrait.jpg' });
  __qa.m.addInput('image', { role: 'ref', url: __qa.svg('c', 1280, 720), name: 'wide.jpg', kind: 'image', asset: h.id, fromAsset: h.id });
  __qa.m.addInput('image', { role: 'ref', url: __qa.svg('d'), name: 'uploading.png', kind: 'image', pending: true });
  await __qa.sleep(60); __qa.typeText('把这几张合成一张海报'); await __qa.sleep(200);` });

S({ id: 'video-frames', title: '视频首尾帧 + 互换钮', run: `await __qa.reset({ assets: __qa.history(), page: 'video' }); ${SIDE_CLOSE} await __qa.go('video');
  __qa.m.addInput('video', { role: 'first', url: __qa.svg('f'), name: 'first.png', kind: 'image', path: 'a.png' });
  __qa.m.addInput('video', { role: 'last', url: __qa.svg('l'), name: 'last.png', kind: 'image', path: 'b.png' });
  await __qa.sleep(200);` });

S({ id: 'voice-audio-ref', title: '配音页参考音频 + 长稿', run: `await __qa.reset({ assets: __qa.history(), page: 'voice' }); ${SIDE_CLOSE} await __qa.go('voice');
  __qa.m.addInput('voice', { role: 'audio', url: '', name: '参考音频-一段很长很长的录音文件名.m4a', kind: 'audio', path: 'a.m4a' });
  __qa.typeText(${J(LONG_ZH)}); await __qa.sleep(200);` });

S({ id: 'music-lyria-zh', title: '音乐页 Lyria 2 输入中文（只认英文的提示）', run: `await __qa.reset({ assets: [], page: 'music' }); ${SIDE_CLOSE} await __qa.go('music');
  __qa.typeText('温暖的钢琴与弦乐，慢板'); await __qa.sleep(200);` });

S({ id: 'long-names', title: '超长模型名 / 服务名（输入框模型钮、chips）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  const c = __qa.m.studio.catalog; __qa.__cat = JSON.stringify(c);
  for (const g of c.kinds.image.groups) { g.provider.name = '一个名字特别特别长的自定义 OpenAI 兼容服务（公司内网 · 测试环境）'; for (const m of g.models) m.label = m.label + ' Extra Long Preview Edition 2026'; }
  __qa.m.studio.catalog = { ...c }; await __qa.sleep(250);`, cleanup: `if (__qa.__cat) { __qa.m.studio.catalog = JSON.parse(__qa.__cat); __qa.__cat = null; }` });

S({ id: 'ov-model-long', title: '模型选择器（超长模型名 / 服务名）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  const c = __qa.m.studio.catalog; __qa.__cat = JSON.stringify(c);
  for (const g of c.kinds.image.groups) { g.provider.name = '一个名字特别特别长的自定义 OpenAI 兼容服务（公司内网 · 测试环境）'; for (const m of g.models) m.label = m.label + ' Extra Long Preview Edition 2026'; }
  __qa.m.studio.catalog = { ...c }; await __qa.sleep(150);
  await __qa.click('.sd-page.on .cp-model'); await __qa.sleep(450);`, cleanup: `if (__qa.__cat) { __qa.m.studio.catalog = JSON.parse(__qa.__cat); __qa.__cat = null; }` });

// —— 浮层 ——
for (const p of pages) {
  S({ id: `ov-model-${p}`, title: `${p} 模型选择器`, run: `await __qa.reset({ assets: __qa.history(), page: '${p}' }); ${SIDE_CLOSE} await __qa.go('${p}'); await __qa.click('.sd-page.on .cp-model'); await __qa.sleep(450);` });
  S({ id: `ov-params-${p}`, title: `${p} 参数（chips「参数」或右栏）`, run: `await __qa.reset({ assets: __qa.history(), page: '${p}' }); ${SIDE_CLOSE} await __qa.go('${p}');
    if (document.querySelector('.sd-page.on .cp-all')) { await __qa.click('.sd-page.on .cp-all'); await __qa.sleep(500); }` });
  S({ id: `ov-params-${p}-end`, title: `${p} 参数滚到底`, run: `await __qa.reset({ assets: __qa.history(), page: '${p}' }); ${SIDE_CLOSE} await __qa.go('${p}');
    if (document.querySelector('.sd-page.on .cp-all')) { await __qa.click('.sd-page.on .cp-all'); await __qa.sleep(500); }
    for (const el of document.querySelectorAll('.studio-root .sh-body, .studio-root .pv-scroll, .studio-root .sd-dock-pane.on')) el.scrollTop = el.scrollHeight;
    await __qa.sleep(200);` });
}
S({ id: 'ov-params-chip', title: '点 chip 打开参数并定位到那一项', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  const chips = [...document.querySelectorAll('.sd-page.on .cp-chips .chip:not(.cp-all)')].filter((x) => !x.hidden); if (chips[1] || chips[0]) { (chips[1] || chips[0]).click(); await __qa.sleep(600); }` });
S({ id: 'ov-add-role', title: '＋ 选素材用处', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); await __qa.click('.sd-page.on .cp-ib'); await __qa.sleep(450);` });
S({ id: 'ov-add-source', title: '＋ 选来源（工作空间 / 这台设备）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); await __qa.click('.sd-page.on .cp-ib'); await __qa.sleep(400);
  const b = [...document.querySelectorAll('.studio-root .op')].find((x) => !x.disabled); if (b) { b.click(); await __qa.sleep(300); }` });
S({ id: 'ov-wspick', title: '工作空间选图', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); await __qa.click('.sd-page.on .cp-ib'); await __qa.sleep(400);
  let b = [...document.querySelectorAll('.studio-root .op')].find((x) => !x.disabled); if (b) { b.click(); await __qa.sleep(300); }
  const src = [...document.querySelectorAll('.studio-root .op')].filter((x) => __qa.vis(x) && !x.disabled); src[0]?.click(); await __qa.sleep(900);   // 来源第一项＝工作空间（不按文案找，英文档也能跑）
  const f = [...document.querySelectorAll('.studio-root .op, .studio-root .wp-crumb ~ * button')].find((x) => /素材/.test(x.textContent)); if (f) { f.click(); await __qa.sleep(900); }` });
S({ id: 'ov-voice', title: '配音页音色', run: `await __qa.reset({ assets: __qa.history(), page: 'voice' }); ${SIDE_CLOSE} await __qa.go('voice');
  const b = document.querySelector('.sd-page.on [data-chip="voice"]') || document.querySelector('.studio-root .sd-dock-pane.on [data-ctl="voice"] .pl-sel'); if (b) { b.click(); await __qa.sleep(800); }` });
S({ id: 'ov-tray', title: '任务托盘（进行中 + 最近：完成 / 失败 / 已放弃）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  const h = __qa.m.studio.assets;
  for (const j of [
    __qa.job('image', ${J(LONG_ZH.slice(0, 90))}),
    __qa.job('video', '镜头缓慢推近灯塔', { progress: 0, uncancelable: true }),
    __qa.job('image', '一碗冒着热气的拉面', { state: 'done', result: [h[0]], ago: 60000 }),
    __qa.job('speech', '欢迎来到 Media Studio', { state: 'error', error: '上游返回 429：Resource has been exhausted (e.g. check quota). 请稍后再试，或者到设置里换一个服务。', ago: 90000 }),
    __qa.job('video', '会被放弃的视频', { state: 'canceled', ago: 120000 }),
  ]) { j.__mine = false; __qa.m.upsertJob(j); }
  const cv = __qa.m.studio.jobs.find((x) => x.state === 'canceled'); if (cv) cv.abandoned = true;
  await __qa.click('.studio-root .sd-cap'); await __qa.sleep(500);` });
S({ id: 'ov-tray-empty', title: '任务托盘（空）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); await __qa.click('.studio-root .sd-cap'); await __qa.sleep(450);` });
S({ id: 'drawer', title: '侧栏（手机抽屉 / 平板推入 / 桌面常驻）+ 血缘线', run: `await __qa.reset({ assets: __qa.history() }); await __qa.go('image'); ${SIDE_OPEN}
  __qa.m.upsertJob(__qa.job('image', '雨夜的东京小巷，霓虹倒影'));
  await __qa.sleep(250);` });
S({ id: 'drawer-search', title: '侧栏搜索（没有结果）', run: `await __qa.reset({ assets: __qa.history() }); await __qa.go('image'); ${SIDE_OPEN}
  await __qa.click('.studio-root .sb-qbtn'); await __qa.sleep(200);
  const q = document.querySelector('.studio-root .sb-q input'); q.value = '一个肯定搜不到的很长很长的关键词'; q.dispatchEvent(new Event('input', { bubbles: true })); await __qa.sleep(700);` });
S({ id: 'drawer-filter', title: '侧栏筛选「视频」', run: `await __qa.reset({ assets: __qa.history() }); await __qa.go('image'); ${SIDE_OPEN}
  const b = [...document.querySelectorAll('.studio-root .sb-chip')][2]; b?.click(); await __qa.sleep(300);
  __qa.m.studio.assets = __qa.history().filter((a) => a.kind === 'video'); await __qa.sleep(200);` });
S({ id: 'drawer-files', title: '侧栏「文件」', run: `await __qa.reset({ assets: __qa.history() }); await __qa.go('image'); ${SIDE_OPEN}
  document.querySelector('.studio-root .sb-top .seg button[data-v="files"]')?.click(); await __qa.sleep(1500);` });
S({ id: 'ov-workmenu', title: '作品菜单（图像：接着做）', run: `await __qa.reset({ assets: __qa.history() }); await __qa.go('image'); ${SIDE_OPEN}
  const rows = [...document.querySelectorAll('.studio-root .wr')]; const r = rows.find((x) => x.querySelector('img'));
  const b = r?.querySelector('.wr-more'); if (b) { b.style.opacity = 1; b.click(); await __qa.sleep(600); }` });
S({ id: 'ov-workmenu-last', title: '作品菜单（列表最底下那一行：菜单要往上翻、不出屏）', run: `await __qa.reset({ assets: __qa.history() }); await __qa.go('image'); ${SIDE_OPEN}
  const ws = document.querySelector('.studio-root .ws'); ws.scrollTop = ws.scrollHeight; await __qa.sleep(200);
  const rows = [...document.querySelectorAll('.studio-root .wr')].filter((x) => { const r = x.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
  const b = rows[rows.length - 1]?.querySelector('.wr-more'); if (b) { b.style.opacity = 1; b.click(); await __qa.sleep(600); }` });
S({ id: 'ov-workmenu-audio', title: '作品菜单（配音）', run: `await __qa.reset({ assets: __qa.history() }); await __qa.go('voice'); ${SIDE_OPEN}
  const rows = [...document.querySelectorAll('.studio-root .wr')]; const r = rows.find((x) => !x.querySelector('img') && x.querySelector('.wr-more'));
  const b = r?.querySelector('.wr-more'); if (b) { b.style.opacity = 1; b.click(); await __qa.sleep(600); }` });
S({ id: 'droptray-files', title: '落点托盘（从系统拖文件进来）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image');
  const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
  __qa.page().querySelector('.cf').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await __qa.sleep(300);`, cleanup: `__qa.page()?.querySelector('.cf')?.dispatchEvent(new DragEvent('drop', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }));` });
S({ id: 'droptray-video', title: '落点托盘（拖作品进视频页：首帧 / 尾帧 / 参考图，按模型置灰）', run: `await __qa.reset({ assets: __qa.history(), page: 'video' }); ${SIDE_CLOSE} await __qa.go('video');
  const a = __qa.m.studio.assets.find((x) => x.kind === 'image');
  const cp = __qa.page().querySelector('.cp').getBoundingClientRect();
  __qa.dnd.beginDrag(__qa.sdrag.assetPayload(a), { x: cp.left + 40, y: cp.top - 120, pointerId: 7, pointerType: 'mouse', ghost: { name: __qa.adrag.ghostName(a), thumb: a.thumb } });
  await __qa.sleep(80);
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: cp.left + 60, clientY: cp.top + 20, pointerId: 7, pointerType: 'mouse', bubbles: true }));
  await __qa.sleep(350);`, cleanup: `try { __qa.dnd.cancelDrag(); } catch {}` });

// —— v3（方案 §9.2 / §9.3）：自动识别出来的模型与参数 ——
// 样例目录来自后端会话（catalog-v3.sample.json：真目录跑真代码生成）；bigModel 是十几个参数 + 42 项长枚举 + 超长英文标签的 schema 模型。
// 桌面宽屏参数在坞里（直接看得到）；窄屏点「参数」开浮层 / Sheet。
const V3_END = `__qa.restoreCatalog();`;
const OPEN_PARAMS = `if (document.querySelector('.sd-page.on .cp-all')) { await __qa.click('.sd-page.on .cp-all'); await __qa.sleep(550); }`;
const OPEN_MORE = `for (const b of document.querySelectorAll('.studio-root .pl-gh.fold[aria-expanded="false"]')) b.click(); await __qa.sleep(250);`;
const SCROLL_END = `for (const el of document.querySelectorAll('.studio-root .sh-body, .studio-root .pv-scroll, .studio-root .sd-dock-pane.on')) el.scrollTop = el.scrollHeight; await __qa.sleep(200);`;
S({ id: 'v3-many-params', title: '十几个参数的 schema 模型（参数坞 / 参数浮层）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); __qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS}`, cleanup: V3_END });
S({ id: 'v3-many-params-open', title: '十几个参数：展开「更多」（按控件种类排、原始参数在最末）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); __qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE}`, cleanup: V3_END });
S({ id: 'v3-many-params-mid', title: '十几个参数：滚到中段（长英文标签、开关、滑条）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); __qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE}
  const row = document.querySelector('.studio-root [data-param="safety_tolerance"]'); __qa.scrollTo(row, 'start'); await __qa.sleep(200);`, cleanup: V3_END });
S({ id: 'v3-many-params-end', title: '十几个参数：滚到底（原始参数）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); __qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE} ${SCROLL_END}`, cleanup: V3_END });
S({ id: 'v3-long-enum', title: '42 项长枚举的选项菜单（带搜索）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); __qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE}
  const b = document.querySelector('.studio-root [data-param="style_preset"] .pl-sel'); __qa.scrollTo(b, 'center'); await __qa.sleep(150); b?.click(); await __qa.sleep(600);`, cleanup: V3_END });
S({ id: 'v3-long-enum-search', title: '长枚举菜单里搜「photo」', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); __qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE}
  const b = document.querySelector('.studio-root [data-param="style_preset"] .pl-sel'); __qa.scrollTo(b, 'center'); await __qa.sleep(150); b?.click(); await __qa.sleep(500);
  const q = [...document.querySelectorAll('.studio-root :is(.pv, .sh) .op-q input')].pop(); if (q) { q.value = 'photo'; q.dispatchEvent(new Event('input', { bubbles: true })); } await __qa.sleep(300);`, cleanup: V3_END });
S({ id: 'v3-chips', title: '输入框底行：模型芯片 + 值芯片（比例 / 分辨率 / 画质 / 张数）+ 参数（桌面先收起参数坞）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} __qa.m.studio.side.dock = false; await __qa.go('image'); __qa.bigModel(); await __qa.sleep(400);`, cleanup: V3_END });
S({ id: 'v3-chip-menu', title: '点值芯片：就地出选项菜单（桌面先收起参数坞）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} __qa.m.studio.side.dock = false; await __qa.go('image'); __qa.bigModel(); await __qa.sleep(400);
  const cs = [...document.querySelectorAll('.sd-page.on .cp-chips .chip:not(.cp-all)')].filter((x) => !x.hidden); const c = cs.find((x) => x.dataset.chip === 'resolution') || cs[0]; c?.click(); await __qa.sleep(600);`, cleanup: V3_END });
S({ id: 'v3-params-pop', title: '桌面收起参数坞后点「参数」：贴着芯片的浮层（十几个参数）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} __qa.m.studio.side.dock = false; await __qa.go('image'); __qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS}`, cleanup: V3_END });
S({ id: 'v3-picker', title: '模型选择器：样例目录（服务分组、聚合服务按厂商、新模型朱点、参数来源、搜索框）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); await __qa.v3('image', 'grok-imagine'); await __qa.click('.sd-page.on .cp-model'); await __qa.sleep(600);`, cleanup: V3_END });
S({ id: 'v3-picker-search', title: '模型选择器搜「flux」（连备选一起搜）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); await __qa.v3('image'); await __qa.click('.sd-page.on .cp-model'); await __qa.sleep(500);
  const q = document.querySelector('.studio-root .mp-q input'); if (q) { q.value = 'flux'; q.dispatchEvent(new Event('input', { bubbles: true })); } await __qa.sleep(350);`, cleanup: V3_END });
S({ id: 'v3-picker-video', title: '视频模型选择器（直连 + 聚合 + 通用卡 + 继承卡）', run: `await __qa.reset({ assets: __qa.history(), page: 'video' }); ${SIDE_CLOSE} await __qa.go('video'); await __qa.v3('video', 'omni-1.2'); await __qa.click('.sd-page.on .cp-model'); await __qa.sleep(600);`, cleanup: V3_END });
S({ id: 'v3-schema-image', title: 'OpenRouter schema 卡（14 项比例）参数', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); await __qa.v3('image', 'grok-imagine'); ${OPEN_PARAMS}`, cleanup: V3_END });
S({ id: 'v3-family', title: '继承 + 精修卡（Omni 1.2：时长 3–15）', run: `await __qa.reset({ assets: __qa.history(), page: 'video' }); ${SIDE_CLOSE} await __qa.go('video'); await __qa.v3('video', 'omni-1.2'); ${OPEN_PARAMS}`, cleanup: V3_END });
S({ id: 'v3-seedance', title: 'Seedance 参考生视频：参考图 + 参考视频 + 参考音频素材', run: `await __qa.reset({ assets: __qa.history(), page: 'video' }); ${SIDE_CLOSE} await __qa.go('video'); await __qa.v3('video', 'seedance');
  const v = __qa.m.studio.assets.find((a) => a.kind === 'video');
  __qa.m.addInput('video', { role: 'ref', url: __qa.svg('r'), name: 'ref.png', kind: 'image', path: 'r.png' });
  if (v) __qa.m.addInput('video', { role: 'video', asset: v.id, url: v.thumb, name: v.prompt, kind: 'video', fromAsset: v.id });
  __qa.m.addInput('video', { role: 'audio', url: '', name: '一段很长很长的参考音频文件名.m4a', kind: 'audio', path: 'a.m4a' });
  __qa.typeText('让镜头跟着参考视频的运镜走，配上参考音频的节奏'); await __qa.sleep(300);`, cleanup: V3_END });
S({ id: 'v3-seedance-params', title: 'Seedance 参数（时长长枚举、任务、草稿）滚到底', run: `await __qa.reset({ assets: __qa.history(), page: 'video' }); ${SIDE_CLOSE} await __qa.go('video'); await __qa.v3('video', 'seedance'); ${OPEN_PARAMS} ${SCROLL_END}`, cleanup: V3_END });
S({ id: 'v3-tts', title: 'fal ElevenLabs v4：输出格式 19 项、音色 21 项', run: `await __qa.reset({ assets: __qa.history(), page: 'voice' }); ${SIDE_CLOSE} await __qa.go('voice'); await __qa.v3('voice', 'eleven-v4'); ${OPEN_PARAMS}`, cleanup: V3_END });
S({ id: 'v3-generic', title: '通用卡（只有原始参数）', run: `await __qa.reset({ assets: __qa.history(), page: 'video' }); ${SIDE_CLOSE} await __qa.go('video'); await __qa.v3('video', 'unknown-video'); ${OPEN_PARAMS}`, cleanup: V3_END });
S({ id: 'v3-shelf-picked', title: '选了一个备选模型（按需取回完整卡）', run: `await __qa.reset({ assets: __qa.history() }); ${SIDE_CLOSE} await __qa.go('image'); await __qa.v3('image');
  const g = __qa.m.studio.catalog.kinds.image.groups.find((x) => (x.shelf || []).length); const sm = g.shelf[0];
  __qa.m.studio.resolved = { [sm.key]: { ...sm, shelf: undefined, inputs: { text: true }, paramSource: 'schema', params: g.models.find((m) => (m.params || []).length > 3)?.params || [] } };
  __qa.m.studio.drafts.image.model = sm.key; await __qa.sleep(300); await __qa.click('.sd-page.on .cp-model'); await __qa.sleep(600);`, cleanup: V3_END });

// —— 设置 › Media Studio（手机 / 网页那套 iOS 外壳；桌面壳那套在 desk 档里跑）——
// 只按结构找按钮（.sst 是 Studio 设置正文的根，两套外壳都有），不按文案，英文档同样能跑。
const SET_OPEN = `await __qa.reset(); __qa.nav.openSettings('studio'); await __qa.until(() => { const r = document.querySelector('.sst'); return r && __qa.vis(r) && r.querySelectorAll('button').length > 4; }, 9000, '设置 › Media Studio'); await __qa.sleep(700);`;
// 收尾：服务管理器 / 保存位置浮层点它自己的关闭钮（别手动删 Svelte 管的节点），再关设置
const SET_CLOSE = `for (let i = 0; i < 4 && document.querySelector('.sst-layer'); i++) { const bs = document.querySelectorAll('.sst-layer header .hbtn, .sst-layer [aria-label="关闭"], .sst-layer [aria-label="Close"]'); bs[bs.length - 1]?.click(); await __qa.sleep(250); }
  __qa.st.ui.settingsOpen = false; await __qa.sleep(300);`;
const PROV = `[...document.querySelectorAll('.sst button.r, .sst button.drow')].find((x) => /Google Vertex AI/.test(x.textContent) && __qa.vis(x))`;
S({ id: 'set-main', title: '设置 › Media Studio 首页', run: SET_OPEN, cleanup: SET_CLOSE });
S({ id: 'set-main-end', title: '设置 › Media Studio 滚到底', run: SET_OPEN + `for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4 && el.getBoundingClientRect().width > 200) el.scrollTop = el.scrollHeight; } await __qa.sleep(300);`, cleanup: SET_CLOSE });
S({ id: 'set-def-image', title: '设置 › 默认图像模型（手机：推入页；桌面壳：下拉）', run: SET_OPEN + `const t = [...document.querySelectorAll('.sst .tile[data-k="image"]')].find((x) => __qa.vis(x)); const row = t?.closest('button, .drow'); const b = row?.matches('button') ? row : row?.querySelector('button'); __qa.scrollTo(b, 'center'); await __qa.sleep(300); b?.click(); await __qa.sleep(300); await __qa.stable('.pg.top'); await __qa.sleep(200);`, cleanup: SET_CLOSE });
S({ id: 'set-mgr-presets', title: '设置 › 添加媒体服务（预设页）', run: SET_OPEN + `const a = document.querySelector('.sst .r-tx.accent')?.closest('button') || [...document.querySelectorAll('.sst button, .sst [role=button]')].find((x) => /添加服务|Add provider/.test(x.textContent)); a?.click(); await __qa.sleep(1200);`, cleanup: SET_CLOSE });
S({ id: 'set-mgr-list', title: '设置 › 全部媒体服务（桌面壳）', only: (c) => !!c.desk, run: SET_OPEN + `const a = [...document.querySelectorAll('.sst button, .sst [role=button]')].find((x) => /管理全部服务|Manage all providers/.test(x.textContent)); a?.click(); await __qa.sleep(1300);`, cleanup: SET_CLOSE });
for (const [k, i] of [['conn', -1], ['models', 1], ['params', 2], ['test', 3]]) {
  S({ id: `set-ed-${k}`, title: `设置 › 服务编辑器「${k}」`, run: SET_OPEN + `const b = ${PROV}; b?.click(); await __qa.sleep(1500);
    ${i >= 0 ? `const n = [...document.querySelectorAll('.sst-layer nav.side button.nav')][${i}]; n?.click(); await __qa.sleep(900);` : ''}`, cleanup: SET_CLOSE });
}
// Google 云凭据：没导入过时导入卡的那一行点进去；导入过（卡缩成一行）就在 Vertex 服务编辑器「连接」区，滚到凭据卡
S({ id: 'set-google', title: '设置 › Google 云凭据', run: SET_OPEN + `const b = [...document.querySelectorAll('.sst .it.tap button.hit')].find((x) => __qa.vis(x));
  if (b) { b.click(); await __qa.sleep(1300); }
  else { ${PROV}?.click(); await __qa.sleep(1500); __qa.scrollTo(document.querySelector('.sst-layer .vxc'), 'start'); await __qa.sleep(400); }`, cleanup: SET_CLOSE });
// 「高级」（别的 agent / 能生成什么 / 内容安全过滤）：手机推入子页；桌面壳就地展开
S({ id: 'set-adv', title: '设置 › 高级', run: SET_OPEN + `const a = document.querySelector('.sst button.adv') || [...document.querySelectorAll('.sst button.r')].find((x) => /^\\s*(高级|Advanced)\\s*$/.test(x.textContent));
  __qa.scrollTo(a, 'center'); await __qa.sleep(300); a?.click(); await __qa.sleep(300); await __qa.stable('.pg.top'); await __qa.sleep(200);
  if (a?.matches('.adv')) { __qa.scrollTo(document.querySelector('.sst .grpwrap'), 'start'); await __qa.sleep(400); }`, cleanup: SET_CLOSE });
