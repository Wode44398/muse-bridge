# The Bridge — web frontend

Mobile web frontend rebuild (Vite + Svelte 5). Replaces the legacy single-file
`public/index.html`. Builds to `../public/app`, which the node server serves at
`/app` during the transition (legacy UI stays at `/` until we cut over).

## Dev

```bash
# 1) a loopback NO_AUTH backend (no token, no routine scheduler, separate port)
cd ..  &&  PORT=8799 BRIDGE_NO_AUTH=1 node src/server.mjs

# 2) Vite dev (proxies /api + /healthz → 127.0.0.1:8799, SSE passes through)
cd web  &&  npm run dev          # http://127.0.0.1:5173/   (dev base '/'; build base '/app/')
```

Point the proxy elsewhere with `BRIDGE_API=http://127.0.0.1:8787 npm run dev`
(the prod token server — calls then need a Bearer token / cookie).

## Build

```bash
npm run build        # → ../public/app  (index.html + hashed assets)
```

## Layout

```
web/
  index.html              app shell (early theme binding, #app mount)
  vite.config.js          base /app/, build → ../public/app, dev proxy
  src/
    main.js               mount(App)
    app.css               design tokens (dark default + full light) + fonts
    App.svelte            root router: preload → home/claude/coming; history-sentinel
                          back-nav (lib/nav.js) + offline banner
    lib/nav.js            history sentinel: system side-swipe closes top layer, not the app
    lib/cache.js          IndexedDB chat cache (offline read) + localStorage me
    lib/chat.svelte.js    SSE → reactive message model; load/cache sessions
    lib/server.js         apiUrl(): online-shell relative vs offline-apk remote base
    lib/store.js          token/serverBase via Android SharedPreferences, localStorage fallback
    assets/font/          Bridge Sans (Inter) / Bridge Serif (Lora) / Bridge Icons + Symbols (Lucide), woff2;
                          licenses in public/licenses/. A private overlay can swap brand fonts at runtime
                          (lib/overlay.svelte.js, src/runtime/overlay-web.mjs)
    lib/
      state.svelte.js     shared runes state (session, settings, ui, caps, me, status, taskSheet, refusalBand)
      api.js              REST client (auth/sessions/status/routines/answer…)
      caps.js             load /api/capabilities (or window.__CAPS__)
      sse.js              chat streaming + reconnect/attach (the hard core)
      taskModel.js        Agent / Workflow task model (workflow_progress merge, phases, agent state)
      composerBridge.svelte.js  prefill bridge into the Claude composer (draft + nonce, draft guard)
      refusalRetry.js     "Edit prompt and retry with {original}" after a safeguard model switch
    components/claude/    tool groups, Agent row/card, Workflow card + dots, TaskSheet,
                          ModelNotice (timeline card), RefusalBand (band above the composer)
  public/
    assets/mascot/        claude 小人 站立/举旗/行走 (own drawings) + Claude mark (LobeHub, MIT)
    licenses/             third-party font / icon / logo licenses (shipped with every build)
```

## Backend contract (do NOT change the backend; match it)

- Chat: `POST /api/chat` → SSE. Buffered per-caller; on drop, probe `GET /api/active`
  then `POST /api/attach` to resume buffered events (not the transcript). `POST /api/stop`.
- Questions: SSE `question` event → `POST /api/answer {qid, answers:[{selected,custom}], cancelled?}`.
- Capabilities: `GET /api/capabilities` (models/efforts/media options).
- Sessions: `GET /api/sessions`, `GET /api/session?id=`, `/session/delete`, `/session/export`.
- Status: `GET /api/status` (rate limits + per-conversation context fill).
- Routines: `GET/POST /api/routines`, `/update`, `/delete`, `/run`.
- Auth: `bridge_auth`/`bridge_user` cookie or `Authorization: Bearer <token>`; loopback NO_AUTH for dev.

## Design decisions — Claude page

Locked with the owner. Visual reference: `…/bridge前端设计/claude页面设计参考资源`
(claude.ai mobile clone) + `bridge前端设计-手机端.md`.

