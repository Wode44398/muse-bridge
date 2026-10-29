// Bridge-owned chat history for Gemini (Vertex). Gemini is stateless per call, so
// the bridge keeps the record itself: each turn's question (it sent) + answer (it
// streamed). "Resume" replays these turns as the next call's `contents` (vertex.mjs).
//
// Multi-user: every function takes an optional `dir` (defaults to the admin/global
// vertex-history dir). Per-user callers pass their own .bridge/vertex-history.
// Pure fs.
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { ID_RE, writeJson } from '@bridge/core/jsonfile.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';

const ROOT = DATA_ROOT;
export const HIST = path.join(ROOT, 'vertex-history'); // admin / default
mkdirSync(HIST, { recursive: true });

const fileFor = (id, dir) => path.join(dir, id + '.json');

export function newId() { return randomUUID(); }

export function listConversations(dir = HIST) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch {}
  const out = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      const st = statSync(f);
      out.push({ id: j.id || n.slice(0, -5), title: j.title || '(无标题)', mtime: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Same shape as the Claude /api/session response so the phone UI can reuse it.
export function loadConversation(id, dir = HIST) {
  if (!ID_RE.test(id)) return null;
  const f = fileFor(id, dir);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return { messages: (j.turns || []).map((t) => ({ role: t.role, text: t.text })) };
  } catch { return null; }
}

// Raw prior turns for rebuilding Gemini's `contents` array (context replay).
export function turnsFor(id, dir = HIST) {
  if (!ID_RE.test(id)) return [];
  const f = fileFor(id, dir);
  if (!existsSync(f)) return [];
  try { return (JSON.parse(readFileSync(f, 'utf8')).turns) || []; } catch { return []; }
}

export function appendTurn(id, userText, agentText, dir = HIST) {
  if (!ID_RE.test(id)) return;
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const f = fileFor(id, dir);
  let j = { id, title: '', created: Date.now(), turns: [] };
  if (existsSync(f)) { try { j = JSON.parse(readFileSync(f, 'utf8')); } catch {} }
  if (!j.turns) j.turns = [];
  if (!j.title && userText) j.title = String(userText).replace(/\s+/g, ' ').slice(0, 60);
  j.turns.push({ role: 'user', text: userText });
  j.turns.push({ role: 'assistant', text: agentText });
  j.updated = Date.now();
  writeJson(f, j);
}

export function removeConversation(id, dir = HIST) {
  if (!ID_RE.test(id)) return false;
  try { rmSync(fileFor(id, dir), { force: true }); return true; } catch { return false; }
}
