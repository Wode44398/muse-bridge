// minimax 适配器单测：mock 全局 fetch，不联网、不需要 Key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { minimaxAdapter, CARDS } from './minimax.mjs';
import { AdapterError } from './http.mjs';
import { applySpecs, genericCard } from '../cards/spec.mjs';
import { dialectCards } from '../cards/dialects.mjs';

const BASE = 'https://api.minimaxi.com/v1';
const PROVIDER = { id: 'p-test0001', owner: 'admin', dialect: 'minimax', baseUrl: BASE, authStyle: 'bearer', headers: {}, params: {}, timeoutSec: 60, models: [] };
const OK = { status_code: 0, status_msg: 'success' };
const J = (body, status = 200) => ({ body, status });   // 可重复使用的 JSON 回应
const hex = (s) => Buffer.from(s).toString('hex');
const frame = (data = 'PNG', mime = 'image/png') => ({ role: 'first', data: Buffer.from(data), mime, name: 'f' });

/** 替换全局 fetch：routes = [[匹配函数, 回应]]，回应是 J(...)、返回 Response 的函数或 Response；每次调用记进 calls。 */
function mockFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const rec = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
    calls.push(rec);
    for (const [match, reply] of routes) {
      if (!match(rec)) continue;
      const r = typeof reply === 'function' ? reply(rec) : reply;
      return r instanceof Response ? r : new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`未预期的请求：${rec.method} ${rec.url}`);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

function ctxOf(extra = {}) {
  const ctx = { secret: { key: 'k' }, signal: new AbortController().signal, pollMs: 1, notes: [], submits: 0, ...extra };
  ctx.progress = (x) => { ctx.notes.push(x.note); };
  ctx.submitted = () => { ctx.submits++; };
  return ctx;
}

// 同 jobs.mjs：没有自定义 normalize 的卡走 applySpecs（json 类的 extra 也在这里解析）
function reqOf(card, model, raw, { prompt = '', inputs = [] } = {}) {
  return { kind: card.kind, model, card, prompt, negative: '', params: applySpecs(card.params, raw), inputs, thread: null };
}

test('视频：请求构造、排队→生成中→完成的轮询、进度回调、成片走 download_url（不带 Key）', async () => {
  const TASK = '106916112212032', FILE = '176844028768320';
  let polls = 0;
  const m = mockFetch([
    [(r) => r.method === 'POST' && r.url === `${BASE}/video_generation`, J({ task_id: TASK, base_resp: OK })],
    [(r) => r.url === `${BASE}/query/video_generation?task_id=${TASK}`, () => {
      polls++;
      if (polls === 1) return J({ task_id: TASK, status: 'Queueing', base_resp: OK });
      if (polls === 2) return J({ task_id: TASK, status: 'Processing', base_resp: OK });
      return J({ task_id: TASK, status: 'Success', file_id: FILE, video_width: 1920, video_height: 1080, base_resp: OK });
    }],
    [(r) => r.url === `${BASE}/files/retrieve?file_id=${FILE}`, J({ file: { file_id: FILE, download_url: 'https://cdn.example.com/out.mp4' }, base_resp: OK })],
    [(r) => r.url === 'https://cdn.example.com/out.mp4', () => new Response(Buffer.from('MP4BYTES'), { headers: { 'content-type': 'video/mp4' } })],
  ]);
  try {
    const ctx = ctxOf();
    const req = reqOf(CARDS['MiniMax-Hailuo-2.3'], 'MiniMax-Hailuo-2.3', { durationSeconds: 6, resolution: '1080P' }, { prompt: '镜头缓慢推进', inputs: [frame()] });
    const out = await minimaxAdapter.run(req, PROVIDER, ctx);
    const [create] = m.calls;
    assert.equal(create.method, 'POST');
    assert.equal(create.headers.Authorization, 'Bearer k');
    assert.deepEqual(create.body, {
      model: 'MiniMax-Hailuo-2.3', prompt: '镜头缓慢推进', first_frame_image: `data:image/png;base64,${Buffer.from('PNG').toString('base64')}`,
      duration: 6, resolution: '1080P', prompt_optimizer: true, fast_pretreatment: false,
    });
    assert.equal(ctx.submits, 1);
    assert.deepEqual(ctx.notes, ['排队中', '生成中']);
    const dl = m.calls.at(-1);
    assert.equal(dl.url, 'https://cdn.example.com/out.mp4');
    assert.equal(dl.headers.Authorization, undefined);   // 成片地址自带签名，不把 Key 发给第三方
    assert.equal(out.assets[0].bytes.toString(), 'MP4BYTES');
    assert.equal(out.assets[0].mime, 'video/mp4');
    assert.deepEqual(out.assets[0].meta, { width: 1920, height: 1080, duration: 6 });
  } finally { m.restore(); }
});

