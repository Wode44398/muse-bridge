import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseAvailableModelLimits,
  lookupModelContextLimit,
  resolveEffectiveContextUsage,
  getAgyContextLimits,
  _resetAgyContextLimitsForTest,
} from './context-limits.mjs';
import { _resetAgyQuotaForTest } from './quota.mjs';
import { AcpClient } from './acp/client.mjs';

const SAMPLE_MODELS = {
  response: {
    models: {
      'gemini-4-neon-high': {
        displayName: 'Gemini 4 Neon (High)',
        maxTokens: 1048576,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '512000', token_threshold: '50000', enabled: true }),
            },
          },
        },
      },
      'gemini-3.8-flash-medium': {
        displayName: 'Gemini 3.8 Flash (Medium)',
        maxTokens: 1048576,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '256000', token_threshold: '50000', enabled: true }),
            },
          },
        },
      },
      'claude-opus-4-6-thinking': {
        displayName: 'Claude Opus 4.6 (Thinking)',
        maxTokens: 250000,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '160000', enabled: true }),
            },
          },
        },
      },
      'gpt-oss-120b-medium': {
        displayName: 'GPT-OSS 120B (Medium)',
        maxTokens: 131072,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '80000', enabled: true }),
            },
          },
        },
      },
      'no-checkpoint-model': {
        maxTokens: 300000,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '100000', enabled: false }),
            },
          },
        },
      },
    },
  },
};

test('parseAvailableModelLimits：优先取启用的 checkpointer.max_token_limit，未启用回退 maxTokens，并写入家族基名', () => {
  const limits = parseAvailableModelLimits(SAMPLE_MODELS);
  assert.equal(limits['gemini-4-neon-high'], 512000);
  assert.equal(limits['gemini-4-neon'], 512000);
  assert.equal(limits['gemini-3.8-flash-medium'], 256000);
  assert.equal(limits['gemini-3.8-flash'], 256000);
  assert.equal(limits['claude-opus-4-6-thinking'], 160000);
  assert.equal(limits['gpt-oss-120b-medium'], 80000);
  assert.equal(limits['gpt-oss-120b'], 80000);
  assert.equal(limits['no-checkpoint-model'], 300000);
  assert.deepEqual(parseAvailableModelLimits(null), {});
});

test('lookupModelContextLimit：实时表优先于兜底表，兼容别名，未知模型返回 null', () => {
  const live = { 'gemini-4-neon': 900000, 'gemini-3.8-flash': 256000 };
  assert.equal(lookupModelContextLimit('gemini-4-neon', { liveLimits: live }), 900000);
  assert.equal(lookupModelContextLimit('gemini-3-8-flash', { liveLimits: live }), 256000);
  assert.equal(lookupModelContextLimit('claude-opus-4-6-thinking', { liveLimits: null }), 160000);
  assert.equal(lookupModelContextLimit('gpt-oss-120b-medium', { liveLimits: null }), 80000);
  assert.equal(lookupModelContextLimit('brand-new-unknown-model', { liveLimits: live }), null);
});

test('resolveEffectiveContextUsage：用模型真实上限替换 ACP 的 1M，且切模型后基于新模型重算', () => {
  const live = parseAvailableModelLimits(SAMPLE_MODELS);
  const neon = resolveEffectiveContextUsage({ used: 313516, size: 1048576 }, { model: 'gemini-4-neon', thoughtLevel: 'high', liveLimits: live });
  assert.deepEqual(neon, { used: 313516, size: 512000, rawSize: 1048576 });

  const flash = resolveEffectiveContextUsage({ used: 120000, size: 1048576 }, { model: 'gemini-3.8-flash', liveLimits: live });
  assert.deepEqual(flash, { used: 120000, size: 256000, rawSize: 1048576 });

  // 从小窗口模型切回大窗口模型时，不能被旧模型的 rawSize 钳死
  const switched = resolveEffectiveContextUsage({ used: 40000, size: 131072 }, { model: 'gemini-4-neon', liveLimits: live });
  assert.deepEqual(switched, { used: 40000, size: 512000, rawSize: 131072 });

  // 未知模型保留 ACP 上报值
  const unknown = resolveEffectiveContextUsage({ used: 5000, size: 1048576 }, { model: 'future-x', liveLimits: live });
  assert.deepEqual(unknown, { used: 5000, size: 1048576 });

  assert.equal(resolveEffectiveContextUsage(null, { model: 'gemini-4-neon', liveLimits: live }), null);
});

test('getAgyContextLimits：从 acp 日志读 language server 端口拉 GetAvailableModels 并按进程缓存', async () => {
  _resetAgyQuotaForTest();
  _resetAgyContextLimitsForTest();
  let hits = 0;
  let lastUrl = '';
  const srv = createServer((req, res) => {
    hits++;
    lastUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SAMPLE_MODELS));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-ctxlimit-'));
  const log = path.join(dir, 'acp.log');
  writeFileSync(log, `I1 Language server listening on random port at ${port} for HTTP\n`);

  try {
    const client = { status: () => ({ running: true, pid: 7788, logFile: log }) };
    const first = await getAgyContextLimits(client);
    assert.match(lastUrl, /GetAvailableModels$/);
    assert.equal(first['gemini-4-neon'], 512000);
    assert.equal(first['claude-opus-4-6-thinking'], 160000);
    assert.equal(hits, 1);

    const second = await getAgyContextLimits(client);
    assert.equal(second, first);
    assert.equal(hits, 1);
  } finally {
    srv.close();
  }
});

test('AcpClient：实时 usage_update 与切换模型时同步把 size 换成模型真实上限', async () => {
  _resetAgyQuotaForTest();
  _resetAgyContextLimitsForTest();
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-ctx-acp-'));
  const fakeScript = path.resolve('modules/agy/server/testing/fake-acp-agent.mjs');
  const client = new AcpClient({
    command: process.execPath,
    args: [fakeScript],
    daemonCwd: path.join(dir, 'daemon-cwd'),
    logFile: null,
  });

  try {
    const events = [];
    const res = await client.runPrompt({
      cwd: dir,
      promptBlocks: [{ type: 'text', text: 'hello' }],
      desiredConfig: { model: 'gemini-4-carbon' },
      onEvent: (ev) => events.push(ev),
    });
    const usageEvts = events.filter((e) => e.type === 'usage');
    assert.ok(usageEvts.length > 0);
    assert.equal(usageEvts[usageEvts.length - 1].size, 512000);
    assert.equal(res.contextUsage?.size, 512000);

    // 切到 Gemini 3.8 Flash，setConfigOption 返回的 usage 立刻刷新为 256k
    const switched = await client.setConfigOption(res.sessionId, 'model', 'gemini-3.8-flash', { cwd: dir });
    assert.equal(switched.model, 'gemini-3.8-flash');
    assert.equal(switched.usage?.size, 256000);

    // 切到 Claude Opus 4.6 (Thinking)，立刻刷新为 160k
    const switchedClaude = await client.setConfigOption(res.sessionId, 'model', 'claude-opus-4-6-thinking', { cwd: dir });
    assert.equal(switchedClaude.model, 'claude-opus-4-6-thinking');
    assert.equal(switchedClaude.usage?.size, 160000);
  } finally {
    client.shutdown();
  }
});
