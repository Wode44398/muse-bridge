import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { shell, killTree, childEnv } from "./tools/bash.ts";
import { consoleDecoder } from "./tools/console-decode.ts";
import { killProcessTree } from "./proc-tree.ts";
import { disposeOwner, registerResource } from "./resources.ts";
import { startProxy, type PreviewProxy, type BrowserLog } from "./preview-proxy.ts";

// Background service manager. The Bash tool waits for the child to CLOSE, so
// starting a long-running server there hangs it until timeout. Services spawned
// here are kept alive across tool calls: stdout/stderr stream into a ring buffer
// the model can read later, and the child is only killed on demand or on exit.

export interface ServiceLog {
  t: number;
  stream: "out" | "err" | "sys";
  line: string;
}

export interface Service {
  id: string;
  name: string;
  command: string;
  port: number;
  cwd: string;
  child: ChildProcess;
  logs: ServiceLog[];
  // Browser-side signals (console/errors/failed fetches) captured via the probe
  // the preview proxy injects. Empty until the preview is opened + interacted with.
  browserLogs: BrowserLog[];
  status: "starting" | "up" | "exited";
  exitCode: number | null;
  startedAt: number;
  // Capability token for the public preview URL (pv-<token>.<domain> via the
  // bridge tunnel). Unguessable = the only access control on that URL; dies
  // with the service (bridge resolves tokens live against /api/preview/services).
  publicToken: string;
  // Reverse proxy in front of the app that injects the browser probe; the
  // preview iframe points at proxy.port, not the app's real port.
  proxy?: PreviewProxy;
  // Session that started it ("" = unowned). "The" service is resolved per owner:
  // with concurrent sessions, a process-wide "most recently started" pick made
  // session A's Preview(logs)/restart act on the dev server session B just
  // launched. Also what makes per-session stop possible (see stopServicesFor).
  owner: string;
  // M5：会话资源账本里的那一条（停掉就注销）
  release?: () => void;
}

// DNS-label-safe unguessable token (lowercase base36, ~82 bits).
function makePublicToken(): string {
  return Array.from(randomBytes(16), (b) => (b % 36).toString(36)).join("");
}

// Public https URL for a service, reachable from any device (phone on 5G etc.)
// through the bridge tunnel's wildcard ingress. Needs PV_PUBLIC_DOMAIN (the
// bridge injects it when spawning the harness); without it there is no public
// route, return null and callers fall back to localhost-only behavior.
export function publicPreviewUrl(s: Service): string | null {
  const domain = (process.env.PV_PUBLIC_DOMAIN || "").trim().replace(/^\.+|\.+$/g, "");
  if (!domain) return null;
  return `https://pv-${s.publicToken}.${domain}`;
}

// Snapshot for the bridge's Host-router (and anything else that needs the
// token→port map). Tokens are capabilities — this endpoint stays on the
// harness API surface, which is already trusted-LAN/bridge-auth territory.
export function listServices(): Array<{
  id: string;
  name: string;
  port: number;
  status: Service["status"];
  publicToken: string;
}> {
  return [...services.values()].map((s) => ({
    id: s.id,
    name: s.name,
    port: s.port,
    status: s.status,
    publicToken: s.publicToken,
  }));
}

const services = new Map<string, Service>();
const MAX_LOGS = 600;
let seq = 0;

function pushLog(s: Service, stream: ServiceLog["stream"], text: string): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    s.logs.push({ t: Date.now(), stream, line });
  }
  if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS);
}

function pushBrowserLog(s: Service, log: BrowserLog): void {
  s.browserLogs.push(log);
  if (s.browserLogs.length > MAX_LOGS) {
    s.browserLogs.splice(0, s.browserLogs.length - MAX_LOGS);
  }
}

// Poll a TCP connect until the port accepts a connection, the service exits, or
// we time out. This is how we know "the server is actually up" before returning.
function waitForPort(
  s: Service,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      if (signal?.aborted || s.status === "exited") return resolve(false);
      if (Date.now() > deadline) return resolve(false);
      const sock = net.connect({ host: "127.0.0.1", port: s.port });
      sock.setTimeout(1500);
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      const retry = () => {
        sock.destroy();
        setTimeout(attempt, 250);
      };
      sock.once("error", retry);
      sock.once("timeout", retry);
    };
    attempt();
  });
}

// (killTree — kill a whole process tree — now lives in tools/bash.ts, shared
// with its background-job manager.)

// Return the PIDs currently LISTENING on a TCP port, straight from the OS — so
// we can reclaim a port held by an ORPHAN preview server that this process
// doesn't track (e.g. left behind by a previous harness instance after a
// --watch restart; its child node server keeps the port but is absent from our
// in-memory `services` map). Best-effort: parse errors just yield [].
function portHolderPids(port: number): number[] {
  const pids = new Set<number>();
  try {
    if (process.platform === "win32") {
      const out = spawnSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        windowsHide: true,
      }).stdout || "";
      for (const line of out.split(/\r?\n/)) {
        // e.g.  TCP    0.0.0.0:3000   0.0.0.0:0   LISTENING   34208
        if (!/\bLISTENING\b/.test(line)) continue;
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && Number(m[1]) === port) pids.add(Number(m[2]));
      }
    } else {
      const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        encoding: "utf8",
      }).stdout || "";
      for (const tok of out.split(/\s+/)) {
        const n = Number(tok.trim());
        if (Number.isInteger(n) && n > 0) pids.add(n);
      }
    }
  } catch {
    /* best-effort */
  }
  pids.delete(process.pid); // never target ourselves
  return [...pids];
}

