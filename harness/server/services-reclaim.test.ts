// reclaimPort 护栏：Preview(start) 要回收的端口若被【宿主进程树】（bridge / 本 harness /
// 它们的启动壳）占着，必须拒绝而不是 taskkill /T 把宿主连根带走（09-13 之前
// Preview(start, port=8787) 就会杀掉 bridge + harness + 其下所有 CLI）。
//
// 两道闸各验一次：
//   ① hostPorts —— PORT / BRIDGE_PORT 指名的端口直接拒绝（不查进程）；
//   ② 祖先守卫 —— 端口持有者是当前进程的祖先：测试进程本身在某端口监听，再 spawn 一个
//      子 node 进程去 startService 同一端口，子进程里的 services.ts 必须认出「持有者是我爹」。
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function runChild(port: number, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const script = `
    const { startService } = await import(${JSON.stringify(pathToFileURL(path.join(here, "services.ts")).href)});
    try {
      await startService({ command: "node -e \\"setTimeout(()=>{},60000)\\"", port: ${port}, cwd: process.cwd(), name: "t" });
      console.log("STARTED");
    } catch (e) { console.log("THREW " + (e && e.name) + " :: " + (e && e.message)); }
    process.exit(0);
  `;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.join(here, ".."),
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = "";
    c.stdout.on("data", (d) => { out += d.toString(); });
    c.stderr.on("data", (d) => { out += d.toString(); });
    c.on("close", (code) => resolve({ code, out }));
  });
}

test("reclaimPort refuses a port named by BRIDGE_PORT without touching any process", async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  try {
    const { out } = await runChild(port, { BRIDGE_PORT: String(port), PORT: "0" });
    assert.match(out, /THREW PortHeldByHostError/, out);
    assert.ok(srv.listening, "listener must survive");
  } finally {
    srv.close();
  }
});

test("reclaimPort refuses to kill an ANCESTOR that holds the port (the bridge/harness host)", async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  try {
    // 子进程视角：这个端口的持有者 = 它的父进程（本测试进程）→ 祖先守卫必须拒绝。
    const { out } = await runChild(port, { BRIDGE_PORT: "", PORT: "0" });
    assert.match(out, /THREW PortHeldByHostError/, out);
    assert.match(out, new RegExp(`pid ${process.pid}`), "error names the protected ancestor pid: " + out);
    assert.ok(srv.listening, "the parent's listener must still be alive (nothing was killed)");
    // 守卫之后本进程还活着且端口还在手里——再确认一次能接受连接。
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(); });
      s.once("error", reject);
    });
  } finally {
    srv.close();
  }
});
