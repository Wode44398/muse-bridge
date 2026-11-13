// 型号种类判定：一个型号 ID 落在 文本 / 图像 / 视频 / 配音 / 音乐 / 其他 哪一类。
//
// 模型中心「识别」出的目录、Media Studio 的可选型号、dimensio 的型号表共用这一份，所以：
//   · 纯函数、不发请求、不 import 别的模块（bridge 前端也会打进包里，越小越好）；
//   · 先信上游给的元数据，名字只是兜底——同一个名字在不同站点意义可能不同（kling 既有视频也有图像接口），
//     目录出处（hint）与条目里的 output_modalities / type / category 才是这条线路上的真话；
//   · 名字规则按「排除 → 音乐 → 配音 → 明确的视频字样 → 明确的图像字样 → 视频品牌 → 图像品牌 → 文本」排：
//     越具体的字样越先判。否则 grok-imagine-video 会被「imagine」先拉成图像，gpt-4o-mini-tts 会被当成对话，
//     wanx2.1-t2v 会因为 wanx 是图像系列被判成图像。
//
// 「其他」= 向量、重排、语音识别、审核、OCR、实时语音对话、3D 等：模型中心里看得见、但不能添加到任何去向。

export const MODALITIES = Object.freeze(['text', 'image', 'video', 'voice', 'music']);
const KINDS = new Set([...MODALITIES, 'other']);

// ---------- 规范化 ----------

