// 状态清单：每一项是一段在页面里跑的异步代码（window.__qa 的工具见 helpers.mjs），跑完由 run.mjs 检测 + 截图。
// 字段：id、title（人话）、run（页面里执行的代码字符串）、only(cfg)（这一档才跑）、metrics（临时改视口，如键盘弹起）、cleanup。
// 新加构件 / 浮层时在这里补一项——检测脚本只看得见被打开过的状态。
// v4「作品台」（方案 §12，2026-11-26）：四面作品墙、生成中取景框、失败卡、焦点（版本条 / 续改中）、托盘与单项卡、
// 全部参数（手机表单 / 平板居中卡 / 宽屏参数坞）、模型选择器（同名合一行）、＋ 添加素材、素材架（收 / 展开 / 抽屉 / 文件 / 挑选态）、
// 作品菜单、设置入口、落点托盘、长提示词 + 键盘弹起。墙的底子是隔离后端里的真实作品。

const LONG_ZH = '帮我改：项目\t原截图\t现在\n时间\t2026-11-05 06:35:39\t2026-11-05 23:02:58\n浮亏\t−1,397,581.00 USDT\t−3,512,458.40 USDT\n浮亏比例\t−50.50%\t−126.92%\n最新价格\t189.33000\t169.34500\n开仓价格\t201.27644\t201.27644\n杠杆\t8x\t8x\n备注：把右上角的数字全部换成「现在」这一列，字体字号保持原样，不要动其它地方，也不要加水印。';
const LONG_ERR = '上游返回 400：The prompt could not be submitted. Your prompt may violate our usage guidelines (request id 7f3c9a2e-41b8-4c55-9d0e-aa1b2c3d4e5f). 请换个说法再试。';
const J = (s) => JSON.stringify(s);

const pages = ['image', 'video', 'voice', 'music'];
const KIND = { image: 'image', video: 'video', voice: 'speech', music: 'music' };
const PROMPT = { image: '雨夜的东京小巷，霓虹灯倒映在积水里，35mm 胶片', video: '镜头缓慢推近灯塔，海浪拍岸，傍晚', voice: '欢迎来到 Media Studio。今天我们用一句话做出一张图、一段视频和一首曲子，再把它们串成一个短片。', music: 'Warm piano and strings, slow tempo, cinematic' };
const R = (p = 'image', o = '') => `await __qa.reset({ page: '${p}'${o ? ', ' + o : ''} }); await __qa.go('${p}');`;
// 全部参数：宽屏是参数坞（复位时已开），手机 / 平板点托盘最右的「全部参数」开表单 / 居中卡
const OPEN_PARAMS = `if (__qa.lay.expanded) { __qa.m.studio.side.dock = true; await __qa.sleep(450); } else if (document.querySelector('.sd-page.on .t-all')) { await __qa.click('.sd-page.on .t-all'); await __qa.sleep(550); } await __qa.idle();`;
const OPEN_MORE = `for (const b of document.querySelectorAll('.studio-root .pl-gh.fold[aria-expanded="false"]')) b.click(); await __qa.sleep(250);`;
const SCROLL_END = `for (const el of document.querySelectorAll('.studio-root .sh-body, .studio-root .pv-scroll, .studio-root .sd-dock-pane.on')) el.scrollTop = el.scrollHeight; await __qa.sleep(250);`;
// 托盘的参数段要看得见：宽屏先收起参数坞（坞开着时托盘只留模型）
const NODOCK = `__qa.m.studio.side.dock = false; await __qa.sleep(350);`;
const SEG = (key) => `{ const b = await __qa.until(() => __qa.find('.sd-page.on .t-seg[data-seg="${key}"]'), 5000, '托盘段 ${key}'); b.click(); await __qa.sleep(550); await __qa.idle(); }`;

export const SCENARIOS = [];
const S = (o) => SCENARIOS.push(o);

// —— 四面作品墙 ——
for (const p of pages) {
  S({ id: `${p}-wall`, title: `${p} 作品墙（真实作品）`, run: R(p) + `await __qa.sleep(400); await __qa.idle();` });
  S({ id: `${p}-empty`, title: `${p} 空墙（线稿 + 宋体句）`, run: R(p, 'empty: true') });
  // 生成中：图像两格（16:9 一格、默认比例一格，其中一个不能取消），视频竖版一格；音频一行
  S({ id: `${p}-busy`, title: `${p} 生成中（取景框 / 墨线上走着一小段波）`, run: R(p) + `
    ${p === 'image' ? `__qa.runJob('image', ${J(PROMPT.image)}, { params: { aspectRatio: '16:9' } }); __qa.runJob('image', '一碗冒着热气的拉面', { progress: 0, uncancelable: true, ago: 3000 });`
      : p === 'video' ? `__qa.runJob('video', ${J(PROMPT.video)}, { params: { aspectRatio: '9:16' }, progress: 0.7 });`
      : p === 'voice' ? `__qa.runJob('speech', ${J(PROMPT.voice)}, { params: { voice: 'Kore' } });`
      : `__qa.runJob('music', ${J(PROMPT.music)});`}
    await __qa.sleep(700); await __qa.idle();` });
  S({ id: `${p}-error`, title: `${p} 失败卡（长原因）`, run: R(p) + `
    __qa.failJob('${KIND[p]}', ${J(PROMPT[p])}, ${J(LONG_ERR)}${p === 'image' ? `, { params: { aspectRatio: '3:4' } }` : ''}); await __qa.sleep(700); await __qa.idle();` });
}
S({ id: 'image-err-detail', title: '失败卡点开「详情」（上游原话）', run: R('image') + `
  __qa.failJob('image', ${J(PROMPT.image)}, ${J(LONG_ERR)}, { params: { aspectRatio: '1:1' } }); await __qa.sleep(600);
  __qa.find('.sd-page.on .sw-err-more')?.click(); await __qa.sleep(300); await __qa.idle();` });
