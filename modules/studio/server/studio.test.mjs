// Media Studio 后端（方案 §3）：服务注册表、模型卡（Google 系与旧路由逐项一致）、目录、任务执行器、作品、设置、旧接口转接、
// Claude 工具描述。数据根改道到临时目录（核心 config 导入时就读数据根，所以先设环境变量再动态 import）。
// 真正的上游一律不打：方言适配器的 run 在测试里换成假的（返回一张内存里的 PNG）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';
process.env.BRIDGE_VERTEX_RELAY = '';
process.env.BRIDGE_MODULES_SKIP = 'codex,dimensio';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  port: 18997, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'), features: { multiUser: true },
  vertexHost: { claudeProactive: false, safetyHate: 'low' },
}, null, 2));

await (await import('@bridge/core/modules/registry.mjs')).loadModules();   // studio 扩展加载了，studio 这个 agent 才算可用
const P = await import('./providers.mjs');
const { cardFor } = await import('./cards/index.mjs');
const { googleCard } = await import('./cards/google.mjs');
const { applySpecs } = await import('./cards/spec.mjs');
const catalogMod = await import('./catalog.mjs');
const jobs = await import('./jobs.mjs');
const { adapterFor } = await import('./adapters/index.mjs');
const assets = await import('./assets.mjs');
const settings = await import('@bridge/core/runtime/studio-settings.mjs');
const vsettings = await import('@bridge/core/runtime/vertex-settings.mjs');
const media = await import('@bridge/core/vertex-media.mjs');
const { contextFor, userIdentity } = await import('@bridge/core/runtime/identity.mjs');
const users = await import('@bridge/core/users.mjs');
const { busSubscribe } = await import('@bridge/core/runtime/bus.mjs');
const caps = await import('@bridge/core/config/capabilities.mjs');
const { buildMediaTools, belowSize } = await import('./mcp/media-tools.mjs');
const { resultText: phoneResultText } = await import('./mcp/media-phone.mjs');

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const admin = contextFor({ kind: 'admin' });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('设置：首次照抄 vertexHost 的老值（含安全四键）；写入落 studioHost；老出口读写同一份；个人值压过主机值', () => {
  const h = settings.getStudioHostSettings();
  assert.equal(h.claudeProactive, false);
  assert.equal(h.safetyHate, 'low');
  assert.deepEqual(vsettings.vertexSafetySettings(), [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' }]);
  assert.equal(settings.setStudioHostSettings({ saveDir: '../x' }).ok, false, '保存位置不许越界');
  assert.equal(settings.setStudioHostSettings({ autoSave: true, saveDir: 'Media Studio/作品' }).ok, true);
  const cfg = JSON.parse(readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.studioHost, { claudeProactive: false, safetyHate: 'low', saveDir: 'Media Studio/作品' });
  assert.deepEqual(cfg.vertexHost, { claudeProactive: false, safetyHate: 'low' }, '老值原样留着（回滚旧版时还在）');
  assert.equal(vsettings.setVertexSettings({ claudeProactive: null }).ok, true);
  assert.equal(settings.getStudioHostSettings().claudeProactive, true);
  assert.equal(vsettings.setVertexSettings({ saveDir: 'x' }).ok, false, '老出口只认原来那几组');
  assert.equal(settings.setStudioMineSettings('admin', { claudeMedia: false }).ok, false, '个人不能改主机级项');
  assert.equal(settings.setStudioMineSettings('admin', { saveDir: '我的' }).ok, true);
  assert.equal(settings.effectiveStudioSettings('admin').saveDir, '我的');
  settings.setStudioMineSettings('admin', { saveDir: null });
});

test('服务注册表：Key / 服务账号只进加密存储；成员限制（本机、ADC、共享、上限）；共享服务成员看得到名字看不到地址', async () => {
  const p = P.createProvider({ preset: 'openrouter', dialect: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-secret-123456', shared: true,
    models: [{ id: 'openai/gpt-image-2.5-sunburst', kind: 'image', source: 'builtin' }] }, 'admin');
  assert.equal(p.hasKey, true); assert.equal(p.keyTail, '3456');
  const raw = readFileSync(path.join(tmp, 'studio-providers', 'providers.json'), 'utf8');
  assert.ok(!raw.includes('sk-or-secret'), 'Key 不进明文 json');
  assert.ok(existsSync(path.join(tmp, 'studio-providers', 'connector-secrets.json')));
  assert.throws(() => P.createProvider({ dialect: 'openai', baseUrl: 'https://x.example/v1', models: [{ id: 'm', kind: 'music' }] }, 'admin'), /不能做/);
  assert.throws(() => P.createProvider({ dialect: 'vertex', models: [], serviceAccount: '{"type":"authorized_user"}' }, 'admin'), /服务账号/);
  const sa = JSON.stringify({ type: 'service_account', client_email: 'a@b.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n', project_id: 'proj-1' });
  const v = P.createProvider({ dialect: 'vertex', google: { credMode: 'json' }, serviceAccount: sa, models: [{ id: 'gemini-3.1-flash-image', kind: 'image' }] }, 'admin');
  assert.equal(v.hasServiceAccount, true); assert.equal(v.saEmail, 'a@b.iam.gserviceaccount.com'); assert.equal(v.saProject, 'proj-1');
  // 成员
  const m = 'u:bob';
  assert.throws(() => P.createProvider({ dialect: 'local', models: [] }, m), /本机模型/);
  assert.throws(() => P.createProvider({ dialect: 'vertex', google: { credMode: 'adc' }, models: [] }, m), /自己的服务账号/);
  const mine = P.createProvider({ dialect: 'openai', baseUrl: 'https://api.openai.com/v1', shared: true, models: [] }, m);
  assert.equal(mine.shared, false, '成员不能共享');
  assert.equal(P.findProvider(p.id, m).id, p.id, '共享的找得到');
  assert.equal(P.getProvider(p.id, m), null, '改 / 删 / 测试够不着');
  assert.deepEqual(Object.keys(P.sharedProvidersView(m)[0]).sort(), ['dialect', 'enabled', 'id', 'models', 'name', 'note', 'preset']);
  assert.equal(P.findProvider(v.id, m), null, '没共享的成员看不到');
  P.deleteProvider(mine.id, m); P.deleteProvider(v.id, 'admin');
});

test('Google 模型卡：参数矩阵与 capabilities 一致，规范化与旧路由的夹紧逐项相同', () => {
  // 图像：超宽比例只 2.1 认、lite 只 1K、不认的尺寸落到最大档、思考 / 搜索按模型门控、人物生成 dev 通道不给
  const lite = googleCard('vertex', 'gemini-3.1-flash-lite-image');
  assert.deepEqual(lite.params.find((s) => s.key === 'imageSize').options.map((o) => o.value), ['', '1K']);
  assert.equal(lite.normalize({ imageSize: '4K' }).imageSize, '1K');
  assert.equal(lite.normalize({ aspectRatio: '4:1' }).aspectRatio, 'auto');
  const nb21 = googleCard('vertex', 'gemini-nano-banana-2.1');
  assert.equal(nb21.normalize({ aspectRatio: '4:1' }).aspectRatio, '4:1');
  assert.deepEqual(nb21.params.find((s) => s.key === 'personGeneration').when, { imageSize: ['', '1K'] });
  assert.equal(googleCard('gemini', 'gemini-nano-banana-2.1').params.some((s) => s.key === 'personGeneration'), false);
  const pro = googleCard('vertex', 'gemini-3-pro-image');
  const n = pro.normalize({ thinkingLevel: 'high', useImageSearch: true, useSearch: true, temperature: 9, topP: -1, personGeneration: 'DONT_ALLOW', imageSize: 'zz' });
  assert.equal(n.thinkingLevel, undefined, 'Pro 不支持思考');
  assert.equal(n.useImageSearch, false); assert.equal(n.useSearch, true);
  assert.equal(n.temperature, 2); assert.equal(n.topP, 0);
  assert.equal(n.personGeneration, undefined, 'Imagen 那套枚举不认');
  assert.equal(n.imageSize, undefined, '没给 / 不认的尺寸不传');
  for (const id of caps.CAPABILITIES.image.models.map((x) => x.id).filter((x) => x.startsWith('gemini-'))) {
    const c = googleCard('vertex', id);
    for (const a of caps.CAPABILITIES.image.aspects.map((x) => x.id)) assert.equal(c.normalize({ aspectRatio: a }).aspectRatio, caps.imgAspectFor(id, a));
    for (const s of ['1K', '2K', '4K', 'x', undefined]) assert.equal(c.normalize({ imageSize: s }).imageSize, caps.imgSizeClamp(id, caps.IMAGE_SIZES.has(s) ? s : undefined));
  }
  // 视频：时长取最近档、分辨率落 720p 或最高、Veo 专属三件 Omni 一律不传
  const veo = googleCard('vertex', 'veo-3.1-fast-generate-001');
  assert.deepEqual(veo.normalize({ durationSeconds: 3, resolution: '360p', aspectRatio: '1:1', enhancePrompt: false, compressionQuality: 'LOSSLESS' }),
    { aspectRatio: 'auto', resolution: '720p', durationSeconds: 4, generateAudio: false, enhancePrompt: false, compressionQuality: 'LOSSLESS' });
  assert.equal(veo.negative('  不要文字  '), '不要文字');
  const omni = googleCard('gemini', 'gemini-omni-1.1-flash');
  assert.deepEqual(omni.normalize({ durationSeconds: 3, resolution: '360p', enhancePrompt: false, compressionQuality: 'LOSSLESS' }),
    { aspectRatio: 'auto', resolution: '360p', durationSeconds: 3, generateAudio: false });
  assert.equal(omni.negative('x'), '');
  assert.equal(omni.params.some((s) => s.key === 'generateAudio'), false, 'Omni 音频恒开，不给开关');
  // 配音：音色白名单、多人对白两种写法
  const tts = googleCard('vertex', 'gemini-2.5-flash-tts');
  assert.equal(tts.normalize({ voice: 'Nope' }).voice, 'Kore');
  assert.deepEqual(tts.normalize({ speakerA: '甲', voiceA: 'Puck', speakerB: '乙', voiceB: 'Zephyr' }).speakers, [{ speaker: '甲', voice: 'Puck' }, { speaker: '乙', voice: 'Zephyr' }]);
  assert.equal(tts.normalize({ speakers: [{ speaker: '甲', voice: 'Puck' }] }).speakers, undefined, '不足 2 人退回单人');
  // 音乐：负面提示词只 lyria-002 吃
  assert.equal(googleCard('vertex', 'lyria-002').negative('drums'), 'drums');
  assert.equal(googleCard('gemini', 'lyria-3.5').negative('drums'), '');
  // 只认英文提示词的模型：inputs.promptLang（前端据此拦中文输入）；不限的不带
  assert.equal(googleCard('vertex', 'lyria-002').inputs.promptLang, 'en');
  assert.equal('promptLang' in googleCard('gemini', 'lyria-3.5').inputs, false);
});

test('通用卡与 ParamSpec 规范化：不认的键丢掉、enum 回落默认、数字夹紧、when 不满足丢掉、extra 解析 JSON', () => {
  const card = cardFor({ dialect: 'fal' }, { id: 'someone/new-model', kind: 'image' });
  assert.equal(card.generic, true);
  assert.ok(card.params.some((s) => s.key === 'extra' && s.type === 'json'));
  const out = applySpecs(card.params, { aspectRatio: 'weird', bogus: 1, extra: '{"num_inference_steps": 8}' });
  assert.deepEqual(out, { aspectRatio: 'auto', extra: { num_inference_steps: 8 } });
  assert.throws(() => applySpecs(card.params, { extra: '[1]' }), /JSON 对象/);
  const specs = [{ key: 'size', type: 'enum', options: [{ value: 'a' }, { value: 'custom' }], default: 'a' }, { key: 'w', type: 'number', min: 1, max: 10, when: { size: 'custom' } }];
  assert.deepEqual(applySpecs(specs, { w: 50 }), { size: 'a' });
  assert.deepEqual(applySpecs(specs, { size: 'custom', w: 50 }), { size: 'custom', w: 10 });
});

// —— 目录与任务：用一个 OpenRouter 服务 + 假 run ——
const OR = adapterFor('openrouter');
const realRun = OR.run;
let lastReq = null, delay = 0, failWith = null;
OR.run = async (req, provider, ctx) => {
  lastReq = req;
  if (delay) { ctx.submitted(); await new Promise((r, j) => { const t = setTimeout(r, delay); ctx.signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); }); }
  if (failWith) throw failWith;
  return { assets: [{ bytes: PNG, mime: 'image/png', meta: { signature: 'sig-1' } }] };
};
test.after(() => { OR.run = realRun; });

test('目录：按种类分组、默认模型（设置 > 内置默认 > 第一个）、裸 id 解析到对应方言', () => {
  const cat = catalogMod.catalog('admin');
  const g = cat.kinds.image.groups.find((x) => x.provider.dialect === 'openrouter');
  assert.ok(g && g.models[0].key.endsWith('/openai/gpt-image-2.5-sunburst'));
  assert.equal(g.models[0].label, 'GPT Image 2.5 Sunburst');
  assert.ok(g.models[0].params.some((s) => s.key === 'quality'));
  assert.equal(cat.kinds.image.defaults.model, 'openai/gpt-image-2.5-sunburst', '没有 Google 服务：落到第一个能用的');
  const bare = catalogMod.resolveBare('gpt-image-2.5-sunburst', 'image', 'admin');
  assert.equal(bare.provider.dialect, 'openrouter'); assert.equal(bare.entry.id, 'openai/gpt-image-2.5-sunburst');
  assert.equal(catalogMod.resolveBare('veo-3.1-fast-generate-001', 'video', 'admin'), null, '没有 Vertex 服务');
  assert.ok(catalogMod.resolveBare('gpt-image-2.5-sunburst', 'image', 'u:bob'), '成员也能用管理员共享的');
});

test('任务：跑完存进媒体库（侧车带 provider / params / parents / jobId）、自动存进工作空间、总线推平铺的 studio.job', async () => {
  const seen = [];
  busSubscribe('admin', { write: (s) => { const m = /data: (.*)/.exec(String(s)); if (m) { try { seen.push(JSON.parse(m[1])); } catch {} } return true; }, on() {}, once() {}, writableEnded: false, destroyed: false });
  const key = catalogMod.catalog('admin').kinds.image.defaults;
  const parentId = media.newId();
  media.save(parentId, PNG, 'png', { kind: 'image', prompt: 'parent' });
  const { job, done } = jobs.startJob(admin, { kind: 'image', key: key.provider + '/' + key.model, prompt: '一只纸船', params: { quality: 'low', imageSize: '1K', junk: 1 }, inputs: [{ role: 'edit', asset: parentId }] });
  assert.equal(job.state, 'queued');
  assert.deepEqual(job.params, { aspectRatio: 'auto', imageSize: '1K', quality: 'low' });
  const fin = await done;
  assert.equal(fin.state, 'done');
  assert.equal(lastReq.inputs[0].role, 'edit'); assert.equal(lastReq.inputs[0].mime, 'image/png');
  const a = fin.result[0];
  assert.equal(a.kind, 'image'); assert.equal(a.url, '/api/vertex/media?id=' + a.id); assert.ok(a.thumb);
  assert.deepEqual(a.parents, [parentId]);
  assert.equal(a.w, 1); assert.equal(a.h, 1);
  assert.match(a.wsPath, /^Media Studio\/作品\/图像\/\d{8}-\d{6}-一只纸船\.png$/);
  assert.ok(existsSync(path.join(tmp, 'vault', ...a.wsPath.split('/'))));
  const rec = media.get(a.id);
  assert.equal(rec.provider, key.provider); assert.equal(rec.jobId, job.id); assert.equal(rec.signature, 'sig-1'); assert.equal(rec.wsPath, a.wsPath);
  await wait(20);
  const evs = seen.filter((e) => e.type === 'studio.job' && e.id === job.id);
  assert.ok(evs.some((e) => e.state === 'running'));
  const last = evs[evs.length - 1];
  assert.equal(last.state, 'done'); assert.equal(last.result[0].id, a.id); assert.equal(last.job, undefined, '平铺，不包一层');
  // 列表与查询
  assert.equal(jobs.getJob('admin', job.id).state, 'done');
  assert.ok(jobs.listJobs('admin', { active: true }).jobs.some((j) => j.id === job.id));
  assert.equal(jobs.getJob('u:bob', job.id), null, '别人的任务看不到');
  // 落盘
  await wait(600);
  assert.ok(readFileSync(path.join(tmp, 'studio-providers', 'jobs.json'), 'utf8').includes(job.id));
});

test('任务：素材路径过守卫；不收的角色 / 太多张拒；空描述拒；找不到模型给人话', async () => {
  writeFileSync(path.join(tmp, 'vault', 'a.png'), PNG);
  const key = catalogMod.catalog('admin').kinds.image.defaults;
  const k = key.provider + '/' + key.model;
  assert.throws(() => jobs.startJob(admin, { kind: 'image', key: k, prompt: 'x', inputs: [{ role: 'edit', path: '../../etc/passwd' }] }), /越界|不存在/);
  assert.throws(() => jobs.startJob(admin, { kind: 'image', key: k, prompt: 'x', inputs: [{ role: 'first', path: 'a.png' }] }), /不收/);
  assert.throws(() => jobs.startJob(admin, { kind: 'image', key: k, prompt: '', inputs: [] }), /空的/);
  assert.throws(() => jobs.startJob(admin, { kind: 'image', key: 'p-00000000/x', prompt: 'x' }), /找不到可用的模型/);
  assert.throws(() => jobs.startJob(admin, { kind: 'sound', prompt: 'x' }), /kind/);
  const ok = jobs.startJob(admin, { kind: 'image', key: k, prompt: 'x', inputs: [{ role: 'ref', path: 'a.png' }] });
  assert.equal((await ok.done).state, 'done');
});

test('任务：本机上传的素材——uploads 相对名、本人 uploads 里的绝对路径（反斜杠 / 正斜杠）都收；越界的拒', async () => {
  // 2026-11-05 真机翻车：/api/upload 回的是绝对路径，前端原样塞进 upload，safeJoin 去掉盘符后拼成 uploads/Users/…/uploads/x，全报「素材文件不存在」
  mkdirSync(admin.uploads, { recursive: true });
  const name = Date.now() + '-手机照片 1.png';
  const abs = path.join(admin.uploads, name);
  writeFileSync(abs, PNG);
  const key = catalogMod.catalog('admin').kinds.image.defaults;
  const k = key.provider + '/' + key.model;
  const fwd = abs.split(path.sep).join('/');
  for (const upload of [name, abs, fwd]) {
    assert.deepEqual(jobs.uploadFile(admin, upload), { abs, rel: name }, upload);
    const r = jobs.startJob(admin, { kind: 'image', key: k, prompt: '改这张', inputs: [{ role: 'edit', upload }] });
    assert.equal(r.job.inputs[0].upload, name, '任务记录里只留相对名，不回服务器路径');
    const fin = await r.done;
    assert.equal(fin.state, 'done', upload);
    assert.equal(lastReq.inputs[0].role, 'edit'); assert.equal(lastReq.inputs[0].mime, 'image/png');
  }
  // 越界：uploads 外的绝对路径（含盘符写法）、uploads 根本身、空；相对路径里的 .. 被剥掉、穿不出去
  const outside = path.join(tmp, 'vault', 'a.png');
  assert.equal(jobs.uploadFile(admin, outside), null);
  assert.equal(jobs.uploadFile(admin, outside.split(path.sep).join('/')), null);
  assert.equal(jobs.uploadFile(admin, admin.uploads), null);
  assert.equal(jobs.uploadFile(admin, ''), null);
  assert.equal(jobs.uploadFile(admin, path.resolve(admin.uploads) + '-evil' + path.sep + 'x.png'), null, '同前缀的兄弟目录不算');
  assert.ok(jobs.uploadFile(admin, '../../config.json').abs.startsWith(path.resolve(admin.uploads) + path.sep));
  assert.throws(() => jobs.startJob(admin, { kind: 'image', key: k, prompt: 'x', inputs: [{ role: 'edit', upload: outside }] }), /越界/);
  assert.throws(() => jobs.startJob(admin, { kind: 'image', key: k, prompt: 'x', inputs: [{ role: 'edit', upload: '../../config.json' }] }), /不存在/);
  if (process.platform === 'win32') assert.equal(jobs.uploadFile(admin, 'Z:\\elsewhere\\uploads\\' + name), null, '别的盘');
});

test('任务：续改链带上一张出图与签名；取消——没发出去直接停，发出去的标「已放弃（仍可能计费）」', async () => {
  const key = catalogMod.catalog('admin').kinds.image.defaults;
  const k = key.provider + '/' + key.model;
  const first = await jobs.startJob(admin, { kind: 'image', key: k, prompt: '第一张' }).done;
  const thread = first.result[0].id;
  const second = await jobs.startJob(admin, { kind: 'image', key: k, prompt: '改成蓝色', thread }).done;
  assert.equal(lastReq.thread.turns.length, 1);
  assert.equal(lastReq.thread.turns[0].signature, 'sig-1');
  assert.equal(second.result[0].thread, thread);
  assert.deepEqual(media.loadImageChat(thread).turns.map((t) => t.userText), ['第一张', '改成蓝色']);
  delay = 5000;
  try {
    const { job, done } = jobs.startJob(admin, { kind: 'image', key: k, prompt: '慢的' });
    await wait(30);
    const c = jobs.cancelJob('admin', job.id);
    assert.equal(c.state, 'canceled');
    assert.equal(c.note, '已放弃（仍可能计费）');
    assert.equal((await done).state, 'canceled');
  } finally { delay = 0; }
  failWith = Object.assign(new Error('OpenRouter 400：bad size'), { status: 400 });
  try {
    const r = await jobs.startJob(admin, { kind: 'image', key: k, prompt: '会失败' }).done;
    assert.equal(r.state, 'error'); assert.match(r.error, /bad size/);
  } finally { failWith = null; }
});

test('成员：用管理员共享的服务计媒体额度、报错去掉地址；没开 Studio 的成员进不来', async () => {
  await users.createUser('bob', 'password123', 'user');
  const bob = contextFor(userIdentity('bob'));
  assert.equal(bob.allowStudio, true, '新账号默认有 Media Studio');
  const key = catalogMod.catalog('u:' + users.accountIdOf('bob')).kinds.image.defaults;
  // 共享服务花的是管理员的钱：过成员的媒体额度闸（这台测试服务器没给成员开放媒体 → 429 + 标题）
  assert.throws(() => jobs.startJob(bob, { kind: 'image', key: key.provider + '/' + key.model, prompt: 'x' }), (e) => e.status === 429 && !!e.title);
  // 自己的服务不计额度；报错原话给自己看
  const own = P.createProvider({ dialect: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k-bob-000000', models: [{ id: 'openai/gpt-image-2.5-sunburst', kind: 'image' }] }, bob.key);
  failWith = Object.assign(new Error('OpenRouter 400：bad'), { status: 400 });
  try {
    const r = await jobs.startJob(bob, { kind: 'image', key: own.id + '/openai/gpt-image-2.5-sunburst', prompt: 'x', params: {} }).done;
    assert.equal(r.state, 'error');
  } catch (e) {
    // 成员自己的服务每次生成前要过「只许公网」检查：测试环境解析不了外网时这里会报错，跳过即可
    assert.match(String(e && e.message), /解析|公网|内网/);
  } finally { failWith = null; P.deleteProvider(own.id, bob.key); }
  const noStudio = contextFor({ kind: 'user', user: users.accountIdOf('bob'), tier: 'user', agents: ['claude'] });
  assert.throws(() => jobs.startJob(noStudio, { kind: 'image', prompt: 'x' }), /不能用 Media Studio/);
});

test('作品：旧侧车照常可见（推断方言、捡旧参数）；筛选 / 搜索 / 分页；另存与删除', () => {
  const old = media.newId();
  media.save(old, PNG, 'png', { kind: 'image', prompt: '老图', model: 'gemini-3-pro-image', aspectRatio: '16:9', imageSize: '2K' });
  const oldVid = media.newId();
  media.save(oldVid, Buffer.from('x'), 'mp4', { prompt: '老视频', model: 'gemini-omni-1.1-flash' });
  media.save(media.newId(), PNG, 'png', { kind: 'chat-image', prompt: '代码执行画的图' });
  const all = assets.listAssets(admin.media, {});
  assert.ok(!all.items.some((a) => a.kind === 'chat-image'), '对话里代码执行的图不进作品流');
  const a = all.items.find((x) => x.id === old);
  assert.equal(a.dialect, 'vertex'); assert.equal(a.provider, 'vertex');
  assert.deepEqual(a.params, { aspectRatio: '16:9', imageSize: '2K' });
  assert.equal(all.items.find((x) => x.id === oldVid).dialect, 'gemini');
  assert.equal(assets.listAssets(admin.media, { kind: 'video' }).items.length, 1);
  assert.equal(assets.listAssets(admin.media, { q: '老图' }).items[0].id, old);
  const p1 = assets.listAssets(admin.media, { limit: 2 });
  assert.equal(p1.items.length, 2); assert.ok(p1.cursor);
  const p2 = assets.listAssets(admin.media, { limit: 2, cursor: p1.cursor });
  assert.ok(p2.items.every((x) => !p1.items.some((y) => y.id === x.id)), '下一页不重复');
  const saved = assets.saveAsset(admin, old, { dir: '素材', name: '封面' });
  assert.equal(saved.wsPath, '素材/封面.png');
  const again = assets.saveAsset(admin, old, { dir: '../../x' }).wsPath;
  assert.match(again, /^x\//, '.. 段被剥掉，落在工作空间里');
  assert.equal(assets.deleteAsset(admin, old, { withFile: true }), true);
  assert.equal(existsSync(path.join(tmp, 'vault', ...again.split('/'))), false, '连工作空间里那份（最后一次另存的）一起删');
  assert.equal(existsSync(path.join(tmp, 'vault', '素材', '封面.png')), true, '别的副本不动');
  assert.equal(media.get(old), null);
});

test('旧接口转接：/api/vertex/image 走任务、响应形状不变；没模型用 Studio 默认', async () => {
  const { registerMediaRoutes } = await import('./routes/legacy.mjs');
  const h = {};
  registerMediaRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; }, prefix() {} }, { identify: () => ({ kind: 'admin' }) });
  const call = (p, body) => new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: p, headers: {} });
    let status = 0, out = '';
    h['POST ' + p](req, { headersSent: false, writableEnded: false, writeHead(s) { status = s; this.headersSent = true; }, write(c) { out += c; return true; }, end(c) { if (c) out += c; this.writableEnded = true; resolve({ status, out }); }, setHeader() {}, on() {}, once() {} }, new URL(p, 'http://x'));
  });
  const r = await call('/api/vertex/image', { prompt: '旧接口的图', model: 'gpt-image-2.5-sunburst', quality: 'low' });
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true); assert.match(j.url, /^\/api\/vertex\/media\?id=/);
  assert.deepEqual(Object.keys(j).sort(), ['id', 'ok', 'url']);
  assert.equal(media.get(j.id).source, 'legacy');
  assert.equal(media.get(j.id).wsPath, undefined, '旧接口不自动存进工作空间');
  const chat = JSON.parse((await call('/api/vertex/image-chat', { message: '续改', model: 'gpt-image-2.5-sunburst' })).out);
  assert.equal(chat.ok, true); assert.ok(chat.sessionId);
  const bad = await call('/api/vertex/image-chat', { message: '' });
  assert.equal(bad.status, 400);
});

