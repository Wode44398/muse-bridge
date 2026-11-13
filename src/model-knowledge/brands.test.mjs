// 品牌表的自检：型号 → 模型厂（各种前缀 / 后缀写法）、服务地址 → 提供商（含本机端口与不带 scheme 的主机名）、
// 快捷选择的顺序与地址 / 协议自洽、表的规模与键唯一，以及 .d.mts 声明与运行时一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDORS, vendorOf, vendorInfo, PROVIDERS, FEATURED_PROVIDERS, providerOf, providerInfo } from './brands.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const VENDOR_CASES = [
  // 前缀 / 后缀写法
  ['models/gemini-2.5-pro', 'google'], ['publishers/google/models/gemini-2.0-flash', 'google'],
  ['projects/p/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-5', 'anthropic'],
  ['accounts/fireworks/models/llama-v3p1-70b-instruct', 'meta'], ['accounts/fireworks/models/deepseek-v3', 'deepseek'],
  ['@cf/meta/llama-3.1-8b-instruct', 'meta'], ['@cf/baai/bge-m3', 'baai'], ['@hf/thebloke/mistral-7b-instruct-v0.1-awq', 'mistral'],
  ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'anthropic'], ['global.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic'],
  ['eu.meta.llama3-2-3b-instruct-v1:0', 'meta'], ['amazon.nova-pro-v1:0', 'amazon'], ['mistral.mistral-large-2407-v1:0', 'mistral'],
  ['cohere.command-r-plus-v1:0', 'cohere'], ['ai21.jamba-1-5-large-v1:0', 'ai21'], ['deepseek.r1-v1:0', 'deepseek'],
  ['openai.gpt-oss-120b-1:0', 'openai'], ['twelvelabs.pegasus-1-2-v1:0', 'twelvelabs'],
  ['claude-sonnet-4-5[1m]', 'anthropic'], ['deepseek/deepseek-r1:free', 'deepseek'], ['anthropic/claude-3.7-sonnet:thinking', 'anthropic'],
  ['~anthropic/claude-sonnet-latest', 'anthropic'], ['llama3.2:3b', 'meta'], ['qwen2.5-coder:7b', 'qwen'],
  // 「厂商/型号」：查别名、跳过转传层
  ['fal-ai/flux-pro/kontext', 'bfl'], ['fal-ai/kling-video/v2.1/pro/image-to-video', 'kuaishou'], ['fal-ai/bytedance/seedream/v4/text-to-image', 'bytedance'],
  ['fal-ai/minimax/hailuo-02/standard/text-to-video', 'minimax'], ['fal-ai/wan/v2.2-a14b/text-to-video', 'alibaba'],
  ['openrouter/auto', 'openrouter'], ['openrouter/anthropic/claude-3.5-sonnet', 'anthropic'], ['Pro/deepseek-ai/DeepSeek-V3', 'deepseek'],
  ['Pro/moonshotai/Kimi-K2-Instruct', 'moonshot'], ['THUDM/GLM-4.1V-9B-Thinking', 'zhipu'], ['zai-org/GLM-4.6', 'zhipu'], ['z-ai/glm-4.6', 'zhipu'],
  ['x-ai/grok-4', 'xai'], ['meta-llama/llama-4-maverick', 'meta'], ['mistralai/codestral-2508', 'mistral'], ['bytedance-seed/seedream-4.5', 'bytedance'],
  ['inclusionai/ling-1t', 'antgroup'], ['kwaivgi/kling-v3.0-pro', 'kuaishou'], ['Kwai-Kolors/Kolors', 'kuaishou'], ['black-forest-labs/FLUX.1-schnell', 'bfl'],
  ['stabilityai/stable-diffusion-3-5-large', 'stability'], ['Wan-AI/Wan2.2-T2V-A14B', 'alibaba'], ['FunAudioLLM/CosyVoice2-0.5B', 'alibaba'],
  ['BAAI/bge-reranker-v2-m3', 'baai'], ['unsloth/Llama-3.2-3B-Instruct-GGUF', 'meta'], ['hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF', 'qwen'],
  ['lmstudio-community/gemma-3-12b-it-GGUF', 'google'], ['library/llama3.2', 'meta'], ['writer/palmyra-x5', 'writer'], ['nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia'],
  ['aion-labs/aion-rp-llama-3.1-8b', 'aionlabs'], ['inference-net/schematron-v2-small', 'inferencenet'], ['nightmareai/real-esrgan', ''],
  // 只看名字，开头锚定（先到先得）
  ['deepseek-r1-distill-qwen-32b', 'deepseek'], ['deepseek-ai/DeepSeek-R1-Distill-Llama-70B', 'deepseek'], ['llama-3.1-nemotron-70b-instruct', 'nvidia'],
  ['gpt-oss-120b', 'openai'], ['o3-mini', 'openai'], ['o1', 'openai'], ['chatgpt-4o-latest', 'openai'], ['dall-e-3', 'openai'], ['sora-2', 'openai'],
  ['whisper-1', 'openai'], ['tts-1-hd', 'openai'], ['text-embedding-3-large', 'openai'], ['omni-moderation-latest', 'openai'],
  ['text-embedding-004', 'google'], ['gemini-embedding-001', 'google'], ['text-embedding-v4', 'qwen'], ['embedding-3', 'zhipu'],
  ['gemma-3-27b-it', 'google'], ['imagen-4.0-generate-001', 'google'], ['veo-3.0-generate-001', 'google'], ['lyria-002', 'google'], ['nano-banana', 'google'],
  ['qwen-vl-max', 'qwen'], ['qwq-plus', 'qwen'], ['wanx2.1-t2i-turbo', 'alibaba'], ['wan2.2-t2v-plus', 'alibaba'], ['cosyvoice-v2', 'alibaba'],
  ['paraformer-v2', 'alibaba'], ['glm-4.6v', 'zhipu'], ['cogview-4', 'zhipu'], ['kimi-k2-0905-preview', 'moonshot'], ['moonshot-v1-8k', 'moonshot'],
  ['MiniMax-M2', 'minimax'], ['abab6.5s-chat', 'minimax'], ['speech-02-hd', 'minimax'], ['speech-2.6-hd', 'minimax'], ['image-01', 'minimax'],
  ['video-01', 'minimax'], ['T2V-01', 'minimax'], ['music-1.5', 'minimax'], ['hailuo-02', 'minimax'], ['speech-1.6', 'fishaudio'],
  ['doubao-seed-1-6-250615', 'bytedance'], ['doubao-seedream-4-0-250828', 'bytedance'], ['seed-oss-36b', 'bytedance'], ['seedance-1-pro', 'bytedance'],
  ['grok-imagine-image', 'xai'], ['pixtral-12b', 'mistral'], ['ministral-8b', 'mistral'], ['mimo-v2-flash', 'xiaomi'], ['hunyuan-t1-latest', 'tencent'],
  ['ernie-4.5-turbo', 'baidu'], ['step-2-16k', 'stepfun'], ['yi-lightning', 'zeroone'], ['Baichuan4', 'baichuan'], ['generalv3.5', 'iflytek'],
  ['4.0Ultra', 'iflytek'], ['internlm3-8b-instruct', 'internlm'], ['MiniCPM-V-2_6', 'openbmb'], ['phi-4', 'microsoft'], ['nova-lite-v1', 'amazon'],
  ['nova-ptc-xl-v1', 'sensenova'], ['command-a-03-2025', 'cohere'], ['rerank-v3.5', 'cohere'], ['rerank-2', 'voyage'], ['sonar-pro', 'perplexity'],
  ['jamba-1.5-large', 'ai21'], ['lfm-40b', 'liquid'], ['mercury-coder', 'inception'], ['hermes-3-llama-3.1-405b', 'nousresearch'],
  ['solar-pro', 'upstage'], ['granite-3.3-8b-instruct', 'ibm'], ['flux-dev', 'bfl'], ['ideogram-v3', 'ideogram'], ['recraft-v3', 'recraft'],
  ['kling-v2-1', 'kuaishou'], ['kolors', 'kuaishou'], ['gen4_turbo', 'runway'], ['ray-2', 'luma'], ['photon-1', 'luma'], ['pika-2.2', 'pika'],
  ['vidu-q1', 'vidu'], ['ltx-video', 'lightricks'], ['suno-v4.5', 'suno'], ['eleven_multilingual_v2', 'elevenlabs'], ['scribe_v1', 'elevenlabs'],
  ['bge-m3', 'baai'], ['jina-embeddings-v3', 'jina'], ['rwkv-6', 'rwkv'], ['olmo-2-32b', 'ai2'], ['falcon-180b', 'tii'], ['exaone-3.5', 'lg'],
  ['longcat-flash-chat', 'meituan'], ['ring-1t', 'antgroup'], ['skywork-o1', 'skywork'], ['pangu-pro-moe', 'huawei'], ['palmyra-x5', 'writer'],
  ['dolphin-mixtral-8x22b', 'cognitivecomputations'], ['moondream2', 'moondream'], ['inkling', 'thinkingmachines'], ['nomic-embed-text', 'nomic'],
  ['mxbai-embed-large', 'mixedbread'], ['palm-2', 'google'], ['gpt-j-6b', 'eleutherai'],
  // 认不出 / 明确不是
  ['gpt-sovits-v2', ''], ['my-finetune-7b', ''], ['', ''], ['   ', ''], [null, ''], [undefined, ''], ['scaledown/summarize', ''],
];