S({ id: 'image-landed', title: '任务完成：结果在取景框原地显影、换成作品格子', run: R('image') + `
  const real = __qa.realWhere('image', (a) => a.w > a.h);
  const j = __qa.runJob('image', real.prompt, { params: { aspectRatio: '16:9' }, mine: true }); await __qa.sleep(900);
  const a = __qa.clone(real);
  __qa.m.upsertJob({ ...j, state: 'done', progress: 1, result: [a] }); await __qa.sleep(2600); await __qa.idle();` });
S({ id: 'wall-extreme', title: '极端比例（1:8 / 8:1 夹住）+ 超长时长的视频', run: R('image', `walls: { image: [__qa.asset('image', '很长的竖条', { w: 400, h: 3200 }), __qa.asset('image', '很长的横条', { w: 3200, h: 400 }), ...__qa.base.walls.image.slice(0, 10)], video: [__qa.asset('video', '一段很长的视频', { w: 1920, h: 1080, duration: 5025 }), ...__qa.base.walls.video] }`) + `await __qa.sleep(400);` });
S({ id: 'video-wall-long', title: '视频墙：超长时长签', run: R('video', `walls: { video: [__qa.asset('video', '一段很长的视频', { w: 1920, h: 1080, duration: 5025 }), __qa.asset('video', '竖版短片', { w: 720, h: 1280, duration: 59 }), ...__qa.base.walls.video] }`) + `await __qa.sleep(400);` });
S({ id: 'voice-take-2', title: '配音并卡：切到第二个音色', run: R('voice') + `
  const seg = await __qa.until(() => __qa.find('.sd-page.on .sw-takes'), 4000, '音色分段'); const bs = seg.querySelectorAll('.sw-take'); bs[1]?.click(); await __qa.sleep(500); await __qa.idle();` });
S({ id: 'voice-text-open', title: '配音行点开全文', run: R('voice') + `
  const tx = await __qa.until(() => __qa.find('.sd-page.on .sw-atext'), 4000, '配音文字'); tx.click(); await __qa.sleep(400);` });
S({ id: 'audio-long', title: '音频墙：超长文字 + 超长模型名 + 多人对话音色', run: R('voice', `walls: { voice: [__qa.asset('audio', ${J(LONG_ZH)}, { model: 'gemini-3.1-flash-tts-preview-extra-long-model-id-2026', params: { voice: '主持人=Kore，嘉宾=Puck' }, duration: 125 }), ...__qa.base.walls.voice], music: [__qa.asset('music', 'Instrumental only, no vocals. ' + 'A very long English description of the score that keeps going and going, '.repeat(4), { duration: 3725 }), ...__qa.base.walls.music] }`) + `await __qa.sleep(400);` });
S({ id: 'music-long', title: '音乐墙：超长描述 + 一小时以上时长', run: R('music', `walls: { music: [__qa.asset('music', 'Instrumental only, no vocals. ' + 'A very long English description of the score that keeps going and going, '.repeat(4), { duration: 3725 }), ...__qa.base.walls.music] }`) + `await __qa.sleep(400);` });
S({ id: 'tabs-busy', title: '顶栏种类：视频 / 音乐页有任务在跑（字形上走着一段墨）', run: R('image') + `
  __qa.runJob('video', ${J(PROMPT.video)}); __qa.runJob('music', ${J(PROMPT.music)}); await __qa.sleep(700);` });

// —— 焦点 ——
S({ id: 'focus-image', title: '图像焦点（横图）+ 输入栏「接着改」', run: R('image') + `await __qa.focus(__qa.realWhere('image', (a) => a.w > a.h * 1.2));` });
S({ id: 'focus-image-tall', title: '图像焦点（竖图 9:16）', run: R('image') + `await __qa.focus(__qa.realWhere('image', (a) => a.h > a.w * 1.5));` });
S({ id: 'focus-chain', title: '续改链：版本条三格、看第 2 版', run: R('image') + `
  const r = __qa.realWhere('image', (a) => a.w > a.h); const a1 = __qa.clone(r, { ago: 300000 }); const a2 = __qa.clone(__qa.real('image', 1), { ago: 200000, thread: a1.id }); const a3 = __qa.clone(__qa.real('image', 2), { ago: 100000, thread: a1.id });
  await __qa.focus(a2, { chain: [a1, a2, a3], at: 1 });` });
