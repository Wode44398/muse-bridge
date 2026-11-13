// replicate 适配器单测：全局 fetch 全部 mock，不联网、不需要 Key（未真打）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { replicateAdapter, CARDS } from './replicate.mjs';
import { dialectCards } from '../cards/dialects.mjs';
import { genericCard } from '../cards/spec.mjs';
import { AdapterError } from './http.mjs';

const API = 'https://api.replicate.com/v1';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const WEBP = Buffer.from('RIFF0000WEBPdata');

const provider = (o = {}) => ({ id: 'p-test0001', owner: 'admin', dialect: 'replicate', baseUrl: API, authStyle: 'bearer', headers: {}, params: {}, timeoutSec: 60, models: [], ...o });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bin = (buf, type) => new Response(buf, { status: 200, headers: { 'content-type': type } });

// 替换全局 fetch：handler(call) 返回 Response（没 mock 的返回 undefined）；所有调用记下来，测完还原
async function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method || 'GET').toUpperCase(),
      headers: { ...(init.headers || {}) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const res = await handler(call);
    if (!res) throw new Error(`未 mock 的请求：${call.method} ${call.url}`);
    return res;
  };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}

// 运行上下文：轮询间隔调到 1ms；记录 submitted 与 progress，events 记下先后顺序
function makeCtx(events = []) {
  const ac = new AbortController();
  const rec = { progress: [], submitted: 0 };
  const ctx = {
    secret: { key: 'k' }, signal: ac.signal, dispatcher: undefined, pollMs: 1,
    progress(p) { rec.progress.push(p); events.push('progress'); },
    submitted() { rec.submitted++; events.push('submitted'); },
  };
  return { ac, ctx, rec };
}

const imgReq = (o = {}) => ({
  kind: 'image', model: 'black-forest-labs/flux-schnell', card: CARDS['black-forest-labs/flux-schnell'],
  prompt: 'a red fox', negative: '', params: { aspect_ratio: '1:1', num_outputs: 1 }, inputs: [], thread: null, ...o,
});

test('官方模型：POST models/{owner}/{name}/predictions，body 只有 input；带 Bearer、Cancel-After，不带 Prefer: wait（拿到 id 立刻标 submitted）；输出文件带鉴权头下载', async () => {
  const { ctx } = makeCtx();
  await withFetch((c) => {
    if (c.method === 'POST') return json({ id: 'pred1', status: 'succeeded', output: 'https://replicate.delivery/pbxt/abc/out-0.webp', metrics: { predict_time: 1.2 } }, 201);
    if (c.url.startsWith('https://replicate.delivery/')) return bin(WEBP, 'image/webp');
    return undefined;
  }, async (calls) => {
    const { assets } = await replicateAdapter.run(imgReq(), provider(), ctx);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].mime, 'image/webp');
    assert.deepEqual(assets[0].bytes, WEBP);
    assert.equal(assets[0].meta.predictionId, 'pred1');
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.url, `${API}/models/black-forest-labs/flux-schnell/predictions`);
    assert.equal(post.headers.Authorization, 'Bearer k');
    assert.equal(post.headers.Prefer, undefined);
    assert.equal(post.headers['Cancel-After'], '60s');
    assert.deepEqual(Object.keys(post.body), ['input']);
    assert.equal(post.body.input.prompt, 'a red fox');
    assert.equal(post.body.input.aspect_ratio, '1:1');
    const file = calls.find((c) => c.url.startsWith('https://replicate.delivery/'));
    assert.equal(file.headers.Authorization, 'Bearer k');
  });
});

test('带版本：POST /predictions，body { version, input }；owner/name:版本号 和裸 64 位版本号都行', async () => {
  const hex = 'a'.repeat(64);
  for (const model of ['black-forest-labs/flux-schnell:0123abcd', hex]) {
    const { ctx } = makeCtx();
    await withFetch((c) => {
      if (c.method === 'POST') return json({ id: 'pred2', status: 'succeeded', output: ['https://replicate.delivery/x/o.webp'] }, 201);
      return bin(WEBP, 'image/webp');
    }, async (calls) => {
      await replicateAdapter.run(imgReq({ model }), provider(), ctx);
      const post = calls.find((c) => c.method === 'POST');
      assert.equal(post.url, `${API}/predictions`);
      assert.equal(post.body.version, model);
      assert.equal(post.body.input.prompt, 'a red fox');
      assert.equal('model' in post.body, false);
    });
  }
});

