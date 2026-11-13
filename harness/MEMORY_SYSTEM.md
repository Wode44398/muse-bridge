# Dimensio memory and project-knowledge system

The system deliberately separates authored decisions from rebuildable facts.
Generated code facts never become durable project decisions merely because a
model observed them.

## 1. Governed durable memory

Source of truth: human-readable Markdown under
`memory/workspaces/<workspace-key>/`.

- `Remember` validates lifecycle status, confidence, evidence, scope, anchors,
  expiry, supersession, conflicts, and credential-like content.
- Only currently valid `active` notes enter a fresh prompt.
- Expired notes, missing anchors, conflicting active topics, proposed notes,
  stale notes, and superseded notes remain inspectable but are quarantined.
- There is no memory checkpoint on the agent's critical path (瘦身 P0-1,
  2026-10-07; `MemoryAudit` used to be mandatory before every finish and before
  lossy compaction, costing one extra model turn per user message). The model
  may still `Remember` at any time. After a run finishes normally,
  `server/memory-extract.ts` decides from deterministic signals whether the run
  is worth reviewing — a stated lasting preference, real work (edits with a
  non-trivial number of calls, a failure that was then fixed, a long run, a
  mid-run compaction) — and skips runs where the model already remembered
  something. Worthy runs get one background side request (same provider, no
  tools, thinking off, bounded digest of request / tool trace / changed files /
  final answer / existing catalogue) that returns JSON notes; each note is filed
  through the `Remember` tool so the same governance applies. Quick-chat buckets
  only accept global-layer notes. Full compaction keeps a tool trace of the
  compacted part (`AgentState.compactedTrace`) for this review.
  `DIMENSIO_MEMORY_EXTRACT=0` turns it off.
- A whole message that is only a greeting or thanks takes a narrow fast-path:
  no semantic recall. Any attached request, preference, correction, or project
  context disables the exemption.
- Memory is workspace-isolated and written atomically.
- Every note records the session it was written in (`source_session`, filled
  by the server from the tool context, kept when the note is overwritten
  without one). It is the link back to the raw record that offline review
  (section 4) checks the note against.
- The workspace index that enters a fresh prompt has a character budget
  (`WORKSPACE_PROMPT_BUDGET`, 4000; the global layer keeps its own 2000). Under
  budget the rendering is byte-identical to before; over budget the most
  recalled notes (then the most recently updated) are kept, in their original
  order, with one line saying how many were left out.

Use this layer only for information that cannot be reconstructed from files:
design decisions and reasons, non-obvious reusable pitfalls, stable user
preferences, and project goals or constraints.

## 2. Rebuildable project knowledge

Source: the current workspace. Cache: `knowledge/workspaces/<workspace-key>/`.
Schema v2 writes five atomic JSON snapshots:

- `project-profile.json`: stack, manifests, commands, entrypoints, Git head.
- `test-map.json`: source-to-test relationships and how each was inferred.
- `module-map.json`: module boundaries, imports, reverse imports, exports, and
  mapped tests.
- `runtime-contracts.json`: API routes, environment-key references (never
  values), data tables/models, CI/deploy artifacts, and GUIDE/AGENTS/CLAUDE
  constraints.
- `health.json`: analyzed coverage plus the latest 50 executable verification
  records, including pass/fail, command, edited paths, fingerprint, and commit.

Successful `Edit`/`Write` marks the cache dirty. The next read or search rebuilds
it from current files. Any tool result carrying verification evidence is
appended to `health.json`; rebuilds preserve that bounded history.

## 3. Hybrid retrieval

`Recall(query)` and `ProjectKnowledge(action:"search")` use one unified corpus.
The ranking order is intentional:

1. Apply exact kind, lifecycle status, scope, and path filters.
2. Rank exact path/title/scope and keyword matches.
3. If configured, add embedding similarity without overriding strong exact
   evidence.
4. Return an explanation for every result.

The semantic layer is a local, rebuildable vector cache, not the source of
truth and not a required external vector database. It stores document vectors
by content hash in `semantic-index.json`. Raw queries, API keys, and embedding
values from memory notes are never written to metrics; metrics retain only a
short query hash, result ids, aggregate latency, zero-result count, and semantic
availability.

At the start of every task, up to six relevant results are inserted into a
non-persisted provider context. They do not appear in session history and are
cleared by the next user message. If embeddings are unavailable or fail, the
turn continues with deterministic retrieval. Pure social fast-path messages do
not run this retrieval at all.

## 4. Offline review ("dreaming")

A note is a prediction made at write time: that it will matter again and that
it is true. The after-run filing in section 1 only sees the run that just
ended, and most of what it files waits as `proposed` for a human. On
2026-11-06 the production store held 90 notes, 60 of them proposed (the oldest
from July), duplicates under one topic, and almost none ever recalled.
`server/memory-dream.ts` adds the step that looks back, following Anthropic's
"The components of agent memory" (2026-11-06): transcripts are the ground truth
notes are checked against.

