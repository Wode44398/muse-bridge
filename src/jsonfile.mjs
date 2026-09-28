// Shared JSON-file primitives for the small fs-backed stores (accounts, invites,
// sessions, usage, agy/vertex histories, media metadata, routines). One ATOMIC
// writer (tmp + rename, so a crash mid-write never leaves a half-written file) and
// one tolerant reader (missing / corrupt file -> fallback). Plus the shared
// session/conversation id shape used to guard traversal before an id hits a path.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const ID_RE = /^[0-9a-fA-F-]{8,}$/;

export function readJson(file, fallback) {
  try { const o = JSON.parse(readFileSync(file, 'utf8')); return o && typeof o === 'object' ? o : fallback; }
  catch { return fallback; }
}

// Atomic write: serialize to <file>.tmp then rename over the target (same dir =
// same volume = atomic replace). Ensures the parent dir exists. `space` preserves
// each file's prior formatting (2 = human-inspected files, 0 = compact machine data).
export function writeJson(file, obj, space = 0) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj, null, space || undefined));
    renameSync(tmp, file);
  } catch (err) {
    // 磁盘满/权限/占用——账号、邀请码、会话这类数据静默丢失是最难排查的一类故障，
    // 至少在 server 日志里留一行。
    console.error('[jsonfile] write failed:', file, String(err && err.message || err));
  }
}
