// Codex 分页用到的接口（契约以《Codex 翻修方案》第十五节为准，字段只加不改名）。
import { api } from '../api.js';

const enc = encodeURIComponent;

export const codexApi = {
  sessions: () => api.get('/api/codex/sessions'),
  projects: () => api.get('/api/codex/projects'),
  createProject: (path) => api.post('/api/codex/project/create', { name: '', path }),
  session: (id) => api.get('/api/codex/session?id=' + enc(id)),
  turns: (id, { cursor = '', limit = 30 } = {}) =>
    api.get(`/api/codex/thread/turns?session=${enc(id)}&limit=${limit}&sort=desc` + (cursor ? '&cursor=' + enc(cursor) : '')),
  deleteSession: (id) => api.post('/api/codex/session/delete', { id }),
  /** 引用线程：整理成 Markdown 落进 uploads，回 { path, name, count } */
  quoteSession: (id, title = '') => api.post('/api/codex/session/quote', { id, ...(title ? { title } : {}) }),
  stop: (sessionId) => api.post('/api/codex/stop', sessionId ? { sessionId } : {}),
  /** 线程操作：fork / revert / compact / steer / rename / archive / unarchive / review / shell / migrate / queue/* / goal */
  op: (op, session, body = {}) => api.post('/api/codex/thread/' + op, { session, ...body }),
  queue: (session) => api.get('/api/codex/thread/queue?session=' + enc(session)),
  active: () => api.get('/api/codex/active'),
  models: () => api.get('/api/codex/models'),
  pool: () => api.get('/api/codex/pool'),
  poolActive: (id) => api.post('/api/codex/pool/active', { id }),
  usage: (account) => api.get('/api/codex/usage' + (account ? '?account=' + enc(account) : '')),
  settings: () => api.get('/api/codex/settings'),
  answer: (qid, payload) => api.answer(qid, payload),
};