S({ id: 'focus-chain-dev', title: '续改中：大图盖一层墨、版本条末格在晕', run: R('image') + `
  const a1 = __qa.clone(__qa.real('image', 0), { ago: 300000 }); const a2 = __qa.clone(__qa.real('image', 3), { ago: 200000, thread: a1.id });
  await __qa.focus(a2, { chain: [a1, a2], at: 1, dev: '再把背景换成黄昏' }); await __qa.sleep(900);` });
S({ id: 'focus-chain-err', title: '续改失败：焦点里出失败卡', run: R('image') + `
  const a1 = __qa.clone(__qa.real('image', 0), { ago: 300000 }); const a2 = __qa.clone(__qa.real('image', 4), { ago: 200000, thread: a1.id });
  await __qa.focus(a2, { chain: [a1, a2], at: 1, err: { prompt: '再把背景换成黄昏', error: ${J(LONG_ERR)} } });` });
S({ id: 'focus-longprompt', title: '焦点：超长提示词 + 超长模型名', run: R('image') + `
  await __qa.focus(__qa.clone(__qa.real('image', 5), { prompt: ${J(LONG_ZH)}, model: 'gpt-image-2.6-sunburst-extra-long-preview-edition-2026' }));` });
S({ id: 'focus-video', title: '视频焦点（就地播放控件）', run: R('video') + `await __qa.focus(__qa.realWhere('video', (a) => a.w >= 1280)); await __qa.sleep(600);` });
S({ id: 'focus-more', title: '焦点「…」作品菜单', run: R('image') + `await __qa.focus(__qa.real('image', 6));
  __qa.find('.sd-page.on .sf-acts .sf-b.icon')?.click(); await __qa.sleep(500); await __qa.idle();` });
S({ id: 'focus-continue', title: '焦点「接着做」菜单', run: R('image') + `await __qa.focus(__qa.real('image', 6));
  [...document.querySelectorAll('.sd-page.on .sf-acts .sf-b[aria-haspopup="menu"]')].find((b) => !b.classList.contains('icon'))?.click(); await __qa.sleep(500); await __qa.idle();` });

// —— 托盘（输入栏身后那一条）与单项卡 ——
for (const p of pages) {
  S({ id: `tray-${p}`, title: `${p} 托盘：模型 + 每个基本参数一段（宽屏先收起参数坞）`, run: R(p) + NODOCK });
}
S({ id: 'tray-changed', title: '托盘：改过的段加深加粗、「全部参数」带改动数', run: R('image') + NODOCK + `
  const m = __qa.m.currentModel('image'); __qa.m.setParam('image', 'aspectRatio', '16:9'); __qa.m.setParam('image', 'imageSize', '2K'); __qa.m.setParam('image', 'temperature', 0.4); __qa.m.setParam('image', 'outputFormat', (m.params.find((x) => x.key === 'outputFormat')?.options || [])[1]?.value ?? 'jpeg');
  await __qa.sleep(600); await __qa.idle();`, cleanup: `__qa.m.studio.drafts.image.params = {};` });
S({ id: 'tray-big', title: '托盘：十几个参数的 schema 模型（4 段）', run: R('image') + NODOCK + `__qa.bigModel(); await __qa.sleep(500); await __qa.idle();` });
S({ id: 'tray-size', title: '托盘：自定义尺寸写像素、画质、张数、格式', run: R('image') + NODOCK + `__qa.sizeModel('flex', { width: 3840, height: 2160 }); await __qa.sleep(500); await __qa.idle();` });
S({ id: 'tray-video-toggle', title: '视频托盘：开关段开着（点一下就切）', run: R('video') + NODOCK + `__qa.m.studio.drafts.video.params = { generateAudio: true }; await __qa.sleep(450);` });
S({ id: 'seg-aspect', title: '点比例段：单项卡里墨块格', run: R('image') + NODOCK + SEG('aspectRatio') });
S({ id: 'seg-tier', title: '点分辨率段：一排档位', run: R('image') + NODOCK + SEG('imageSize') });
S({ id: 'seg-aspect-16', title: '16 项比例的单项卡', run: R('image') + NODOCK + `__qa.bigModel(); await __qa.sleep(400);` + SEG('aspect_ratio') });
S({ id: 'seg-size', title: '点尺寸段：取景框 + 比例格 + 档位 + 宽 × 高', run: R('image') + NODOCK + `__qa.sizeModel('flex', { width: 1600, height: 896 }); await __qa.sleep(400);` + SEG('size') });
S({ id: 'seg-count', title: '点张数段：− n +', run: R('image') + NODOCK + `__qa.sizeModel('flex'); await __qa.sleep(400);` + SEG('count') });
S({ id: 'seg-video-dur', title: '视频时长段', run: R('video') + NODOCK + SEG('durationSeconds') });
// 时长 28 项：长枚举，卡里直接是选项列表（直接点那一段；别逐段开关浮层——机器忙时关掉的那层退场动画会卡住，截图健全性核对对不上）
S({ id: 'seg-select', title: '长枚举段：卡里直接是选项列表（Seedance 时长 28 项）', run: R('video') + NODOCK + `await __qa.v3('video', 'seedance'); await __qa.sleep(400);` + SEG('duration') });
S({ id: 'seg-voice', title: '配音页音色段 → 音色列表', run: R('voice') + NODOCK + `
  const b = document.querySelector('.sd-page.on .t-seg[data-seg="voice"]') || document.querySelector('.studio-root .sd-dock-pane.on [data-ctl="voice"] .pl-sel'); b?.click(); await __qa.sleep(900); await __qa.idle();` });