test('请求体合并：卡上参数 < provider.params < 逐次 extra，extra 本身不进请求体', async () => {
  const { ctx } = makeCtx();
  await withFetch((c) => (c.method === 'POST' ? json({ id: 'pred3', status: 'succeeded', output: 'https://replicate.delivery/x/o.webp' }, 201) : bin(WEBP, 'image/webp')), async (calls) => {
    await replicateAdapter.run(imgReq({ params: { aspect_ratio: '16:9', seed: 42, extra: { seed: 9, foo: 'bar' } } }), provider({ params: { seed: 7, keep: 'yes' } }), ctx);
    const input = calls.find((c) => c.method === 'POST').body.input;
    assert.equal(input.aspect_ratio, '16:9');   // 卡上参数
    assert.equal(input.keep, 'yes');            // provider.params
    assert.equal(input.seed, 9);                // 逐次 extra 最后合并，压过前两者
    assert.equal(input.foo, 'bar');
    assert.equal('extra' in input, false);
  });
});

test('Cancel-After 夹在 Replicate 允许的 5 秒到 24 小时之间', async () => {
  for (const [sec, want] of [[2, '5s'], [60, '60s'], [999999, '86400s']]) {
    const { ctx } = makeCtx();
    await withFetch((c) => (c.method === 'POST' ? json({ id: 'pred4', status: 'succeeded', output: 'https://replicate.delivery/x/o.webp' }, 201) : bin(WEBP, 'image/webp')), async (calls) => {
      await replicateAdapter.run(imgReq(), provider({ timeoutSec: sec }), ctx);
      assert.equal(calls.find((c) => c.method === 'POST').headers['Cancel-After'], want);
    });
  }
});

test('异步：starting → processing（日志里解析出 45%）→ succeeded；submitted 只调一次，且在第一次轮询之前', async () => {
  const events = [];
  const { ctx, rec } = makeCtx(events);
  const base = `${API}/predictions/pred5`;
  let gets = 0;
  await withFetch((c) => {
    if (c.method === 'POST') { events.push('POST'); return json({ id: 'pred5', status: 'starting', urls: { get: base, cancel: `${base}/cancel` } }, 201); }
    if (c.method === 'GET' && c.url === base) {
      gets++;
      events.push('GET');
      if (gets === 1) return json({ id: 'pred5', status: 'processing', logs: 'loading weights\n 45%|████▌     | 9/20 [00:02<00:03]' });
      return json({ id: 'pred5', status: 'succeeded', output: ['https://replicate.delivery/x/1.webp', 'https://replicate.delivery/x/2.webp'] });
    }
    return bin(WEBP, 'image/webp');
  }, async () => {
    const { assets } = await replicateAdapter.run(imgReq({ params: { aspect_ratio: '1:1', num_outputs: 2 } }), provider(), ctx);
    assert.equal(assets.length, 2);
    assert.equal(gets, 2);
    assert.equal(rec.submitted, 1);
    assert.ok(events.indexOf('POST') < events.indexOf('submitted'));
    assert.ok(events.indexOf('submitted') < events.indexOf('GET'));
    assert.ok(rec.progress.some((p) => p.progress === 0.45), JSON.stringify(rec.progress));
    assert.ok(rec.progress.every((p) => typeof p.elapsed === 'number'));
  });
});

test('提交时就已完成（极快的模型）：直接取结果，不轮询', async () => {
  const { ctx } = makeCtx();
  await withFetch((c) => (c.method === 'POST' ? json({ id: 'pred6', status: 'succeeded', output: 'https://replicate.delivery/x/a.webp' }, 201) : bin(WEBP, 'image/webp')), async (calls) => {
    const { assets } = await replicateAdapter.run(imgReq(), provider(), ctx);
    assert.equal(assets.length, 1);
    assert.equal(calls.filter((c) => c.method === 'GET' && c.url.includes('/predictions/')).length, 0);
  });
});

