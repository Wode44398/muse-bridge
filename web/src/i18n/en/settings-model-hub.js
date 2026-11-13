// 英文界面文案 · settings-model-hub（两套设置外壳里「模型中心」这一分区的入口、头图、搜索索引；Studio / dimensio 设置页指过去的那一行）（键 = 中文原文，见 lib/i18n.js）
// 分区正文（HubHome）与浮层的文案归 modelhub 各流自己的文件；同一句中文在别的文件里的英文必须与这里一致（i18n-check 查冲突）
export default {
  // —— 入口与头图 ——
  '模型中心': 'Model Hub',
  '模型中心没加载出来：关掉设置再打开试试。': 'Model Hub didn’t load. Close Settings and open it again.',

  // —— 设置搜索（桌面设置的索引关键词）——
  '自定义 API 共用服务 API 池 Key 池 线路 Vertex 模型服务 第三方模型 接口地址 API Key OpenAI 兼容 DeepSeek Kimi GLM OpenRouter Ollama custom provider base url temperature 显示在模型列表 更多模型 More models 推理强度 档位 effort reasoning_effort 思考 检测连接 探测能力 小米 MiMo': 'custom API shared providers API pool key pool routes Vertex model providers third-party models endpoint base url API key OpenAI compatible DeepSeek Kimi GLM OpenRouter Ollama custom provider temperature show in model list more models reasoning effort level reasoning_effort thinking test connection probe capabilities Xiaomi MiMo',
  '模型中心 媒体服务 文本 图像 视频 配音 音乐 模型 Claude model hub': 'model hub media providers text image video voice music models Claude',
  'dimensio 模型中心 自定义 API OpenAI 兼容 OpenRouter Ollama custom provider base url': 'dimensio model hub custom API OpenAI compatible OpenRouter Ollama custom provider base url',
};
