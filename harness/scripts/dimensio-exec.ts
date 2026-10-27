// M15（Codex X35）：dimensio 的 exec 形态——命令行发一条消息，读完这一轮，把最终正文打到 stdout，结局打到 stderr。
// 走产品实际的 /api/run（server/headless-client.ts），卡片按无人值守落定（权限默认拒；--allow-once 逐次放行）。
//
//   DIMENSIO_TOKEN=<令牌> node scripts/dimensio-exec.ts [--base http://127.0.0.1:8799] [--session <id>] [--allow-once]
//                         [--workspace <dir>] [--provider <id>] [--model <id>] [--mode auto|plan|read-only] "要做的事"
//
// 令牌：直连 harness 用它的能力令牌（开发实例启动时打印的 dev token）；经 bridge（--base …/api/harness）时是 bridge 的令牌，
// 走 Authorization 头（--bridge）。退出码：做完 0，出错 1，流断了 2。
import { runHeadless } from "../server/headless-client.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);
const VALUE_FLAGS = new Set(["--base", "--session", "--workspace", "--provider", "--model", "--mode"]);
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !VALUE_FLAGS.has(all[i - 1] ?? ""));
const message = positional.join(" ").trim();
if (!message) {
  console.error('usage: DIMENSIO_TOKEN=… node scripts/dimensio-exec.ts [--base URL] [--session ID] [--allow-once] "message"');
  process.exit(64);
}
const token = process.env.DIMENSIO_TOKEN?.trim();
if (!token) {
  console.error("DIMENSIO_TOKEN is not set");
  process.exit(64);
}
const base = arg("--base") ?? "http://127.0.0.1:8799";
const headers: Record<string, string> = flag("--bridge") ? { authorization: `Bearer ${token}` } : { "x-dimensio-internal-token": token };
const config: Record<string, unknown> = {};
for (const [flagName, key] of [["--workspace", "workspace"], ["--provider", "provider"], ["--model", "model"], ["--mode", "permissionMode"]] as const) {
  const v = arg(flagName);
  if (v) config[key] = v;
}

const result = await runHeadless({
  baseUrl: base,
  headers,
  message,
  sessionId: arg("--session"),
  config: Object.keys(config).length ? config : undefined,
  permissions: flag("--allow-once") ? "once" : "deny",
  onEvent: (ev) => {
    if (ev.e === "tool_start") console.error(`· ${String(ev.name)}`);
  },
});
process.stdout.write(result.text + (result.text.endsWith("\n") ? "" : "\n"));
console.error(`[${result.outcome}] session ${result.sessionId ?? "?"} · run ${result.runId ?? "?"}`);
// 不调 process.exit：Windows 上 fetch 的 keep-alive 连接还在关的时候硬退，libuv 会断言失败（src\win\async.c），
// 退出码成了 127。设好退出码，等连接自己关完再退（最多几秒）。
process.exitCode = result.outcome === "done" ? 0 : result.outcome === "disconnected" ? 2 : 1;
