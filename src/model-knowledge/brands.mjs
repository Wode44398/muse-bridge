// 品牌表：模型厂（VENDORS，按型号 ID 认）与提供商（PROVIDERS，按服务地址认）。
//
// 两张表分开，因为它们回答的是两个问题：同一个 deepseek-r1 可以从 DeepSeek 官方、硅基流动、OpenRouter、
// 本机 Ollama 拿到——提供商是「这条线路是谁家的」，模型厂是「这个型号是谁做的」。模型中心的服务卡显示提供商，
// 模型行显示模型厂。
//
// logo = lobehub 图标库（@lobehub/icons-static-svg）的文件基名：有 -color 版优先用它；本来就是单色的品牌
// （OpenAI、xAI / Grok、Ollama、月之暗面、OpenRouter…）用单色版，由前端填 currentColor，深浅色都看得见。
// 图标库里没有的写 ''，前端画首字头像。web/scripts/gen-brand-logos.mjs 按这里用到的 logo 收图标，改名要同步。
//
// 纯数据 + 纯函数、不发请求，bridge 前后端与 harness 都能 import。

// ---------- 模型厂 ----------

const V = (name, logo = '') => Object.freeze({ name, logo });

export const VENDORS = Object.freeze({
  // 国际大厂
  anthropic: V('Anthropic', 'claude-color'),      // 模型行认的是 Claude 的标；提供商 Anthropic 用公司字标
  openai: V('OpenAI', 'openai'),
  google: V('Google', 'gemini-color'),
  meta: V('Meta', 'meta-color'),
  xai: V('xAI', 'grok'),
  mistral: V('Mistral', 'mistral-color'),
  microsoft: V('Microsoft', 'microsoft-color'),
  amazon: V('Amazon Nova', 'nova-color'),
  nvidia: V('NVIDIA', 'nvidia-color'),
  cohere: V('Cohere', 'cohere-color'),
  perplexity: V('Perplexity', 'perplexity-color'),
  ibm: V('IBM Granite', 'ibm'),
  ai21: V('AI21 Labs', 'ai21'),
  // 国内
  deepseek: V('DeepSeek', 'deepseek-color'),
  qwen: V('通义千问', 'qwen-color'),
  alibaba: V('阿里巴巴', 'alibaba-color'),        // 万相（Wan）、CosyVoice、Paraformer 等千问以外的阿里系
  zhipu: V('智谱 GLM', 'zhipu-color'),
  moonshot: V('Kimi', 'kimi-color'),
  minimax: V('MiniMax', 'minimax-color'),
  bytedance: V('豆包', 'doubao-color'),           // 豆包 / Seed / Seedream / Seedance / UI-TARS
  xiaomi: V('小米 MiMo', 'xiaomimimo'),
  tencent: V('腾讯混元', 'hunyuan-color'),
  baidu: V('百度文心', 'wenxin-color'),
  stepfun: V('阶跃星辰', 'stepfun-color'),
  zeroone: V('零一万物', 'yi-color'),
  baichuan: V('百川智能', 'baichuan-color'),
  iflytek: V('讯飞星火', 'spark-color'),
  sensenova: V('商汤日日新', 'sensenova-color'),
  internlm: V('书生 InternLM', 'internlm-color'),
  openbmb: V('面壁 MiniCPM'),
  meituan: V('美团 LongCat', 'longcat-color'),
  antgroup: V('蚂蚁百灵', 'ling-color'),
  kuaishou: V('可灵', 'kling-color'),             // 可灵视频、可图（Kolors）
  kwaipilot: V('快手 KAT', 'kwaipilot-color'),     // 快手的编码模型线，和可灵分开
  skywork: V('昆仑天工', 'skywork-color'),
  huawei: V('华为盘古', 'huawei-color'),
  ai360: V('360 智脑', 'ai360-color'),
  dotsstudio: V('小红书 dots', 'dotsstudio'),
  xuanyuan: V('度小满轩辕', 'xuanyuan-color'),
  bilibili: V('哔哩哔哩 Index', 'bilibili-color'),
  baai: V('BAAI 智源', 'baai'),
  // 开放权重 / 研究机构
  liquid: V('Liquid AI', 'liquid'),
  inception: V('Inception', 'inception'),
  nousresearch: V('Nous Research', 'nousresearch'),
  arcee: V('Arcee AI', 'arcee-color'),
  upstage: V('Upstage', 'upstage-color'),
  ai2: V('Ai2', 'ai2-color'),
  tii: V('TII Falcon', 'tii-color'),
  lg: V('LG EXAONE', 'lg-color'),
  snowflake: V('Snowflake Arctic', 'snowflake-color'),
  databricks: V('Databricks', 'dbrx-color'),
  alephalpha: V('Aleph Alpha', 'alephalpha'),
  sakana: V('Sakana AI', 'sakana-color'),
  inflection: V('Inflection', 'inflection'),
  reka: V('Reka', 'reka'),
  rwkv: V('RWKV', 'rwkv-color'),
  deepcogito: V('Deep Cogito', 'deepcogito-color'),
  reflection: V('Reflection AI', 'reflection'),
  perceptron: V('Perceptron', 'perceptron'),
  essentialai: V('Essential AI', 'essentialai-color'),
  aionlabs: V('Aion Labs', ''),   // 库里的标 73KB，不收
  morph: V('Morph', 'morph-color'),
  relace: V('Relace', 'relace'),
  typesafe: V('Typesafe', 'typesafeai'),
  menlo: V('Menlo / Jan', 'menlo-color'),
  writer: V('Writer'),
  thinkingmachines: V('Thinking Machines'),
  nexagi: V('Nex AGI'),
  moondream: V('Moondream'),
  eleutherai: V('EleutherAI'),
  fireworks: V('Fireworks', 'fireworks-color'),
  inferencenet: V('Inference.net', 'inference'),
  huggingface: V('Hugging Face', 'huggingface-color'),
  openrouter: V('OpenRouter', 'openrouter'),       // openrouter/auto 一类路由，不是真的模型厂
  // 社区微调（OpenRouter 上常见，名字认得出就标出来，没有官方标）
  cognitivecomputations: V('Dolphin', ''),   // 库里的标 101KB，不收
  gryphe: V('Gryphe'),
  sao10k: V('Sao10K'),
  thedrummer: V('TheDrummer'),
  anthracite: V('Anthracite'),
  mancer: V('Mancer'),
  undi95: V('Undi95'),
  // 向量 / 重排
  jina: V('Jina AI', 'jina'),
  voyage: V('Voyage AI', 'voyage-color'),
  nomic: V('Nomic AI'),
  mixedbread: V('Mixedbread'),
  twelvelabs: V('TwelveLabs'),                     // 视频理解（Pegasus / Marengo），Bedrock 上有
  // 图像
  bfl: V('Black Forest Labs', 'bfl'),
  stability: V('Stability AI', 'stability-color'),
  midjourney: V('Midjourney', 'midjourney'),
  ideogram: V('Ideogram', 'ideogram'),
  recraft: V('Recraft', 'recraft'),
  krea: V('Krea', 'krea'),
  bria: V('Bria', 'briaai-color'),
  reve: V('Reve', 'reve'),
  prunaai: V('Pruna AI', 'prunaai-color'),
  sourceful: V('Sourceful'),
  adobe: V('Adobe Firefly', 'adobefirefly-color'),
  // 视频
  runway: V('Runway', 'runway'),
  luma: V('Luma AI', 'luma-color'),
  pika: V('Pika', 'pika'),
  vidu: V('Vidu', 'vidu-color'),
  pixverse: V('PixVerse', 'pixverse-color'),
  lightricks: V('Lightricks LTX', 'lightricks'),
  heygen: V('HeyGen'),
  hedra: V('Hedra', 'hedra'),
  haiper: V('Haiper', 'haiper'),
  decart: V('Decart', 'decart-color'),
  topazlabs: V('Topaz Labs', 'topazlabs'),
  sync: V('Sync Labs', 'sync'),
  // 音频
  suno: V('Suno', 'suno'),
  udio: V('Udio', 'udio-color'),
  elevenlabs: V('ElevenLabs', 'elevenlabs'),
  fishaudio: V('Fish Audio', 'fishaudio'),
  cartesia: V('Cartesia'),
});