test('视频：任务失败（Fail）→ 人话原因；提交后才失败的任务已记为不可取消', async () => {
  const m = mockFetch([
    [(r) => r.method === 'POST', J({ task_id: 'T1', base_resp: OK })],
    [(r) => r.url.includes('/query/video_generation'), J({ task_id: 'T1', status: 'Fail', base_resp: { status_code: 1027, status_msg: 'output flagged' } })],
  ]);
  try {
    const ctx = ctxOf();
    await assert.rejects(minimaxAdapter.run(reqOf(CARDS['MiniMax-Hailuo-02'], 'MiniMax-Hailuo-02', {}, { prompt: 'x' }), PROVIDER, ctx), (e) => /生成的内容被判为敏感/.test(e.message));
    assert.equal(ctx.submits, 1);
  } finally { m.restore(); }
});

test('视频：文件检索没给下载地址时走 retrieve_content（二进制或 JSON 里的地址都认）', async () => {
  for (const variant of ['binary', 'json']) {
    const m = mockFetch([
      [(r) => r.method === 'POST', J({ task_id: 'T2', base_resp: OK })],
      [(r) => r.url.includes('/query/video_generation'), J({ task_id: 'T2', status: 'Success', file_id: 'F2', base_resp: OK })],
      [(r) => r.url === `${BASE}/files/retrieve?file_id=F2`, J({ file: { file_id: 'F2' }, base_resp: OK })],
      [(r) => r.url === `${BASE}/files/retrieve_content?file_id=F2`, () => (variant === 'binary'
        ? new Response(Buffer.from('BIN'), { headers: { 'content-type': 'application/octet-stream' } })
        : new Response(JSON.stringify({ download_url: 'https://cdn.example.com/f2.mp4' }), { headers: { 'content-type': 'application/json' } }))],
      [(r) => r.url === 'https://cdn.example.com/f2.mp4', () => new Response(Buffer.from('VIA-URL'), { headers: { 'content-type': 'video/mp4' } })],
    ]);
    try {
      const out = await minimaxAdapter.run(reqOf(CARDS['MiniMax-Hailuo-02'], 'MiniMax-Hailuo-02', {}, { prompt: 'x' }), PROVIDER, ctxOf());
      assert.equal(out.assets[0].bytes.toString(), variant === 'binary' ? 'BIN' : 'VIA-URL');
      assert.equal(out.assets[0].mime, 'video/mp4');
    } finally { m.restore(); }
  }
});

test('视频：查询瞬时限流不致命，下一轮再查', async () => {
  let n = 0;
  const m = mockFetch([
    [(r) => r.method === 'POST', J({ task_id: 'T3', base_resp: OK })],
    [(r) => r.url.includes('/query/video_generation'), () => (++n === 1
      ? J({ base_resp: { status_code: 1002, status_msg: 'rate limit' } })
      : J({ task_id: 'T3', status: 'Success', file_id: 'F3', base_resp: OK }))],
    [(r) => r.url.includes('/files/retrieve?'), J({ file: { download_url: 'https://cdn.example.com/f3.mp4' }, base_resp: OK })],
    [(r) => r.url === 'https://cdn.example.com/f3.mp4', () => new Response(Buffer.from('OK3'), { headers: { 'content-type': 'video/mp4' } })],
  ]);
  try {
    const ctx = ctxOf();
    const out = await minimaxAdapter.run(reqOf(CARDS['MiniMax-Hailuo-02'], 'MiniMax-Hailuo-02', {}, { prompt: 'x' }), PROVIDER, ctx);
    assert.equal(out.assets[0].bytes.toString(), 'OK3');
    assert.ok(ctx.notes.includes('查询暂时失败，重试中'));
  } finally { m.restore(); }
});

