// 瘦身 P0-3：按需注入的专章（playbook）。以前这四章（网页 / 桌面 / 安卓的验证流程、本地服务的安全规矩，合计约 6.6k 字符）写死在
// system 里，每个会话、每次请求都带着——实际使用中 57 个会话里只有 1 个跑过 adb、1 个碰过 Electron。现在 system 里只留一句「做到这块时会
// 收到 [Playbook: …]」，第一次碰到时由 loop 注入一条 harness 消息（随会话落盘，同一个会话只注入一次；被整段压缩掉之后再碰到会再注入）。
//
// 触发分两种：用户点名（只给误报代价低、又必须开工前就知道的：安卓的工具链放哪、桌面应用的验证路线）；动手时的工具调用（写了网页文件、
// 起了 Preview、跑了 adb / gradle、写了监听端口的代码）——网页与本地服务两章故意不认用户原话：问答里提到「接口」「页面」的太多，
// 而它们的规矩在第一个相关的 Write / Preview 之后、收尾验证之前送到就来得及（「别用 Bash 后台起服务」另写在 Bash / Preview 的工具说明里）。
// 措辞照搬原来的 system 段落；正文是模板字符串，手写段落里的反引号要转义（prompt-sections.test.ts 有守卫）。
import { messageKind } from "./injections.ts";
import type { Msg } from "./turn.ts";

export type PlaybookId = "web" | "local-server" | "desktop" | "android";