test('错误映射：401 → 含「API Key」的人话；422 → 上游原话透出', async () => {
  const { ctx } = makeCtx();
  await withFetch(() => json({ detail: 'Invalid token.' }, 401), async () => {
    await assert.rejects(replicateAdapter.run(imgReq(), provider(), ctx), (e) => e instanceof AdapterError && e.status === 401 && /API Key/.test(e.message));
  });
  // 422 会先按社区模型兜底查一次最新版本（这里 404，查不到），最后抛的还是原来的 422
  await withFetch((c) => (c.method === 'POST'
    ? json({ detail: [{ loc: ['body', 'input', 'aspect_ratio'], msg: "value is not a valid enumeration member; permitted: '1:1'", type: 'type_error.enum' }] }, 422)
    : json({ detail: 'Not found' }, 404)), async () => {
    await assert.rejects(replicateAdapter.run(imgReq({ params: { aspect_ratio: '7:3' } }), provider(), ctx), (e) => e.status === 422 && /not a valid enumeration member/.test(e.message));
  });
});

test('终态失败：failed 带服务方原因；canceled 给人话', async () => {
  const { ctx } = makeCtx();
  await withFetch(() => json({ id: 'pred8', status: 'failed', error: 'NSFW content detected' }, 201), async () => {
    await assert.rejects(replicateAdapter.run(imgReq(), provider(), ctx), /NSFW content detected/);
  });
  await withFetch(() => json({ id: 'pred8b', status: 'canceled' }, 201), async () => {
    await assert.rejects(replicateAdapter.run(imgReq(), provider(), ctx), /取消/);
  });
});

test('用户取消：轮询中 abort → 尽力 POST urls.cancel（不带 signal）；取消失败也不影响报错', async () => {
  const { ctx, ac } = makeCtx();
  const cancelUrl = `${API}/predictions/pred9/cancel`;
  ctx.progress = () => ac.abort();   // 第一次进度回报后用户点了取消
  await withFetch((c) => {
    if (c.method === 'POST') return json({ id: 'pred9', status: 'processing', urls: { get: `${API}/predictions/pred9`, cancel: cancelUrl } }, 201);
    if (c.url === cancelUrl) return json({ detail: 'boom' }, 500);
    return undefined;
  }, async (calls) => {
    await assert.rejects(replicateAdapter.run(imgReq(), provider(), ctx), (e) => e.code === 'aborted');
    const cancel = calls.find((c) => c.url === cancelUrl);
    assert.ok(cancel, '应该发出取消请求');
    assert.equal(cancel.method, 'POST');
    assert.equal(cancel.headers.Authorization, 'Bearer k');
  });
});

test('社区模型：owner/name 直连报 404 → 查最新版本号，再用 version 提交', async () => {
  const { ctx } = makeCtx();
  const ver = 'b'.repeat(64);
  await withFetch((c) => {
    if (c.method === 'POST' && c.url === `${API}/models/lucataco/ace-step/predictions`) return json({ detail: 'Not found' }, 404);
    if (c.method === 'GET' && c.url === `${API}/models/lucataco/ace-step`) return json({ owner: 'lucataco', name: 'ace-step', latest_version: { id: ver } });
    if (c.method === 'POST' && c.url === `${API}/predictions`) return json({ id: 'pred10', status: 'succeeded', output: 'https://replicate.delivery/x/a.mp3' }, 201);
    if (c.url === 'https://replicate.delivery/x/a.mp3') return bin(Buffer.from('ID3'), 'audio/mpeg');
    return undefined;
  }, async (calls) => {
    const req = { kind: 'music', model: 'lucataco/ace-step', card: genericCard('replicate', 'music'), prompt: 'lofi', negative: '', params: {}, inputs: [], thread: null };
    const { assets } = await replicateAdapter.run(req, provider(), ctx);
    assert.equal(assets[0].mime, 'audio/mpeg');
    const post = calls.filter((c) => c.method === 'POST').pop();
    assert.equal(post.url, `${API}/predictions`);
    assert.equal(post.body.version, ver);
    assert.equal(post.body.input.prompt, 'lofi');
  });
});