// —— 输入栏 ——
S({ id: 'send-ready', title: '写了字：发送键胀出来', run: R('image') + `__qa.typeText('一只白色的纸鹤停在窗台上'); await __qa.sleep(500); await __qa.idle();` });
S({ id: 'image-longprompt', title: '维护者截图复现：粘贴多行长文 + 一张「改这张图」素材', run: R('image') + `
  __qa.m.addInput('image', { role: 'edit', url: __qa.svg('截图', 1080, 2400), name: 'Screenshot_20261105_230658.jpg', kind: 'image', upload: '1793891304685-x.jpg' });
  await __qa.sleep(60); __qa.typeText(${J(LONG_ZH)}); await __qa.sleep(300); await __qa.idle();` });
S({ id: 'image-longprompt-kb', title: '长文 + 键盘弹起（视口只剩 520 高）', metrics: { height: 520, sab: 0 }, run: R('image') + `
  __qa.m.addInput('image', { role: 'edit', url: __qa.svg('截图', 1080, 2400), name: 'Screenshot.jpg', kind: 'image', upload: 'x.jpg' });
  await __qa.sleep(60); __qa.typeText(${J(LONG_ZH)}); await __qa.sleep(300); await __qa.idle();`, only: (c) => c.touch });
S({ id: 'image-atts', title: '4 份素材（改图 + 2 参考 + 上传中）+ 血缘 + 超长文件名', run: R('image') + `
  const h = __qa.real('image', 0);
  __qa.m.studio.drafts.image.parent = { id: h.id, kind: 'image', thumb: __qa.m.mediaSrc(h, 'thumb'), prompt: h.prompt };
  __qa.m.addInput('image', { role: 'edit', url: __qa.svg('a'), name: '一张名字特别特别长的中文素材图片文件名用来测试截断与省略号.png', kind: 'image', path: '素材/a.png' });
  __qa.m.addInput('image', { role: 'ref', url: __qa.svg('b', 720, 1280), name: 'portrait.jpg', kind: 'image', path: '素材/portrait.jpg' });
  __qa.m.addInput('image', { role: 'ref', url: __qa.svg('c', 1280, 720), name: 'wide.jpg', kind: 'image', asset: 'x1', fromAsset: 'x1' });
  __qa.m.addInput('image', { role: 'ref', url: __qa.svg('d'), name: 'uploading.png', kind: 'image', pending: true });
  await __qa.sleep(60); __qa.typeText('把这几张合成一张海报'); await __qa.sleep(300); await __qa.idle();` });
S({ id: 'focus-atts', title: '焦点开着：素材行最前面「接着改」+ 一张参考图 + 写了字', run: R('image') + `await __qa.focus(__qa.real('image', 7));
  __qa.m.addInput('image', { role: 'ref', url: __qa.svg('ref', 720, 1280), name: 'ref.jpg', kind: 'image', path: '素材/ref.jpg' }); __qa.typeText('把天空换成晚霞'); await __qa.sleep(400); await __qa.idle();` });
S({ id: 'video-frames', title: '视频首尾帧 + 互换钮', run: R('video') + `
  __qa.m.addInput('video', { role: 'first', url: __qa.svg('f'), name: 'first.png', kind: 'image', path: 'a.png' });
  __qa.m.addInput('video', { role: 'last', url: __qa.svg('l'), name: 'last.png', kind: 'image', path: 'b.png' });
  await __qa.sleep(300); await __qa.idle();` });
S({ id: 'voice-audio-ref', title: '配音页参考音频 + 长稿', run: R('voice') + `
  __qa.m.addInput('voice', { role: 'audio', url: '', name: '参考音频-一段很长很长的录音文件名.m4a', kind: 'audio', path: 'a.m4a' });
  __qa.typeText(${J(LONG_ZH)}); await __qa.sleep(300); await __qa.idle();` });
