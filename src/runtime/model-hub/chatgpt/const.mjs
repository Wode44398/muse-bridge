// ChatGPT 订阅（Sign in with ChatGPT 的「套餐额度」通道）的固定值。出处：developers.openai.com/siwc/token-sharing-open-source。

export const KIND = 'chatgpt';
export const PLAN_BASE = 'https://api.openai.com/v1';
// resource 参数与访问令牌的 aud：固定是这个值（不随测试换地址）
export const RESOURCE = PLAN_BASE;
// 实际发请求的地址放在一个对象里：测试换成本机的假服务
export const EP = {
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  oidcConfig: 'https://auth.openai.com/.well-known/openid-configuration',
  plan: PLAN_BASE,
};
const EP0 = { ...EP };
export function _setEndpointsForTests(patch) { Object.assign(EP, patch ? patch : EP0); }
// 第一次登录（动态注册）用它；回调里给的 oaiapp_… 才是以后换令牌、刷新、重新登录用的 client_id
export const DYNAMIC_CLIENT = 'dynamic_agent_client';
// 官方要求各处一致地用应用的真名：用户在授权页能改显示名，它只是显示用的
export const AGENT_NAME = 'bridge';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
export const CALLBACK_PATH = '/auth/callback';

export const LOGIN_TTL_MS = 10 * 60_000;
// 访问令牌一小时；提前这么久就换新的（长请求开头拿到快过期的令牌，流到一半会 401）
export const REFRESH_AHEAD_MS = 5 * 60_000;
// 刷新令牌 30 天、每次刷新都换新的：长期不用的账号隔这么久主动刷一次，免得过期要重新登录
export const KEEPALIVE_AFTER_MS = 20 * 24 * 3600_000;

// 这条通道不收的请求体字段（preview-limitations）：带了就 400
export const UNSUPPORTED_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
  'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user',
  'previous_response_id', 'service_tier',
];
// 托管工具这条通道都不支持；web_search 看模型与账号策略，先留着，被拒了再去掉重发
export const UNSUPPORTED_TOOLS = new Set([
  'image_generation', 'file_search', 'code_interpreter', 'computer_use', 'computer_use_preview', 'computer', 'mcp', 'tool_search',
  'programmatic_tool_calling',
]);

// 刷新令牌已经不能用了：清掉令牌、要用户重新登录（errors-and-recovery 的 Refresh errors）
export const DEAD_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
