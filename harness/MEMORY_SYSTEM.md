# Dimensio memory and project-knowledge system

The system separates authored notes from rebuildable facts. Generated code
facts never become durable project decisions merely because a model observed
them.

The memory layer follows the shape Anthropic describes for agent memory
(2026-11) and Claude Code uses: raw conversations stay searchable → each note is
a plain Markdown file → a small index of every note sits in the system prompt →
an offline pass ("dreaming") deduplicates, corrects and promotes. Writing is
cheap and mostly unguarded; governance happens offline.

## 1. Notes are files

Location: `<memory root>/workspaces/<workspace-key>/` for a workspace and
`<memory root>/global/` for the global layer (facts about the user or this
machine that hold in every workspace). `MEMORY_DIR` overrides the root.

- A note is `<id>.md`; the id is the file name. Frontmatter is optional: `name`
  / `title`, `description` and `type` (`user | feedback | project | reference`)
  are enough, and a file without frontmatter is listed too (title = its first
  heading or the file name, description = the start of the text). Every
  schema-2 field (`topic`, `status`, `confidence`, `evidence`, `anchors`,
  `expires_at`, `verified_at`, `supersedes`, `source_session`, review fields …)
  is optional and gets a default when read; a note without a status is
  `active`. Old files load unchanged.
- The model reads the directories with Read / Grep / Glob and writes notes with
  Write / Edit. The session's sandbox treats the two directories as its own
  (readable and writable outside the workspace); everything else under the
  memory root — other workspaces' memory, dream state — is unreachable, also
  through `..` or links (`sandbox.ts setOwnStateDirs`, `memory-files.ts`). Only
  top-level `.md` notes may be written directly: `MEMORY.md` (generated),
  `.history/`, `usage.json`, `.provenance.json` are internal, and only Write /
  Edit may write into the memory directory — Bash, Terminal, device pulls and
  any other tool that reports a write target are refused (Write / Edit keep the
  previous version in `.history/` and record provenance; the others cannot).
  Write / Edit check again themselves, also in the admin-only bypass mode:
  internal files stay unwritable, sub-agents and workflow workers can read the
  memory but not write it (`ToolContext.memoryWriter` is set only for the main
  session), a note the user rejected cannot be edited or replaced, and a note
  may not declare itself rejected.
- Read and Grep give a note that matches prompt-injection patterns the same
  treatment as the index: Read returns the withheld notice, Grep skips it.
- After a direct write the harness records provenance in `.provenance.json`
  (session id, whether that session had read external content) instead of
  touching the file, regenerates `MEMORY.md`, and the next run's World State
  memory section carries the new index. While that record exists the fields
  only the server may set are not taken from the file: `origin` counts as
  `model` (so `origin: user` + `user_confirmed` written by the model does not
  skip the injection and external-content checks), `user_confirmed` /
  `verified` read as `observed`, the source session is the recorded one, and a
  review older than the write does not count. Saving through `saveMemory`
  (`Remember`, promotion in the panel) clears the record.
- `Remember` is the shortcut: required `title` and `content`; optional
  `description`, `type`, `layer` (`workspace | global`), `id` (update) and
  `action: "delete"`. Older arguments (`why`, `howToApply`, `topic`, `status`,
  `confidence`, `scope`, `evidence`, `anchors`, `expiresAt`, `verifiedAt`,
  `verifiedCommit`, `supersedes`) are still accepted and land in the
  frontmatter; malformed optional values are dropped with a note in the result.
  The result says which file the note is in. Updating an existing note keeps
  the metadata the call does not give (type, topic, scope, evidence, anchors,
  expiry, verification, a hand-written description); trust is recomputed, so a
  changed note is no longer user-confirmed. Ids come from the title in any
  script (`月桥-前端改版`); an explicit id that matches an existing file (case
  insensitive) updates it.
- What is still decided automatically:
  - a note that looks like it holds a credential is refused by `Remember`; a
    file that does is kept out of the prompt (only counted);
  - a note matching prompt-injection patterns shows only its title and is held
    as unconfirmed;
  - a note written after the session read external content (web pages, search
    results, browser pages) is held as unconfirmed until the user confirms it —
    for direct writes the signal comes from `.provenance.json`;
  - expired notes, notes whose anchor file is gone, and two active notes on one
    topic are quarantined (`stale`) with the reason shown.
  Missing `Why` / `How to apply`, missing evidence, trust levels and topic
  collisions no longer refuse or downgrade a save (that was where 60 of 95
  production notes got stuck as `proposed`).
- `status: rejected` is set only by the user in the memory panel; the model
  cannot overwrite or delete a rejected note. User-confirmed or verified notes
  are retired (soft-deleted) rather than deleted by the model.