test('重试只针对确定没被受理的错误：429 / 拒连重试，5xx / 连接中途断开不重发（防重复计费）', async () => {
  const key = catalogMod.catalog('admin').kinds.image.defaults;
  const k = key.provider + '/' + key.model;
  let n = 0;
  const real = OR.run;
  try {
    OR.run = async () => { n++; throw Object.assign(new Error('上游 502'), { status: 502 }); };
    assert.equal((await jobs.startJob(admin, { kind: 'image', key: k, prompt: 'x' }).done).state, 'error');
    assert.equal(n, 1, '5xx 不重发');
    n = 0;
    OR.run = async () => { n++; throw Object.assign(new Error('连不上服务（ECONNRESET）'), { code: 'network', detail: 'ECONNRESET' }); };
    await jobs.startJob(admin, { kind: 'image', key: k, prompt: 'x' }).done;
    assert.equal(n, 1, '连接中途断开不重发');
    n = 0;
    OR.run = async () => { n++; if (n === 1) throw Object.assign(new Error('429'), { status: 429 }); return { assets: [{ bytes: PNG, mime: 'image/png' }] }; };
    assert.equal((await jobs.startJob(admin, { kind: 'image', key: k, prompt: 'x' }).done).state, 'done');
    assert.equal(n, 2, '429 重试一次');
  } finally { OR.run = real; }
});