// 「厂商/型号」前缀里的组织名 → 模型厂。覆盖 OpenRouter、Hugging Face、硅基流动、Replicate、fal、
// 魔搭等常见写法（大小写在规范化时已统一）。VENDORS 的键本身也自动算别名。
const VENDOR_ALIASES = {
  'anthropic': 'anthropic', 'claude': 'anthropic',
  'openai': 'openai', 'openai-community': 'openai',
  'google': 'google', 'google-deepmind': 'google', 'deepmind': 'google', 'gemini': 'google', 'vertex_ai': '', 'google-ai': 'google',
  'meta': 'meta', 'meta-llama': 'meta', 'facebook': 'meta', 'llama': 'meta',
  'x-ai': 'xai', 'xai-org': 'xai', 'grok': 'xai',
  'mistralai': 'mistral', 'mistral-ai': 'mistral',
  'microsoft': 'microsoft', 'azure': '',
  'amazon': 'amazon', 'aws': 'amazon',
  'nvidia': 'nvidia', 'nim': '',
  'cohere': 'cohere', 'cohereforai': 'cohere', 'coherelabs': 'cohere', 'cohere-labs': 'cohere',
  'perplexity': 'perplexity', 'perplexity-ai': 'perplexity', 'perplexityai': 'perplexity',
  'ibm-granite': 'ibm', 'ibm-research': 'ibm',
  'ai21labs': 'ai21', 'ai21-labs': 'ai21',
  'deepseek-ai': 'deepseek',
  'qwen': 'qwen', 'tongyi': 'qwen', 'tongyi-zhiwen': 'qwen', 'qwenlm': 'qwen',
  'alibaba': 'alibaba', 'alibaba-nlp': 'alibaba', 'alibaba-pai': 'alibaba', 'aliyun': 'alibaba', 'wan-ai': 'alibaba',
  'wan-video': 'alibaba', 'wan': 'alibaba', 'funaudiollm': 'alibaba', 'iic': 'alibaba', 'damo': 'alibaba', 'tongyi-mai': 'alibaba',
  'z-ai': 'zhipu', 'zai': 'zhipu', 'zai-org': 'zhipu', 'zhipuai': 'zhipu', 'thudm': 'zhipu', 'thukeg': 'zhipu', 'bigmodel': 'zhipu',
  'moonshotai': 'moonshot', 'moonshot': 'moonshot', 'kimi': 'moonshot',
  'minimaxai': 'minimax', 'minimax-ai': 'minimax', 'hailuo': 'minimax',
  'bytedance': 'bytedance', 'bytedance-seed': 'bytedance', 'bytedance-research': 'bytedance', 'doubao': 'bytedance',
  'volcengine': 'bytedance', 'byteplus': 'bytedance',
  'xiaomi': 'xiaomi', 'xiaomimimo': 'xiaomi', 'mimo': 'xiaomi',
  'tencent': 'tencent', 'tencent-hunyuan': 'tencent', 'hunyuan': 'tencent', 'tencentarc': 'tencent',
  'baidu': 'baidu', 'paddlepaddle': 'baidu', 'ernie': 'baidu',
  'stepfun': 'stepfun', 'stepfun-ai': 'stepfun',
  '01-ai': 'zeroone', '01ai': 'zeroone', 'lingyiwanwu': 'zeroone', 'yi': 'zeroone',
  'baichuan-inc': 'baichuan', 'baichuan': 'baichuan',
  'iflytek': 'iflytek', 'xfyun': 'iflytek', 'spark': 'iflytek',
  'sensetime': 'sensenova', 'sensenova': 'sensenova',
  'internlm': 'internlm', 'opengvlab': 'internlm', 'shanghai-ai-lab': 'internlm', 'intern': 'internlm',
  'openbmb': 'openbmb', 'modelbest': 'openbmb',
  'meituan': 'meituan', 'meituan-longcat': 'meituan', 'longcat': 'meituan',
  'inclusionai': 'antgroup', 'antgroup': 'antgroup', 'ant-ling': 'antgroup', 'antling': 'antgroup',
  'kwaivgi': 'kuaishou', 'klingai': 'kuaishou', 'kling': 'kuaishou', 'kuaishou': 'kuaishou', 'kwai-kolors': 'kuaishou', 'kwai': 'kuaishou',
  'kwaipilot': 'kwaipilot',
  'skywork': 'skywork', 'skyworkai': 'skywork',
  'huawei': 'huawei', 'ascend-tribe': 'huawei', 'huawei-noah': 'huawei',
  '360': 'ai360', 'qihoo360': 'ai360', 'qihoo-360': 'ai360',
  'dots-studio': 'dotsstudio', 'rednote-hilab': 'dotsstudio', 'xiaohongshu': 'dotsstudio',
  'duxiaoman-di': 'xuanyuan',
  'indexteam': 'bilibili', 'bilibili': 'bilibili',
  'baai': 'baai',
  'liquid': 'liquid', 'liquidai': 'liquid',
  'inception': 'inception', 'inceptionlabs': 'inception',
  'nousresearch': 'nousresearch', 'nous': 'nousresearch',
  'arcee-ai': 'arcee', 'arcee': 'arcee',
  'upstage': 'upstage',
  'allenai': 'ai2', 'ai2': 'ai2',
  'tiiuae': 'tii', 'tii': 'tii',
  'lgai-exaone': 'lg', 'lg': 'lg',
  'snowflake': 'snowflake', 'snowflake-labs': 'snowflake',
  'databricks': 'databricks',
  'aleph-alpha': 'alephalpha', 'alephalpha': 'alephalpha',
  'sakana': 'sakana', 'sakanaai': 'sakana',
  'inflection': 'inflection',
  'reka': 'reka', 'rekaai': 'reka', 'reka-ai': 'reka',
  'rwkv': 'rwkv', 'blinkdl': 'rwkv', 'recursal': 'rwkv',
  'deepcogito': 'deepcogito',
  'reflection': 'reflection',
  'perceptron': 'perceptron',
  'essentialai': 'essentialai',
  'aion-labs': 'aionlabs', 'aionlabs': 'aionlabs',
  'morph': 'morph', 'morphllm': 'morph',
  'relace': 'relace',
  'typesafe': 'typesafe',
  'menlo': 'menlo', 'janhq': 'menlo',
  'writer': 'writer',
  'thinkingmachines': 'thinkingmachines', 'thinking-machines': 'thinkingmachines',
  'nex-agi': 'nexagi', 'nexagi': 'nexagi',
  'moondream': 'moondream', 'vikhyatk': 'moondream',
  'eleutherai': 'eleutherai',
  'fireworks': 'fireworks', 'fireworks-ai': 'fireworks',
  'inference-net': 'inferencenet', 'kuzco': 'inferencenet',
  'huggingface': 'huggingface', 'huggingfaceh4': 'huggingface', 'huggingfacetb': 'huggingface',
  'cognitivecomputations': 'cognitivecomputations',
  'gryphe': 'gryphe', 'sao10k': 'sao10k', 'thedrummer': 'thedrummer', 'anthracite-org': 'anthracite', 'mancer': 'mancer', 'undi95': 'undi95',
  'jinaai': 'jina', 'jina': 'jina', 'jina-ai': 'jina',
  'voyage': 'voyage', 'voyageai': 'voyage',
  'nomic-ai': 'nomic', 'mixedbread-ai': 'mixedbread', 'twelve-labs': 'twelvelabs',
  'black-forest-labs': 'bfl', 'bfl': 'bfl', 'blackforestlabs': 'bfl',
  'stability-ai': 'stability', 'stabilityai': 'stability', 'stability': 'stability',
  'midjourney': 'midjourney',
  'ideogram-ai': 'ideogram', 'ideogram': 'ideogram',
  'recraft-ai': 'recraft', 'recraft': 'recraft',
  'krea': 'krea',
  'bria': 'bria', 'briaai': 'bria',
  'reve': 'reve',
  'prunaai': 'prunaai',
  'sourceful': 'sourceful',
  'adobe': 'adobe',
  'runwayml': 'runway', 'runway': 'runway',
  'luma': 'luma', 'lumalabs': 'luma', 'luma-ai': 'luma', 'lumaai': 'luma',
  'pika': 'pika', 'pika-labs': 'pika',
  'vidu': 'vidu', 'shengshu': 'vidu',
  'pixverse': 'pixverse',
  'lightricks': 'lightricks',
  'heygen': 'heygen',
  'hedra': 'hedra',
  'haiper': 'haiper',
  'decart': 'decart',
  'topazlabs': 'topazlabs',
  'sync': 'sync', 'synclabs': 'sync',
  'suno': 'suno',
  'udio': 'udio',
  'elevenlabs': 'elevenlabs',
  'fishaudio': 'fishaudio', 'fish-audio': 'fishaudio',
  'cartesia': 'cartesia',
};