test('型号 → 模型厂：前缀 / 后缀剥干净、别名表、转传层跳过、开头锚定', () => {
  const wrong = [];
  for (const [id, want] of VENDOR_CASES) {
    const got = vendorOf(id);
    if (got !== want) wrong.push(`${id}: 应为 ${want || '(无)'}，实际 ${got || '(无)'}`);
  }
  assert.deepEqual(wrong, []);
});

test('vendorOf 的结果都在 VENDORS 里；vendorInfo 收别名', () => {
  for (const [id] of VENDOR_CASES) {
    const v = vendorOf(id);
    if (v) assert.ok(VENDORS[v], `${id} → ${v} 不在 VENDORS`);
  }
  assert.deepEqual(vendorInfo('anthropic'), { key: 'anthropic', name: 'Anthropic', logo: 'claude-color' });
  assert.equal(vendorInfo('x-ai').key, 'xai');
  assert.equal(vendorInfo('MoonshotAI').name, 'Kimi');
  assert.equal(vendorInfo('nope'), null);
  assert.equal(vendorInfo(''), null);
  assert.equal(vendorInfo(null), null);
  assert.equal(vendorInfo('constructor'), null);
  assert.equal(vendorInfo('toString'), null);
});

test('VENDORS：数量够、展示名可认、国内厂商用中文名、logo 按约定', () => {
  const keys = Object.keys(VENDORS);
  assert.ok(keys.length >= 55, `只有 ${keys.length} 家`);
  for (const [k, v] of Object.entries(VENDORS)) {
    assert.ok(v.name && typeof v.name === 'string', k);
    assert.equal(typeof v.logo, 'string', k);
    assert.ok(!/\.svg$/.test(v.logo), `${k} 的 logo 应是基名`);
  }
  assert.equal(VENDORS.qwen.name, '通义千问');
  assert.equal(VENDORS.zhipu.name, '智谱 GLM');
  assert.equal(VENDORS.moonshot.name, 'Kimi');
  assert.equal(VENDORS.bytedance.name, '豆包');
  assert.equal(VENDORS.kuaishou.name, '可灵');
  assert.equal(VENDORS.anthropic.logo, 'claude-color');
  assert.equal(VENDORS.openai.logo, 'openai');
  assert.ok(Object.isFrozen(VENDORS) && Object.isFrozen(VENDORS.openai));
});