test('轮询时偶发网络错误不直接失败：继续重试', async () => {
  const { ctx } = makeCtx();
  let gets = 0;
  await withFetch((c) => {
    if (c.method === 'POST') return json({ id: 'pred11', status: 'starting', urls: { get: `${API}/predictions/pred11` } }, 201);
    if (c.method === 'GET' && c.url === `${API}/predictions/pred11`) {
      gets++;
      if (gets === 1) throw new TypeError('fetch failed');   // 网络断了一下
      return json({ id: 'pred11', status: 'succeeded', output: 'https://replicate.delivery/x/o.webp' });
    }
    return bin(WEBP, 'image/webp');   // 结果文件的下载
  }, async () => {
    const { assets } = await replicateAdapter.run(imgReq(), provider(), ctx);
    assert.equal(assets.length, 1);
    assert.equal(gets, 2);
  });
});

test('未知模型（通用卡）能跑：prompt、aspectRatio→aspect_ratio（auto 不传）、durationSeconds→duration、首帧→image，extra 原样合并', async () => {
  const card = genericCard('replicate', 'video');
  for (const aspectRatio of ['16:9', 'auto']) {
    const { ctx } = makeCtx();
    await withFetch((c) => (c.method === 'POST' ? json({ id: 'pred12', status: 'succeeded', output: 'https://replicate.delivery/x/v.mp4' }, 201) : bin(Buffer.from('mp4'), 'video/mp4')), async (calls) => {
      const req = {
        kind: 'video', model: 'someone/unknown-video', card, prompt: 'a cat jumping', negative: '',
        params: { aspectRatio, durationSeconds: 6, extra: { quality: 'high' } },
        inputs: [{ role: 'first', data: PNG, mime: 'image/png', name: 'f.png' }], thread: null,
      };
      const { assets } = await replicateAdapter.run(req, provider(), ctx);
      assert.equal(assets[0].mime, 'video/mp4');
      const post = calls.find((c) => c.method === 'POST');
      assert.equal(post.url, `${API}/models/someone/unknown-video/predictions`);
      const input = post.body.input;
      assert.equal(input.prompt, 'a cat jumping');
      assert.equal(input.duration, 6);
      assert.equal(input.quality, 'high');
      assert.equal(input.image, `data:image/png;base64,${PNG.toString('base64')}`);
      assert.equal(input.aspect_ratio, aspectRatio === 'auto' ? undefined : '16:9');
      assert.equal('aspectRatio' in input, false);
      assert.equal('durationSeconds' in input, false);
    });
  }
});

test('素材：卡上写死字段名（flux-2-pro → input_images 数组）；没给素材时续改链上一张当参考；文本卡不收图', async () => {
  const ok = (c) => (c.method === 'POST' ? json({ id: 'pred13', status: 'succeeded', output: 'https://replicate.delivery/x/o.webp' }, 201) : bin(WEBP, 'image/webp'));
  const flux2 = CARDS['black-forest-labs/flux-2-pro'];
  const { ctx } = makeCtx();
  await withFetch(ok, async (calls) => {
    await replicateAdapter.run(imgReq({ model: 'black-forest-labs/flux-2-pro', card: flux2, inputs: [{ role: 'edit', data: PNG, mime: 'image/png' }, { role: 'ref', data: PNG, mime: 'image/png' }] }), provider(), ctx);
    const input = calls.find((c) => c.method === 'POST').body.input;
    assert.equal(input.input_images.length, 2);
    assert.match(input.input_images[0], /^data:image\/png;base64,/);
  });
  await withFetch(ok, async (calls) => {
    await replicateAdapter.run(imgReq({ model: 'black-forest-labs/flux-2-pro', card: flux2, inputs: [], thread: { turns: [{ userText: '上一句', data: PNG, mime: 'image/png' }] } }), provider(), ctx);
    assert.equal(calls.find((c) => c.method === 'POST').body.input.input_images.length, 1);
  });
  await withFetch(ok, async (calls) => {
    // 文本卡（flux-schnell）给了改图素材：报错，不许悄悄丢掉
    await assert.rejects(replicateAdapter.run(imgReq({ inputs: [{ role: 'edit', data: PNG, mime: 'image/png' }] }), provider(), ctx), /不收「改图」素材/);
    assert.equal(calls.length, 0);
    // 文本卡 + 续改链：续改链的图只给能改图的卡，这里按普通文生图走
    await replicateAdapter.run(imgReq({ inputs: [], thread: { turns: [{ userText: '上一句', data: PNG, mime: 'image/png' }] } }), provider(), ctx);
    const input = calls.find((c) => c.method === 'POST').body.input;
    assert.equal('input_images' in input, false);
  });
});

