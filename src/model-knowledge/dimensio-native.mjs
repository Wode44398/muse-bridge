// dimensio 自带专门适配的那几家厂商（harness/server/catalog.ts 的 CATALOG，本机那家除外）在模型中心这边的登记。
//
// 2026-11-11 起模型中心是唯一的配置入口：这几家不再在 dimensio 里单独填 Key，而是模型中心里的一个普通服务——
// 服务上记着 native = 厂商 id，勾给 dimensio 的模型就落在 dimensio 原来那个厂商 id 上（专门的思考参数写法、逐个核对过的
// 型号表、个别厂商的特殊处理都照旧），Key 取这个服务的第一条可用线路。旧会话、默认模型里记着的厂商 id 不变。
//
// 这里只放模型中心要用的：怎么按地址认出是哪一家、迁移时建服务用的地址 / 协议 / 型号清单、harness/.env 里哪几个变量是它的 Key。
// 型号清单与 catalog.ts 对齐由 harness/server/native-vendors-contract.test.ts 守着（改 CATALOG 时这里跟着改）。
const host = (s) => new RegExp(`^${s.replace(/\./g, '\\.')}$`);
const M = (id, label, contextWindow, maxOutput, vision) => Object.freeze({ id, label, contextWindow, maxOutput, vision });

export const NATIVE_VENDORS = Object.freeze([
  {
    id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com',
    hosts: [host('api.anthropic.com')], envKey: ['ANTHROPIC_API_KEY'], envBase: [],
    models: [
      M('claude-fable-5-2', 'Fable 5.2', 1_000_000, 128_000, true),
      M('claude-opus-5-5', 'Opus 5.5', 1_000_000, 128_000, true),
      M('claude-opus-5', 'Opus 5', 1_000_000, 128_000, true),
      M('claude-sonnet-5-5', 'Sonnet 5.5', 1_000_000, 128_000, true),
      M('claude-opus-4-8', 'Opus 4.8', 1_000_000, 128_000, true),
      M('claude-opus-4-7', 'Opus 4.7', 1_000_000, 128_000, true),
      M('claude-sonnet-4-6', 'Sonnet 4.6', 1_000_000, 128_000, true),
      M('claude-haiku-5-5', 'Haiku 5.5', 1_000_000, 128_000, true),
      M('claude-haiku-4-5', 'Haiku 4.5', 200_000, 64_000, true),
    ],
  },
  {
    // dimensio 里这家的厂商 id 叫 openai（历史原因），接的是 DeepSeek
    id: 'openai', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
    hosts: [host('api.deepseek.com')], envKey: ['OPENAI_API_KEY'], envBase: ['OPENAI_BASE_URL'],
    models: [
      M('deepseek-flash', 'V4.1 Flash', 1_000_000, 393_216, true),
      M('deepseek-v4-pro', 'V4 Pro', 1_000_000, 393_216, false),
    ],
  },
  {
    id: 'qwen', name: 'Qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    hosts: [host('dashscope.aliyuncs.com'), host('dashscope-intl.aliyuncs.com'), host('dashscope-us.aliyuncs.com')],
    envKey: ['QWEN_API_KEY', 'VISION_API_KEY'], envBase: ['QWEN_BASE_URL', 'VISION_BASE_URL'],
    derive: (h) => `https://${h}/compatible-mode/v1`,
    models: [
      M('qwen3.8-max', 'Qwen3.8 Max', 1_000_000, 131_072, true),
      M('qwen3.8-flash', 'Qwen3.8 Flash', 1_000_000, 131_072, true),
      M('qwen3.7-max', 'Qwen3.7 Max', 1_000_000, 131_072, false),
      M('qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, 131_072, true),
      M('qwen3.7-flash', 'Qwen3.7 Flash', 1_000_000, 131_072, false),
    ],
  },
  {
    id: 'zhipu', name: 'Zhipu GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hosts: [host('open.bigmodel.cn')], envKey: ['ZHIPU_API_KEY'], envBase: ['ZHIPU_BASE_URL'],
    models: [
      M('glm-5.3', 'GLM-5.3', 1_000_000, 131_072, false),
      M('glm-5.3-flash', 'GLM-5.3 Flash', 1_000_000, 131_072, true),
      M('glm-5.2', 'GLM-5.2', 1_000_000, 131_072, false),
      M('glm-5', 'GLM-5', 200_000, 131_072, false),
    ],
  },
  {
    // Kimi for Coding（订阅端点）；开放平台 api.moonshot.cn 的 Key 与它不通用，不算这一家
    id: 'kimi', name: 'Kimi', protocol: 'openai', baseUrl: 'https://api.kimi.com/coding/v1',
    hosts: [host('api.kimi.com')], envKey: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], envBase: ['KIMI_BASE_URL'],
    models: [
      M('k3.1-pro', 'K3.1 Pro', 1_048_576, 65_536, true),
      M('k3.1-pro-highspeed', 'K3.1 Pro Highspeed', 1_048_576, 65_536, true),
      M('k3', 'K3', 1_048_576, 65_536, true),
      M('k3-256k', 'K3 256k', 262_144, 65_536, true),
      M('kimi-for-coding', 'K2.8 Preview', 1_048_576, 65_536, true),
      M('kimi-for-coding-highspeed', 'K2.7 Highspeed', 262_144, 65_536, true),
    ],
  },
  {
    id: 'mimo', name: 'Xiaomi MiMo', protocol: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1',
    hosts: [host('api.xiaomimimo.com'), /^token-plan-[a-z0-9-]+\.xiaomimimo\.com$/],
    envKey: ['MIMO_API_KEY'], envBase: ['MIMO_BASE_URL'],
    derive: (h) => `https://${h}/v1`,
    // Token Plan 的 tp- Key 与按量的 sk- Key 不通用（同 harness/server/config.ts providerDefaults）
    baseForKey: (key) => (String(key).startsWith('tp-') ? 'https://token-plan-cn.xiaomimimo.com/v1' : ''),
    models: [
      M('mimo-v2.6-pro', 'MiMo V2.6 Pro', 1_000_000, 131_072, true),
      M('mimo-v2.6-pro-ultraspeed', 'MiMo V2.6 Pro UltraSpeed', 1_000_000, 131_072, true),
      M('mimo-v2.6-flash', 'MiMo V2.6 Flash', 1_000_000, 131_072, true),
    ],
  },
  {
    id: 'gemini', name: 'Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    hosts: [host('generativelanguage.googleapis.com')], envKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], envBase: ['GEMINI_BASE_URL'],
    models: [
      M('gemini-4-argon', 'Gemini 4 Argon', 1_048_576, 32_768, true),
      M('gemini-3.5-flash', 'Gemini 3.5 Flash', 1_048_576, 65_536, true),
      M('gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 1_048_576, 65_536, true),
      M('gemini-2.5-flash', 'Gemini 2.5 Flash', 1_048_576, 65_536, true),
    ],
  },
].map((v) => Object.freeze({ ...v, models: Object.freeze(v.models) })));

export const NATIVE_VENDOR_IDS = Object.freeze(NATIVE_VENDORS.map((v) => v.id));
export const nativeVendor = (id) => NATIVE_VENDORS.find((v) => v.id === id) || null;

const hostnameOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ''; } };

