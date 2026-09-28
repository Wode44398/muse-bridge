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
- `MemoryAudit` is mandatory before task completion and lossy compaction.
- A whole message that is only a greeting or thanks takes a narrow fast-path:
  no semantic recall and no audit turn. Any attached request, preference,
  correction, or project context disables the exemption.
- Memory is workspace-isolated and written atomically.

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

## Agent and management interfaces

- `Recall`: exact memory read, lifecycle catalogue, or filtered hybrid search.
- `ProjectKnowledge`: summary, modules, tests, contracts, health, search,
  metrics, status, and forced refresh.
- Guarded HTTP endpoints:
  - `GET /api/memory/overview` (capability `memory-overview`): the global layer,
    every project that has notes, and old quick-chat buckets in one read-only
    response — per bucket the note metadata, usage, prompt-index characters, and
    history events parsed from `.history/` file names. It never creates a memory
    directory; projects without notes are only counted.
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
