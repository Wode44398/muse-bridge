// Vertex 扩展里所有 Google 客户端的唯一出处：主机直连，或客户端经家里主机的中继。
//
// 主机（维护者本机 / 服务器）：Vertex 走 ADC，Gemini Developer API 走 config 里的 key——和以前一模一样。
// Windows 客户端（client/agent/profile.mjs 注入）：
//   BRIDGE_VERTEX_RELAY = <能力基址>/v1/vertex   中继按路径第一段 location 分流，替换 Authorization 为主机 ADC 令牌
//   BRIDGE_GEMINI_RELAY = <能力基址>/v1/gemini   中继替换 x-goog-api-key 为主机的 Gemini key
// 客户端上没有 ADC、也不该落 key：本地只放占位令牌，让 SDK 的鉴权层别去找 ADC，真凭据在中继那头注入。
// 主机上设置页上传过凭据（核心 runtime/vertex-credentials.mjs）就用它，优先于 GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC；
// 换了凭据 epoch 自增，各驱动按 vertexClientKey 缓存的客户端随之重建。

import { GoogleGenAI } from '@google/genai';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { vertexCredentials, vertexCredsEpoch } from '@bridge/core/runtime/vertex-credentials.mjs';

const VERTEX_RELAY = String(process.env.BRIDGE_VERTEX_RELAY || '').replace(/\/+$/, '');
const GEMINI_RELAY = String(process.env.BRIDGE_GEMINI_RELAY || '').replace(/\/+$/, '');
const RELAY_TOKEN = 'bridge-relay';
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

export const viaRelay = { vertex: !!VERTEX_RELAY, gemini: !!GEMINI_RELAY };

function relayAuthClient() {
  const c = new OAuth2Client();
  c.setCredentials({ access_token: RELAY_TOKEN, expiry_date: Date.now() + 3650 * 86400_000 });
  return c;
}

// Vertex（vertexai:true）客户端。
export function vertexGenAI({ project, location }) {
  if (!VERTEX_RELAY) {
    const credentials = vertexCredentials();
    return new GoogleGenAI({ vertexai: true, project, location, ...(credentials ? { googleAuthOptions: { credentials, scopes: SCOPES } } : {}) });
  }
  return new GoogleGenAI({
    vertexai: true, project, location,
    googleAuthOptions: { authClient: relayAuthClient() },
    httpOptions: { baseUrl: `${VERTEX_RELAY}/${location}/` },
  });
}

// 各驱动缓存 Vertex 客户端用的键：凭据换了键就变，下一次调用拿到新客户端。
export const vertexClientKey = (project, location) => project + '@' + location + '#' + vertexCredsEpoch();

// Gemini Developer API（API key）客户端。
export function geminiGenAI(apiKey) {
  if (!GEMINI_RELAY) return new GoogleGenAI({ apiKey });
  return new GoogleGenAI({ apiKey: apiKey || RELAY_TOKEN, httpOptions: { baseUrl: GEMINI_RELAY + '/' } });
}

// 直调 Vertex REST（Lyria :predict）的地址与令牌。path 不带开头斜杠，如 'v1/projects/…:predict'。
export function vertexRestUrl(location, path) {
  return VERTEX_RELAY ? `${VERTEX_RELAY}/${location}/${path}` : `https://${location}-aiplatform.googleapis.com/${path}`;
}

let adcClient = null, adcEpoch = -1;
export async function vertexAccessToken() {
  if (VERTEX_RELAY) return RELAY_TOKEN;
  if (!adcClient || adcEpoch !== vertexCredsEpoch()) {
    const credentials = vertexCredentials();
    adcEpoch = vertexCredsEpoch();
    adcClient = await new GoogleAuth({ scopes: SCOPES, ...(credentials ? { credentials } : {}) }).getClient();
  }
  const t = await adcClient.getAccessToken();
  return t && t.token;
}

// Gemini Developer API 返回的文件下载地址（Omni 视频）：客户端改走中继。
export function geminiFileUrl(uri) {
  if (!GEMINI_RELAY) return uri;
  try {
    const u = new URL(uri);
    if (u.hostname === 'generativelanguage.googleapis.com') return GEMINI_RELAY + u.pathname + u.search;
  } catch {}
  return uri;
}