S({ id: 'music-lyria-zh', title: '音乐页 Lyria 2 输入中文（只认英文：发送键淡、底下一句）', run: R('music') + `
  const m = __qa.m.modelsOf('music').find((x) => x.id === 'lyria-002'); if (m) __qa.m.setModel('music', m.key);
  __qa.typeText('温暖的钢琴与弦乐，慢板'); await __qa.sleep(400); await __qa.idle();` });
S({ id: 'long-names', title: '超长模型名 / 服务名（托盘模型钮）', run: R('image') + NODOCK + `
  const c = __qa.m.studio.catalog; __qa.__cat = JSON.stringify(c);
  for (const g of c.kinds.image.groups) { g.provider.name = '一个名字特别特别长的自定义 OpenAI 兼容服务（公司内网 · 测试环境）'; for (const m of g.models) m.label = m.label + ' Extra Long Preview Edition 2026'; }
  __qa.m.studio.catalog = { ...c }; await __qa.sleep(400); await __qa.idle();` });

// —— 全部参数（手机表单 / 平板居中卡 / 宽屏参数坞）——
for (const p of pages) {
  S({ id: `ov-params-${p}`, title: `${p} 全部参数`, run: R(p) + OPEN_PARAMS });
  S({ id: `ov-params-${p}-end`, title: `${p} 全部参数滚到底`, run: R(p) + OPEN_PARAMS + OPEN_MORE + SCROLL_END });
}

// —— 模型选择器 ——
for (const p of pages) {
  S({ id: `ov-model-${p}`, title: `${p} 模型选择器（按厂商分组，同名合一行）`, run: R(p) + `await __qa.click('.sd-page.on .t-model'); await __qa.sleep(500); await __qa.idle();` });
}
S({ id: 'ov-model-long', title: '模型选择器（超长模型名 / 服务名）', run: R('image') + `
  const c = __qa.m.studio.catalog; __qa.__cat = JSON.stringify(c);
  for (const g of c.kinds.image.groups) { g.provider.name = '一个名字特别特别长的自定义 OpenAI 兼容服务（公司内网 · 测试环境）'; for (const m of g.models) m.label = m.label + ' Extra Long Preview Edition 2026'; }
  __qa.m.studio.catalog = { ...c }; await __qa.sleep(200);
  await __qa.click('.sd-page.on .t-model'); await __qa.sleep(500); await __qa.idle();` });

// —— ＋ 添加素材 ——
const PLUS = `await __qa.click('.sd-page.on .cp-plus'); await __qa.sleep(450); await __qa.idle();`;
S({ id: 'ov-add-role', title: '＋ 选素材用处', run: R('image') + PLUS });
S({ id: 'ov-add-source', title: '＋ 选来源（作品 / 工作空间 / 这台设备）', run: R('image') + PLUS + `
  const b = [...document.querySelectorAll('.studio-root .op')].find((x) => !x.disabled && __qa.vis(x)); if (b) { b.click(); await __qa.sleep(350); await __qa.idle(); }` });
// 来源第一项＝作品：手机在表单里翻到作品格子；宽一些的屏素材架进挑选态
S({ id: 'ov-add-works', title: '＋ → 作品（手机：作品格子表单；宽屏：素材架挑选态）', run: R('video') + PLUS + `
  let b = [...document.querySelectorAll('.studio-root .op')].find((x) => !x.disabled && __qa.vis(x) && /首帧|First/i.test(x.textContent)) || [...document.querySelectorAll('.studio-root .op')].find((x) => !x.disabled && __qa.vis(x)); b?.click(); await __qa.sleep(350);
  const src = [...document.querySelectorAll('.studio-root .op')].filter((x) => __qa.vis(x) && !x.disabled); src[0]?.click(); await __qa.sleep(900); await __qa.idle();` });
S({ id: 'ov-wspick', title: '＋ → 工作空间选图', run: R('image') + PLUS + `
  let b = [...document.querySelectorAll('.studio-root .op')].find((x) => !x.disabled && __qa.vis(x)); if (b) { b.click(); await __qa.sleep(350); }
  const src = [...document.querySelectorAll('.studio-root .op')].filter((x) => __qa.vis(x) && !x.disabled); src[1]?.click(); await __qa.sleep(1000);
  const f = [...document.querySelectorAll('.studio-root .op, .studio-root .wp-crumb ~ * button')].find((x) => /素材/.test(x.textContent)); if (f) { f.click(); await __qa.sleep(1000); } await __qa.idle();` });

// —— 素材架 ——
S({ id: 'shelf', title: '素材架打开（宽屏展开三列小墙 / 平板手机抽屉）', run: R('image') + `await __qa.shelf(true);` });
S({ id: 'shelf-search', title: '素材架搜索（没有结果）', run: R('image') + `await __qa.shelf(true);
  document.querySelector('.studio-root .sd-shelf-gap ~ .sd-ib')?.click(); await __qa.sleep(250);
  const q = document.querySelector('.studio-root .sd-shelf-q input'); if (q) { q.value = '一个肯定搜不到的很长很长的关键词'; q.dispatchEvent(new Event('input', { bubbles: true })); } await __qa.sleep(900); await __qa.idle();`,
  cleanup: `__qa.m.studio.q = ''; __qa.m.loadAssets(true);` });
