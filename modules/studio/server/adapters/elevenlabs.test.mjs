// elevenlabs 适配器单测：全程 mock 全局 fetch，不联网、不需要 Key（未真打）。
// 没有轮询用例：ElevenLabs 配音和音乐都是同步接口，一次请求直接回音频（见 elevenlabs.mjs 头注释）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { elevenlabsAdapter as A, CARDS } from './elevenlabs.mjs';
import { AdapterError } from './http.mjs';
import { applySpecs, genericCard } from '../cards/spec.mjs';
import { dialectBuiltinModels } from '../cards/dialects.mjs';

const provider = (over = {}) => ({ id: 'p-test0001', owner: 'admin', dialect: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1', authStyle: 'xi-api-key', headers: {}, params: {}, timeoutSec: 60, models: [], ...over });

// 调用方的 ctx：记录 submitted() 被调了几次
function ctx(over = {}) {
  const c = { secret: { key: 'k' }, signal: new AbortController().signal, submittedCalls: 0, ...over };
  c.progress = () => {};
  c.submitted = () => { c.submittedCalls++; };
  return c;
}

// 替换全局 fetch：记录每次请求（URL / 方法 / 头 / 解析后的 JSON 体），响应由 handler 决定；restore() 还原
function mockFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
    calls.push(call);
    return handler(calls.length - 1, call);
  };
  return { calls, restore() { globalThis.fetch = real; } };
}
const audio = (bytes, type = 'audio/mpeg') => new Response(bytes, { status: 200, headers: { 'content-type': type } });
const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
// 按卡的 ParamSpec 规范化（没有自定义 normalize 的卡，线上 jobs 走的就是这一条）
const paramsOf = (card, raw) => applySpecs(card.params, raw);
const req = (kind, model, card, params, prompt = 'hi') => ({ kind, model, card, prompt, params, negative: '', inputs: [], thread: null });

test('配音：URL 带 voice 与 output_format；POST；xi-api-key 头；卡上参数映射成下划线字段，音色设置只带用户设的；秒级短请求不标 submitted（限流可重试）', async () => {
  const m = mockFetch(() => audio(Buffer.from('ID3fake')));
  const c = ctx();
  try {
    const card = CARDS.eleven_multilingual_v2;
    const out = await A.run(req('speech', 'eleven_multilingual_v2', card, paramsOf(card, {
      voice: 'VOICE_A', outputFormat: 'mp3_44100_192', stability: 0.3, similarityBoost: 0.8, useSpeakerBoost: true, languageCode: 'zh', seed: 7, applyTextNormalization: 'on',
    }), '你好，世界'), provider(), c);
    assert.equal(m.calls.length, 1);
    const r = m.calls[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.url, 'https://api.elevenlabs.io/v1/text-to-speech/VOICE_A?output_format=mp3_44100_192');
    assert.equal(r.headers['xi-api-key'], 'k');
    assert.deepEqual(r.body, {
      text: '你好，世界', model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.3, similarity_boost: 0.8, use_speaker_boost: true },
      language_code: 'zh', seed: 7, apply_text_normalization: 'on',
    });
    assert.ok(Buffer.isBuffer(out.assets[0].bytes));
    assert.equal(out.assets[0].bytes.toString(), 'ID3fake');
    assert.equal(out.assets[0].mime, 'audio/mpeg');
    assert.equal(out.assets[0].meta.voice, 'VOICE_A');
    assert.equal(c.submittedCalls, 0, '配音不标「发出去收不回」，执行器遇 429 还能重试');
  } finally { m.restore(); }
});

