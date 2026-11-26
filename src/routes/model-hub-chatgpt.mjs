// 设置 › 模型中心 · ChatGPT 订阅（Sign in with ChatGPT）的后端。挂在 model-hub 路由里，同一个管理员守卫、同一种 POST 写法。
//   POST /api/model-hub/chatgpt/login/start   { serviceId?, lineId? } → { login }   都不给 = 新建服务；只给 serviceId = 加账号；都给 = 这个账号重新登录
//   POST /api/model-hub/chatgpt/login/status  { loginId }             → { login }
//   POST /api/model-hub/chatgpt/login/finish  { loginId, url }        → { login }   url = 登录后浏览器停住的 http://127.0.0.1:…/auth/callback?… 整段
//   POST /api/model-hub/chatgpt/login/cancel  { loginId }             → {}
//   POST /api/model-hub/chatgpt/create        { loginId, name?, assign, defaultModel? } → { service, warnings }
// LoginView 的形状见 runtime/model-hub/chatgpt/service.mjs 的 loginView；任何响应都不带令牌。
import {
  startChatgptLogin, chatgptLoginStatus, finishChatgptLogin, cancelChatgptLogin, createFromLogin,
} from '../runtime/model-hub/chatgpt/service.mjs';

/** post = model-hub 路由里带守卫与读体的注册函数。 */
export function registerChatgptRoutes(post) {
  post('/api/model-hub/chatgpt/login/start', async (b) => ({ login: await startChatgptLogin({ serviceId: String(b.serviceId || ''), lineId: String(b.lineId || '') }) }));
  post('/api/model-hub/chatgpt/login/status', (b) => ({ login: chatgptLoginStatus(b.loginId) }));
  post('/api/model-hub/chatgpt/login/finish', async (b) => ({ login: await finishChatgptLogin(b.loginId, String(b.url || '').slice(0, 8000)) }));
  post('/api/model-hub/chatgpt/login/cancel', (b) => { cancelChatgptLogin(b.loginId); return {}; });
  post('/api/model-hub/chatgpt/create', (b) => createFromLogin({
    loginId: String(b.loginId || ''), name: b.name, assign: Array.isArray(b.assign) ? b.assign : [], defaultModel: b.defaultModel,
  }));
}