S({ id: 'shelf-files', title: '素材架「文件」分段', run: R('image') + `await __qa.shelf(true);
  document.querySelectorAll('.studio-root .sd-shelf-seg button[role=tab]')[1]?.click(); await __qa.sleep(1600); await __qa.idle();` });
S({ id: 'shelf-pick', title: '挑选态：选一张当首帧（能用的实、其余淡）', run: R('video') + `__qa.m.startPick('video', 'first'); await __qa.sleep(500); await __qa.idle();` });
S({ id: 'shelf-empty', title: '素材架没有作品', run: R('image', 'empty: true') + `await __qa.shelf(true);` });
S({ id: 'shelf-collapsed', title: '宽屏素材架收着（64 的一条小格子 + 文件夹钮）', only: (c) => c.w >= 1000, run: R('voice') + `await __qa.sleep(300);` });
S({ id: 'shelf-menu', title: '素材架格子右键 / 长按：作品菜单', run: R('image') + `await __qa.shelf(true);
  __qa.ctx(__qa.find('.studio-root .sd-shelf .sd-tile')); await __qa.sleep(550); await __qa.idle();` });

// —— 作品菜单 ——
S({ id: 'wall-menu', title: '作品墙格子右键 / 长按：作品菜单', run: R('image') + `__qa.ctx(__qa.find('.sd-page.on .sw-tile')); await __qa.sleep(550); await __qa.idle();` });
S({ id: 'wall-menu-last', title: '作品墙最下面一格的菜单（往上翻、不出屏）', run: R('image') + `
  const sc = document.querySelector('.sd-page.on .sw-scroll'); sc.scrollTop = sc.scrollHeight; await __qa.sleep(400);
  const tiles = [...document.querySelectorAll('.sd-page.on .sw-tile')].filter((x) => { const r = x.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight * 0.75; });
  __qa.ctx(tiles[tiles.length - 1]); await __qa.sleep(550); await __qa.idle();` });
S({ id: 'wall-menu-audio', title: '配音行右键 / 长按：作品菜单', run: R('voice') + `__qa.ctx(__qa.find('.sd-page.on .sw-arow')); await __qa.sleep(550); await __qa.idle();` });

// —— 落点托盘 ——
S({ id: 'droptray-files', title: '落点托盘（从系统拖文件进来）', run: R('image') + `
  const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
  __qa.page().querySelector('.cf').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await __qa.sleep(400);`, cleanup: `__qa.page()?.querySelector('.cf')?.dispatchEvent(new DragEvent('drop', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }));` });
S({ id: 'droptray-video', title: '落点托盘（拖作品进视频页：首帧 / 尾帧 / 参考图，按模型置灰）', run: R('video') + `
  const a = __qa.real('image', 0);
  const cp = __qa.page().querySelector('.cp').getBoundingClientRect();
  __qa.dnd.beginDrag(__qa.sdrag.assetPayload(a), { x: cp.left + 40, y: cp.top - 120, pointerId: 7, pointerType: 'mouse', ghost: { name: __qa.adrag.ghostName(a), thumb: __qa.m.mediaSrc(a, 'thumb') } });
  await __qa.sleep(80);
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: cp.left + 60, clientY: cp.top + 20, pointerId: 7, pointerType: 'mouse', bubbles: true }));
  await __qa.sleep(450);`, cleanup: `try { __qa.dnd.cancelDrag(); } catch {}` });

// —— v3（方案 §9.2 / §9.3）：自动识别出来的模型与参数 ——
// 样例目录来自后端会话（catalog-v3.sample.json：真目录跑真代码生成）；bigModel 是十几个参数 + 42 项长枚举 + 超长英文标签的 schema 模型。
S({ id: 'v3-many-params', title: '十几个参数的 schema 模型（参数坞 / 表单）', run: R('image') + `__qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS}` });
S({ id: 'v3-many-params-open', title: '十几个参数：展开「更多」', run: R('image') + `__qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE}` });
S({ id: 'v3-many-params-mid', title: '十几个参数：滚到中段（长英文标签、开关、滑条）', run: R('image') + `__qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE}
  const row = document.querySelector('.studio-root [data-param="safety_tolerance"]'); __qa.scrollTo(row, 'start'); await __qa.sleep(250);` });
S({ id: 'v3-many-params-end', title: '十几个参数：滚到底（原始参数）', run: R('image') + `__qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE} ${SCROLL_END}` });
S({ id: 'v3-long-enum', title: '42 项长枚举的选项菜单（带搜索）', run: R('image') + `__qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE}
  const b = document.querySelector('.studio-root [data-param="style_preset"] .pl-sel'); __qa.scrollTo(b, 'center'); await __qa.sleep(150); b?.click(); await __qa.sleep(600); await __qa.idle();` });