// 只剥「不改变型号身份」的包装：各家 API 的路径前缀、OpenRouter 的 ~别名与 :free / :thinking 变体、
// Claude 的 [1m] 档位标记、Ollama 的 :8b 标签、Replicate 的 :版本哈希、Vertex 的 @版本戳。
// 厂商前缀（openai/、fal-ai/…）保留——kling-video/…/image-to-video 这类路径本身就是最好的线索。
function normId(id) {
  let s = String(id ?? '').trim().toLowerCase();
  s = s.replace(/\[[^\]]*\]$/, '');
  s = s.replace(/^(?:models|tunedmodels)\//, '');                                   // Gemini API
  s = s.replace(/^accounts\/[^/]+\/models\//, '');                                  // Fireworks
  s = s.replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/([^/]+)\/models\//, '$1/'); // Vertex
  s = s.replace(/^@(?:cf|hf)\//, '');                                               // Cloudflare Workers AI
  s = s.replace(/(^|\/)~/g, '$1');                                                  // OpenRouter 的 ~vendor/…-latest
  s = s.replace(/(.)@[\w.-]+$/, '$1');                                              // Vertex 的 claude-…@20250514
  s = s.replace(/:[\w.-]+$/, '');                                                   // :free、:8b、:0、:哈希
  return s;
}

// ---------- 名字规则 ----------

// 左右边界：开头 / 结尾或非字母。数字和分隔符都算边界——veo3、sd3、gen4_turbo、qwen3guard 都要认得出来，
// 而 aurora 里的 ora、media 里的 dia、audio 里的 udio 不能误中。
const w = (alts) => new RegExp(`(?:^|[^a-z])(?:${alts})(?![a-z])`);

// 不能添加的：向量 / 重排 / 审核 / OCR / 语音识别 / 实时语音对话 / 3D / 编码器……
const OTHER_RES = [
  /embed|rerank|moderation|imagebind/,                       // text-embedding-3、gemini-embedding、nomic-embed、bge-reranker
  w('bge|bce|gte|e5|voyage|jina|colbert|colpali|siglip\\d*|clip-vit'),
  /guard(?:ian)?(?![a-z])|shieldgemma|content-safety|safety-?classifier/, // llama-guard、qwen3guard、gpt-oss-safeguard、granite-guardian
  /ocr(?![a-z])/,                                            // mistral-ocr、deepseek-ocr、paddleocr-vl、dots.ocr、olmocr
  /whisper|transcri|paraformer|sensevoice|speech-?to-?text|speech2text|parakeet|livetranslate/,
  /asr(?![a-z])/, w('stt|scribe'),                           // fun-asr、qwen3-asr-flash、TeleSpeechASR、scribe_v1
  /native-audio|realtime|bidi|computer-use|robotics|nova-sonic/, // 实时语音对话 / 操控电脑 / 机器人：都不是一问一答
  w('aqa'),
  /(?:^|[^a-z])gpt-(?:[\w.]+-)*audio(?![a-z])/,               // gpt-4o-audio-preview、gpt-audio-mini：音频对话，不是配音
  /gemini(?:[\w.-]*-)?live(?![a-z])/,                         // Gemini Live（gemini-2.0-flash-live-001、gemini-live-2.5-flash）
  /sound-?effects?|mmaudio|foley/, w('sfx'),                  // 音效：既不是配音也不是音乐
  /hunyuan3d|seed3d|trellis|tripo|meshy|rodin|hyper3d/, w('3d'), // 3D 生成
  w('bert|roberta|deberta|distilbert|xlm-roberta'),          // 分类 / 抽取用的编码器
];

// 音乐（排在配音前：eleven_music、minimax music-1.5 不能被 eleven / minimax 的配音规则吃掉）
const MUSIC_RES = [
  /lyria|music|mureka|diffrhythm|riffusion|ace-step|stable-audio|beatoven|songgen/,
  w('suno|udio|songs?'), /chirp-v\d/,                        // chirp-v4 是 Suno；Google 的 Chirp 是语音，不在这里
];

// 配音（TTS）。注意 glm-4-voice、qwen3-omni 是语音对话 / 全模态的对话模型，不归这里——所以不收单独的 voice 字样。
const VOICE_RES = [
  /ttsd?(?![a-z])/,                                          // gpt-4o-mini-tts、tts-1-hd、qwen3-tts-flash、f5-tts、megatts3、melotts、MOSS-TTSD
  /text-?to-?speech|text2speech|cosyvoice|sambert|kokoro|chatterbox|fish-?speech|openaudio|cartesia|orpheus|index-?tts|vibevoice|sovits|zonos|csm-1b|voice-?(?:design|clon|changer)/,
  w('eleven|dia'),                                           // eleven_multilingual_v2、nari-labs/dia
  /(?:^|[^a-z])speech-\d/,                                   // MiniMax speech-02-hd / speech-2.6、Fish speech-1.5
  /(?:^|[^a-z])sonic-(?:\d|turbo|english|multilingual)/,     // Cartesia sonic-2（光秃秃的 sonic 曾是 OpenRouter 上的编码模型）
];

// 明确写了「出视频」的字样：t2v / i2v / ti2v / kf2v / s2v / r2v、img2vid、…-to-video
const VIDEO_EXPLICIT_RES = [
  /(?:^|[^a-z])[a-z]{1,3}2v(?:id(?:eo)?)?(?![a-z])/,
  /to-?video|2video/,
];
// 明确写了「出图」的字样：t2i / i2i、…-to-image、img2img
const IMAGE_EXPLICIT_RES = [
  /(?:^|[^a-z])[a-z]{1,3}2i(?:mg|mage)?(?![a-z])/,
  /to-?image|2image|(?:txt|text|img)2img/,
];
// 名字里带 video / image 但其实是「看」视频 / 图的对话模型
const VIDEO_TEXT_GUARD = /llava|llama|internvideo|videochat|video-?r1|understand|caption|(?:^|[^a-z])vl(?![a-z])/;
const IMAGE_TEXT_GUARD = /to-?text|img2txt|2text|understand|caption/;

const VIDEO_BRAND_RES = [
  /(?:^|\/)gemini-omni/,                                     // Gemini Omni 出视频；qwen3-omni、gpt-4o（omni）都是对话模型
  w('veo|sora|ltxv?|mochi|magi|pika|avatar|hedra|vace|wan-?\\d|ray'),
  /seedance|seaweed|hailuo|cogvideo|skyreels|happyhorse|heygen|omnihuman|lipsync|infinitetalk|haiper|animatediff|pixverse|runway|dream-machine|nova-reel/,
  /(?:^|[^a-z])(?:kling|vidu)/,                              // kling-v2.1、klingai、vidu-q1、viduq2；左边要有界：inkling 是 Thinking Machines 的文本模型
  /(?:^|[^a-z])gen-?[2-9](?:\.\d+)?a?(?![a-z0-9])/,          // Runway gen-4.5、gen4_turbo、gen3a_turbo（codegen2 前面是字母，不中）
  /(?:^|[^a-z])aleph(?![-_ ]?alpha)/,                         // Runway Aleph；Aleph Alpha 是文本模型厂
];

const IMAGE_BRAND_RES = [
  /gpt-image|chatgpt-image|dall-?e|nano-?banana|imagine|seedream|seededit|kontext|recraft|ideogram|stable-diffusion|midjourney|cogview|kolors|hidream|riverflow|playground-v|pixart|kandinsky|auraflow|omnigen|jimeng|dreamina|step1x|nova-canvas/,
  w('imagen|flux|sdxl|sd-?xl|sd[1-3]|niji|krea|photon|wanx|bria|reve'),
  // 超分 / 修脸 / 抠图：出的也是图（fal 把它们归在 image-to-image）；视频超分前面已被 video 字样截走
  /upscal|esrgan|gfpgan|codeformer|rembg|birefnet|remove-?(?:bg|background)|background-?remov/,
];

const anyOf = (res, s) => res.some((re) => re.test(s));

// 只看名字（s 已规范化）。认不出就是文本：OpenAI 兼容接口列出来的绝大多数都是对话模型。
function kindByName(s) {
  if (!s) return 'text';
  if (anyOf(OTHER_RES, s)) return 'other';
  if (anyOf(MUSIC_RES, s)) return 'music';
  if (anyOf(VOICE_RES, s)) return 'voice';
  if (anyOf(VIDEO_EXPLICIT_RES, s)) return 'video';
  if (anyOf(IMAGE_EXPLICIT_RES, s)) return 'image';
  if (/video/.test(s)) return VIDEO_TEXT_GUARD.test(s) ? 'text' : 'video';
  if (/image/.test(s)) return IMAGE_TEXT_GUARD.test(s) ? 'text' : 'image';
  if (anyOf(VIDEO_BRAND_RES, s)) return 'video';
  if (anyOf(IMAGE_BRAND_RES, s)) return 'image';
  return 'text';
}

// 音频一类（配音 / 音乐 / 其他）只有名字能分：上游目录常把 TTS、音乐、语音识别、音频对话混在一个「audio」里。
function audioByName(s) {
  const k = kindByName(s);
  return k === 'music' || k === 'voice' || k === 'other' ? k : null;
}

// ---------- 元数据 ----------

// 路由型条目（openrouter/auto 一类）的 output_modalities 是「可能路由到的模型」的并集，按它判会把路由判成出图。
const isRouter = (s) => /^openrouter\//.test(s) || /(?:^|\/)(?:auto|switchyard)(?:-[\w.-]*)?$/.test(s);

function outputsOf(raw) {
  const arch = raw.architecture && typeof raw.architecture === 'object' ? raw.architecture : null;
  let out = arch?.output_modalities ?? raw.output_modalities ?? raw.outputModalities
    ?? (raw.modalities && typeof raw.modalities === 'object' && !Array.isArray(raw.modalities) ? raw.modalities.output : undefined);
  if (!Array.isArray(out) && typeof arch?.modality === 'string' && arch.modality.includes('->')) {
    out = arch.modality.split('->')[1].split('+');                // OpenRouter 旧字段 "text+image->text"
  }
  if (!Array.isArray(out)) return null;
  const list = out.map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean);
  return list.length ? list : null;
}

// OpenRouter / models.dev 一类的 output_modalities
function kindFromOutputs(out, s) {
  if (out.some((x) => x.includes('embed'))) return 'other';
  if (out.includes('video')) return 'video';
  if (out.includes('image')) return out.includes('text') && isRouter(s) ? 'text' : 'image';
  if (out.some((x) => x === 'audio' || x === 'speech' || x === 'music')) {
    const a = audioByName(s);
    if (a) return a;                                           // lyria → 音乐、gpt-audio → 其他
    if (out.includes('music')) return 'music';
    return out.includes('text') ? 'text' : 'voice';            // 文本 + 音频且名字看不出 = 全模态对话（qwen3-omni）
  }
  if (out.includes('text')) return 'text';
  return null;
}

// 各家目录的类型标签：Studio 的 kind、fal 的 category、硅基流动 / Together 的 type 与 sub_type、
// Hugging Face 的 pipeline_tag、火山方舟的 domain / task_type、new-api 的 supported_endpoint_types……
// 统一成 kebab-case 再判；认不出的标签（Anthropic 的 type: 'model'）返回 null，交给下一条线索。
function kindFromTag(tag, s) {
  let t = typeof tag === 'string' ? tag.trim() : '';
  if (!t) return null;
  t = t.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[\s_]+/g, '-');
  // 「x-to-y」：只看输出那一端（video-to-audio 是给视频配音效，不是视频模型）
  const to = t.match(/^(.*?)-?(?:-to-|2)(text|image|img|video|vid|speech|voice|audio|music|3d)$/);
  if (to) {
    const [, input, out] = to;
    if (out === 'text') return /speech|audio|voice/.test(input) ? 'other' : 'text';
    if (out === 'image' || out === 'img') return 'image';
    if (out === 'video' || out === 'vid') return 'video';
    if (out === 'speech' || out === 'voice') return /speech|audio|voice/.test(input) ? 'other' : 'voice'; // 变声不是配音
    if (out === 'music') return 'music';
    if (out === 'audio') return /audio|video/.test(input) ? 'other' : (audioByName(s) ?? 'other');
    return 'other';
  }
  if (/embed|rerank|similarity|feature-extraction|moderation|classif|safety|guard|ocr|segment|detect|depth|3d|training|fine-?tun|recogni|transcri|asr|stt/.test(t)) return 'other';
  if (/video/.test(t)) return /understand|caption|qa|chat/.test(t) ? 'text' : 'video';
  if (/image|img|picture|painting|drawing/.test(t)) return /understand|caption|qa|chat|vision-language/.test(t) ? 'text' : 'image';
  if (/music|song/.test(t)) return 'music';
  if (/tts|speech|voice/.test(t)) return 'voice';
  if (t === 'audio' || /audio-?gen/.test(t)) return audioByName(s) === 'music' ? 'music' : 'voice'; // Together 的 type: audio = TTS
  if (/^(?:chat|chat-?completions?|completions?|language|text|code|llm|vlm|lm|vision|multimodal|reasoning|instruct|conversational|summarization|translation|question-answering|visual-question-answering)$/.test(t)
    || /text-generation|text2text|chat|llm|vlm|language-model/.test(t)) return 'text';
  return null;
}