export interface Playbook {
  id: PlaybookId;
  title: string;
  body: string;
  // Muse：这台机器没有浏览器（Browser 工具没注册）时用的正文；needsBrowser = 没浏览器就整章不给（桌面 / 安卓的验证路线都靠 Browser）
  bodyNoBrowser?: string;
  needsBrowser?: boolean;
  // 用户原话点名就注入（不给就只认工具调用）
  userTrigger?: RegExp;
  // 这次工具调用说明工作碰到了这块
  callTrigger(call: { name: string; args: Record<string, unknown> }): boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const writtenPath = (call: { name: string; args: Record<string, unknown> }): string =>
  call.name === "Write" || call.name === "Edit" ? str(call.args.path ?? call.args.file_path) : "";
const writtenText = (call: { name: string; args: Record<string, unknown> }): string =>
  call.name === "Write" ? str(call.args.content) : call.name === "Edit" ? str(call.args.new_string) : "";
const bashCommand = (call: { name: string; args: Record<string, unknown> }): string => (call.name === "Bash" ? str(call.args.command) : "");

const WEB_FILE_RE = /\.(?:html?|css|scss|less|jsx|tsx|vue|svelte)$/i;
const DEV_SERVER_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\bvite\b|\bnext\s+dev\b|\bhttp\.server\b|\b(?:live|http)-server\b/;
const LOCAL_URL_RE = /^(?:\/|file:|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))/i;
const SERVER_CODE_RE =
  /\.listen\s*\(|\bcreateServer\s*\(|\bhttp\.server\b|\buvicorn\b|\bFastAPI\s*\(|\bFlask\s*\(|\bexpress\s*\(\s*\)|\bListenAndServe\b|\bWebSocketServer\b|\bServerSocket\b|\bserve\s*\(\s*\{|["']0\.0\.0\.0["']/;
const ELECTRON_CODE_RE = /require\(\s*["']electron["']\s*\)|from\s+["']electron["']|\bBrowserWindow\b/;
const ANDROID_CMD_RE = /\b(?:adb|gradlew|gradle|sdkmanager|avdmanager|emulator|assembleDebug|assembleRelease|bundleRelease)\b/;
const ANDROID_FILE_RE = /\.(?:kt|kts|gradle)$|AndroidManifest\.xml$/i;

export const PLAYBOOKS: readonly Playbook[] = [
  {
    id: "web",
    title: "Running and verifying a web app",
    callTrigger: (call) =>
      call.name === "Preview" ||
      (call.name === "Browser" && str(call.args.action) === "navigate" && LOCAL_URL_RE.test(str(call.args.url))) ||
      WEB_FILE_RE.test(writtenPath(call)) ||
      DEV_SERVER_RE.test(bashCommand(call)),
    body: `NEVER start a server by backgrounding it with Bash (\`node server.js &\`, \`npm run dev &\`) — the shell pipe stays open and the tool hangs until it times out. Instead:
1. Preview(action:"start", command:"node server.js", port: <port>) — starts it in the background, waits until the port is up, and opens a live preview pane for the user. It returns immediately with startup logs.
2. Test the API endpoints with Bash + curl (register, log in, upload…), reading each response. Preview(action:"logs") reads the server's stdout/stderr (crashes, 500s, request logs).
3. Exercise the real UI with the browser tools: Browser(navigate, url:"/") → ReadPage (structure + [refN] handles) → Browser(click/type, ref:N) → verify.
4. VERIFY with exact checks first: Eval for DOM assertions ("did the error banner appear", "how many rows rendered"), Network for whether the page actually hit the API and what came back, Browser(action:"console") for JS errors. These are cheap, exact, and text-native. Use Browser(action:"screenshot") for visual/layout judgment on top.
5. If the page draws with <canvas> or WebGL (charts, visualizations, custom graphics), run Browser(action:"dprprobe") once after your edits and treat a failure as a real bug. The headless browser runs at devicePixelRatio 1 — the ONE ratio where DPR-scaling mistakes (e.g. re-reading a canvas height you already multiplied by dpr) are symptom-free — while real displays run 1.25–3, so screenshots alone can pass on a page that explodes on every actual device.
6. Fix and repeat. Preview(action:"stop") when finished.`,
    bodyNoBrowser: `NEVER start a server by backgrounding it with Bash (\`node server.js &\`, \`npm run dev &\`) — the shell pipe stays open and the tool hangs until it times out. Instead:
1. Preview(action:"start", command:"node server.js", port: <port>) — starts it in the background, waits until the port is up, and opens a live preview pane for the user. It returns immediately with startup logs.
2. Test the API endpoints with Bash + curl (register, log in, upload…), reading each response. Preview(action:"logs") reads the server's stdout/stderr (crashes, 500s, request logs).
3. There is no browser on this machine, so there are no Browser/ReadPage/Eval/Network tools. Verify pages over HTTP instead: curl each page (status, the markup that matters, the scripts/styles it references) and every API the UI calls, and check the server side with Preview(action:"logs"). Say plainly in your final answer that the UI itself was not exercised in a real browser.
4. Fix and repeat. Preview(action:"stop") when finished.`,
  },
  {
    id: "local-server",
    title: "Local servers you write must not be open doors",
    callTrigger: (call) => (call.name === "Preview" && str(call.args.action) === "start") || SERVER_CODE_RE.test(writtenText(call)),
    body: `Anything you run here listens on the user's own machine, on a network they share with other devices.
- Bind to loopback: \`127.0.0.1\`, never \`0.0.0.0\` and never a LAN address, unless the user explicitly asked to expose it. Most frameworks default to all interfaces — pass the host explicitly (\`app.listen(port, "127.0.0.1")\`, \`--host 127.0.0.1\`, \`server_bind = "127.0.0.1"\`).
- A loopback bind alone does NOT make a local API private: any web page the user has open can POST to \`http://127.0.0.1:<port>\`. If a local server has side effects (writes files, runs commands, holds credentials or a session), check the \`Origin\`/\`Sec-Fetch-Site\` header on every state-changing request and reject anything that is not your own origin. Do not send permissive \`Access-Control-Allow-Origin: *\` on such endpoints.
- Keep side effects out of GET: a cross-site page can trigger a GET by simply linking or embedding, with the user's cookies attached. Mutations belong on POST behind the Origin check.
- Never write credentials, tokens, or API keys into a query string (they land in logs, history, and Referer) — use a header or the request body.
- Same rules for any local proxy/bridge you build for the user, and say in your final answer which host/port you bound and what guards it.`,
  },
  {
    id: "desktop",
    title: "Running and verifying a desktop app (Electron)",
    needsBrowser: true,
    userTrigger: /electron|桌面(?:应用|程序|端|软件|版|app)|desktop\s+app|\.exe\b|安装包|可执行(?:文件|程序)/i,
    callTrigger: (call) => /\belectron\b/i.test(bashCommand(call)) || ELECTRON_CODE_RE.test(writtenText(call)),
    body: `1. Launch the app as a background job with a DevTools port: Bash(command:"npx electron . --remote-debugging-port=9223", background:true). A GUI app is the one exception to the no-servers-via-Bash rule — it serves no web port for Preview to wait on.
2. Browser(action:"attach", port:9223) — the shared browser now drives the app's real window. From here everything works exactly like the web-app loop: ReadPage for structure and [refN] handles, Browser(click/type/key), Eval(js, verify:true) for DOM assertions, Network for its HTTP traffic, Browser(action:"screenshot") to look at it, Browser(action:"console") for renderer errors.
3. Exercise the real flow end-to-end and fix-and-repeat — exact checks first, screenshots on top.
4. Finish: Browser(close) to detach, then Bash(kill:"<job id>") to quit the app. If the user asked for a clickable app, package it (e.g. npx electron-builder) and verify the packaged build too: launch the built exe with --remote-debugging-port and attach again.`,
  },
  {
    id: "android",
    title: "Running and verifying an Android app",
    needsBrowser: true,
    userTrigger: /安卓|android|\bapk\b|手机\s*(?:app|应用|软件)/i,
    callTrigger: (call) => ANDROID_CMD_RE.test(bashCommand(call)) || ANDROID_FILE_RE.test(writtenPath(call)),
    body: `An APK you never launched is not verified, and "the user installs it and tells me what broke" is the LAST resort, not the loop — one earlier run burned 8 hand-carried rounds that way. Drive the device yourself:
1. Put the toolchain in the workspace, never system-wide: sdkmanager --sdk_root=<workspace>/.sdk "platform-tools" "platforms;android-NN" "build-tools;NN". That gives you adb at <workspace>/.sdk/platform-tools/adb.exe. Run "adb devices" before asking the user for anything — you may already be connected.
2. Get a device. A real phone is the actual target and downloads nothing: the user turns on Developer options, then Wireless debugging; you run "adb pair IP:PORT CODE" once — ask for the pairing code with AskUserQuestion, it is on their screen and expires in seconds — then "adb connect IP:PORT". Pairing is persistent, so Remember the device address and later sessions just reconnect. The Environment section of the system prompt tells you which subnet this machine is on; the phone is normally on the same one.
3. Then run the whole loop yourself, every iteration: adb install -r <apk>, then adb shell am start -n <pkg>/<activity>, then adb logcat -b crash -d (or adb logcat --pid=$(adb shell pidof <pkg>) while it runs), then adb exec-out screencap -p > shot.png and Read shot.png to actually LOOK at the screen. adb shell dumpsys window | grep mCurrentFocus is a cheap way to confirm which activity is actually in front. A crash log plus a screenshot usually pins a UI bug without asking the user anything.
4. No device available: an emulator works, but ask the user before starting it — sdkmanager "emulator" "system-images;android-NN;google_apis;x86_64" pulls about 5 GB and needs hardware virtualization. Once installed: avdmanager create avd -n <name> -k "system-images;android-NN;google_apis;x86_64" -d pixel (answer "no" to the custom-profile prompt), set ANDROID_AVD_HOME to a workspace directory so the AVD does not land in the user's home, and launch with Bash(background:true): emulator -avd <name> -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect. It is ready when adb shell getprop sys.boot_completed prints 1 — roughly a minute; poll for that instead of sleeping blindly. If virtualization is unavailable, say so and stop; do not retry-loop.
Everything after "adb shell" runs on the phone, not here, so workspace path rules do not apply to those paths — but it is still someone's real device: install, launch, log and screenshot freely, and ask first before wiping data, uninstalling their apps, or rebooting it.`,
  },
];

export const PLAYBOOK_KIND = "playbook";
export const playbookHeader = (p: Pick<Playbook, "title">): string => `[Playbook: ${p.title}]`;

export function playbookMessage(p: Playbook, why: "request" | "work", browser = true): string {
  const reason = why === "request" ? "your request names this area" : "your work just touched this area";
  const body = !browser && p.bodyNoBrowser ? p.bodyNoBrowser : p.body;
  return `${playbookHeader(p)} Attached by the harness because ${reason}. Follow it like the system prompt.\n\n${body}`;
}

// 这一章此刻还在转录里（注入过、没被整段压缩掉）
export function playbookLoadedIn(messages: readonly Msg[], p: Playbook): boolean {
  const header = playbookHeader(p);
  return messages.some((m) => messageKind(m) === PLAYBOOK_KIND && m.content.some((b) => b.t === "text" && b.text.startsWith(header)));
}

export function playbooksForRequest(text: string): Playbook[] {
  return PLAYBOOKS.filter((p) => p.userTrigger?.test(text));
}

export function playbooksForCalls(calls: readonly { name: string; args: Record<string, unknown> }[]): Playbook[] {
  return PLAYBOOKS.filter((p) => calls.some((call) => p.callTrigger(call)));
}