S({ id: 'v3-long-enum-search', title: '长枚举菜单里搜「photo」', run: R('image') + `__qa.bigModel(); await __qa.sleep(300); ${OPEN_PARAMS} ${OPEN_MORE}
  const b = document.querySelector('.studio-root [data-param="style_preset"] .pl-sel'); __qa.scrollTo(b, 'center'); await __qa.sleep(150); b?.click(); await __qa.sleep(500);
  const q = [...document.querySelectorAll('.studio-root :is(.pv, .sh) .op-q input')].pop(); if (q) { q.value = 'photo'; q.dispatchEvent(new Event('input', { bubbles: true })); } await __qa.sleep(350); await __qa.idle();` });
S({ id: 'v3-picker', title: '模型选择器：样例目录（服务分组、厂商小组、新模型朱点、参数来源、搜索框）', run: R('image') + `await __qa.v3('image', 'grok-imagine'); await __qa.click('.sd-page.on .t-model'); await __qa.sleep(600); await __qa.idle();` });
S({ id: 'v3-picker-search', title: '模型选择器搜「flux」（连备选一起搜）', run: R('image') + `await __qa.v3('image'); await __qa.click('.sd-page.on .t-model'); await __qa.sleep(500);
  const q = document.querySelector('.studio-root .mp-q input'); if (q) { q.value = 'flux'; q.dispatchEvent(new Event('input', { bubbles: true })); } await __qa.sleep(400); await __qa.idle();` });
S({ id: 'v3-picker-video', title: '视频模型选择器（直连 + 聚合 + 通用卡 + 继承卡）', run: R('video') + `await __qa.v3('video', 'omni-1.3'); await __qa.click('.sd-page.on .t-model'); await __qa.sleep(600); await __qa.idle();` });
S({ id: 'v3-schema-image', title: 'OpenRouter schema 卡（14 项比例）参数', run: R('image') + `await __qa.v3('image', 'grok-imagine'); ${OPEN_PARAMS}` });
S({ id: 'v3-family', title: '继承 + 精修卡（Omni 1.3：沿用 1.2、时长 3–20）', run: R('video') + `await __qa.v3('video', 'omni-1.3'); ${OPEN_PARAMS}` });
S({ id: 'v3-seedance', title: 'Seedance 参考生视频：参考图 + 参考视频 + 参考音频素材', run: R('video') + `await __qa.v3('video', 'seedance');
  const v = __qa.real('video', 0);
  __qa.m.addInput('video', { role: 'ref', url: __qa.svg('r'), name: 'ref.png', kind: 'image', path: 'r.png' });
  if (v) __qa.m.addInput('video', { role: 'video', asset: v.id, url: __qa.m.mediaSrc(v, 'thumb'), name: v.prompt, kind: 'video', fromAsset: v.id });
  __qa.m.addInput('video', { role: 'audio', url: '', name: '一段很长很长的参考音频文件名.m4a', kind: 'audio', path: 'a.m4a' });
  __qa.typeText('让镜头跟着参考视频的运镜走，配上参考音频的节奏'); await __qa.sleep(400); await __qa.idle();` });
S({ id: 'v3-seedance-params', title: 'Seedance 参数滚到底', run: R('video') + `await __qa.v3('video', 'seedance'); ${OPEN_PARAMS} ${SCROLL_END}` });
S({ id: 'v3-tts', title: 'fal ElevenLabs v4：输出格式 19 项、音色 21 项', run: R('voice') + `await __qa.v3('voice', 'eleven-v4'); ${OPEN_PARAMS}` });
S({ id: 'v3-tts-tray', title: 'fal ElevenLabs v4 托盘（宽屏先收起参数坞）', run: R('voice') + NODOCK + `await __qa.v3('voice', 'eleven-v4'); await __qa.sleep(300); await __qa.idle();` });
S({ id: 'v3-generic', title: '通用卡（只有原始参数）', run: R('video') + `await __qa.v3('video', 'unknown-video'); ${OPEN_PARAMS}` });
S({ id: 'v3-shelf-picked', title: '选了一个备选模型（按需取回完整卡）', run: R('image') + `await __qa.v3('image');
  const g = __qa.m.studio.catalog.kinds.image.groups.find((x) => (x.shelf || []).length); const sm = g.shelf[0];
  __qa.m.studio.resolved = { [sm.key]: { ...sm, shelf: undefined, inputs: { text: true }, paramSource: 'schema', params: g.models.find((m) => (m.params || []).length > 3)?.params || [] } };
  __qa.m.studio.drafts.image.model = sm.key; await __qa.sleep(300); await __qa.click('.sd-page.on .t-model'); await __qa.sleep(600); await __qa.idle();` });

// —— 尺寸参数（方案 §10 / §12.4：取景框 + 比例格 + 档位 + 宽 × 高）——
const SIZE_EDIT = `await __qa.sleep(300); __qa.m.addInput('image', { role: 'edit', url: __qa.svg('原图', 1920, 1080), name: 'IMG_20261115_0930.jpg', kind: 'image', upload: 'x.jpg', w: 1920, h: 1080 }); await __qa.sleep(600);`;
const SIZE_ROW = `{ const q = '.studio-root .pl-r[data-param="size"] .sg';
  try { await __qa.until(() => __qa.find(q), 6000, q); } catch { ${OPEN_PARAMS} } }`;
