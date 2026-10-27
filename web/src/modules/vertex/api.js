// Vertex（Gemini）扩展给核心用的控制器入口：文件页「发送给 AI」、拖放挂附件。
// 核心只经 modules/services.svelte.js 的 ensureModule('gemini') 动态加载它，基础版主包里没有。
export { vchat, vsend, vnewChat, vloadSession } from '../../lib/vertex.svelte.js';
export { vmedia, sendImageChat, newImageChat, genVideo, genTTS, genMusic } from '../../lib/vertexMedia.svelte.js';