Keep in memory what cannot be reconstructed from files: decisions and their
reasons, non-obvious pitfalls, stable preferences, project goals and names.

## 2. The index in the system prompt

`memory-index.ts renderAllMemoryForPrompt` renders both layers, each headed by
its directory's absolute path (an empty layer still names the path), one line
per note: `- <title> — <description> · <id>.md (<flag>)`.

- Listed: every live note — active, unconfirmed (`(unconfirmed)`), and
  quarantined (`(stale: expired)`, `(stale: its anchor file is gone)`,
  `(conflict: …)`, `(retired)`).
- Not listed: superseded notes, notes the user rejected (counted, with "do not
  save those claims again"), injection-pattern and credential-like notes
  (counted as withheld).
- Budget scales with the model's context window: workspace `0.08 × window`
  characters (4,000–24,000), global `0.03 × window` (2,000–8,000). Over budget
  the descriptions are shortened, then dropped, then the least relevant notes
  (unconfirmed / quarantined, rarely read, long unchanged) fold into one line
  "N more notes in this directory". Titles are kept as long as they fit.
- The index is fixed when the session's system prompt is built; later changes
  arrive as the World State `memory` section (no system rewrite).
- After the index the system prompt carries, also fixed at session start:
  - **External memory library** (`external-memory.ts externalMemoryIndex`), when
    `DIMENSIO_EXTERNAL_MEMORY` mounts one for this workspace: its absolute path,
    that it is read-only and kept by other agents, its layering convention
    (`MEMORY.md` → `MEMORY-<area>.md` → single notes) and the text of its
    `MEMORY.md` (budget `0.05 × window`, 3,000–12,000 characters, truncated with
    the path to the rest). Without a `MEMORY.md` its note titles are listed. An
    index matching injection or credential patterns is not shown. The session
    sandbox opens the library read-only.
  - **Recent sessions in this workspace** (`recent-sessions.ts`): up to 15
    earlier sessions (date, title, `session:<id>`), the current one excluded,
    from this instance's own session store (a member instance sees only its
    own). Listing is warmed before the first request with a 1.5 s budget; when
    it is not ready the section is left out.

## 3. Project instruction files

`project-docs.ts` collects agent instruction files from the git root down to
the workspace (nearest last), framed as project-provided reference data under
GUIDE.md.

- Per directory both `AGENTS.md` and `CLAUDE.md` are read
  (`AGENTS.override.md` replaces that directory's `AGENTS.md`). When the two are
  identical, or one only points to the other (a short file naming it, or a lone
  `@AGENTS.md`), one is kept.
- Claude Code style `@path` imports (on their own line or inline; not inside
  code fences or inline code), relative to the importing file, `~/` for home, up
  to 5 levels, each file once. Only text files inside the repository or the
  user's home directory (a member instance: inside its own root); credential
  paths are refused by the sandbox rules. Imports count toward the budget.
- Budget `0.2 × window` characters, 16,000–64,000. Over budget the levels
  farthest from the workspace are cut first, with a note saying what was cut
  and where the file is.
- Subdirectories: when the model first reads or edits a file under a
  subdirectory whose own `AGENTS.md` / `CLAUDE.md` has not been loaded, that
  file is appended as a harness message (`[Project instructions: <dir>/]`,
  kind `project-doc`, persisted, at most 12,000 characters per directory, once
  per directory per session). `node_modules` and dot directories are skipped.
  After a compaction the restore message lists the loaded directories (paths
  only) so they are not injected again.
- Unchanged protections: nothing is loaded when the session runs in the
  fallback default workspace inside dimensio's own install tree.

## 4. Rebuildable project knowledge

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

## 5. Retrieval

`Recall` has three uses: `id` reads one note in full (`global:<id>`,
`external:<id>`, `session:<id>` for the other layers; the file path, source
session and latest review are shown); `query` searches; neither lists the notes.
Note files can equally be read with Read / Grep.

- Notes, the external library and generated project knowledge form one corpus
  (`knowledge-search.ts`). Recall searches every live note (unconfirmed and
  quarantined ones carry their status); superseded and rejected notes are
  excluded.
- Lexical scoring (`text-match.ts`): whole words plus Han-character bigrams
  (2–4 character Han runs also count as a word), stop words and filler bigrams
  dropped; each term is credited to the heaviest field it appears in (path 7,
  title 5, scope 5, note description 4, body 1.5), weighted by rarity across the
  candidates and multiplied by coverage — a partial match still ranks, a query
  that shares nothing scores zero. Exact title / path / scope matches keep their
  bonus.
- Embedding similarity is added when configured and never required. Document
  vectors are cached by content hash in `semantic-index.json`; batches that
  succeed are kept even when a later batch fails, and only a failed query
  embedding fails the search (`semantic: "failed"`, reason in the diagnostics,
  logged once per reason, no URL or key). A Coding Plan key or an
  Anthropic-protocol endpoint has no embeddings and reports `unavailable`.
- `layer: "sessions"` searches this workspace's past conversations (current one
  excluded) with the same scoring over titles (weight 5) and visible text,
  returns the two best passages per session with longer context, and
  `id: "session:<id>"` (optionally with a query) reads one, framed as data.
