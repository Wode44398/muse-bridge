// 配方的几种常见样子：界面「从示例开始」、模型配置视图（给 AI 照着改）都用这几份。
// 写法要能直接通过 normalizeRecipe（有单测钉着）；字段名照各家常见的中转站接口，实际用时按对方文档改。

export const RECIPE_EXAMPLES = Object.freeze([
  {
    id: 'async-video', kind: 'video', title: '异步视频：提交 → 轮询 → 结果地址',
    recipe: {
      submit: {
        method: 'POST', path: '/video/create',
        body: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.first.dataUrl}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}' },
      },
      poll: {
        method: 'GET', path: '/video/query', query: { id: '{{submit.$.id}}' }, intervalSec: 5, timeoutMin: 30,
        status: '$.status', done: ['completed', 'succeeded'], failed: ['failed', 'error'], error: '$.error', progress: '$.progress',
      },
      result: { url: '$.video_url', mime: 'video/mp4' },
      params: [
        { key: 'duration', label: '时长', type: 'enum', options: [5, 10], default: 5 },
        { key: 'aspect_ratio', label: '比例', type: 'enum', options: ['16:9', '9:16', '1:1'], default: '16:9' },
      ],
      inputs: { images: { max: 1, roles: ['first'] } },
    },
  },
  {
    id: 'openai-video', kind: 'video', title: 'OpenAI 式视频：multipart 提交 → 轮询 → 下载内容',
    recipe: {
      submit: {
        method: 'POST', path: '/videos', bodyType: 'multipart',
        body: { model: '{{model}}', prompt: '{{prompt}}', seconds: '{{params.seconds}}', size: '{{params.size}}', input_reference: '{{inputs.first.file}}' },
      },
      poll: {
        method: 'GET', path: '/videos/{{submit.$.id}}',
        status: '$.status', done: ['completed'], failed: ['failed'], error: '$.error.message', progress: '$.progress',
      },
      result: { download: { method: 'GET', path: '/videos/{{submit.$.id}}/content' }, mime: 'video/mp4' },
      params: [
        { key: 'seconds', label: '时长', type: 'enum', options: ['4', '8', '12'], default: '8' },
        { key: 'size', label: '尺寸', type: 'enum', options: ['1280x720', '720x1280'], default: '1280x720' },
      ],
      inputs: { images: { max: 1, roles: ['first'] } },
    },
  },
  {
    id: 'sync-image', kind: 'image', title: '同步出图：结果在响应里（base64）',
    recipe: {
      submit: {
        method: 'POST', path: '/images/generations',
        body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', quality: '{{params.quality}}', n: '{{params.n}}', response_format: 'b64_json' },
      },
      result: { b64: '$.data[*].b64_json', mime: 'image/png' },
      params: [
        { key: 'size', label: '尺寸', type: 'enum', options: ['1024x1024', '1536x1024', '1024x1536'], default: '1024x1024' },
        { key: 'quality', label: '画质', type: 'enum', options: ['low', 'medium', 'high'], default: 'high' },
        { key: 'n', label: '张数', type: 'number', min: 1, max: 4, default: 1 },
      ],
    },
  },
  {
    id: 'binary-speech', kind: 'speech', title: '配音：响应本身就是音频文件',
    recipe: {
      submit: { method: 'POST', path: '/audio/speech', body: { model: '{{model}}', input: '{{prompt}}', voice: '{{params.voice}}', response_format: 'mp3' } },
      result: { binary: true, mime: 'audio/mpeg' },
      params: [{ key: 'voice', label: '音色', type: 'enum', options: ['alloy', 'echo', 'nova', 'shimmer'], default: 'alloy' }],
    },
  },
]);
