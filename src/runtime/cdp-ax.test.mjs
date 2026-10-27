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
