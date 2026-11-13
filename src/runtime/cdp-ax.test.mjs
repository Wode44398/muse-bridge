import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotAccessibility } from './cdp-ax.mjs';

test('renders accessibility nodes and rebuilds refs', async () => {
  const refs = new Map([[99, { stale: true }]]);
  const send = async () => ({
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2'] },
      {
        nodeId: '2',
        parentId: '1',
        role: { value: 'button' },
        name: { value: 'Save' },
        backendDOMNodeId: 42,
        properties: [{ name: 'focusable', value: { value: true } }],
      },
    ],
  });
  const result = await snapshotAccessibility(send, refs);
  assert.match(result.text, /button "Save" \[ref1\]/);
  assert.equal(result.refCount, 1);
  assert.deepEqual(refs.get(1), { backendId: 42, role: 'button', name: 'Save' });
  assert.equal(refs.has(99), false);
});

test('read_page(ref): only that subtree, optional depth limit', async () => {
  const send = async () => ({
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2', '5'] },
      { nodeId: '2', parentId: '1', role: { value: 'navigation' }, name: { value: '菜单' }, backendDOMNodeId: 7, childIds: ['3'] },
      { nodeId: '3', parentId: '2', role: { value: 'list' }, name: { value: '' }, childIds: ['4'] },
      { nodeId: '4', parentId: '3', role: { value: 'link' }, name: { value: '丙' }, backendDOMNodeId: 9 },
      { nodeId: '5', parentId: '1', role: { value: 'button' }, name: { value: '远处按钮' }, backendDOMNodeId: 11 },
    ],
  });
  const sub = await snapshotAccessibility(send, new Map(), { rootBackendId: 7 });
  assert.match(sub.text, /navigation "菜单"/);
  assert.match(sub.text, /link "丙" \[ref1\]/);
  assert.doesNotMatch(sub.text, /远处按钮/);
  const shallow = await snapshotAccessibility(send, new Map(), { rootBackendId: 7, depth: 1 });
  assert.doesNotMatch(shallow.text, /丙/);
  await assert.rejects(snapshotAccessibility(send, new Map(), { rootBackendId: 404 }), /不在无障碍树里/);
});

test('links carry their url: same-origin as a path, others in full; javascript: / url-as-name / long urls handled', async () => {
  const url = (value) => [{ name: 'url', value: { type: 'string', value } }];
  const long = `https://cdn.example.org/${'a'.repeat(200)}`;
  const send = async () => ({
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Releases' }, properties: url('https://github.com/o/r/releases'), childIds: ['2', '3', '4', '5', '6', '7'] },
      { nodeId: '2', parentId: '1', role: { value: 'link' }, name: { value: 'v1.2.0' }, backendDOMNodeId: 10, properties: [{ name: 'focusable', value: { value: true } }, ...url('https://github.com/o/r/releases/tag/v1.2.0?x=1#n')] },
      { nodeId: '3', parentId: '1', role: { value: 'link' }, name: { value: 'Docs' }, backendDOMNodeId: 11, properties: url('https://docs.example.com/start') },
      { nodeId: '4', parentId: '1', role: { value: 'link' }, name: { value: '展开' }, backendDOMNodeId: 12, properties: url('javascript:void(0)') },
      { nodeId: '5', parentId: '1', role: { value: 'link' }, name: { value: 'https://docs.example.com/start' }, backendDOMNodeId: 13, properties: url('https://docs.example.com/start') },
      { nodeId: '6', parentId: '1', role: { value: 'link' }, name: { value: '大文件' }, backendDOMNodeId: 14, properties: url(long) },
      { nodeId: '7', parentId: '1', role: { value: 'button' }, name: { value: '按钮' }, backendDOMNodeId: 15, properties: url('https://github.com/x') },
    ],
  });
  const { text } = await snapshotAccessibility(send, new Map());
  assert.match(text, /link "v1\.2\.0" \[ref1\] → \/o\/r\/releases\/tag\/v1\.2\.0\?x=1#n$/m);
  assert.match(text, /link "Docs" \[ref2\] → https:\/\/docs\.example\.com\/start$/m);
  assert.match(text, /link "展开" \[ref3\]$/m);
  assert.match(text, /link "https:\/\/docs\.example\.com\/start" \[ref4\]$/m);
  const big = text.split('\n').find((l) => l.includes('大文件'));
  assert.ok(big.endsWith('…') && big.split(' → ')[1].length === 120, big);
  assert.match(text, /button "按钮" \[ref6\]$/m);
  assert.doesNotMatch(text.split('\n')[0], /→/);
  // query 也能按地址找链接
  const q = await snapshotAccessibility(send, new Map(), { query: 'releases/tag' });
  assert.equal(q.text, '- link "v1.2.0" [ref1] → /o/r/releases/tag/v1.2.0?x=1#n');
  // 根上没地址：照写完整地址
  const bare = async () => ({ nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'P' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'link' }, name: { value: 'A' }, backendDOMNodeId: 3, properties: url('https://github.com/a') },
  ] });
  assert.match((await snapshotAccessibility(bare, new Map())).text, /link "A" \[ref1\] → https:\/\/github\.com\/a$/m);
});