const PROVIDER_CASES = [
  ['https://openrouter.ai/api/v1', 'openrouter', 'openai'], ['https://api.openai.com/v1', 'openai', 'openai'],
  ['https://api.anthropic.com', 'anthropic', 'anthropic'], ['https://api.anthropic.com/v1', 'anthropic', 'anthropic'],
  ['https://generativelanguage.googleapis.com/v1beta', 'gemini', 'gemini'], ['https://generativelanguage.googleapis.com', 'gemini', 'gemini'],
  ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini', 'openai'],
  ['api.deepseek.com', 'deepseek', 'openai'], ['https://api.deepseek.com/anthropic', 'deepseek', 'anthropic'],
  ['https://api.siliconflow.cn/v1', 'siliconflow', 'openai'], ['https://api.siliconflow.com/v1', 'siliconflow', 'openai'],
  ['https://dashscope.aliyuncs.com/apps/anthropic', 'dashscope', 'anthropic'], ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'dashscope', 'openai'],
  ['https://open.bigmodel.cn/api/paas/v4', 'zhipu', 'openai'], ['https://open.bigmodel.cn/api/anthropic', 'zhipu', 'anthropic'],
  ['https://api.moonshot.cn/v1', 'moonshot', 'openai'], ['https://api.kimi.com/coding/v1', 'kimi-code', 'openai'],
  ['https://ark.cn-beijing.volces.com/api/v3', 'ark', 'openai'], ['https://api.minimaxi.com/anthropic', 'minimax', 'anthropic'],
  ['https://api.minimax.io/v1', 'minimax', 'openai'], ['https://token-plan-cn.xiaomimimo.com/anthropic', 'mimo', 'anthropic'],
  ['https://api.x.ai/v1', 'xai', 'openai'], ['https://api.mistral.ai/v1', 'mistral', 'openai'], ['https://api.groq.com/openai/v1', 'groq', 'openai'],
  ['https://api.together.xyz/v1', 'together', 'openai'], ['https://api.z.ai/api/anthropic', 'zai', 'anthropic'],
  ['https://models.inference.ai.azure.com', 'github', 'openai'], ['https://myres.openai.azure.com/openai/deployments/x', 'azure', 'openai'],
  ['https://bedrock-runtime.us-east-1.amazonaws.com', 'bedrock', undefined], ['https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', 'bedrock', 'openai'],
  ['https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1', 'vertex', undefined],
  ['https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi', 'vertex', 'openai'],
  ['https://queue.fal.run', 'fal', undefined], ['https://api.replicate.com/v1', 'replicate', undefined], ['https://api.elevenlabs.io/v1', 'elevenlabs', undefined],
  ['https://integrate.api.nvidia.com/v1', 'nvidia', 'openai'], ['https://api.fireworks.ai/inference/v1', 'fireworks', 'openai'],
  ['https://api.deepinfra.com/v1/openai', 'deepinfra', 'openai'], ['https://router.huggingface.co/v1', 'huggingface', 'openai'],
  // 本机：只能靠端口认
  ['http://127.0.0.1:11434/v1', 'ollama', 'openai'], ['http://localhost:11434', 'ollama', 'openai'], ['http://[::1]:11434/v1', 'ollama', 'openai'],
  ['http://192.168.1.5:1234/v1', 'lmstudio', 'openai'], ['http://127.0.0.1:8000/v1', 'vllm', 'openai'], ['http://10.0.0.8:9997/v1', 'xinference', 'openai'],
  // 认不出 / 冒充的主机名
  ['http://example.com:8000/v1', null], ['https://evil-openai.com/v1', null], ['https://openai.com.evil.io/v1', null],
  ['https://relay.example.com/v1', null], ['', null], [null, null], ['::::', null],
  // 任何人都能挂的自建中转不按托管方认；公网上的 1234 端口不当 LM Studio
  ['https://my-openai-proxy.someone.workers' + '.dev/v1', null], ['https://someone-relay.hf.space/v1', null], ['http://203.0.113.5:1234/v1', null],
];