// 转传 / 托管层：不是模型厂，跳过它看后面那段。openrouter 例外——openrouter/auto 认作 OpenRouter，
// 但 openrouter/anthropic/claude… 这种还是以后面的为准。
const RELAY_SEGMENTS = new Set([
  'fal-ai', 'fal', 'pro', 'lora', 'accounts', 'models', 'publishers', 'library', 'hf.co', 'huggingface.co',
  'unsloth', 'lmstudio-community', 'mlx-community', 'bartowski', 'thebloke', 'gguf', 'local', 'custom',
  'together', 'togethercomputer', 'groq', 'deepinfra', 'novita', 'siliconflow', 'ppio', 'aihubmix', 'zenmux',
  'cometapi', 'poe', 'vercel', 'workers-ai', 'cf', 'bedrock', 'vertex', 'vertex-ai', 'litellm', 'azureml',
]);

// 不靠前缀、名字里任何位置出现就能定厂商的强标记（先于开头规则：llama-3.1-nemotron 是 NVIDIA 调的）
const VENDOR_MARKERS = [
  [/nemotron|nemoguard/, 'nvidia'],
  [/(?:^|[^a-z])sonar(?![a-z])/, 'perplexity'],
  [/euryale|stheno|lunaris/, 'sao10k'],
  [/mythomax|mythomist/, 'gryphe'],
  [/(?:^|[^a-z])magnum(?![a-z])/, 'anthracite'],
  [/cydonia|rocinante|unslopnemo|skyfall|valkyrie/, 'thedrummer'],
  [/(?:^|[^a-z])sdxl/, 'stability'],
  [/nano-?banana/, 'google'],
];