test('错误映射：HTTP 401 → API Key 人话；业务码 → 状态与人话；4xx 原话透出', async () => {
  const card = CARDS['MiniMax-Hailuo-02'];
  const cases = [
    [J({ error: 'bad key' }, 401), (e) => e.status === 401 && /API Key/.test(e.message)],
    [J({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }), (e) => e.status === 402 && /余额不足/.test(e.message)],
    [J({ base_resp: { status_code: 1002, status_msg: 'rate limit' } }), (e) => e.status === 429],
    [J({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } }), (e) => e.status === 401 && /API Key/.test(e.message)],
    [J({ base_resp: { status_code: 2013, status_msg: 'duration must be 6 or 10' } }), (e) => e.status === 400 && /duration must be 6 or 10/.test(e.message)],
    [J({ base_resp: { status_code: 1026, status_msg: 'sensitive' } }), (e) => e.status === 422 && /敏感/.test(e.message)],
    [J({ message: 'prompt too long' }, 400), (e) => e.status === 400 && /prompt too long/.test(e.message)],
  ];
  for (const [reply, check] of cases) {
    const m = mockFetch([[(r) => r.method === 'POST', reply]]);
    try {
      await assert.rejects(minimaxAdapter.run(reqOf(card, 'MiniMax-Hailuo-02', {}, { prompt: 'x' }), PROVIDER, ctxOf()), (e) => e instanceof AdapterError && check(e));
    } finally { m.restore(); }
  }
});