test('结果抹平：对象只取媒体后缀的地址；数组里外域图不带鉴权头、replicate 域名的带、data URL 直接解码成 Buffer', async () => {
  {
    const { ctx } = makeCtx();
    const req = { kind: 'speech', model: 'minimax/speech-2.8-hd', card: CARDS['minimax/speech-2.8-hd'], prompt: '你好', negative: '', params: {}, inputs: [], thread: null };
    await withFetch((c) => {
      if (c.method === 'POST') return json({ id: 'pred14', status: 'succeeded', output: { audio: 'https://replicate.delivery/x/a.mp3', subtitles: 'https://cdn.example.com/s.json' } }, 201);
      return bin(Buffer.from('ID3-audio'), 'audio/mpeg');
    }, async (calls) => {
      const { assets } = await replicateAdapter.run(req, provider(), ctx);
      assert.equal(assets.length, 1);
      assert.equal(assets[0].mime, 'audio/mpeg');
      assert.equal(calls.find((c) => c.url.endsWith('/a.mp3')).headers.Authorization, 'Bearer k');
      assert.equal(calls.some((c) => c.url.includes('cdn.example.com')), false);
    });
  }
  {
    const { ctx } = makeCtx();
    const dataUri = `data:text/plain;base64,${Buffer.from('hello-data').toString('base64')}`;
    await withFetch((c) => {
      if (c.method === 'POST') return json({ id: 'pred14b', status: 'succeeded', output: ['https://cdn.example.com/x.png', 'https://replicate.delivery/y.png', dataUri] }, 201);
      return bin(Buffer.from('PNG'), 'image/png');
    }, async (calls) => {
      const { assets } = await replicateAdapter.run(imgReq(), provider(), ctx);
      assert.equal(assets.length, 3);
      assert.equal(calls.find((c) => c.url === 'https://cdn.example.com/x.png').headers.Authorization, undefined);
      assert.equal(calls.find((c) => c.url === 'https://replicate.delivery/y.png').headers.Authorization, 'Bearer k');
      assert.equal(assets[2].bytes.toString(), 'hello-data');
    });
  }
});

test('test()：只调 GET /account（零成本，不生成）；401 / 403 → 「API Key 无效」；没填 Key 时一个请求都不发', async () => {
  await withFetch((c) => json({ type: 'user', username: 'alice' }), async (calls) => {
    const r = await replicateAdapter.test(provider(), { secret: { key: 'k' } });
    assert.match(r.detail, /alice/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, `${API}/account`);
    assert.equal(calls[0].headers.Authorization, 'Bearer k');
  });
  for (const status of [401, 403]) {
    await withFetch(() => json({ detail: 'Invalid token.' }, status), async () => {
      await assert.rejects(replicateAdapter.test(provider(), { secret: { key: 'bad' } }), (e) => e.status === status && /API Key 无效/.test(e.message));
    });
  }
  await withFetch(() => { throw new Error('不该发请求'); }, async (calls) => {
    await assert.rejects(replicateAdapter.test(provider(), { secret: {} }), /还没填 API Key/);
    assert.equal(calls.length, 0);
  });
});