// 型号名开头 → 模型厂。顺序有讲究：
//   · deepseek 在 qwen / llama 前（deepseek-r1-distill-qwen 是 DeepSeek 的）；
//   · text-embedding-00x 是 Google、text-embedding-3 / ada 是 OpenAI、text-embedding-v3 是千问；
//   · nova-ptc 是商汤、其余 nova 是亚马逊；speech-1.x 是 Fish Audio、speech-0x / 2.x 是 MiniMax；
//   · gpt-sovits / gpt-j / gpt-neo 不是 OpenAI。
const VENDOR_RULES = [
  [/^(?:gpt-?sovits)/, ''],
  [/^(?:gpt-j|gpt-neo|pythia)(?![a-z])/, 'eleutherai'],
  [/^(?:claude|opus|sonnet|haiku)(?![a-z])/, 'anthropic'],
  [/^(?:deepseek|janus)/, 'deepseek'],
  [/^text-embedding-00\d|^text-multilingual-embedding|^embedding-00\d/, 'google'],
  [/^text-embedding-v\d/, 'qwen'],
  [/^(?:gpt|chatgpt|o\d(?![a-z0-9])|dall-?e|sora|whisper|tts-1|davinci|babbage|codex|computer-use|text-embedding-(?:3|ada)|text-moderation|omni-moderation)/, 'openai'],
  // palm 要带边界：palmyra 是 Writer 的
  [/^(?:gemini|gemma|imagen|veo|lyria|learnlm|palm(?![a-z])|chat-bison|text-bison|bison|medgemma|codegemma|paligemma|shieldgemma|aqa(?![a-z])|chirp(?!-v\d))/, 'google'],
  [/^(?:qwen|qwq|qvq|tongyi)/, 'qwen'],
  [/^(?:wanx?(?:-|\d|$)|happyhorse|cosyvoice|sambert|paraformer|sensevoice|fun-?asr|gte-|z-image)/, 'alibaba'],
  [/^(?:glm|chatglm|cogview|cogvideo|codegeex|charglm|emohaa|autoglm|embedding-[23](?![0-9]))/, 'zhipu'],
  [/^(?:kimi|moonshot)/, 'moonshot'],
  [/^(?:minimax|abab|hailuo|speech-(?:0\d|[2-9]\.\d)|(?:image|video|t2v|i2v|s2v)-0\d|music-(?:0\d|\d\.\d|\d(?![0-9])))/, 'minimax'],
  [/^(?:doubao|seed(?:ream|ance|edit|3d|-|\d)|ui-tars|skylark|omnihuman|dreamina|jimeng)/, 'bytedance'],
  [/^grok/, 'xai'],
  [/^(?:llama|codellama|muse(?:-|$))/, 'meta'],
  [/^(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral|mathstral|open-mi[sx]tral)/, 'mistral'],
  [/^mimo(?![a-z])/, 'xiaomi'],
  [/^(?:hunyuan|hy(?:-|\d)|tencent)/, 'tencent'],
  [/^(?:ernie|wenxin|qianfan)/, 'baidu'],
  [/^step(?:-?\d|-|fun)/, 'stepfun'],
  [/^yi(?:-|$)/, 'zeroone'],
  [/^baichuan/, 'baichuan'],
  [/^(?:spark|generalv\d|4\.0ultra)/, 'iflytek'],
  [/^(?:sensenova|sensechat|nova-ptc)/, 'sensenova'],
  [/^(?:internlm|intern-?s1|internvl|intern-)/, 'internlm'],
  [/^(?:minicpm|cpm-)/, 'openbmb'],
  [/^(?:phi-?\d|phi$|wizardlm|mai(?:-|$)|orca|florence|vibevoice|kosmos|bitnet)/, 'microsoft'],
  [/^(?:nova(?:-|$)|titan)/, 'amazon'],
  [/^(?:command|c4ai|aya(?:-|$)|embed-(?:english|multilingual|v\d)|rerank-(?:english|multilingual|v\d))/, 'cohere'],
  [/^(?:voyage|rerank-(?:\d|lite))/, 'voyage'],
  [/^(?:nvidia|nv-|nvlm|parakeet|canary-|cosmos-)/, 'nvidia'],
  [/^(?:r1-1776|pplx)/, 'perplexity'],
  [/^(?:jamba|jurassic|j2-)/, 'ai21'],
  [/^lfm/, 'liquid'],
  [/^mercury/, 'inception'],
  [/^(?:hermes|nous)/, 'nousresearch'],
  [/^(?:arcee|virtuoso|trinity)/, 'arcee'],
  [/^solar/, 'upstage'],
  [/^granite/, 'ibm'],
  [/^(?:flux|kontext)/, 'bfl'],
  [/^(?:stable-|stablelm|sd[1-3]|sd-)/, 'stability'],
  [/^(?:midjourney|mj-|niji)/, 'midjourney'],
  [/^ideogram/, 'ideogram'],
  [/^recraft/, 'recraft'],
  [/^(?:kling|kolors|kwai(?!pilot))/, 'kuaishou'],
  [/^(?:kat-|kwaipilot)/, 'kwaipilot'],
  [/^(?:gen-?[2-9]|runway|aleph(?![-_]?alpha)|act-two)/, 'runway'],
  [/^(?:ray(?:-|\d|$)|photon|dream-machine|luma)/, 'luma'],
  [/^pika/, 'pika'],
  [/^vidu/, 'vidu'],
  [/^pixverse/, 'pixverse'],
  [/^ltx/, 'lightricks'],
  [/^krea/, 'krea'],
  [/^(?:suno|chirp-v\d|bark(?![a-z]))/, 'suno'],
  [/^udio/, 'udio'],
  [/^(?:eleven|scribe)/, 'elevenlabs'],
  [/^(?:fish-?speech|openaudio|speech-1\.\d)/, 'fishaudio'],
  [/^(?:bge|baai|aquila|emu\d)/, 'baai'],
  [/^(?:jina|reader-lm)/, 'jina'],
  [/^rwkv/, 'rwkv'],
  [/^cogito/, 'deepcogito'],
  [/^reka/, 'reka'],
  [/^(?:olmo|molmo|tulu)/, 'ai2'],
  [/^falcon/, 'tii'],
  [/^exaone/, 'lg'],
  [/^longcat/, 'meituan'],
  [/^(?:ling|ring|ming)(?:-|$)|^bailing/, 'antgroup'],
  [/^skywork/, 'skywork'],
  [/^pangu/, 'huawei'],
  [/^360/, 'ai360'],
  [/^(?:arctic|snowflake)/, 'snowflake'],
  [/^dbrx/, 'databricks'],
  [/^(?:luminous|pharia)/, 'alephalpha'],
  [/^palmyra/, 'writer'],
  [/^dolphin/, 'cognitivecomputations'],
  [/^moondream/, 'moondream'],
  [/^(?:heygen|avatar-iv)/, 'heygen'],
  [/^hedra/, 'hedra'],
  [/^bria/, 'bria'],
  [/^(?:riverflow)/, 'sourceful'],
  [/^(?:dots\.|dots-)/, 'dotsstudio'],
  [/^index-?tts/, 'bilibili'],
  [/^(?:sonic-|cartesia)/, 'cartesia'],
  // OpenRouter 上的小厂：没有前缀时也认得出
  [/^inkling/, 'thinkingmachines'],
  [/^nex-n\d/, 'nexagi'],
  [/^aion-/, 'aionlabs'],
  [/^perceptron/, 'perceptron'],
  [/^(?:sakana|fugu-)/, 'sakana'],
  [/^relace/, 'relace'],
  [/^morph-v\d/, 'morph'],
  [/^schematron/, 'inferencenet'],
  // Ollama 库里常见的向量模型
  [/^nomic-/, 'nomic'],
  [/^mxbai-/, 'mixedbread'],
  [/^(?:pegasus|marengo)-/, 'twelvelabs'],
];