test('配音：不给参数时用默认音色和 mp3_44100_128，不带音色设置（不盖掉音色自己存的设置）', async () => {
  const m = mockFetch(() => audio(Buffer.from('x')));
  try {
    const card = CARDS.eleven_v4;
    await A.run(req('speech', 'eleven_v4', card, paramsOf(card, {})), provider(), ctx());
    assert.equal(m.calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128');
    assert.deepEqual(m.calls[0].body, { text: 'hi', model_id: 'eleven_v4' });
  } finally { m.restore(); }
});

test('合并顺序：卡上字段 → 服务级 params → 逐次 extra；extra 里误写的 output_format 挪到 query 且优先', async () => {
  const m = mockFetch(() => audio(Buffer.from('RIFF'), 'audio/wav'));
  try {
    const card = CARDS.eleven_flash_v2_5;
    const out = await A.run(req('speech', 'eleven_flash_v2_5', card, paramsOf(card, { seed: 1, languageCode: 'fr', extra: { seed: 3, output_format: 'wav_24000' } })),
      provider({ params: { seed: 2, language_code: 'en', previous_text: '前文' } }), ctx());
    assert.deepEqual(m.calls[0].body, { text: 'hi', model_id: 'eleven_flash_v2_5', language_code: 'en', seed: 3, previous_text: '前文' });
    assert.equal(m.calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=wav_24000');
    assert.equal(out.assets[0].mime, 'audio/wav');
  } finally { m.restore(); }
});

test('错误映射：401 → 含「API Key」的人话；402 余额；429 限流；5xx 服务方；422 原话透出', async () => {
  const cases = [
    [401, { detail: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' } }, /API Key 无效/],
    [402, { detail: { type: 'payment_required', code: 'insufficient_credits', message: 'Not enough credits' } }, /余额不足/],
    [422, { detail: [{ loc: ['body', 'text'], msg: 'text too long for this model', type: 'value_error' }] }, /text too long/],
    [429, { detail: { type: 'rate_limit_error', code: 'too_many_concurrent_requests', message: 'slow down' } }, /被限流/],
    [503, { detail: { type: 'service_unavailable', message: 'down' } }, /服务方出错/],
  ];
  for (const [status, body, re] of cases) {
    const m = mockFetch(() => jsonRes(status, body));
    try {
      await assert.rejects(A.run(req('speech', 'eleven_v4', CARDS.eleven_v4, paramsOf(CARDS.eleven_v4, {})), provider(), ctx()), (e) => {
        assert.ok(e instanceof AdapterError, `status ${status} 应归一成 AdapterError`);
        assert.equal(e.status, status);
        assert.match(e.message, re);
        return true;
      });
    } finally { m.restore(); }
  }
});

test('音乐：POST /music 带 output_format；时长换算成 music_length_ms；model_id 显式带；一次请求拿到整首（没有轮询）；发请求前调一次 submitted()', async () => {
  const m = mockFetch(() => audio(Buffer.from('ID3music')));
  const c = ctx();
  try {
    const card = CARDS.music_v2_5;
    const out = await A.run(req('music', 'music_v2_5', card, paramsOf(card, { durationSeconds: 30 }), '夏天的海边，吉他'), provider(), c);
    assert.equal(m.calls.length, 1, '一次请求就拿到整首，没有轮询');
    assert.equal(m.calls[0].method, 'POST');
    assert.equal(m.calls[0].url, 'https://api.elevenlabs.io/v1/music?output_format=auto');
    assert.deepEqual(m.calls[0].body, { prompt: '夏天的海边，吉他', music_length_ms: 30000, force_instrumental: false, model_id: 'music_v2_5' });
    assert.equal(out.assets[0].mime, 'audio/mpeg');
    assert.equal(out.assets[0].bytes.toString(), 'ID3music');
    assert.equal(c.submittedCalls, 1);
  } finally { m.restore(); }
});

test('时长：卡上 3–300 秒（产品页写最长 5 分钟）；通用卡 5–600 秒；run 自己再夹到 API 的 3000–600000 毫秒', async () => {
  assert.equal(paramsOf(CARDS.music_v2, { durationSeconds: 999 }).durationSeconds, 300);
  assert.equal(paramsOf(CARDS.music_v2, { durationSeconds: 1 }).durationSeconds, 3);
  const m = mockFetch(() => audio(Buffer.from('x')));
  try {
    const card = genericCard('elevenlabs', 'music');
    await A.run(req('music', 'music_v9_future', card, { durationSeconds: 999 }), provider(), ctx());
    assert.deepEqual(m.calls[0].body, { prompt: 'hi', music_length_ms: 600000, model_id: 'music_v9_future' });
  } finally { m.restore(); }
});

test('音乐：给了 composition_plan 就去掉 prompt（文档：两者不能同用）；没描述也没计划时报错，且不发请求', async () => {
  const m = mockFetch(() => audio(Buffer.from('x')));
  try {
    const card = CARDS.music_v2;
    await A.run(req('music', 'music_v2', card, paramsOf(card, { forceInstrumental: true, extra: { composition_plan: { chunks: [] } } }), '应该被去掉'), provider(), ctx());
    assert.deepEqual(m.calls[0].body, { model_id: 'music_v2', composition_plan: { chunks: [] } });
    await assert.rejects(A.run(req('music', 'music_v2', card, paramsOf(card, {}), '  '), provider(), ctx()), (e) => e instanceof AdapterError && /描述/.test(e.message));
    assert.equal(m.calls.length, 1, '空描述不发请求');
  } finally { m.restore(); }
});

test('结果抹平：二进制直接成 Buffer；extra 指定的裸 PCM 带采样率（normalizeOutput 据此包成 WAV）', async () => {
  const m = mockFetch(() => audio(Buffer.from([1, 2, 3, 4]), 'application/octet-stream'));
  try {
    const card = CARDS.eleven_v4;
    const out = await A.run(req('speech', 'eleven_v4', card, paramsOf(card, { extra: { output_format: 'pcm_44100' } })), provider(), ctx());
    assert.ok(Buffer.isBuffer(out.assets[0].bytes));
    assert.deepEqual([...out.assets[0].bytes], [1, 2, 3, 4]);
    assert.equal(out.assets[0].mime, 'audio/L16;rate=44100');
    assert.ok(m.calls[0].url.endsWith('?output_format=pcm_44100'));
  } finally { m.restore(); }
});

test('没填 Key：run / test / voices 直接报人话，listModels 给空，都不发请求', async () => {
  const m = mockFetch(() => jsonRes(200, {}));
  const nokey = ctx({ secret: { key: '' } });
  try {
    await assert.rejects(A.run(req('speech', 'eleven_v4', CARDS.eleven_v4, paramsOf(CARDS.eleven_v4, {})), provider(), nokey), /还没填 API Key/);
    await assert.rejects(A.test(provider(), nokey), /还没填 API Key/);
    await assert.rejects(A.voices(provider(), nokey), /还没填 API Key/);
    assert.deepEqual(await A.listModels(provider(), nokey), []);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('test()：只 GET 账户接口，detail 写剩余字符额度，不发生成请求', async () => {
  const m = mockFetch(() => jsonRes(200, { tier: 'creator', character_count: 1234, character_limit: 100000 }));
  try {
    const r = await A.test(provider(), ctx());
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].method, 'GET');
    assert.equal(m.calls[0].url, 'https://api.elevenlabs.io/v1/user/subscription');
    assert.match(r.detail, /剩余 98766 字符/);
  } finally { m.restore(); }
});

test('test()：401 / 403 抛「API Key 无效」', async () => {
  for (const status of [401, 403]) {
    const m = mockFetch(() => jsonRes(status, { detail: { type: 'authentication_error', code: 'invalid_api_key', message: 'bad key' } }));
    try {
      await assert.rejects(A.test(provider(), ctx()), (e) => e instanceof AdapterError && e.status === status && /API Key 无效/.test(e.message));
    } finally { m.restore(); }
  }
});

test('listModels：GET /models，只列能配音的 TTS 模型（speech）；音乐模型按卡补；music_v1 已弃用不列', async () => {
  const m = mockFetch(() => jsonRes(200, [
    { model_id: 'eleven_v4', name: 'Eleven v4', can_do_text_to_speech: true },
    { model_id: 'scribe_v2', name: 'Scribe v2', can_do_text_to_speech: false },
    { model_id: 'eleven_multilingual_sts_v2', name: 'STS', can_do_voice_conversion: true },
  ]));
  try {
    const list = await A.listModels(provider(), ctx());
    assert.equal(m.calls[0].url, 'https://api.elevenlabs.io/v1/models');
    assert.deepEqual(list, [
      { id: 'eleven_v4', label: 'Eleven v4', kind: 'speech' },
      { id: 'music_v2_5', label: 'Eleven Music v2.5', kind: 'music' },
      { id: 'music_v2', label: 'Eleven Music v2', kind: 'music' },
    ]);
  } finally { m.restore(); }
});

test('voices：v2 音色搜索按 has_more / next_page_token 翻页；账号音色在前、预置在后；同 id 去重；地址从 baseUrl 推出 /v2', async () => {
  const m = mockFetch((i, call) => {
    if (call.url.includes('voice_type=non-community') && !call.url.includes('next_page_token')) {
      return jsonRes(200, { voices: [{ voice_id: 'mine1', name: '我的声音', labels: { accent: 'american', gender: 'female', use_case: 'narration' } }], has_more: true, next_page_token: 'T2', total_count: 3 });
    }
    if (call.url.includes('next_page_token=T2')) {
      return jsonRes(200, { voices: [{ voice_id: 'mine2', name: '第二个', labels: {} }], has_more: false, next_page_token: null, total_count: 3 });
    }
    return jsonRes(200, { voices: [{ voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', labels: { accent: 'british', gender: 'male' } }, { voice_id: 'mine1', name: '重复', labels: {} }], has_more: false, total_count: 2 });
  });
  try {
    const list = await A.voices(provider({ baseUrl: 'https://proxy.example.com/el/v1' }), ctx(), 'eleven_v4');
    assert.match(m.calls[0].url, /^https:\/\/proxy\.example\.com\/el\/v2\/voices\?/);
    assert.ok(m.calls[0].url.includes('voice_type=non-community') && m.calls[0].url.includes('page_size=100'));
    assert.ok(m.calls[1].url.includes('next_page_token=T2'));
    assert.ok(m.calls[2].url.includes('voice_type=default'));
    assert.deepEqual(list, [
      { id: 'mine1', label: '我的声音', note: 'american · 女声 · narration' },
      { id: 'mine2', label: '第二个' },
      { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George', note: 'british · 男声' },
    ]);
  } finally { m.restore(); }
});

test('通用卡：未知的配音模型照样能跑（prompt → text，extra 原样合并，音色没给就用默认音色）', async () => {
  const m = mockFetch(() => audio(Buffer.from('x')));
  try {
    const card = genericCard('elevenlabs', 'speech');
    const out = await A.run(req('speech', 'eleven_future_x', card, paramsOf(card, { extra: { language_code: 'fr', stability: 0.9 } }), 'hello'), provider(), ctx());
    assert.equal(m.calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128');
    assert.deepEqual(m.calls[0].body, { text: 'hello', model_id: 'eleven_future_x', language_code: 'fr', stability: 0.9 });
    assert.equal(out.assets[0].mime, 'audio/mpeg');
  } finally { m.restore(); }
});

test('模型卡：登记进方言表；种类对；每张卡末尾是 extra（json）；默认值符合文档，音色设置和文本规范化不带默认', () => {
  assert.deepEqual(dialectBuiltinModels('elevenlabs').map((x) => x.id).sort(),
    ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v4', 'eleven_v4_turbo', 'music_v2', 'music_v2_5']);
  for (const [id, card] of Object.entries(CARDS)) {
    assert.ok(['speech', 'music'].includes(card.kind), id);
    assert.equal(card.params.at(-1).key, 'extra', id);
    assert.equal(card.params.at(-1).type, 'json', id);
  }
  const tts = paramsOf(CARDS.eleven_v4, {});
  assert.equal(tts.voice, 'JBFqnCBsd6RMkjVDRZzb');
  assert.equal(tts.outputFormat, 'mp3_44100_128');
  assert.equal(tts.stability, undefined, '音色设置不给默认值');
  assert.equal(tts.applyTextNormalization, undefined, '文本规范化不给默认值');
  const mus = paramsOf(CARDS.music_v2, {});
  assert.equal(mus.outputFormat, 'auto');
  assert.equal(mus.forceInstrumental, false);
});

test('只做配音和音乐：其他种类直接报错', async () => {
  await assert.rejects(A.run({ kind: 'image', model: 'x', card: null, prompt: 'x', params: {}, inputs: [], thread: null }, provider(), ctx()), /只做配音和音乐/);
});
