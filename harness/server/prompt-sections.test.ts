// The system prompt is one big template literal, so a backtick or a ${…} in
// hand-written section copy silently terminates or interpolates it — that is a
// syntax error at best and a mangled contract at worst (hit while adding the
// Android section on 2026-08-17). These guard the two sections added from the
// k3 run's feedback, plus the template hazard itself.
import assert from "node:assert/strict";
import test from "node:test";
import { systemPrompt } from "./agent/prompt.ts";
import { lanAddress } from "./lan.ts";

const base = {
  root: "C:/ws",
  shell: "bash",
  platform: "win32",
  provider: "kimi",
  model: "k3",
} as const;

test("the Android playbook is present and survives the template literal intact", () => {
  const prompt = systemPrompt({ ...base, access: "workspace" });
  assert.match(prompt, /## Running and verifying an Android app/);
  // The parts that actually close the loop without a human in it.
  assert.match(prompt, /adb install -r/);
  assert.match(prompt, /adb logcat -b crash/);
  assert.match(prompt, /adb exec-out screencap -p > shot\.png/);
  assert.match(prompt, /AskUserQuestion/);
  // A stray ${…} would have been interpolated (or thrown); a literal one left in
  // the copy means the section is quietly broken.
  assert.doesNotMatch(prompt, /\$\{/);
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