// Bedrock 的「厂商.型号」写法（anthropic.claude-…、amazon.nova-…、meta.llama3-…）与跨区前缀 us. / eu. / apac. / global.
const BEDROCK_PREFIX = /^(?:(?:us|eu|apac|ap|global|us-gov|jp|au|ca)\.)?(anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|openai|writer|stability|luma|twelvelabs|minimax|moonshot|moonshotai|google|nvidia)\.(?=[a-z0-9])/;

const ALIAS = new Map(Object.entries(VENDOR_ALIASES));
for (const k of Object.keys(VENDORS)) if (!ALIAS.has(k)) ALIAS.set(k, k);

// 和 modality.mjs 的规范化同一套剥法（两边各留一份：modality 要保持零依赖、前端单独打包也小）
function cleanId(id) {
  let s = String(id ?? '').trim().toLowerCase();
  s = s.replace(/\[[^\]]*\]$/, '');
  s = s.replace(/^(?:models|tunedmodels)\//, '');
  s = s.replace(/^accounts\/[^/]+\/models\//, '');
  s = s.replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/([^/]+)\/models\//, '$1/');
  s = s.replace(/^@(?:cf|hf)\//, '');
  s = s.replace(/(^|\/)~/g, '$1');
  s = s.replace(/(.)@[\w.-]+$/, '$1');
  s = s.replace(/:[\w.-]+$/, '');
  return s;
}

function byName(seg) {
  for (const [re, key] of VENDOR_MARKERS) if (re.test(seg)) return key;
  for (const [re, key] of VENDOR_RULES) if (re.test(seg)) return key || null;   // '' = 明确不是谁家的（gpt-sovits）
  return undefined;
}

/** 型号 ID → 模型厂键；认不出返回 ''。 */
export function vendorOf(id) {
  const s = cleanId(id);
  if (!s) return '';
  const segs = s.split('/').filter(Boolean);
  let fallback = '';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const bed = seg.match(BEDROCK_PREFIX);
    if (bed) return ALIAS.get(bed[1]) || '';
    if (!last) {
      if (seg === 'openrouter') { fallback ||= 'openrouter'; continue; }
      if (RELAY_SEGMENTS.has(seg)) continue;
      if (ALIAS.has(seg)) {
        const a = ALIAS.get(seg);
        if (a) return a;
        continue;                                                // '' 别名 = 托管层（azure、nim…），看后面
      }
    }
    const n = byName(seg);
    if (n) return n;
    if (n === null) return '';
    // 非最后一段又认不出：多半是 Replicate 的个人账号、HF 的转传者，继续看后面那段
  }
  return fallback;
}

/** 模型厂键 → { key, name, logo }；也收别名（x-ai、moonshotai…）。不认识返回 null。 */
export function vendorInfo(key) {
  const k0 = String(key ?? '').trim().toLowerCase();
  // hasOwn：别让 constructor / toString 这类原型上的名字冒充厂商
  const k = Object.hasOwn(VENDORS, k0) ? k0 : ALIAS.get(k0);
  return k && Object.hasOwn(VENDORS, k) ? { key: k, ...VENDORS[k] } : null;
}

// ---------- 提供商 ----------

// hosts 对两样东西测：主机名（api.openai.com）与「主机名:端口」（127.0.0.1:11434）——本机服务只能靠端口认。
// 先具体后笼统：GitHub Models 的 models.inference.ai.azure.com 要排在 Azure 前面。
// baseUrl 只写确定的：优先仓库里已有的预设（Claude 外接 PRESETS、Studio presets、dimensio catalog），
// 其次是官方文档里的固定地址；要带账号 / 区域 / 部署名才能用的（Vertex、Bedrock、Azure、Cloudflare）不写。
// protocol 是这个 baseUrl 的协议；providerOf 另按实际地址的路径推（…/anthropic → anthropic）。
// mediaOnly：只出图 / 视频 / 音频的服务，列表里认不出的型号算「其他」而不是文本。
const h = (s) => new RegExp(`(?:^|\\.)(?:${s.replace(/\./g, '\\.')})$`);
const LOOPBACK = '(?:localhost|127(?:\\.\\d{1,3}){3}|0\\.0\\.0\\.0|::1|10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}|[\\w-]+\\.local|host\\.docker\\.internal)';
const port = (p) => new RegExp(`:${p}$`);
const localPort = (p) => new RegExp(`^${LOOPBACK}:${p}$`);

const P = (key, name, logo, hosts, extra = {}) => Object.freeze({ key, name, logo, hosts: Object.freeze(hosts), ...extra });

export const PROVIDERS = Object.freeze([
  // —— 添加页的快捷选择（featured，顺序即展示顺序）——
  P('openrouter', 'OpenRouter', 'openrouter', [h('openrouter.ai')], { baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', featured: true }),
  P('openai', 'OpenAI', 'openai', [h('openai.com')], { baseUrl: 'https://api.openai.com/v1', protocol: 'openai', featured: true }),
  P('anthropic', 'Anthropic', 'anthropic', [h('anthropic.com')], { baseUrl: 'https://api.anthropic.com', protocol: 'anthropic', featured: true }),
  // Gemini 原生接口（Studio 的 gemini 方言自己补 v1beta/…，桥接时要去掉这里的 /v1beta）；…/v1beta/openai 是兼容接口
  P('gemini', 'Gemini', 'gemini-color', [h('generativelanguage.googleapis.com')], { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini', featured: true }),
  // DeepSeek 根地址是 OpenAI 兼容、/anthropic 是 Anthropic 兼容；推荐后者（Claude 外接直接能用，列模型由 knowledge 的备选地址兜）
  P('deepseek', 'DeepSeek', 'deepseek-color', [h('deepseek.com')], { baseUrl: 'https://api.deepseek.com/anthropic', protocol: 'anthropic', featured: true }),
  P('siliconflow', '硅基流动', 'siliconcloud-color', [h('siliconflow.cn'), h('siliconflow.com')], { baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai', featured: true }),
  // 百炼推荐 OpenAI 兼容地址：/compatible-mode/v1/models 列得出全部型号（含万相、CosyVoice）；/apps/anthropic 只给 Claude 外接用
  P('dashscope', '阿里云百炼', 'bailian-color', [h('dashscope.aliyuncs.com'), h('dashscope-intl.aliyuncs.com'), h('dashscope-us.aliyuncs.com'), h('bailian.console.aliyun.com'), h('aliyuncs.com')], { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai', featured: true }),
  P('zhipu', '智谱 GLM', 'zhipu-color', [h('bigmodel.cn'), h('zhipuai.cn')], { baseUrl: 'https://open.bigmodel.cn/api/anthropic', protocol: 'anthropic', featured: true }),
  // Kimi for Coding（订阅端点，sk-kimi-… 的 Key）：和开放平台 api.moonshot.cn 的 Key 不通用，单列；要排在 moonshot 前面（它也认 kimi.com）
  P('kimi-code', 'Kimi Code', 'kimi-color', [h('api.kimi.com')], { baseUrl: 'https://api.kimi.com/coding/v1', protocol: 'openai', featured: true }),
  P('moonshot', 'Kimi', 'moonshot', [h('moonshot.cn'), h('moonshot.ai'), h('kimi.com'), h('kimi.ai')], { baseUrl: 'https://api.moonshot.cn/anthropic', protocol: 'anthropic', featured: true }),
  P('ark', '火山方舟', 'volcengine-color', [h('volces.com'), h('volcengine.com'), h('volcengineapi.com'), h('bytepluses.com')], { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai', featured: true }),
  // MiniMax 推荐 /v1：Studio 的视频 / 配音 / 音乐方言都挂在 /v1 下；/anthropic 只有对话
  P('minimax', 'MiniMax', 'minimax-color', [h('minimaxi.com'), h('minimax.io'), h('minimax.chat'), h('minimaxi.chat')], { baseUrl: 'https://api.minimaxi.com/v1', protocol: 'openai', featured: true }),
  P('mimo', '小米 MiMo', 'xiaomimimo', [h('xiaomimimo.com')], { baseUrl: 'https://api.xiaomimimo.com/anthropic', protocol: 'anthropic', featured: true }),
  P('xai', 'xAI', 'xai', [h('x.ai')], { baseUrl: 'https://api.x.ai/v1', protocol: 'openai', featured: true }),
  P('mistral', 'Mistral', 'mistral-color', [h('mistral.ai')], { baseUrl: 'https://api.mistral.ai/v1', protocol: 'openai', featured: true }),
  P('groq', 'Groq', 'groq', [h('groq.com')], { baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai', featured: true }),
  P('together', 'Together AI', 'together-color', [h('together.xyz'), h('together.ai')], { baseUrl: 'https://api.together.xyz/v1', protocol: 'openai', featured: true }),

  // —— 聚合 / 中转 ——
  P('aihubmix', 'AiHubMix', 'aihubmix-color', [h('aihubmix.com')], { baseUrl: 'https://aihubmix.com/v1', protocol: 'openai' }),
  P('ai302', '302.AI', 'ai302-color', [h('302.ai')], { baseUrl: 'https://api.302.ai/v1', protocol: 'openai' }),
  P('ppio', 'PPIO 派欧云', 'ppio-color', [h('ppinfra.com'), h('ppio.com'), h('ppio.cn')]),
  P('qiniu', '七牛云', 'qiniu-color', [h('qnaigc.com'), h('qiniu.com'), h('qiniuapi.com')], { baseUrl: 'https://api.qnaigc.com/v1', protocol: 'openai' }),
  P('infini', '无问芯穹', 'infinigence-color', [h('infini-ai.com')], { baseUrl: 'https://cloud.infini-ai.com/maas/v1', protocol: 'openai' }),
  P('giteeai', 'Gitee AI', 'giteeai', [h('ai.gitee.com'), h('moark.com')], { baseUrl: 'https://ai.gitee.com/v1', protocol: 'openai' }),
  P('modelscope', '魔搭 ModelScope', 'modelscope-color', [h('modelscope.cn'), h('modelscope.ai')], { baseUrl: 'https://api-inference.modelscope.cn/v1', protocol: 'openai' }),
  P('cometapi', 'CometAPI', 'cometapi-color', [h('cometapi.com')], { baseUrl: 'https://api.cometapi.com/v1', protocol: 'openai' }),
  P('burncloud', 'BurnCloud', 'burncloud-color', [h('burncloud.com')]),
  P('zenmux', 'ZenMux', 'zenmux', [h('zenmux.ai')], { baseUrl: 'https://zenmux.ai/api/v1', protocol: 'openai' }),
  P('poe', 'Poe', 'poe-color', [h('poe.com')], { baseUrl: 'https://api.poe.com/v1', protocol: 'openai' }),
  P('vercel', 'Vercel AI Gateway', 'vercel', [h('ai-gateway.vercel.sh'), h('vercel.ai')], { baseUrl: 'https://ai-gateway.vercel.sh/v1', protocol: 'openai' }),
  // 不收 workers.dev / hf.space：那是任何人都能挂的自建中转，按托管方认会把别人的中转标成官方
  P('cloudflare', 'Cloudflare Workers AI', 'cloudflare-color', [h('api.cloudflare.com'), h('gateway.ai.cloudflare.com')]),
  // GitHub Models 的老地址在 azure.com 下，必须排在 Azure 前面
  P('github', 'GitHub Models', 'github', [h('models.github.ai'), h('models.inference.ai.azure.com')], { baseUrl: 'https://models.github.ai/inference', protocol: 'openai' }),
  P('aimlapi', 'AI/ML API', 'aimlapi', [h('aimlapi.com')]),
  P('glama', 'Glama', 'glama', [h('glama.ai')]),
  P('atlascloud', 'Atlas Cloud', 'atlascloud', [h('atlascloud.ai')]),
  P('sophnet', 'SophNet', 'sophnet-color', [h('sophnet.com')]),
  P('akash', 'Akash Chat', 'akashchat-color', [h('akash.network')]),

  // —— 原厂 ——
  // 区域端点是 us-central1-aiplatform.googleapis.com（连字符而不是点），h() 认不出，单独写
  P('vertex', 'Vertex AI', 'vertexai-color', [/(?:^|[.-])aiplatform\.googleapis\.com$/]),
  P('zai', 'Z.ai', 'zai', [h('z.ai')], { baseUrl: 'https://api.z.ai/api/anthropic', protocol: 'anthropic' }),
  P('hunyuan', '腾讯混元', 'hunyuan-color', [h('hunyuan.cloud.tencent.com'), h('hunyuan.tencentcloudapi.com')], { baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', protocol: 'openai' }),
  P('tencentcloud', '腾讯云', 'tencentcloud-color', [h('lkeap.cloud.tencent.com'), h('tencentcloudapi.com'), h('cloud.tencent.com')], { baseUrl: 'https://api.lkeap.cloud.tencent.com/v1', protocol: 'openai' }),
  P('qianfan', '百度千帆', 'baiducloud-color', [h('baidubce.com'), h('bcebos.com')], { baseUrl: 'https://qianfan.baidubce.com/v2', protocol: 'openai' }),
  P('spark', '讯飞星火', 'spark-color', [h('xf-yun.com'), h('xfyun.cn')], { baseUrl: 'https://spark-api-open.xf-yun.com/v1', protocol: 'openai' }),
  P('stepfun', '阶跃星辰', 'stepfun-color', [h('stepfun.com')], { baseUrl: 'https://api.stepfun.com/v1', protocol: 'openai' }),
  P('zeroone', '零一万物', 'zeroone-color', [h('lingyiwanwu.com'), h('01.ai')], { baseUrl: 'https://api.lingyiwanwu.com/v1', protocol: 'openai' }),
  P('baichuan', '百川智能', 'baichuan-color', [h('baichuan-ai.com')], { baseUrl: 'https://api.baichuan-ai.com/v1', protocol: 'openai' }),
  P('sensenova', '商汤日日新', 'sensenova-color', [h('sensenova.cn'), h('sensetime.com')]),
  P('longcat', '美团 LongCat', 'longcat-color', [h('longcat.chat')]),
  P('huaweicloud', '华为云 MaaS', 'huaweicloud-color', [h('myhuaweicloud.com'), h('huaweicloud.com')]),
  P('ai360', '360 智脑', 'ai360-color', [h('360.cn')]),
  P('cohere', 'Cohere', 'cohere-color', [h('cohere.ai'), h('cohere.com')], { baseUrl: 'https://api.cohere.ai/compatibility/v1', protocol: 'openai' }),
  P('perplexity', 'Perplexity', 'perplexity-color', [h('perplexity.ai')], { baseUrl: 'https://api.perplexity.ai', protocol: 'openai' }),
  P('azure', 'Azure OpenAI', 'azure-color', [h('openai.azure.com'), h('cognitiveservices.azure.com'), h('services.ai.azure.com'), h('models.ai.azure.com'), h('azure-api.net')]),
  P('bedrock', 'AWS Bedrock', 'bedrock-color', [/(?:^|\.)bedrock[\w-]*\.[\w-]+\.amazonaws\.com$/]),
  P('nvidia', 'NVIDIA NIM', 'nvidia-color', [h('api.nvidia.com'), h('build.nvidia.com')], { baseUrl: 'https://integrate.api.nvidia.com/v1', protocol: 'openai' }),

  // —— 推理云 ——
  P('cerebras', 'Cerebras', 'cerebras-color', [h('cerebras.ai')], { baseUrl: 'https://api.cerebras.ai/v1', protocol: 'openai' }),
  P('fireworks', 'Fireworks', 'fireworks-color', [h('fireworks.ai')], { baseUrl: 'https://api.fireworks.ai/inference/v1', protocol: 'openai' }),
  P('deepinfra', 'DeepInfra', 'deepinfra-color', [h('deepinfra.com')], { baseUrl: 'https://api.deepinfra.com/v1/openai', protocol: 'openai' }),
  P('novita', 'Novita AI', 'novita-color', [h('novita.ai')]),
  P('hyperbolic', 'Hyperbolic', 'hyperbolic-color', [h('hyperbolic.xyz')], { baseUrl: 'https://api.hyperbolic.xyz/v1', protocol: 'openai' }),
  P('sambanova', 'SambaNova', 'sambanova-color', [h('sambanova.ai')], { baseUrl: 'https://api.sambanova.ai/v1', protocol: 'openai' }),
  P('nebius', 'Nebius', 'nebius', [h('nebius.ai'), h('nebius.com')]),
  P('chutes', 'Chutes', 'chutes', [h('chutes.ai')], { baseUrl: 'https://llm.chutes.ai/v1', protocol: 'openai' }),
  P('featherless', 'Featherless', 'featherless-color', [h('featherless.ai')], { baseUrl: 'https://api.featherless.ai/v1', protocol: 'openai' }),
  P('parasail', 'Parasail', 'parasail', [h('parasail.io')], { baseUrl: 'https://api.parasail.io/v1', protocol: 'openai' }),
  P('friendli', 'Friendli', 'friendli', [h('friendli.ai')], { baseUrl: 'https://api.friendli.ai/serverless/v1', protocol: 'openai' }),
  P('lambda', 'Lambda', 'lambda', [h('lambda.ai'), h('lambdalabs.com')]),
  P('kluster', 'kluster.ai', 'kluster-color', [h('kluster.ai')], { baseUrl: 'https://api.kluster.ai/v1', protocol: 'openai' }),
  P('inference', 'Inference.net', 'inference', [h('inference.net')], { baseUrl: 'https://api.inference.net/v1', protocol: 'openai' }),
  P('targon', 'Targon', 'targon-color', [h('targon.com')]),
  P('venice', 'Venice', 'venice-color', [h('venice.ai')], { baseUrl: 'https://api.venice.ai/api/v1', protocol: 'openai' }),
  P('huggingface', 'Hugging Face', 'huggingface-color', [h('huggingface.co')], { baseUrl: 'https://router.huggingface.co/v1', protocol: 'openai' }),
  P('upstage', 'Upstage', 'upstage-color', [h('upstage.ai')]),
  P('baseten', 'Baseten', 'baseten', [h('baseten.co')]),
  P('gmicloud', 'GMI Cloud', 'gmicloud', [h('gmi-serving.com'), h('gmicloud.ai')]),
  P('digitalocean', 'DigitalOcean', 'digitalocean', [h('do-ai.run'), h('digitalocean.com')]),

  // —— 媒体 ——
  P('fal', 'fal', 'fal-color', [h('fal.run'), h('fal.ai'), h('fal.media')], { baseUrl: 'https://queue.fal.run', mediaOnly: true }),
  P('replicate', 'Replicate', 'replicate', [h('replicate.com'), h('replicate.delivery')], { baseUrl: 'https://api.replicate.com/v1', mediaOnly: true }),
  P('elevenlabs', 'ElevenLabs', 'elevenlabs', [h('elevenlabs.io')], { baseUrl: 'https://api.elevenlabs.io/v1', mediaOnly: true }),
  P('stability', 'Stability AI', 'stability-color', [h('stability.ai')], { mediaOnly: true }),
  P('bfl', 'Black Forest Labs', 'bfl', [h('bfl.ai'), h('bfl.ml')], { mediaOnly: true }),
  P('runway', 'Runway', 'runway', [h('runwayml.com')], { mediaOnly: true }),
  P('luma', 'Luma AI', 'luma-color', [h('lumalabs.ai')], { mediaOnly: true }),
  P('kling', '可灵', 'kling-color', [h('klingai.com'), h('klingai.cn'), h('kling.ai')], { mediaOnly: true }),
  P('vidu', 'Vidu', 'vidu-color', [h('vidu.com'), h('vidu.cn'), h('vidu.studio')], { mediaOnly: true }),
  P('pika', 'Pika', 'pika', [h('pika.art')], { mediaOnly: true }),
  P('pixverse', 'PixVerse', 'pixverse-color', [h('pixverse.ai')], { mediaOnly: true }),
  P('ideogram', 'Ideogram', 'ideogram', [h('ideogram.ai')], { mediaOnly: true }),
  P('recraft', 'Recraft', 'recraft', [h('recraft.ai')], { mediaOnly: true }),
  P('suno', 'Suno', 'suno', [h('suno.com'), h('suno.ai')], { mediaOnly: true }),
  P('fishaudio', 'Fish Audio', 'fishaudio', [h('fish.audio')], { mediaOnly: true }),
  P('wavespeed', 'WaveSpeed', 'wavespeed', [h('wavespeed.ai')], { mediaOnly: true }),

  // —— 本机（只能靠端口认；LM Studio 的 1234、vLLM 的 8000 太常见，只认本机 / 内网地址）——
  P('ollama', 'Ollama', 'ollama', [port(11434), h('ollama.com')], { baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'openai' }),
  P('lmstudio', 'LM Studio', 'lmstudio', [localPort(1234)], { baseUrl: 'http://127.0.0.1:1234/v1', protocol: 'openai' }),
  P('vllm', 'vLLM', 'vllm-color', [localPort(8000)], { baseUrl: 'http://127.0.0.1:8000/v1', protocol: 'openai' }),
  P('xinference', 'Xinference', 'xinference-color', [port(9997)], { baseUrl: 'http://127.0.0.1:9997/v1', protocol: 'openai' }),
]);

export const FEATURED_PROVIDERS = Object.freeze(PROVIDERS.filter((p) => p.featured));

// 协议不按 OpenAI 兼容猜的：要带项目 / 区域的原生接口
const NATIVE_PROVIDERS = new Set(['vertex', 'bedrock']);

function parseBase(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
}

function protocolOf(p, pathname) {
  const path = pathname.toLowerCase().replace(/\/+$/, '');
  if (/(?:^|\/)anthropic(?:\/|$)/.test(path)) return 'anthropic';   // …/anthropic、/apps/anthropic、/api/anthropic
  if (p.key === 'anthropic') return 'anthropic';
  if (p.key === 'gemini') return /(?:^|\/)openai(?:\/|$)/.test(path) ? 'openai' : 'gemini';
  if (/(?:^|\/)(?:openai|openapi)(?:\/|$)/.test(path)) return 'openai'; // Groq / DeepInfra / Bedrock / Vertex 的兼容入口
  if (p.mediaOnly || NATIVE_PROVIDERS.has(p.key)) return undefined;
  return 'openai';
}

/** 服务地址 → 提供商 { key, name, logo, protocol?, mediaOnly? }；认不出返回 null。不带 scheme 的主机名也收。 */
export function providerOf(baseUrl) {
  const u = parseBase(baseUrl);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostPort = `${host}:${u.port || (u.protocol === 'http:' ? '80' : '443')}`;
  for (const p of PROVIDERS) {
    if (!p.hosts.some((re) => re.test(host) || re.test(hostPort))) continue;
    const out = { key: p.key, name: p.name, logo: p.logo };
    const proto = protocolOf(p, u.pathname);
    if (proto) out.protocol = proto;
    if (p.mediaOnly) out.mediaOnly = true;
    return out;
  }
  return null;
}

// 仓库里别处用过的提供商 id（Claude 外接预设、Studio 方言名）→ 这里的键
const PROVIDER_ALIASES = {
  'mimo-plan': 'mimo', 'xiaomi': 'mimo', 'bailian': 'dashscope', 'aliyun': 'dashscope', 'qwen': 'dashscope',
  'volcengine': 'ark', 'doubao': 'ark', 'kimi': 'moonshot', 'local': 'ollama', 'google': 'gemini',
  'x-ai': 'xai', 'grok': 'xai', 'zhipuai': 'zhipu', 'bigmodel': 'zhipu', 'claude': 'anthropic', 'silicon': 'siliconflow',
};
const PROVIDER_BY_KEY = new Map(PROVIDERS.map((p) => [p.key, p]));

/** 提供商键（或仓库里的旧 id：mimo-plan、local、bailian…）→ { key, name, logo, baseUrl?, protocol?, featured?, mediaOnly? } | null */
export function providerInfo(key) {
  const k0 = String(key ?? '').trim().toLowerCase();
  const p = PROVIDER_BY_KEY.get(k0) ?? PROVIDER_BY_KEY.get(PROVIDER_ALIASES[k0]);
  if (!p) return null;
  const { hosts, ...view } = p;
  return view;
}