test('通用参数名搬到卡上的字段名、全数字档位就近取（Claude 工具传 aspectRatio / durationSeconds / voice）', () => {
  const specs = [
    { key: 'aspect_ratio', type: 'enum', options: [{ value: '16:9' }, { value: '9:16' }], default: '16:9' },
    { key: 'duration', type: 'enum', options: [{ value: '5' }, { value: '10' }], default: '5' },
    { key: 'voice_id', type: 'voice' },
  ];
  assert.deepEqual(applySpecs(specs, { aspectRatio: '9:16', durationSeconds: 8, voice: 'Bob' }), { aspect_ratio: '9:16', duration: '10', voice_id: 'Bob' });
  assert.deepEqual(applySpecs(specs, { aspect_ratio: '16:9', aspectRatio: '9:16' }), { aspect_ratio: '16:9', duration: '5' }, '卡上字段本人给了就不覆盖');
});

test('上游回的是网页（地址填错）：报错不拼 HTML 原文，只给一句人话', async () => {
  const { http } = await import('./adapters/http.mjs');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!doctype html><html lang=en><head><title>Example</title></head><body>…</body></html>', { status: 404, headers: { 'content-type': 'text/html' } });
  try {
    await assert.rejects(http('https://example.com/v1/models', { label: 'x' }), (e) => /404：接口或模型不存在/.test(e.message) && /对方回的是网页/.test(e.message) && !/<html|doctype/i.test(e.message) && !e.detail);
  } finally { globalThis.fetch = real; }
});

