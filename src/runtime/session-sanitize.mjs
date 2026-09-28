// Workaround for an Agent SDK / Claude Code session-log bug. Extended-thinking
// blocks get persisted to the session .jsonl with their TEXT emptied but the
// signature kept: { type:'thinking', thinking:'', signature:'<1.5KB>' }. On resume
// the SDK replays these blocks to the API, which validates the signature against the
// (now-missing) text and 400s:
//   "thinking blocks in the latest assistant message cannot be modified."
// The original text is gone and the signature is one-way, so the block can't be
// repaired — but the text / tool_use / tool_result blocks around it are intact. We
// strip the dead thinking blocks before resume: conversation content is preserved,
// only the (invisible) reasoning is dropped, and the API stops validating absent
// thinking. Most resumes survive without this; the ones that 400 are turns where a
// dead thinking block sits in a thinking+tool_use sequence the API checks strictly.
//
// The .jsonl stores ONE content block per line, chained by uuid/parentUuid into a
// turn. Dropping a thinking line therefore requires rewiring its child's parentUuid
// to the dropped line's parent so the chain the SDK walks stays unbroken.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const isDeadThinking = (b) =>
  b && (b.type === 'thinking' || b.type === 'redacted_thinking') &&
  !((b.thinking || b.text || '').length) && (b.signature || b.data);

// Strip dead thinking blocks from a session .jsonl in place (atomic tmp+rename).
// Returns { ok, touched, dropped } — touched=0 means the file was left untouched.
export function sanitizeSessionThinking(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'unreadable' }; }
  const lines = raw.split('\n');
  const items = lines.map((ln) => { try { return { o: JSON.parse(ln), raw: ln }; } catch { return { o: null, raw: ln }; } });

  const remap = new Map(); // dropped uuid -> its parentUuid (for rewiring children)
  const drop = new Set();  // line indices to remove
  let touched = 0;

  for (let i = 0; i < items.length; i++) {
    const o = items[i].o; if (!o) continue;
    const m = o.message;
    if (!m || !Array.isArray(m.content) || !m.content.some(isDeadThinking)) continue;
    touched++;
    const rest = m.content.filter((b) => !isDeadThinking(b));
    if (rest.length === 0) {
      // Whole line was just a dead thinking block — drop it and remember the rewire.
      drop.add(i);
      if (o.uuid != null) remap.set(o.uuid, o.parentUuid ?? null);
    } else {
      m.content = rest; // mixed line (rare): keep it, minus the dead block(s)
    }
  }

  if (touched === 0) return { ok: true, touched: 0, dropped: 0 };

  // Resolve chains of consecutively-dropped lines to the nearest surviving ancestor.
  const resolve = (u) => { let x = u; const seen = new Set(); while (x != null && remap.has(x) && !seen.has(x)) { seen.add(x); x = remap.get(x); } return x; };
  for (const it of items) {
    const o = it.o; if (!o) continue;
    if (o.parentUuid != null && remap.has(o.parentUuid)) o.parentUuid = resolve(o.parentUuid);
  }

  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (drop.has(i)) continue;
    out.push(items[i].o ? JSON.stringify(items[i].o) : items[i].raw);
  }
  const content = out.join('\n');
  try {
    const tmp = file + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch (e) {
    // Windows: a LIVE session file is held open by the SDK, so the atomic rename
    // (which needs exclusive access to the target) fails with EPERM and the clean
    // never lands — the dead blocks survive to 400 the next resume. The SDK opens
    // it shared-read/write though, so an in-place overwrite succeeds (verified).
    // Less atomic, but landing the clean matters more than the tiny half-write risk.
    try { writeFileSync(file, content); }
    catch (e2) { return { ok: false, reason: String((e2 && e2.message) || e2) }; }
  }
  return { ok: true, touched, dropped: drop.size };
}
