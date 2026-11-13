// Gemini 对话 2026-11-04 下线（维护者：「不保留gemini对话了」）。老 apk / 老页面还会打这些接口：一律 410 + 中文说明，
// 不落进 404 或「认不出的按 Claude 跑」。磁盘上的旧对话（vertex-history/）不删，只是不再读。
//   /api/vertex/sessions、/api/vertex/session、/api/vertex/session/delete（会话列表 / 详情 / 删除）
//   POST /api/chat 的 agent:'vertex'（routes/chat.mjs 用同一句话）
// 媒体生成的旧接口（/api/vertex/{image,video,tts,music,…}）不在此列：Media Studio 扩展照常转接。

export const GEMINI_RETIRED = 'Gemini 对话已下线，媒体生成请用 Media Studio';

const gone = (req, res) => {
  res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: GEMINI_RETIRED, retired: 'gemini' }));
};

export function registerGeminiRetiredRoutes(router) {
  router.prefix(['GET', 'POST'], '/api/vertex/session', gone);
}
