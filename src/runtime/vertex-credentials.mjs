// Gemini · Vertex 的 Google 云凭据：设置页上传的那份 JSON 的唯一出处。
//
// 以前只能在服务器上配 GOOGLE_APPLICATION_CREDENTIALS 或跑 gcloud auth application-default login——
// VPS 上没有浏览器、Docker 还得把文件挂进容器，门槛很高。现在管理员在「设置 › Agent › Vertex」里
// 直接上传 / 粘贴凭据 JSON（服务账号密钥，或自己电脑上 gcloud 生成的 application_default_credentials.json），
// 存在数据根 secrets/vertex-credentials.json（0600，不进任何成员的工作区；成员沙箱另有 member-boundary 挡）。
//
// 优先级：这里上传的 > 环境变量 GOOGLE_APPLICATION_CREDENTIALS > gcloud ADC（后两者由 google-auth-library 自己找）。
// 换凭据即时生效：epoch 自增，Vertex 扩展里各处缓存的客户端按 epoch 重建（modules/vertex/server/google-clients.mjs）。

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';

export const VERTEX_CREDS_PATH = path.join(DATA_ROOT, 'secrets', 'vertex-credentials.json');

let cache;        // undefined = 还没读；null = 没有
let epoch = 0;

export function vertexCredentials() {
  if (cache === undefined) {
    try { cache = JSON.parse(readFileSync(VERTEX_CREDS_PATH, 'utf8').replace(/^﻿/, '')); } catch { cache = null; }
  }
  return cache;
}

export function vertexCredsEpoch() { return epoch; }

// 认得的几种：服务账号密钥、gcloud 用户 ADC、工作负载身份联合、模拟服务账号。
const KINDS = {
  service_account: (j) => j.client_email && j.private_key,
  authorized_user: (j) => j.client_id && j.client_secret && j.refresh_token,
  external_account: (j) => j.audience && j.credential_source,
  impersonated_service_account: (j) => j.source_credentials && j.service_account_impersonation_url,
};

// 粘贴 / 上传的文本 → { creds } 或 { error }。不联网，只看结构。
export function parseVertexCredentials(text) {
  let j;
  try { j = JSON.parse(String(text || '').replace(/^﻿/, '').trim()); } catch { return { error: '不是有效的 JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: '不是有效的 JSON' };
  if (j.installed || j.web) return { error: '这是 OAuth 客户端 ID 文件，不是凭据：请下载服务账号密钥，或上传 gcloud 生成的 application_default_credentials.json' };
  const check = KINDS[j.type];
  if (!check) return { error: '认不出的凭据类型' };
  if (!check(j)) return { error: '凭据缺少必要字段（文件可能不完整）' };
  return { creds: j };
}

// 给界面看的摘要：不含任何密钥材料。
export function describeVertexCredentials(c = vertexCredentials()) {
  if (!c) return null;
  const imp = c.type === 'impersonated_service_account' && /serviceAccounts\/([^:]+):/.exec(c.service_account_impersonation_url || '');
  return {
    kind: c.type,
    account: c.client_email || (imp && imp[1]) || '',
    projectHint: c.project_id || c.quota_project_id || '',
  };
}

export function saveVertexCredentials(creds) {
  mkdirSync(path.dirname(VERTEX_CREDS_PATH), { recursive: true });
  const tmp = VERTEX_CREDS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  renameSync(tmp, VERTEX_CREDS_PATH);
  cache = creds;
  epoch++;
}

export function clearVertexCredentials() {
  try { if (existsSync(VERTEX_CREDS_PATH)) unlinkSync(VERTEX_CREDS_PATH); } catch {}
  cache = null;
  epoch++;
}