const TAG_FIELDS = ['sub_type', 'subType', 'category', 'pipeline_tag', 'task', 'task_type', 'taskType', 'type', 'domain', 'supported_endpoint_types'];

function kindFromTags(src, s) {
  for (const f of TAG_FIELDS) {
    const v = src[f];
    for (const x of Array.isArray(v) ? v : [v]) {
      const k = kindFromTag(x, s);
      if (k) return k;
    }
  }
  return null;
}

function kindFromRawInner(raw, s) {
  const studio = kindFromTag(raw.kind, s);                     // Studio 自己的目录条目：image / video / speech / music
  if (studio) return studio;
  const out = outputsOf(raw);
  if (out) {
    const k = kindFromOutputs(out, s);
    if (k) return k;
  }
  const tagged = kindFromTags(raw, s) ?? (raw.metadata && typeof raw.metadata === 'object' ? kindFromTags(raw.metadata, s) : null);
  if (tagged) return tagged;
  // Gemini API：predictLongRunning 只有 Veo 用；只剩 embedContent / bidiGenerateContent / generateAnswer 的
  // 是向量、Live 实时音频、AQA——都不能一问一答
  const methods = raw.supportedGenerationMethods ?? raw.supported_generation_methods ?? raw.supportedActions;
  if (Array.isArray(methods) && methods.length) {
    const m = new Set(methods.map((x) => String(x).toLowerCase()));
    if (m.has('predictlongrunning')) return kindByName(s) === 'image' ? 'image' : 'video';
    if (!m.has('generatecontent') && !m.has('streamgeneratecontent') && !m.has('predict')) return 'other';
  }
  const caps = raw.capabilities;
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    // Mistral：completion_chat: false 的是 embed / OCR / 审核 / 转写
    if (caps.completion_chat === false || caps.chat === false) {
      const k = kindByName(s);
      return k === 'text' ? 'other' : k;
    }
  } else if (Array.isArray(caps) && caps.length) {
    // Ollama /api/show：只有 embedding、没有 completion 的是向量模型
    const c = new Set(caps.map((x) => String(x).toLowerCase()));
    if ((c.has('embedding') || c.has('embeddings')) && !c.has('completion') && !c.has('chat')) return 'other';
  }
  // ElevenLabs /v1/models
  if (raw.can_do_text_to_speech === true) return audioByName(s) === 'music' ? 'music' : 'voice';
  if (raw.can_do_text_to_speech === false && (raw.can_do_voice_conversion || raw.can_do_speech_to_text)) return 'other';
  return null;
}