- **What it looks at**: per workspace, only notes whose current version was
  never reviewed (`reviewed_at` < `updated`): proposed notes, quarantined
  active notes, active notes the model made `verified` on its own, and groups
  of notes sharing a topic (kept in one batch so they can be merged). Notes
  that match injection patterns or look like credentials, rejected and retired
  notes, user-confirmed active notes, and the global layer are skipped. At most
  12 notes per pass, 4 per request.
- **Evidence**: the note's source session (or, for older notes, the session
  that was running when it was written, preferring one whose transcript holds
  that `Remember` call): every message the user typed, the assistant text just
  before the note was saved, and the last answer.
- **Decisions**: keep / promote / rewrite / merge / retire, each with a verdict
  (`supported | unclear | contradicted`) and one sentence, recorded on the note
  as `reviewed_at`, `review_verdict`, `review_note`.
- **Trust boundary**: a note becomes `active` only through promote, and only if
  the quoted passage occurs verbatim (whitespace-normalised) in a message the
  user typed in a session shown for that batch — not an injection, not a tool
  result, not assistant text (`session-search.ts quoteInUserLines`). It is then
  saved strictly (`origin: dream`, `user_confirmed`, the quote and session id
  as evidence), subject to the usual validation, topic conflicts and the
  workspace prompt budget. Anything else stays `proposed` with the verdict for
  the user, who can confirm every "supported" note with one click in the
  memory panel. User-confirmed notes are only commented on, never changed.
  Rewrites go back to `proposed`; merged duplicates become `superseded`;
  retired notes become `stale`; every change archives the old version.
- **Across sessions**: when at least two sessions changed since the last pass,
  their digests (user messages, failed tool calls, last answer) go to one more
  request that looks for what recurs in two or more of them. Such a note must
  cite two shown sessions and a topic not already used; it is proposed unless a
  verified quote promotes it.
- **When**: every conversation idle for 20 minutes, one workspace at a time, the
  same workspace at most every 12 hours, and only when there is work. Starting
  any run aborts the pass (finished batches stay; the rest is picked up next
  time). The model is the one the workspace's latest session used. Settings →
  "空闲时整理记忆" (`memoryDream`) turns the automatic pass off;
  `DIMENSIO_MEMORY_DREAM=0` turns the feature off; `DIMENSIO_MEMORY_DREAM_MODEL`
  pins a model (evaluation). State lives in `<memory root>/dream-state.json`.
- **Evaluation**: `evals/memory-dream/run.ts` runs a pass over copies of a
  memory store and its sessions and writes a count-only receipt.

## Agent and management interfaces

- `Recall`: exact memory read, lifecycle catalogue, or filtered hybrid search.
  `layer: "sessions"` searches this workspace's past conversations (the current
  one excluded) and `id: "session:<id>"` reads one, framed as data; reading a
  note shows its source session and its latest review.
- `ProjectKnowledge`: summary, modules, tests, contracts, health, search,
  metrics, status, and forced refresh.
- Guarded HTTP endpoints:
  - `GET /api/memory/overview` (capability `memory-overview`): the global layer,
    every project that has notes, and old quick-chat buckets in one read-only
    response — per bucket the note metadata, usage, prompt-index characters, and
    history events parsed from `.history/` file names. It never creates a memory
    directory; projects without notes are only counted.
  - `GET /api/memory/dream` (capability `memory-dream`): whether the
    automatic pass is on, whether one is running, how many notes await review,
    and the last pass's counts; `POST /api/memory/dream` starts one now
    (202, or 409 while another runs). Not for the global layer.
  - `GET /api/memory`, `GET /api/memory/:id`
  - `POST /api/memory/search`, `POST /api/memory/save`,
    `POST /api/memory/:id/delete`
  - `GET /api/knowledge/status`, `/modules`, `/contracts`, `/metrics`
  - `POST /api/knowledge/search`, `/refresh`

All endpoints inherit the harness API guard; no unguarded memory endpoint is
exposed.

## Usage

`usage.json` in each memory layer's directory counts how often a note's full
text was pulled into a conversation: automatic per-task recall (`memory:<id>` /
`memory:global:<id>` results) and `Recall(id)`. It stores only ids, a count, and
first/last timestamps — never queries. Writes are best-effort and never block a
turn; a directory that does not exist is never created for it. The memory panel
(Settings → 记忆) shows it as 召回 N 次.

## Optional embedding configuration

- `KNOWLEDGE_EMBEDDING_API_KEY` (otherwise the configured Qwen/DashScope key)
- `KNOWLEDGE_EMBEDDING_BASE_URL`
- `KNOWLEDGE_EMBEDDING_MODEL` (default `text-embedding-v4`)
- `KNOWLEDGE_EMBEDDING_DIMENSIONS` (default `256`)
- `KNOWLEDGE_AUTO_SEMANTIC=0` disables semantic work only for automatic
  per-task recall; explicit search can still request it.

`MEMORY_DIR` and `KNOWLEDGE_DIR` override the storage roots for isolation or
tests.

## Verification

Run from `harness/`:

```text
npm run typecheck
npm test
```

The regression suite covers atomic/cache lifecycle, module and contract
extraction, verification-history preservation, exact filtered retrieval,
semantic fallback and cache privacy, automatic expiry quarantine, metrics, and
non-persisted task context.