test('服务地址 → 提供商与协议提示', () => {
  const wrong = [];
  for (const [url, key, proto] of PROVIDER_CASES) {
    const p = providerOf(url);
    const got = p ? `${p.key}/${p.protocol}` : 'null';
    const want = key ? `${key}/${proto}` : 'null';
    if (got !== want) wrong.push(`${url}: 应为 ${want}，实际 ${got}`);
  }
  assert.deepEqual(wrong, []);
  assert.equal(providerOf('https://queue.fal.run').mediaOnly, true);
  assert.equal(providerOf('https://api.openai.com/v1').mediaOnly, undefined);
  assert.deepEqual(Object.keys(providerOf('https://api.openai.com/v1')).sort(), ['key', 'logo', 'name', 'protocol']);
});

test('快捷选择：顺序固定，baseUrl / protocol 与 providerOf 自洽', () => {
  assert.deepEqual(FEATURED_PROVIDERS.map((p) => p.name), [
    'OpenRouter', 'OpenAI', 'Anthropic', 'Gemini', 'DeepSeek', '硅基流动', '阿里云百炼', '智谱 GLM',
    'Kimi Code', 'Kimi', '火山方舟', 'MiniMax', '小米 MiMo', 'xAI', 'Mistral', 'Groq', 'Together AI',
  ]);
  for (const p of FEATURED_PROVIDERS) {
    assert.ok(p.baseUrl && p.protocol, `${p.key} 缺地址或协议`);
    const hit = providerOf(p.baseUrl);
    assert.equal(hit?.key, p.key, p.baseUrl);
    assert.equal(hit.protocol, p.protocol, p.baseUrl);
  }
  // 非快捷的条目写了地址的，也要认回自己
  for (const p of PROVIDERS) if (p.baseUrl) assert.equal(providerOf(p.baseUrl)?.key, p.key, p.baseUrl);
});