test('视频：首帧图格式不对、不止一张、只给尾帧都直接拒（不发请求）', async () => {
  const card = CARDS['MiniMax-Hailuo-2.3'];
  const bad = [
    reqOf(card, 'MiniMax-Hailuo-2.3', {}, { prompt: 'x', inputs: [frame('GIF', 'image/gif')] }),
    reqOf(card, 'MiniMax-Hailuo-2.3', {}, { prompt: 'x', inputs: [frame(), frame()] }),
    reqOf(card, 'MiniMax-Hailuo-2.3', {}, { prompt: 'x', inputs: [{ ...frame(), role: 'last' }] }),
  ];
  const m = mockFetch([]);   // 没有任何路由：万一真发了请求会报「未预期的请求」，断言 status 就对不上
  try {
    for (const req of bad) await assert.rejects(minimaxAdapter.run(req, PROVIDER, ctxOf()), (e) => e.status === 400);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('配音：请求体字段；extra 与服务级参数逐层合并（voice_setting 不被冲掉）；hex 结果与音频元数据', async () => {
  const audio = Buffer.from('ID3-FAKE-AUDIO');
  const m = mockFetch([[(r) => r.url === `${BASE}/t2a_v2`, J({ data: { audio: audio.toString('hex'), status: 2 }, extra_info: { audio_length: 2500, usage_characters: 12, audio_format: 'wav' }, base_resp: OK })]]);
  try {
    const provider = { ...PROVIDER, params: { voice_setting: { vol: 2 } } };
    const req = reqOf(CARDS['speech-2.6-hd'], 'speech-2.6-hd',
      { voice: 'female-yujie', emotion: 'whisper', speed: 1.2, format: 'wav', sampleRate: 24000, bitrate: 128000, extra: { voice_setting: { speed: 0.9 }, language_boost: 'Chinese' } },
      { prompt: '你好，世界' });
    const out = await minimaxAdapter.run(req, provider, ctxOf());
    const [call] = m.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.body.text, '你好，世界');
    assert.equal(call.body.stream, false);
    assert.equal(call.body.output_format, 'hex');
    assert.deepEqual(call.body.voice_setting, { voice_id: 'female-yujie', emotion: 'whisper', speed: 0.9, vol: 2, pitch: 0 });
    assert.deepEqual(call.body.audio_setting, { format: 'wav', sample_rate: 24000, channel: 1 });   // 比特率只对 mp3 生效
    assert.equal(call.body.language_boost, 'Chinese');
    assert.deepEqual(out.assets[0].bytes, audio);
    assert.equal(out.assets[0].mime, 'audio/wav');
    assert.deepEqual(out.assets[0].meta, { duration: 2.5, characters: 12 });
  } finally { m.restore(); }
});

test('音乐：歌词留空自动写词（纯音乐不写）、hex 结果、时长换算', async () => {
  const audio = Buffer.from('MUSIC-BYTES');
  const m = mockFetch([[(r) => r.url === `${BASE}/music_generation`, J({ data: { audio: audio.toString('hex'), status: 2 }, extra_info: { music_duration: 25364, music_size: 813651 }, base_resp: OK })]]);
  try {
    const card = CARDS['music-3.0'];
    const out = await minimaxAdapter.run(reqOf(card, 'music-3.0', { lyrics: '', instrumental: false }, { prompt: '温暖的民谣吉他' }), PROVIDER, ctxOf());
    assert.deepEqual(m.calls[0].body, {
      model: 'music-3.0', prompt: '温暖的民谣吉他', is_instrumental: false, lyrics_optimizer: true, stream: false, output_format: 'hex',
      audio_setting: { format: 'mp3', sample_rate: 44100, bitrate: 256000 },
    });
    assert.deepEqual(out.assets[0].bytes, audio);
    assert.equal(out.assets[0].mime, 'audio/mpeg');
    assert.deepEqual(out.assets[0].meta, { duration: 25.4 });
    await minimaxAdapter.run(reqOf(card, 'music-3.0', { instrumental: true }, { prompt: '钢琴独奏' }), PROVIDER, ctxOf());
    assert.equal(m.calls[1].body.is_instrumental, true);
    assert.equal('lyrics_optimizer' in m.calls[1].body, false);
    assert.equal('lyrics' in m.calls[0].body, false);
  } finally { m.restore(); }
});

test('通用卡：未知视频模型照样能跑（时长 → duration、extra 原样合并、比例不传）', async () => {
  const m = mockFetch([
    [(r) => r.method === 'POST', J({ task_id: 'G1', base_resp: OK })],
    [(r) => r.url.includes('/query/video_generation'), J({ task_id: 'G1', status: 'Success', file_id: 'FG', base_resp: OK })],
    [(r) => r.url.includes('/files/retrieve?'), J({ file: { download_url: 'https://cdn.example.com/g.mp4' }, base_resp: OK })],
    [(r) => r.url === 'https://cdn.example.com/g.mp4', () => new Response(Buffer.from('GEN'), { headers: { 'content-type': 'video/mp4' } })],
  ]);
  try {
    const req = reqOf(genericCard('minimax', 'video'), 'MiniMax-Hailuo-Future', { durationSeconds: 10, aspectRatio: '16:9', extra: { resolution: '1080P' } },
      { prompt: 'a cat', inputs: [frame('JPG', 'image/jpeg')] });
    const out = await minimaxAdapter.run(req, PROVIDER, ctxOf());
    const b = m.calls[0].body;
    assert.equal(b.model, 'MiniMax-Hailuo-Future');
    assert.equal(b.duration, 10);
    assert.equal(b.resolution, '1080P');
    assert.ok(b.first_frame_image.startsWith('data:image/jpeg;base64,'));
    assert.equal('aspectRatio' in b || 'aspect_ratio' in b, false);
    assert.equal(out.assets[0].bytes.toString(), 'GEN');
  } finally { m.restore(); }
});

test('通用卡：未知配音 / 音乐模型照样能跑（音色默认、extra 深合并、歌词经 extra 传）', async () => {
  const m = mockFetch([
    [(r) => r.url === `${BASE}/t2a_v2`, J({ data: { audio: hex('AUD'), status: 2 }, base_resp: OK })],
    [(r) => r.url === `${BASE}/music_generation`, J({ data: { audio: hex('MUS'), status: 2 }, base_resp: OK })],
  ]);
  try {
    const o1 = await minimaxAdapter.run(reqOf(genericCard('minimax', 'speech'), 'speech-future', { voice: 'male-qn-badao', extra: { voice_setting: { speed: 1.5 } } }, { prompt: '测试' }), PROVIDER, ctxOf());
    assert.deepEqual(m.calls[0].body.voice_setting, { voice_id: 'male-qn-badao', speed: 1.5 });
    assert.equal(o1.assets[0].bytes.toString(), 'AUD');
    const o2 = await minimaxAdapter.run(reqOf(genericCard('minimax', 'music'), 'music-future', { durationSeconds: 30, extra: { lyrics: '[Verse]\n夜很长' } }, { prompt: '慢歌' }), PROVIDER, ctxOf());
    assert.equal(m.calls[1].body.lyrics, '[Verse]\n夜很长');
    assert.equal('lyrics_optimizer' in m.calls[1].body, false);
    assert.equal(o2.assets[0].bytes.toString(), 'MUS');
  } finally { m.restore(); }
});

test('test()：只调音色查询（只读），不发生成请求；401 / 403 / 业务码 1004 都是「API Key 无效」', async () => {
  const m = mockFetch([[(r) => r.url === `${BASE}/get_voice`, J({ system_voice: [{ voice_id: 'a' }, { voice_id: 'b' }], base_resp: OK })]]);
  try {
    const r = await minimaxAdapter.test(PROVIDER, ctxOf());
    assert.equal(r.detail, 'Key 有效（系统音色 2 个）');
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].method, 'POST');
    assert.deepEqual(m.calls[0].body, { voice_type: 'system' });
  } finally { m.restore(); }
  for (const reply of [J({ base_resp: { status_code: 1004, status_msg: 'invalid' } }), new Response('nope', { status: 403 })]) {
    const m2 = mockFetch([[() => true, reply]]);
    try {
      await assert.rejects(minimaxAdapter.test(PROVIDER, ctxOf()), (e) => /API Key 无效/.test(e.message));
    } finally { m2.restore(); }
  }
  await assert.rejects(minimaxAdapter.test(PROVIDER, ctxOf({ secret: { key: '' } })), /API Key/);
});

