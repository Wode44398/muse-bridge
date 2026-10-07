// The system prompt is one big template literal, so a backtick or a ${…} in
// hand-written section copy silently terminates or interpolates it — that is a
// syntax error at best and a mangled contract at worst (hit while adding the
// Android section on 2026-08-17). These guard the two sections added from the
// k3 run's feedback, plus the template hazard itself.
import assert from "node:assert/strict";
import test from "node:test";
import { PLAYBOOKS } from "./agent/playbooks.ts";
import { systemPrompt } from "./agent/prompt.ts";
import { lanAddress } from "./lan.ts";

const base = {
  root: "C:/ws",
  shell: "bash",
  platform: "win32",
  provider: "kimi",
  model: "k3",
} as const;

// 瘦身 P0-3：安卓一章（连同网页 / 桌面验证、本地服务安全）从 system 搬进了按需注入的 playbook——守卫跟着搬过去。
test("the Android playbook moved out of the system prompt and survives its template literal intact", () => {
  const prompt = systemPrompt({ ...base, access: "workspace" });
  assert.doesNotMatch(prompt, /## Running and verifying an Android app/, "no longer resident in every request");
  assert.match(prompt, /## Playbooks/, "the prompt says playbooks arrive on demand");
  const android = PLAYBOOKS.find((p) => p.id === "android")!;
  // The parts that actually close the loop without a human in it.
  assert.match(android.body, /adb install -r/);
  assert.match(android.body, /adb logcat -b crash/);
  assert.match(android.body, /adb exec-out screencap -p > shot\.png/);
  assert.match(android.body, /AskUserQuestion/);
  // A stray ${…} would have been interpolated (or thrown); a literal one left in
  // the copy means the section is quietly broken.
  assert.doesNotMatch(prompt, /\$\{/);
  for (const p of PLAYBOOKS) assert.doesNotMatch(p.body, /\$\{/, `${p.id} playbook`);
});

test("the environment names this machine's own subnet when there is one", () => {
  const prompt = systemPrompt({ ...base, access: "workspace" });
  const lan = lanAddress();
  if (lan) {
    assert.ok(
      prompt.includes(`This machine on the local network: ${lan.cidr}`),
      "the detected LAN address must reach the prompt",
    );
    // Never a link-local address: that means the adapter never got a lease.
    assert.doesNotMatch(lan.address, /^169\.254\./);
  } else {
    assert.doesNotMatch(prompt, /This machine on the local network/);
  }
});
