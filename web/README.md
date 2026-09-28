# Muse Bridge — web frontend

Vite + Svelte 5 frontend for Muse Bridge. Builds to `../public/app`, which the node
server serves at `/app`. Runs in ordinary desktop and mobile browsers.

Two agent pages:

- **Claude** (`components/ClaudePage.svelte`) — Claude Code via the Agent SDK, with the
  right-side dock (tasks / review / terminal / files).
- **dimensio** (`components/HarnessPage.svelte`) — embeds the harness web app from
  `../harness/web/src` through the `@hx` Vite alias.

When a user has access to both, the home page (`components/Home.svelte`) is a small
launcher with one tile per agent. When only one is enabled for them, that page *is* the
root (no home page; account card at the bottom of its sidebar) — see `rootScreen()` in
`lib/state.svelte.js`.

## Dev

```bash
# 1) a loopback NO_AUTH backend (no token, separate port)
cd ..  &&  PORT=8788 BRIDGE_NO_AUTH=1 node src/server.mjs

# 2) Vite dev (proxies /api + /healthz → 127.0.0.1:8788, SSE passes through)
cd web  &&  npm run dev          # http://127.0.0.1:5173/   (dev base '/'; build base '/app/')
```

Point the proxy elsewhere with `BRIDGE_API=http://127.0.0.1:8787 npm run dev`
(calls then need a Bearer token / cookie). Port 8799 belongs to the harness.

## Build & test

```bash
npm run build                       # → ../public/app  (index.html + solo.html + hashed assets)
node --test src/lib/*.test.js       # small unit tests
```

## Layout

```
web/
  index.html              app shell (early theme binding, #app mount)
  solo.html               single-conversation entry (split-pane iframe / popped-out window)
  vite.config.js          base /app/, build → ../public/app, dev proxy, @hx alias
  src/
    main.js               mount App / SharePage (/w/) / SnapPage (/c/)
    app.css               design tokens (dark default + full light) + fonts
    App.svelte            root router: home / claude / harness / files; login, settings, admin overlays
    components/
      ClaudePage.svelte   Claude page (sidebar, thread, composer, dock)
      HarnessPage.svelte  dimensio page (harness app embedded)
      Home.svelte         launcher (shown only when both agents are enabled)
      AccountCard.svelte  sidebar account card + account menu (both pages)
      claude/             tool groups, Agent / Workflow cards, ModelNotice, RefusalBand
      dock/               Claude dock panels (tasks, review, terminal, files)
      settings/           settings dialog (general / account / agents / connection / about)
      admin/              server admin console
      preview/            unified file viewer (image / video / audio / pdf / office / markdown)
    lib/
      state.svelte.js     shared runes state (session, settings, ui, caps, me, status, refusalBand)
      api.js              REST client
      chat.svelte.js      Claude chat kernel (SSE → reactive message model; sync / resume)
      bus.js / sse.js     account event bus + POST-SSE reader and stall watchdog
      nav.js              history sentinel: system back closes the top layer, not the page
      pageMorph.js        View Transitions page engine (open / close / switch)
      server.js           apiUrl() + server reachability (offline banner)
      cache.js            IndexedDB chat cache (offline read)
  public/
    logo-animations/      Claude asterisk sprite player strips
    assets/               mascot + agent icons
```

## Backend contract (match the backend)

- Chat: `POST /api/chat` → SSE. Buffered per caller; on drop, probe `GET /api/active`
  then `POST /api/attach` to resume buffered events. `POST /api/stop`.
- Questions: SSE `question` event → `POST /api/answer {qid, answers:[{selected,custom}], cancelled?}`.
- Capabilities: `GET /api/capabilities` (Claude models / efforts).
- Sessions: `GET /api/sessions`, `GET /api/session?id=`, `/session/delete`, `/session/export`.
- Status: `GET /api/status` (rate limits + per-conversation context fill).
- Routines: `GET/POST /api/routines`, `/update`, `/delete`, `/run`.
- Workspace: `/api/files*`, `/api/file*`, `/api/share*`.
- dimensio: everything under `/api/harness/*` (proxied to the harness process).
- Auth: `bridge_auth` / `bridge_user` cookie or `Authorization: Bearer <token>`; browser QR
  login via `/api/pair/*`; loopback NO_AUTH for dev.

## Effort levels (Claude page)

The level table (ids + labels) comes from `/api/capabilities` (`claude.efforts`) — the
front end never hard-codes level names; the chip and the slider read the table.

| id | chip label | what the server hands the SDK |
|---|---|---|
| `low` / `medium` / `high` / `xhigh` / `max` | Low / Medium / High / Extra high / Max | `effort: <id>` |
| `ultracode` | Ultracode | `effort: 'xhigh'` + `settings: { ultracode: true, enableWorkflows: true }` |

- **Ultracode** = Extra high effort **plus dynamic workflows** (the `Workflow` tool fans a
  task out to many subagents). Session-scoped on the SDK side: new sessions start without it.
- Not available for `/c/` snapshot visitors and sandboxed (no-shell) users — the server
  downgrades to `xhigh`; Routines reject `ultracode` when saving.