test('设置：默认模型里的服务 / 模型写入时就要存在（服务 id 不存在、种类不对都拒）', async () => {
  const { registerStudioApi } = await import('./routes/api.mjs');
  const h = {};
  registerStudioApi({ on: (m, p, fn) => { h[m + ' ' + p] = fn; }, prefix() {} }, { identify: () => ({ kind: 'admin' }) });
  const call = (body) => new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: '/api/studio/settings', headers: {} });
    let status = 0, out = '';
    h['POST /api/studio/settings'](req, { writeHead(s) { status = s; }, end(c) { out += c || ''; resolve({ status, j: JSON.parse(out) }); } });
  });
  const ok = catalogMod.catalog('admin').kinds.image.defaults;
  assert.equal((await call({ scope: 'host', values: { defaults: { image: { provider: 'p-0a1b0000', model: 'x' } } } })).status, 400);
  assert.match((await call({ scope: 'host', values: { defaults: { video: { provider: ok.provider, model: ok.model } } } })).j.error, /没有这个视频模型/);
  assert.equal((await call({ scope: 'host', values: { defaults: { image: { provider: ok.provider, model: ok.model } } } })).status, 200);
  await call({ scope: 'host', values: { defaults: null } });
});

test('Claude 工具：设置全默认时描述与 schema 逐字不变；选了默认模型就把写死的内置默认换掉，不再前后两个默认', () => {
  const ad = { newId: () => 'x', emit() {}, resultText() {}, errorText() {}, generate() {} };
  const DEF = { image: { key: 'p-1234abcd/m', label: '某模型' }, video: { key: 'p-1234abcd/v', label: '某视频' }, speech: { key: 'p-1234abcd/s', label: '某语音' }, music: { key: 'p-1234abcd/u', label: '某音乐' } };
  const count = (s, sub) => s.split(sub).length - 1;
  for (const flavor of ['phone', 'desktop']) {
    const plain = buildMediaTools({ flavor, adapter: ad, defaults: null });
    const nulls = buildMediaTools({ flavor, adapter: ad, defaults: () => null });
    assert.deepEqual(plain.map((t) => t.description), nulls.map((t) => t.description));
    plain.forEach((t, i) => { for (const f of Object.keys(t.schema)) assert.equal(nulls[i].schema[f], t.schema[f], `${flavor} ${t.name}.${f}`); });
    // 工具没有图片输入参数，描述不许说能改图（2026-11-07 反馈）
    assert.doesNotMatch(plain[0].description, /改图|pass image/i);
    assert.ok(!('image' in plain[0].schema) && !('images' in plain[0].schema));

    const withDef = buildMediaTools({ flavor, adapter: ad, defaults: (k) => DEF[k] || null });
    const [img, vid, sp, mu] = withDef;
    // 图片：开头的默认子句换成设置里选的，内置 Flash 不再被说成默认；默认只出现一次
    assert.doesNotMatch(img.description, /model Nano Banana Flash \(gemini-3\.1-flash-image\)|默认模型 Flash|Flash supports both|当前默认模型|Current default model/);
    assert.equal(count(img.description, '某模型'), 1);
    assert.ok(img.description.includes('model:"p-1234abcd/m"'));
    assert.match(img.schema.model.description, /^可选模型 id，不传 = 当前默认 某模型（Media Studio 设置里选的，也可传 "p-1234abcd\/m"）。内置：gemini-3\.1-flash-image=Nano Banana Flash/);
    assert.ok(img.schema.model.description.includes('gpt-image-2.5-sunburst'));   // 内置模型清单还在
    assert.doesNotMatch(img.schema.useImageSearch.description, /默认模型即 Flash/);
    assert.equal(img.schema.prompt, plain[0].schema.prompt);
    assert.equal(img.schema.aspectRatio, plain[0].schema.aspectRatio);
    // 视频：「Default model veo-3.1-fast」同样换掉
    assert.doesNotMatch(vid.description, /Default model veo-3\.1-fast \(|当前默认模型|Current default model/);
    assert.equal(count(vid.description, '某视频'), 1);
    assert.match(vid.schema.model.description, /当前默认 某视频/);
    // 语音描述没写死默认模型：照旧末尾补一句
    assert.ok(sp.description.startsWith(plain[2].description) && sp.description.includes('某语音'));
    // 音乐：桌面版写了「Default lyria-002」就换，手机版没写就补一句；字段说明两边都换
    if (flavor === 'desktop') assert.ok(!mu.description.includes('Default lyria-002') && count(mu.description, '某音乐') === 1);
    else assert.ok(mu.description.startsWith(plain[3].description) && mu.description.includes('某音乐'));
    assert.match(mu.schema.model.description, /当前默认 某音乐/);
    if (flavor === 'desktop') assert.ok('outputPath' in img.schema);
  }
  // label / key 里的 $ 不当替换模式
  const odd = buildMediaTools({ flavor: 'phone', adapter: ad, defaults: (k) => (k === 'image' ? { key: 'p-1234abcd/a$&b', label: 'X$&Y' } : null) });
  assert.ok(odd[0].description.includes('X$&Y') && odd[0].description.includes('p-1234abcd/a$&b'));
});

test('Claude 工具：图片回执报实际像素；明显低于下发档位时直说（2026-11-07 Pro 请求 4K 实出 768×1376）', async () => {
  const ID = '0bab0dac-1111-4222-8333-444455556666';
  const run = async (ret, args) => {
    const ad = { newId: () => ID, emit() {}, resultText: phoneResultText, errorText: (k, e) => String(e), generate: async () => ({ id: ID, file: 'C:\\m\\' + ID + '.png', ...ret }) };
    const [img] = buildMediaTools({ flavor: 'phone', adapter: ad, defaults: null });
    return (await img.handler({ prompt: '海报', ...args })).content[0].text;
  };
  const pro = { model: 'gemini-3-pro-image', imageSize: '4K', aspectRatio: '9:16' };
  // 降档：报请求档位 → 实际像素，并提示；媒体 id 仍在路径里（转录还原靠它）
  let t = await run({ model: 'gemini-3-pro-image', width: 768, height: 1376, params: { imageSize: '4K', aspectRatio: '9:16' } }, pro);
  assert.match(t, /gemini-3-pro-image · 请求 4K → 实际 768×1376 · 9:16/);
  assert.match(t, /注意：实际像素明显低于请求的 4K 档；要大图请换模型或重试。/);
  assert.ok(t.endsWith(ID + '.png'));
  // 真 4K：只报像素，不提示
  t = await run({ model: 'gemini-3-pro-image', width: 3072, height: 5504, params: { imageSize: '4K' } }, pro);
  assert.match(t, /请求 4K → 实际 3072×5504/);
  assert.doesNotMatch(t, /注意/);
  // auto 比例拿到小图：多给一个「指定比例」的出路
  t = await run({ model: 'gpt-image-2.6-sunburst', width: 1536, height: 864, params: { imageSize: '4K', aspectRatio: 'auto' } }, { model: 'gpt-image-2.6-sunburst', imageSize: '4K' });
  assert.match(t, /明显低于请求的 4K 档.*或指定明确的 aspectRatio/);
  // 卡不收 imageSize（下发参数里没有）：只报实际像素，不说「请求 2K」、不判降档
  t = await run({ model: 'flux', width: 1024, height: 1024, params: { size: '1024x1024' } }, { model: 'p-1234abcd/flux' });
  assert.match(t, /（flux · 实际 1024×1024 · auto）/);
  assert.doesNotMatch(t, /请求|注意/);
  // 量不到像素（侧车没宽高）：照旧只报请求档位
  t = await run({ model: 'gemini-3-pro-image' }, pro);
  assert.match(t, /（gemini-3-pro-image · 4K · 9:16）。绝对文件路径/);

  // 门槛按总像素：Gemini 1K 的超宽 / 超长图（长边过 1400）也认得出；GPT Image 本档的最小尺寸不误报
  assert.equal(belowSize('2K', 1584, 672), true);    // Gemini 1K 21:9
  assert.equal(belowSize('2K', 352, 2928), true);    // 2.1 的 1K 1:8
  assert.equal(belowSize('2K', 2048, 880), false);   // GPT Image 2K 21:9
  assert.equal(belowSize('4K', 2048, 2048), true);   // Gemini 2K
  assert.equal(belowSize('4K', 3840, 1632), false);  // GPT Image 4K 21:9
  assert.equal(belowSize('1K', 512, 512), false);    // 1K 不判
  assert.equal(belowSize(undefined, 512, 512), false);
});
