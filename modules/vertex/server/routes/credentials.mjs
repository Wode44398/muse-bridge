// 设置「Agent › Vertex」的凭据面（管理员）：看现在用的是哪份凭据、上传 / 换 / 删、填项目与区域、测一下通不通。
//
//   GET  /api/vertex/credentials        现状（不含任何密钥材料：服务账号只给邮箱，API Key 只给末 4 位）
//   POST /api/vertex/credentials        { credentials?: JSON 文本 | null（删）, project?, location?, mediaLocation?, apiKey?: 文本 | ''（清）, test? }
//   POST /api/vertex/credentials/test   用现在的配置真打一次（countTokens 不计费；有 API Key 再列一次模型）
//
// 改动即时生效：凭据 epoch 自增让各驱动重建客户端（google-clients.mjs），项目 / 区域 / Key 是核心 config 的活绑定。
// 门禁同 /api/agents：admin 身份（token / cookie），可远程；写操作受全局 Origin 闸保护。

import { readBody } from '@bridge/core/runtime/body.mjs';
import {
  VERTEX_PROJECT, VERTEX_LOCATION, VERTEX_MEDIA_LOCATION, GEMINI_API_KEY, VERTEX_ENV, setVertexConfig,
} from '@bridge/core/config/index.mjs';
import {
  vertexCredentials, parseVertexCredentials, describeVertexCredentials, saveVertexCredentials, clearVertexCredentials,
} from '@bridge/core/runtime/vertex-credentials.mjs';
import { refreshAgentStatus } from '@bridge/core/runtime/agent-status.mjs';
import { VERTEX_MODEL_DEFAULT } from '@bridge/core/config/capabilities.mjs';
import { vertexGenAI, geminiGenAI, vertexAccessToken, viaRelay } from '../google-clients.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

const LOC_RE = /^[a-z0-9-]{2,40}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9.:-]{3,62}$/i;   // 项目 ID 或项目编号（带域的老项目形如 example.com:proj）

const gcloudAdcPath = () => (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
  : path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'));

// 现在实际生效的凭据从哪来（同 google-auth-library 的查找顺序，上传的排最前）
function credSource() {
  if (vertexCredentials()) return 'upload';
  const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (sa) return existsSync(sa) ? 'env' : 'env-missing';
  if (existsSync(gcloudAdcPath())) return 'gcloud';
  return 'none';
}

function status() {
  return {
    ok: true,
    source: credSource(),
    creds: describeVertexCredentials(),
    envFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    project: VERTEX_PROJECT,
    location: VERTEX_LOCATION,
    mediaLocation: VERTEX_MEDIA_LOCATION,
    apiKey: GEMINI_API_KEY ? { set: true, tail: GEMINI_API_KEY.slice(-4) } : { set: false },
    locked: { ...VERTEX_ENV },
    relay: viaRelay.vertex,
  };
}

// Google 的报错 → 一句能照着改的话。原文保留在 detail 里。
function explain(e) {
  const msg = String((e && (e.message || e)) || '');
  const low = msg.toLowerCase();
  if (/invalid_grant|invalid jwt|account not found|invalid_client|decoder|private key|pem|asn1/.test(low)) return '凭据无效：密钥可能已被删除或吊销，重新下载一份再上传';
  if (/service_disabled|has not been used in project|is disabled/.test(low)) return '这个项目还没开通 Vertex AI API：在 Google Cloud 控制台「API 和服务」里启用 Vertex AI API';
  if (/billing/.test(low)) return '这个项目没有关联结算账号：Vertex AI 需要先开通结算';
  if (/permission_denied|permission denied|403/.test(low)) return '没有权限：给这个账号授予「Vertex AI 用户」(roles/aiplatform.user) 角色，并确认项目 ID 填对了';
  if (/not found|404/.test(low) && /project/.test(low)) return '找不到这个项目：检查项目 ID';
  if (/could not load the default credentials|unable to detect a project id/.test(low)) return '还没有凭据：上传一份凭据 JSON';
  if (/enotfound|etimedout|econnreset|econnrefused|fetch failed|socket hang up/.test(low)) return '连不上 Google：检查这台服务器的网络或出站代理';
  return '';
}

// 测试封顶：出站代理按网站审核的环境（如 Muse 的 VM）里，没批过的 Google 地址会一直挂着等人批，别让界面一直转圈
const TEST_TIMEOUT_MS = 30_000;
const TIMED_OUT = 'bridge-test-timeout';
const capped = (p) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(TIMED_OUT)), TEST_TIMEOUT_MS); })]).finally(() => clearTimeout(t));
};
const failText = (e, fallback) => (String((e && e.message) || e) === TIMED_OUT
  ? '30 秒没有回应：这台服务器连不上 Google，或出站代理还在等你批准访问 googleapis.com'
  : explain(e) || fallback);

