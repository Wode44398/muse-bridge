// Media Studio 里 Google 客户端（vertex / gemini 方言、Google 云凭据设置）的唯一出处：主机直连，或客户端经家里主机的中继。
// 2026-11-04 随 Gemini 对话下线从 Vertex 扩展搬来；2026-11-13 搬进核心（git mv）：Studio 的驱动和核心的「Google 云凭据」接口
// （routes/vertex-credentials.mjs）共用，关掉 Media Studio 也能配 Vertex 给模型中心用。
//
// 主机（维护者本机 / 服务器）：Vertex 走 ADC，Gemini Developer API 走服务里的 key。
// Windows 客户端（client/agent/profile.mjs 注入）：
//   BRIDGE_VERTEX_RELAY = <能力基址>/v1/vertex   中继按路径第一段 location 分流，替换 Authorization 为主机 ADC 令牌
//   BRIDGE_GEMINI_RELAY = <能力基址>/v1/gemini   中继替换 x-goog-api-key 为主机的 Gemini key
// 客户端上没有 ADC、也不该落 key：本地只放占位令牌，让 SDK 的鉴权层别去找 ADC，真凭据在中继那头注入。
// 主机上设置页上传过凭据（核心 runtime/vertex-credentials.mjs）就用它，优先于 GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC；
// 换了凭据 epoch 自增，各驱动按 vertexClientKey 缓存的客户端随之重建。
// 服务自带服务账号（Studio 的 vertex 服务 credMode 'json'）：调用方把解析好的 credentials 传进来，优先于上面那条链；
// 缓存键带上账号邮箱与私钥指纹，换了账号就重建。中继模式下不认服务自带的账号（凭据在家里主机那头）。

import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { vertexCredentials, vertexCredsEpoch } from './vertex-credentials.mjs';

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

// Vertex（vertexai:true）客户端。credentials：服务自带的服务账号（不给 = 主机凭据链）。
export function vertexGenAI({ project, location, credentials: own }) {
  if (!VERTEX_RELAY) {
    const credentials = own || vertexCredentials();
    return new GoogleGenAI({ vertexai: true, project, location, ...(credentials ? { googleAuthOptions: { credentials, scopes: SCOPES } } : {}) });
  }
  return new GoogleGenAI({
    vertexai: true, project, location,
    googleAuthOptions: { authClient: relayAuthClient() },
    httpOptions: { baseUrl: `${VERTEX_RELAY}/${location}/` },
  });
}

// 服务账号的指纹（缓存键用）：邮箱 + 私钥哈希前 12 位
export const credsTag = (c) => (c && c.client_email ? c.client_email + ':' + createHash('sha256').update(String(c.private_key || '')).digest('hex').slice(0, 12) : '');
// 各驱动缓存 Vertex 客户端用的键：凭据换了键就变，下一次调用拿到新客户端。
export const vertexClientKey = (project, location, credentials) => project + '@' + location + '#' + vertexCredsEpoch() + (credentials && !VERTEX_RELAY ? '#' + credsTag(credentials) : '');

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
const ownClients = new Map();   // 服务账号指纹 → auth client
export async function vertexAccessToken(own) {
  if (VERTEX_RELAY) return RELAY_TOKEN;
  if (own && own.client_email) {
    const tag = credsTag(own);
    let c = ownClients.get(tag);
    if (!c) { c = await new GoogleAuth({ scopes: SCOPES, credentials: own }).getClient(); ownClients.set(tag, c); }
    const t = await c.getAccessToken();
    return t && t.token;
  }
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