// PIDs this process must NEVER kill: itself, and every ancestor up the parent chain
// (the bridge server that spawned this harness, its cmd/wscript launcher…). Reclaiming
// a port with `taskkill /T` on one of those takes down the whole host tree — bridge,
// this harness and every Claude/Codex CLI under it — the moment an agent asks for
// Preview(start, port=8787) ("restart the app" on the port bridge itself owns).
// Ports that belong to the host are refused outright too (PORT = this harness,
// BRIDGE_PORT handed down by bridge). Resolved lazily and cached: the parent chain
// needs one Win32_Process enumeration (~1-3s), and reclaiming is rare.
let ancestorCache: { at: number; pids: Set<number> } | null = null;
function protectedPids(): Set<number> {
  if (ancestorCache && Date.now() - ancestorCache.at < 60_000) return ancestorCache.pids;
  const pids = new Set<number>([process.pid, process.ppid]);
  try {
    const parent = new Map<number, number>();
    if (process.platform === "win32") {
      const out = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
        { encoding: "utf8", windowsHide: true, timeout: 20_000 },
      ).stdout || "";
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) parent.set(Number(m[1]), Number(m[2]));
      }
    } else {
      const out = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).stdout || "";
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) parent.set(Number(m[1]), Number(m[2]));
      }
    }
    let cur = process.pid;
    const seen = new Set<number>();
    while (parent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const p = parent.get(cur)!;
      if (!p || p === cur) break;
      pids.add(p);
      cur = p;
    }
  } catch {
    /* best-effort: self + direct parent are always protected */
  }
  ancestorCache = { at: Date.now(), pids };
  return pids;
}

function hostPorts(): Set<number> {
  const out = new Set<number>();
  for (const v of [process.env.PORT, process.env.BRIDGE_PORT]) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return out;
}

export class PortHeldByOtherError extends Error {
  constructor(port: number) {
    super(`port ${port} is already in use by another program on this server; it cannot be reclaimed — start your server on a different port.`);
    this.name = "PortHeldByOtherError";
  }
}

export class PortHeldByHostError extends Error {
  constructor(port: number, pid: number | null) {
    super(
      `port ${port} is held by the host process tree` +
        (pid ? ` (pid ${pid}: the bridge/harness that runs this agent)` : " (bridge/harness)") +
        `; it cannot be reclaimed — start your server on a different port.`,
    );
    this.name = "PortHeldByHostError";
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.setTimeout(1000);
    sock.once("connect", () => {
      sock.destroy();
      resolve(false); // someone answered → still held
    });
    const free = () => {
      sock.destroy();
      resolve(true);
    };
    sock.once("error", free);
    sock.once("timeout", free);
  });
}

async function waitPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return portIsFree(port);
}

// Make a port genuinely available before we spawn a replacement on it. First
// stop any service WE track on that port, then — critically — reclaim it from
// any untracked OS holder (cross-process orphan), and only return once the port
// actually stops accepting connections. Without the wait, a replacement spawned
// while the old holder is still dying makes waitForPort latch onto the dying
// server, so the preview pane ends up proxying a stale/soon-dead app ("挂起").
async function reclaimPort(port: number): Promise<void> {
  if (hostPorts().has(port)) throw new PortHeldByHostError(port, null);
  for (const existing of [...services.values()]) {
    if (existing.port === port && existing.status !== "exited") stopService(existing.id);
  }
  if (await portIsFree(port)) return;
  const holders = portHolderPids(port);
  if (!holders.length) { await waitPortFree(port, 5000); return; }
  // 租户实例（多用户服务端上每个用户一个 harness）从不结束不是自己起的进程：那个端口上可能是别人的预览服务。
  if (process.env.DIMENSIO_TENANT === "1") throw new PortHeldByOtherError(port);
  // Refuse BEFORE killing anything: one protected holder = the whole reclaim is off.
  const guard = protectedPids();
  for (const pid of holders) {
    if (guard.has(pid)) {
      console.error(`[services] refusing to reclaim port ${port}: holder pid ${pid} is this process or an ancestor (bridge/harness host)`);
      throw new PortHeldByHostError(port, pid);
    }
  }
  for (const pid of holders) {
    console.log(`[services] reclaiming port ${port}: killing orphan holder pid ${pid} (tree)`);
    // #77：不用 taskkill /T（会顺着悬空的父 PID 杀到不相干的进程），按创建时间核对子孙后逐个结束。
    await killProcessTree(pid).catch(() => []);
  }
  await waitPortFree(port, 5000);
}