// 元数据说是文本时仍让名字里的「排除」字样说了算：审核 / 安全分类器在 OpenRouter 上的 output 也是 text，
// Together 也把 Llama Guard 标成 chat 一类。
function kindFromRaw(raw, s) {
  const k = kindFromRawInner(raw, s);
  return k === 'text' && kindByName(s) === 'other' ? 'other' : k;
}

function hintKind(h) {
  const t = typeof h === 'string' ? h.trim().toLowerCase() : '';
  if (!t) return null;
  if (KINDS.has(t)) return t;
  if (t === 'speech' || t === 'tts') return 'voice';           // Studio 内部把配音叫 speech
  if (t === 'audio') return 'audio';                           // 只知道「出音频」：配音 / 音乐 / 其他交给名字与元数据
  return null;
}

/**
 * 型号种类。id：上游的型号 ID（带不带厂商前缀都行）；
 * meta.hint：目录出处（OpenRouter ?output_modalities=image 这类专门目录、Studio 方言给的种类），最高优先；
 * meta.raw：上游这条型号的原始条目；meta.mediaOnly：纯媒体服务（fal、Replicate…），名字认不出就算「其他」。
 */
export function classifyModality(id, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const s = normId(id);
  const raw = m.raw && typeof m.raw === 'object' && !Array.isArray(m.raw) ? m.raw : null;
  const h = hintKind(m.hint);
  if (h === 'text' || h === 'image' || h === 'video' || h === 'other') return h;
  if (h) {
    // 音频目录的出处只说明「出音频」：SenseVoice（识别）、lyria（音乐）、gpt-audio（音频对话）常和 TTS 混在一起，
    // 名字看得出就按名字；看不出才信 hint
    const a = audioByName(s);
    if (a) return a;
    if (h === 'audio') {
      const r = raw ? kindFromRaw(raw, s) : null;
      return r === 'text' || r === 'music' ? r : 'voice';
    }
    return h;
  }
  if (!s) return 'other';
  if (raw) {
    const r = kindFromRaw(raw, s);
    if (r) return r;
  }
  const k = kindByName(s);
  return k === 'text' && m.mediaOnly ? 'other' : k;
}