> **Status (2026-06-04): the rebuild is DONE and live at prod `/`** (legacy single-file
> falls back to `/legacy`). Everything once "deferred" shipped — preload page, main page
> (wallpaper / liquid-glass 4 buttons / login morph), main→claude entry animation,
> settings page (quality presets + check-update), dynamic-workflow panel. Later additions:
> offline apk + in-app self-update, system side-swipe back (`lib/nav.js` history sentinel),
> local chat cache (`lib/cache.js`, offline browsing). The Claude-page notes below still
> describe the live UI. New backend endpoints since: `/api/app/version|download` (apk
> update), `/api/login|register|logout`, `/api/files*` (workspace, read+write).
- **Themes**: both dark (default) + light, with a topbar toggle (spec §2.1: don't drop light).
- **Topbar**: `[menu] … [theme] [eyes]`, no center title; per-conversation
  rename/export/delete live in the history list item menu.
- **Composer**: greeting `Hey there, {user}`; replace mic → **quota ring** (tightest
  limit; tap → full usage panel with context-window on top); replace voice-chat →
  **enter/submit** key; drop the suggestion pills.
- **Mascot** (小人): appears only while generating, stands above the enter key,
  pointer-events:none (doesn't block the key); switches to the flag (举旗) variant
  when the turn finishes.
- **Thinking bar**: 菊花 + "elapsed · tokens", a separate element shown while generating.
- **Tools**: a run of tool calls folds under an official-style head (`Read 3 files,
  ran 2 commands, ran an agent`; the running tool's label shimmers while live); expand
  lists each call on its own row. `Agent`/`Task` render as an agent row/card,
  `Workflow` as a workflow card with the phase dot grid; tapping either opens the
  TaskSheet (workflow phases / subagent transcript). See `components/claude/`.
- **Model/effort**: tap "Opus 5 · High" → popover (claude.ai style): primary
  models (Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5) + "Effort ›" (Low/Medium/High·default/
  Extra high=xhigh/Max/**Ultracode**) + "More models ›" (1M / legacy). **No** Thinking toggle
  (the backend has only `effort`). Effort levels are described below.
- **Model safeguards**: when the SDK auto-switches models after a refusal
  (`system/model_refusal_fallback`, Fable → Opus), a `ModelNotice` card lands in the
  thread and a `RefusalBand` sits above the composer (`Switched to X` · Why? ·
  `Edit prompt and retry with {original}` · ×). The retry action (`lib/refusalRetry.js`)
  rewinds to the refused user message (conversation anchor only, no file rollback),
  switches the session model back to the original, and prefills the composer with the
  original text (`lib/composerBridge.svelte.js`). The model chip gets a dotted underline
  + title whenever the session's actual model (`status.models[sid]`) differs from the pick.
- **AskUserQuestion**: full support — multiple questions, multi-select, custom, skip/cancel.
- **History status dot**: hollow = idle · 3-dot loop = working · blinking = asking · solid = done (unviewed).
- **Drawer**: only New chat / History / Routines (full CRUD). Everything else removed.
- **Inline images**: Claude-generated media (gen_media SSE) only; vault image browsing is the workspace tab (later).
- **Markdown**: marked + DOMPurify. **Running mark**: StarMark (own SVG + CSS keyframes); a private overlay may
  provide other animation players (ovModule).

## Effort levels (Claude page)

The level table (ids + labels) comes from `/api/capabilities` (`claude.efforts`) — the
front end never hard-codes level names; the chip and the slider read the table.

| id | chip label | what the server hands the SDK |
|---|---|---|
| `low` / `medium` / `high` / `xhigh` / `max` | Low / Medium / High / Extra high / Max | `effort: <id>` |
| `ultracode` | Ultracode | `effort: 'xhigh'` + `settings: { ultracode: true, enableWorkflows: true }` |

- **Ultracode** = Extra high effort **plus dynamic workflows** (the `Workflow` tool fans a
  task out to many subagents). Session-scoped on the SDK side: new sessions start without it.
  The chip shows the level that actually ran — after each turn the Stop hook reports the
  effort and, for an ultracode request, the server confirms `getSettings().applied.ultracode`
  before reporting `ultracode` back; if the pick and the applied level differ the chip gets a
  dotted underline + title.
- The slider (`EffortPanel.svelte`) puts its purple accent, energy field and the
  `Ultracode` help text (`Ultracode is Extra high effort plus workflows. Most thorough,
  slowest, and heaviest on your limits. Applies to this session only…`) on the `ultracode`
  stop; if the table has no such stop (older backend) the accent falls back to the last stop.
- Not available for `/c/` snapshot visitors and sandboxed (no-shell) users — the server
  downgrades to `xhigh`; Routines reject `ultracode` when saving.