export async function startService(
  opts: { command: string; port: number; cwd: string; name?: string; owner?: string },
  signal?: AbortSignal,
): Promise<Service> {
  // A fresh start on an occupied port almost always means "restart my server".
  // Reclaim it from BOTH our own tracked services and any untracked OS orphan,
  // and wait for the port to truly free before spawning the replacement.
  await reclaimPort(opts.port);

  const id = `svc${++seq}`;
  // PORT is pinned to the requested port: the harness process itself may run
  // with PORT set (e.g. 8799), and a child dev server doing
  // `process.env.PORT || 3000` would inherit it — binding the WRONG port (often
  // the harness's own → EADDRINUSE) while we wait on the right one.
  const child = spawn(shell.path, shell.argsFor(opts.command), {
    cwd: opts.cwd,
    windowsHide: true,
    env: childEnv({ PORT: String(opts.port) }),
  });

  const s: Service = {
    id,
    name: opts.name || opts.command.slice(0, 40),
    command: opts.command,
    port: opts.port,
    cwd: opts.cwd,
    child,
    logs: [],
    browserLogs: [],
    status: "starting",
    exitCode: null,
    startedAt: Date.now(),
    publicToken: makePublicToken(),
    owner: opts.owner ?? "",
  };
  services.set(id, s);
  // M5（K03）：进会话资源账本——停止 / 删除会话、owner 已不在的巡检都由账本收掉
  s.release = registerResource(s.owner, "service", id, () => stopService(id));

  // #97：按流解码——多字节字符跨块不再切成乱码，Windows 上原生程序写的 GBK 也认得出来（tools/console-decode.ts）
  const outDec = consoleDecoder();
  const errDec = consoleDecoder();
  child.stdout?.on("data", (b: Buffer) => pushLog(s, "out", outDec.write(b)));
  child.stderr?.on("data", (b: Buffer) => pushLog(s, "err", errDec.write(b)));
  child.on("close", () => {
    pushLog(s, "out", outDec.end());
    pushLog(s, "err", errDec.end());
  });
  child.on("error", (e) => {
    pushLog(s, "sys", `spawn error: ${e.message}`);
    s.status = "exited";
  });
  child.on("exit", (code) => {
    if (s.status !== "exited") {
      s.status = "exited";
      s.exitCode = code;
      pushLog(s, "sys", `process exited with code ${code}`);
    }
  });

  const up = await waitForPort(s, 15_000, signal);
  if (s.status !== "exited") s.status = up ? "up" : "starting";

  // Once the app is listening, put the browser-probe proxy in front of it.
  if (s.status === "up") {
    try {
      s.proxy = await startProxy(s.port, (log) => pushBrowserLog(s, log));
    } catch (e) {
      pushLog(s, "sys", `preview proxy failed to start: ${(e as Error).message}`);
    }
  }
  return s;
}

export function getService(id: string): Service | undefined {
  return services.get(id);
}

// The owner's most recently started service. `owner` omitted = process-wide
// (the browser panel's "preview" button and other UI paths that legitimately
// just want whatever is up).
export function latestService(owner?: string): Service | undefined {
  let best: Service | undefined;
  for (const s of services.values()) {
    if (owner !== undefined && s.owner !== owner) continue;
    if (!best || s.startedAt > best.startedAt) best = s;
  }
  return best;
}

export function stopService(id: string): boolean {
  const s = services.get(id);
  if (!s) return false;
  s.release?.(); // 单独停的（Preview stop、换端口重启……）也从账本上注销
  s.proxy?.close();
  s.proxy = undefined;
  if (s.status !== "exited") {
    killTree(s.child);
    s.status = "exited";
    pushLog(s, "sys", "stopped by request");
  }
  services.delete(id);
  return true;
}

export function stopAllServices(): void {
  for (const id of [...services.keys()]) stopService(id);
}

// Stop just one session's dev servers. This is what "stop this session" and
// "new chat cleanup" should do: the old process-wide stop-all killed the dev
// server another device's session was mid-way through verifying.
export function stopServicesFor(owner: string): number {
  return disposeOwner(owner, "stop", ["service"]).service; // M5：由会话资源账本收
}

// Live (non-exited) service count for one owner — lets stopSession report what
// it actually shut down instead of claiming success blindly.
export function liveServiceCount(owner: string): number {
  let n = 0;
  for (const s of services.values()) if (s.owner === owner && s.status !== "exited") n++;
  return n;
}

// Tail the last N log lines as a plain-text block for the model.
export function renderLogs(s: Service, lines: number): string {
  const tail = s.logs.slice(-lines);
  if (tail.length === 0) return "(no output yet)";
  return tail
    .map((l) => `${l.stream === "err" ? "[stderr] " : l.stream === "sys" ? "[sys] " : ""}${l.line}`)
    .join("\n");
}

// Tail the browser-side probe reports (console, uncaught errors, failed fetches).
export function renderBrowserLogs(s: Service, lines: number): string {
  const tail = s.browserLogs.slice(-lines);
  if (tail.length === 0) {
    return "(no browser logs yet — open the preview and interact with the page first, then check again)";
  }
  return tail.map((l) => `[${l.type}] ${l.msg}`).join("\n");
}