async function runTest() {
  const out = { vertex: null, apiKey: null };
  if (!VERTEX_PROJECT) out.vertex = { ok: false, error: '还没填项目 ID' };
  else {
    const t0 = Date.now();
    try {
      await capped((async () => {
        await vertexAccessToken();
        // countTokens：走同一条鉴权 + 项目 + 权限链路，但不生成、不计费
        await vertexGenAI({ project: VERTEX_PROJECT, location: VERTEX_LOCATION }).models.countTokens({ model: VERTEX_MODEL_DEFAULT, contents: 'ping' });
      })());
      out.vertex = { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      out.vertex = { ok: false, error: failText(e, '测试没通过'), detail: String((e && e.message) || e).slice(0, 400) };
    }
  }
  if (GEMINI_API_KEY) {
    const t0 = Date.now();
    try {
      await capped(geminiGenAI(GEMINI_API_KEY).models.list({ config: { pageSize: 1 } }));
      out.apiKey = { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      const m = String((e && e.message) || e);
      out.apiKey = { ok: false, error: /api key not valid|api_key_invalid|400/i.test(m) ? 'API Key 无效' : failText(e, '测试没通过'), detail: m.slice(0, 400) };
    }
  }
  return out;
}

export function registerCredentialRoutes(router, { identify }) {
  const gate = (req, res) => {
    const id = identify(req);
    if (id && id.kind === 'admin') return true;
    json(res, id && id.kind !== 'none' ? 403 : 401, { ok: false, error: 'Vertex 凭据仅对管理员开放' });
    return false;
  };

  router.on('GET', '/api/vertex/credentials', (req, res) => {
    if (!gate(req, res)) return;
    json(res, 200, status());
  });

  router.on('POST', '/api/vertex/credentials', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {};
    try { b = JSON.parse(await readBody(req, 256_000)); } catch { return json(res, 400, { ok: false, error: '请求格式不对' }); }

    // 先全部校验，任何一项不对整批不改
    let creds;
    if (typeof b.credentials === 'string' && b.credentials.trim()) {
      const p = parseVertexCredentials(b.credentials);
      if (p.error) return json(res, 400, { ok: false, error: p.error });
      creds = p.creds;
    }
    const cfg = {};
    for (const k of ['project', 'location', 'mediaLocation']) {
      if (b[k] === undefined) continue;
      const v = String(b[k] ?? '').trim();
      if (v && !(k === 'project' ? PROJECT_RE : LOC_RE).test(v)) return json(res, 400, { ok: false, error: k === 'project' ? '项目 ID 格式不对' : '区域格式不对（如 global、us-central1）' });
      cfg[k] = v;
    }
    if (b.apiKey !== undefined) {
      const v = String(b.apiKey ?? '').trim();
      if (v && !/^[A-Za-z0-9_\-]{20,120}$/.test(v)) return json(res, 400, { ok: false, error: 'API Key 格式不对' });
      cfg.apiKey = v;
    }
    // 没填项目时用凭据里带的（服务账号密钥都有 project_id）
    if (creds && !VERTEX_PROJECT && !cfg.project) {
      const hint = describeVertexCredentials(creds).projectHint;
      if (hint) cfg.project = hint;
    }

    try {
      if (creds) saveVertexCredentials(creds);
      else if (b.credentials === null) clearVertexCredentials();
      if (Object.keys(cfg).length) setVertexConfig(cfg);
    } catch (e) {
      return json(res, 500, { ok: false, error: '保存失败：' + ((e && e.message) || e) });
    }
    refreshAgentStatus();
    json(res, 200, { ...status(), test: b.test ? await runTest() : undefined });
  });

  router.on('POST', '/api/vertex/credentials/test', async (req, res) => {
    if (!gate(req, res)) return;
    json(res, 200, { ...status(), test: await runTest() });
  });
}
