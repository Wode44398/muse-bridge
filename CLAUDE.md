# Muse Bridge

见 `AGENTS.md`（结构、约定、测试命令）。要点：`src/`、`web/`、`harness/` 等以 bridge 公开版为准（`deploy/muse/sync/sync-from-bridge.mjs` 同步，别在这里改）；
Muse 专属的东西只在 `deploy/muse/`、`feedback-worker/`；改了界面要同步改 `deploy/muse/guide/`。