const SIZE_PICK = `${SIZE_ROW} { const row = __qa.find('.studio-root .pl-r[data-param="size"]');
  [...row.querySelectorAll('.sg-o')].find((b) => /16:9/.test(b.textContent))?.click(); await __qa.sleep(250);
  [...row.querySelectorAll('.sg-o')].find((b) => /^\\s*2K\\s*$/.test(b.textContent))?.click(); await __qa.sleep(400); await __qa.idle(); }`;
S({ id: 'size-flex', title: '自由尺寸模型的参数（尺寸 = 自动：取景框写「自动」、档位淡）', run: R('image') + `__qa.sizeModel('flex'); await __qa.sleep(300); ${OPEN_PARAMS}` });
S({ id: 'size-menu', title: '尺寸：点比例 16:9 × 2K（换算成 2048×1152，行上出「恢复默认」）', run: R('image') + `__qa.sizeModel('flex'); await __qa.sleep(300); ${OPEN_PARAMS} ${SIZE_PICK}` });
S({ id: 'size-original-menu', title: '挂了改图素材：尺寸默认「原图」', run: R('image') + `__qa.sizeModel('flex'); ${SIZE_EDIT} ${OPEN_PARAMS} ${SIZE_ROW}` });
S({ id: 'size-custom', title: '自定义宽 × 高（合规）', run: R('image') + `__qa.sizeModel('flex', { width: 2048, height: 1152 }); await __qa.sleep(300); ${OPEN_PARAMS}` });
S({ id: 'size-custom-bad', title: '自定义宽 × 高不合规：两框描红 + 一行红字', run: R('image') + `__qa.sizeModel('flex', { width: 3999, height: 1001 }); await __qa.sleep(300); ${OPEN_PARAMS}` });
S({ id: 'size-split', title: '拆字段卡：比例选 custom 才出宽 × 高（没有档位）', run: R('image') + `__qa.sizeModel('split'); await __qa.sleep(300); ${OPEN_PARAMS}` });
S({ id: 'p11-gif', title: '格式选 GIF：帧数 / 每帧时长跟着出现，透明背景不可选', run: R('image') + `__qa.sizeModel('flex'); __qa.m.studio.drafts.image.params = { outputFormat: 'gif', count: 3, quality: 'low' }; await __qa.sleep(300); ${OPEN_PARAMS} ${SCROLL_END}` });
S({ id: 'p11-jpeg-end', title: '格式选 JPEG：压缩质量滑条 + 数字框；滚到底（全部恢复默认）', run: R('image') + `__qa.sizeModel('flex', { width: 2048, height: 1152 }); Object.assign(__qa.m.studio.drafts.image.params, { outputFormat: 'jpeg', outputCompression: 80, moderation: 'low', complexity: 'medium' }); await __qa.sleep(300); ${OPEN_PARAMS} ${SCROLL_END}` });
S({ id: 'p11-voice', title: '配音参数：风格候选词小块', run: R('voice') + OPEN_PARAMS });

// —— 设置 › Media Studio（手机 / 网页那套 iOS 外壳；桌面壳那套在 desk 档里跑）——
// 只按结构找按钮（.sst 是 Studio 设置正文的根，两套外壳都有），不按文案，英文档同样能跑。
const SET_WAIT = `await __qa.until(() => { const r = document.querySelector('.sst'); return r && __qa.vis(r) && r.querySelectorAll('button').length > 4; }, 9000, '设置 › Media Studio'); await __qa.sleep(700);`;
const SET_OPEN = `await __qa.reset(); __qa.nav.openSettings('studio'); ${SET_WAIT}`;
// 收尾：服务管理器 / 保存位置浮层点它自己的关闭钮（别手动删 Svelte 管的节点），再关设置
const SET_CLOSE = `for (let i = 0; i < 4 && document.querySelector('.sst-layer'); i++) { const bs = document.querySelectorAll('.sst-layer header .hbtn, .sst-layer [aria-label="关闭"], .sst-layer [aria-label="Close"]'); bs[bs.length - 1]?.click(); await __qa.sleep(250); }
  __qa.st.ui.settingsOpen = false; await __qa.sleep(300);`;
const PROV = `[...document.querySelectorAll('.sst button.r, .sst button.drow')].find((x) => /Google Vertex AI/.test(x.textContent) && __qa.vis(x))`;
// 设置入口：顶栏右边的齿轮
S({ id: 'set-gear', title: '顶栏齿轮 → 设置 › Media Studio', run: R('image') + `document.querySelector('.studio-root .sd-cbar-r .sd-ib')?.click(); ${SET_WAIT} await __qa.stable('.pg.top');`, cleanup: SET_CLOSE });
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
