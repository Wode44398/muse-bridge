import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, generationSettings, imageDimensions, validateDimensions, DEFAULT_SETTINGS } from './local-image.mjs';
import { loadImageChat } from '@bridge/core/vertex-media.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleLocalImage, registerLocalImageRoutes } from './routes/local-image.mjs';

function response() {
  return { code: 0, body: '', headersSent: false, writableEnded: false,
    writeHead(code) { this.code = code; this.headersSent = true; },
    end(body = '') { this.body += body; this.writableEnded = true; },
    write(body) { this.body += body; },
  };
}
test('deployment values are an allowlist, never executable paths or shell arguments', () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ offload: 'sequential', dtype: 'float16', vaeTiling: false }).offload, 'sequential');
  for (const bad of [null, [], { python: 'other.exe' }, { offload: 'cuda' }, { dtype: 'fp8' }, { vaeTiling: 'false' }, { cpuThreads: 0 }, { cpuThreads: 33 }, { vaeTileSize: 128 }, { tf32: 'true' }]) assert.throws(() => normalizeSettings(bad));
});
test('sampling bounds reject malformed values and preserve zero seed', () => {
  assert.equal(generationSettings().steps, 40);
  assert.equal(generationSettings().cfg, 1);
  assert.equal(generationSettings({ steps: 1, seed: 0 }).seed, 0);
  for (const bad of [{ steps: 0 }, { steps: 101 }, { steps: 1.5 }, { seed: -2 }, { seed: 2 ** 32 }, { seed: NaN }, { steps: '40' }]) assert.throws(() => generationSettings(bad));
});
test('all UI aspect and size combinations stay inside worker dimensions budget', () => {
  for (const aspect of ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']) {
    for (const size of ['1K', '2K', '4K']) {
      const { width, height } = imageDimensions(aspect, size);
      assert.equal(width % 32, 0); assert.equal(height % 32, 0);
      assert.ok(width * height <= 17_000_000); assert.ok(Math.max(width, height) <= 6144);
      if (size !== '4K') { assert.ok(width * height <= 4_500_000); assert.ok(Math.max(width, height) <= 3072); }
    }
  }
  const source = imageDimensions('auto', '1K', { width: 600, height: 900 });
  assert.ok(source.height > source.width);
  assert.deepEqual(imageDimensions('0:0'), { width: 2048, height: 2048 });
});
test('custom dimensions are preserved exactly and never silently downscaled', () => {
  assert.deepEqual(imageDimensions('16:9', 'custom', null, { width: 3840, height: 2176 }), { width: 3840, height: 2176 });
  assert.deepEqual(imageDimensions('1:1', '4K'), { width: 4096, height: 4096 });
  for (const [width, height] of [[3840, 2160], [255, 512], [8192, 512], [6144, 6144], [NaN, 1024], ['1024', 1024]]) assert.throws(() => validateDimensions(width, height));
});
test('advanced generation validates count, guidance, cache and sigma schedule', () => {
  assert.deepEqual(generationSettings({ steps: 4, sigmas: [1, .75, .5, .25], count: 4, cfg: 3 }).sigmas, [1, .75, .5, .25]);
  for (const bad of [{ cfg: 0 }, { cfg: NaN }, { count: 5 }, { count: 1.5 }, { useKvCache: 1 }, { referenceResolution: 4096 }, { transparent: 'yes' }, { negativePrompt: [] }, { steps: 2, sigmas: [1, 1] }, { steps: 2, sigmas: [1, 0] }, { steps: 2, sigmas: [1] }, { steps: 2, sigmas: [1, Infinity] }]) assert.throws(() => generationSettings(bad));
});
test('batch history restores distinct generations and retains image metadata', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qwen-batch-history-'));
  const sessionId = '11111111-1111-1111-1111-111111111111';
  try {
    const records = [
      { id: '22222222-2222-2222-2222-222222222222', batchId: 'batch-a', batchIndex: 1, created: 2, seed: 43 },
      { id: '33333333-3333-3333-3333-333333333333', batchId: 'batch-a', batchIndex: 0, created: 1, seed: 42 },
      { id: '44444444-4444-4444-4444-444444444444', created: 3, seed: 44 },
    ];
    for (const rec of records) writeFileSync(path.join(dir, rec.id + '.json'), JSON.stringify({ kind: 'image', sessionId, width: 4096, height: 4096, prompt: 'draw', ...rec }));
    const chat = loadImageChat(sessionId, dir);
    assert.equal(chat.turns.length, 2); assert.equal(chat.turns[0].outputs.length, 2);
    assert.equal(chat.turns[0].imageId, records[1].id);
    assert.equal(chat.turns[0].outputs[0].seed, 42);
    assert.equal(chat.turns[0].outputs[0].width, 4096);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('deployment endpoints reject unauthenticated and tenant requests', async () => {
  const routes = [];
  registerLocalImageRoutes({ on: (method, path, handler) => routes.push({ method, path, handler }) }, { identify: req => req.identity });
  assert.equal(routes.length, 4);
  for (const route of routes) {
    for (const kind of ['none', 'user']) {
      const res = response();
      await route.handler({ identity: { kind, user: 'local-image-test-user' } }, res);
      assert.equal(res.code, kind === 'none' ? 401 : 403);
    }
  }
});
test('invalid references and cross-user history are rejected before inference', async () => {
  for (const parsed of [
    { message: 'edit', image: 'C:/private.png' },
    { message: 'edit', turns: [{ imageId: '../../private' }] },
    { message: 'draw', steps: 1000 },
    { message: 'edit', images: ['C:/private.png'] },
    { message: 'edit', images: Array(11).fill('C:/private.png') },
    { message: 'edit', images: 'C:/private.png' },
    { message: 'edit', referenceId: '../../private' },
    { message: 'edit', referenceId: '11111111-1111-1111-1111-111111111111' },
  ]) {
    const res = response();
    await handleLocalImage({}, res, { ctx: { media: 'nonexistent-test-media' }, parsed, ownUpload: () => false, stream: true });
    assert.equal(res.code, 400); assert.equal(JSON.parse(res.body).ok, false);
  }
});