test('PROVIDERS：数量够、键唯一、主机规则是正则、logo 是基名；Anthropic 提供商用公司字标', () => {
  assert.ok(PROVIDERS.length >= 70, `只有 ${PROVIDERS.length} 家`);
  const keys = PROVIDERS.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length, '提供商键重复');
  for (const p of PROVIDERS) {
    assert.ok(p.name && p.hosts.length && p.hosts.every((re) => re instanceof RegExp), p.key);
    assert.equal(typeof p.logo, 'string', p.key);
    assert.ok(!p.protocol || ['openai', 'anthropic', 'gemini'].includes(p.protocol), p.key);
  }
  assert.equal(providerInfo('anthropic').logo, 'anthropic');
  assert.ok(Object.isFrozen(PROVIDERS) && Object.isFrozen(PROVIDERS[0]) && Object.isFrozen(FEATURED_PROVIDERS));
});

test('providerInfo 收仓库里的旧 id，不带 hosts', () => {
  assert.equal(providerInfo('mimo-plan').key, 'mimo');
  assert.equal(providerInfo('local').key, 'ollama');
  assert.equal(providerInfo('bailian').key, 'dashscope');
  assert.equal(providerInfo('Volcengine').key, 'ark');
  assert.equal(providerInfo('kimi').key, 'moonshot');
  assert.equal(providerInfo('openrouter').baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(providerInfo('openrouter').hosts, undefined);
  assert.equal(providerInfo('nope'), null);
  assert.equal(providerInfo(undefined), null);
  assert.equal(providerInfo('constructor'), null);
});

function declared(file) {
  const src = readFileSync(path.join(HERE, file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
}

test('brands.d.mts 声明的导出与运行时一致；index 一并转出', async () => {
  const mod = await import('./brands.mjs');
  assert.deepEqual([...declared('brands.d.mts')].sort(), Object.keys(mod).sort());
  const idx = await import('./index.mjs');
  for (const n of [...Object.keys(mod), 'classifyModality', 'MODALITIES']) assert.ok(n in idx, `index 没转出 ${n}`);
});
