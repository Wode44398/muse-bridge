import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sniffImageMime } from "./image-assets.ts";
import { Sandbox } from "./sandbox.ts";
import { readTool } from "./tools/read.ts";
import type { ToolContext } from "./tools/types.ts";

test("image magic-byte detection accepts the common native provider subset", () => {
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from("RIFFxxxxWEBP")), "image/webp");
  assert.equal(sniffImageMime(Buffer.from("not an image")), undefined);
});

test("Read returns image pixels as native follow-up feedback for a multimodal agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-read-image-"));
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6]);
    fs.writeFileSync(path.join(root, "design.png"), bytes);
    const ctx: ToolContext = {
      sandbox: new Sandbox(root),
      readFileState: new Map(),
      setTodos: () => {},
      limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
      agentSeesImages: true,
    };
    const result = await readTool.run({ path: "design.png", question: "Is the layout centered?" }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.feedback?.length, 1);
    assert.deepEqual(result.feedback?.[0], {
      t: "image",
      mime: "image/png",
      data: bytes.toString("base64"),
      name: "design.png",
    });
    assert.match((result.content[0] as any).text, /Is the layout centered/);
    assert.equal(ctx.readFileState.size, 0, "reading pixels must not unlock a later text overwrite");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