/** 服务地址 → dimensio 自带适配的厂商 id（按主机名认，路径不管：DeepSeek 的 /anthropic 入口也算 DeepSeek）；认不出返回 ''。 */
export function nativeVendorOf(baseUrl) {
  const h = hostnameOf(baseUrl);
  if (!h) return '';
  return NATIVE_VENDORS.find((v) => v.hosts.some((re) => re.test(h)))?.id || '';
}

/**
 * dimensio 的专门适配该打哪个地址 → 地址；'' = 用它自己的默认地址（catalog.ts / harness/.env 里配的）。
 * 服务的协议就是这家适配说的那种（OpenAI 兼容）时照服务填的地址；服务填的是别的入口（给 Claude 用的 /anthropic）时，
 * 只有地址随主机名变的两家（小米的 Token Plan 集群、百炼的海外区）按主机名推，其余用默认。
 * Anthropic、Gemini 一律用默认（适配器自己拼路径）。
 */
export function nativeEndpoint(vendorId, { kind, baseUrl } = {}) {
  const v = nativeVendor(vendorId);
  if (!v || v.protocol !== 'openai') return '';
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  if (kind === 'openai') return clean;
  const h = hostnameOf(clean);
  return v.derive && h && v.hosts.some((re) => re.test(h)) ? v.derive(h) : '';
}