test('listModels：读官方集合，kind 按集合定，owner/name 去重；单个集合失败不影响其余，全部失败才抛错', async () => {
  const cols = {
    'text-to-image': { models: [{ owner: 'black-forest-labs', name: 'flux-schnell' }, { url: 'https://replicate.com/google/imagen-4' }] },
    'text-to-video': { models: [{ owner: 'google', name: 'veo-3.1' }, { owner: 'black-forest-labs', name: 'flux-schnell' }] },
    'text-to-speech': { models: [{ owner: 'minimax', name: 'speech-2.8-hd' }, { url: 'not a url' }] },
    'ai-music-generation': { models: [{ owner: 'google', name: 'lyria-2' }] },
  };
  const serve = (c) => {
    const slug = c.url.split('/collections/')[1];
    return cols[slug] ? json(cols[slug]) : undefined;
  };
  await withFetch(serve, async (calls) => {
    const list = await replicateAdapter.listModels(provider(), { secret: { key: 'k' } });
    assert.deepEqual(list.map((m) => [m.id, m.kind]), [
      ['black-forest-labs/flux-schnell', 'image'],
      ['google/imagen-4', 'image'],
      ['google/veo-3.1', 'video'],
      ['minimax/speech-2.8-hd', 'speech'],
      ['google/lyria-2', 'music'],
    ]);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].url, `${API}/collections/text-to-image`);
  });
  await withFetch((c) => (c.url.endsWith('/text-to-video') ? json({ detail: 'Not found' }, 404) : serve(c)), async () => {
    const list = await replicateAdapter.listModels(provider(), { secret: { key: 'k' } });
    assert.deepEqual(list.map((m) => m.id), ['black-forest-labs/flux-schnell', 'google/imagen-4', 'minimax/speech-2.8-hd', 'google/lyria-2']);
  });
  await withFetch(() => json({ detail: 'Not found' }, 404), async () => {
    await assert.rejects(replicateAdapter.listModels(provider(), { secret: { key: 'k' } }), (e) => e.status === 404);
  });
});

test('voices：schema 里有 voice 枚举就用它（支持 $ref）；没有就用卡上的内置表；模型查不到就是 []', async () => {
  const modelJson = (props, schemas = {}) => json({ latest_version: { openapi_schema: { components: { schemas: { Input: { properties: props }, ...schemas } } } } });
  await withFetch((c) => {
    if (c.url === `${API}/models/google/gemini-3.1-flash-tts`) return modelJson({ text: { type: 'string' }, voice: { $ref: '#/components/schemas/Voice' } }, { Voice: { type: 'string', enum: ['Kore', 'Puck'] } });
    if (c.url === `${API}/models/minimax/speech-2.8-hd`) return modelJson({ voice_id: { type: 'string' } });
    return json({ detail: 'Not found' }, 404);
  }, async () => {
    const opt = { secret: { key: 'k' } };
    assert.deepEqual((await replicateAdapter.voices(provider(), opt, 'google/gemini-3.1-flash-tts')).map((v) => v.id), ['Kore', 'Puck']);
    const mm = await replicateAdapter.voices(provider(), opt, 'minimax/speech-2.8-hd');
    assert.ok(mm.some((v) => v.id === 'English_Wiselady') && mm.every((v) => v.note), JSON.stringify(mm));
    assert.deepEqual(await replicateAdapter.voices(provider(), opt, 'someone/unknown-tts'), []);
  });
});

test('CARDS 自检：四种各 2–4 张；枚举默认值在选项里；P.json 放最后；素材角色都在 inputs 里声明；已登记到方言表', () => {
  const byKind = {};
  for (const [id, card] of Object.entries(CARDS)) {
    byKind[card.kind] = (byKind[card.kind] || 0) + 1;
    assert.equal(card.params.at(-1).key, 'extra', `${id}：P.json() 要放最后`);
    for (const s of card.params) {
      if (s.type === 'enum') assert.ok(s.options.some((o) => o.value === s.default), `${id}.${s.key} 的默认值 ${s.default} 不在选项里`);
    }
    for (const role of Object.keys(card.wire?.images || {})) {
      assert.ok(card.inputs.images?.roles.includes(role), `${id}：素材角色 ${role} 没在 inputs.images.roles 里`);
    }
    assert.equal(dialectCards('replicate', id)?.kind, card.kind, `${id} 没登记到方言表`);
  }
  for (const k of ['image', 'video', 'speech', 'music']) assert.ok(byKind[k] >= 2 && byKind[k] <= 4, `${k} 有 ${byKind[k]} 张卡`);
  assert.equal(CARDS['google/gemini-3.1-flash-tts'].params.find((s) => s.type === 'voice').options.length, 30);
});