test('voices()：拉得到 → 系统音色 + 克隆音色；拉不到 → 内置表；listModels 为空', async () => {
  const m = mockFetch([[(r) => r.url === `${BASE}/get_voice`, J({
    system_voice: [{ voice_id: 'male-qn-qingse', voice_name: '青涩青年音色', description: [] }],
    voice_cloning: [{ voice_id: 'my_clone', description: [], created_time: '2026-11-01' }],
    voice_generation: [],
    base_resp: OK,
  })]]);
  try {
    const list = await minimaxAdapter.voices(PROVIDER, ctxOf(), 'speech-2.8-hd');
    assert.deepEqual(list, [{ id: 'male-qn-qingse', label: '青涩青年音色' }, { id: 'my_clone', label: 'my_clone', note: '克隆音色' }]);
    assert.deepEqual(m.calls[0].body, { voice_type: 'all' });
  } finally { m.restore(); }
  const m2 = mockFetch([[() => true, () => new Response('oops', { status: 500 })]]);
  try {
    const list = await minimaxAdapter.voices(PROVIDER, ctxOf(), 'speech-2.8-hd');
    assert.ok(list.length >= 10);
    assert.ok(list.some((v) => v.id === 'male-qn-qingse'));
  } finally { m2.restore(); }
  assert.deepEqual(await minimaxAdapter.listModels(PROVIDER, ctxOf()), []);
});

test('模型卡：种类合法，末尾是 extra（json），登记进方言表，enum 默认值都在选项里', () => {
  assert.equal(Object.keys(CARDS).length, 9);
  for (const [id, card] of Object.entries(CARDS)) {
    assert.ok(['video', 'speech', 'music'].includes(card.kind), id);
    assert.equal(card.params.at(-1).key, 'extra', id);
    assert.equal(dialectCards('minimax', id).kind, card.kind, id);
    for (const s of card.params) {
      if (s.type === 'enum' && s.default !== undefined) assert.ok(s.options.some((o) => o.value === s.default), `${id}.${s.key} 的默认值不在选项里`);
    }
  }
});

test('run：没 Key、不做的种类直接抛（不发请求）', async () => {
  const m = mockFetch([]);
  try {
    await assert.rejects(minimaxAdapter.run(reqOf(CARDS['speech-2.8-hd'], 'speech-2.8-hd', {}, { prompt: 'x' }), PROVIDER, ctxOf({ secret: { key: '' } })), /API Key/);
    await assert.rejects(minimaxAdapter.run({ kind: 'image', model: 'x', params: {}, inputs: [] }, PROVIDER, ctxOf()), (e) => e.status === 400);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});