- Automatic per-task recall (up to six results appended as a persisted internal
  `recall` message after the user's message) is a profile switch,
  `memory.autoRecall`: off in the lean posture (the index is always in the
  prompt), on in hardened. Pure greetings skip it.

Metrics store only a short query hash, result ids, latency, zero-result count
and semantic availability — never raw queries, keys or vectors.

## 6. After-run filing and offline review

- After-run filing (`memory-extract.ts`) is kept in both postures; it does not
  use the main conversation's context. After a run that finished normally it
  decides from deterministic signals whether the run is worth reviewing (a
  stated lasting preference, real work, a fixed failure, a long run, a
  compaction) and skips runs where the model already wrote a note (Remember or
  a direct Write / Edit of a note file). One background side request (same
  provider, no tools, thinking off) returns JSON notes, each filed through
  `Remember`'s lenient path: active only for what the user stated in that run,
  otherwise unconfirmed. Quick-chat buckets only accept global notes.
  `DIMENSIO_MEMORY_EXTRACT=0` turns it off.
- Offline review (`memory-dream.ts`) looks at notes whose current version was
  never reviewed: unconfirmed notes, quarantined active ones, model-written
  active ones (including files the model wrote directly, with or without
  frontmatter) and notes sharing a topic. It keeps / promotes / rewrites /
  merges / retires them, recording `reviewed_at`, `review_verdict`,
  `review_note`; every change archives the old version.
- Trust boundary (unchanged): a note becomes `active` + `user_confirmed`
  through the offline pass only when the quoted passage occurs verbatim in a
  message the user typed in a session shown for that batch
  (`session-search.ts quoteInUserLines`). User-confirmed notes are only
  commented on; rejected notes and the global layer are not touched.
  Promotion no longer consumes a prompt budget (the index folds instead).
- Across sessions: when at least two sessions changed since the last pass,
  recurring patterns citing two shown sessions may be filed as unconfirmed
  notes (active only with a verified quote).
- When: a conversation idle for 20 minutes, one workspace at a time, the same
  workspace at most every 12 hours; starting any run aborts the pass. Settings →
  "空闲时整理记忆" (`memoryDream`) turns the automatic pass off;
  `DIMENSIO_MEMORY_DREAM=0` turns the feature off; `DIMENSIO_MEMORY_DREAM_MODEL`
  pins a model. State lives in `<memory root>/dream-state.json`.

## Management interfaces

All endpoints inherit the harness API guard; response shapes are unchanged and
notes with missing fields come back with the defaults above.

- `GET /api/memory/overview` (capability `memory-overview`): the global layer,
  every project with notes and old quick-chat buckets — per bucket the note
  metadata, usage, prompt-index characters and history parsed from `.history/`.
- `GET /api/memory/dream`, `POST /api/memory/dream` (capability
  `memory-dream`).
- `GET /api/memory`, `GET /api/memory/:id`, `POST /api/memory/search`,
  `POST /api/memory/save` (strict validation, unlike `Remember`),
  `POST /api/memory/:id/delete`, promote / reject / restore.
- `GET /api/knowledge/status`, `/modules`, `/contracts`, `/metrics`;
  `POST /api/knowledge/search`, `/refresh`.

`usage.json` in each layer's directory counts how often a note's full text was
pulled into a conversation (automatic recall, `Recall(id)`): ids, a count and
first / last timestamps only. The memory panel shows it as 召回 N 次.

## Optional embedding configuration

- `KNOWLEDGE_EMBEDDING_API_KEY` — its own key; default endpoint the DashScope
  compatible URL. Without it the configured Qwen key is borrowed together with
  the Qwen service's own base URL (model-center overrides included).
- `KNOWLEDGE_EMBEDDING_BASE_URL`, `KNOWLEDGE_EMBEDDING_MODEL` (default
  `text-embedding-v4`), `KNOWLEDGE_EMBEDDING_DIMENSIONS` (default `256`).
- `KNOWLEDGE_AUTO_SEMANTIC=0` disables semantic work for automatic recall only.

## Verification

Run from `harness/`: `npx tsc --noEmit`, then the server test suite. Memory
coverage lives in `server/memory*.test.ts`, `external-memory.test.ts`,
`knowledge-search.test.ts`, `project-docs*.test.ts`,
`control-plane-write.test.ts` and `memory-recall-rank.test.ts`.
