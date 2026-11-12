// Live typing documents (liveText.js): devices converge on the same text,
// nothing is lost or doubled, undo is per device.
//   npm run test:cowork-merge

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveText, isLiveTextPath, textDiff, LOCAL } from './liveText.js';

// A device: its documents, the updates it would send, the texts it would show.
function device() {
  const sent = [];
  const shown = [];
  const live = createLiveText({
    onUpdate: (path, update) => sent.push({ path, update }),
    onText: (path, text, origin) => shown.push({ path, text, origin }),
  });
  return { live, sent, shown };
}
// Deliver everything `from` sent so far to `to` (in order), then clear it.
function deliver(from, to) {
  for (const m of from.sent.splice(0)) to.live.applyRemote(m.path, m.update);
}
// Type at an index on a device, as the editor binding does (origin LOCAL).
function type(dev, path, index, text, remove = 0) {
  const e = dev.live.entry(path);
  e.doc.transact(() => {
    if (remove) e.ytext.delete(index, remove);
    if (text) e.ytext.insert(index, text);
  }, LOCAL);
}

test('which files are typed live', () => {
  assert.equal(isLiveTextPath('a.py'), true);
  assert.equal(isLiveTextPath('q.sql'), true);
  assert.equal(isLiveTextPath('notes.md'), true);
  assert.equal(isLiveTextPath('nb.ipynb'), false);
  assert.equal(isLiveTextPath('data.db'), false);
});

test('textDiff finds the smallest replacement', () => {
  assert.equal(textDiff('abc', 'abc'), null);
  assert.deepEqual(textDiff('hello world', 'hello brave world'), { index: 6, remove: 0, insert: 'brave ' });
  assert.deepEqual(textDiff('x = 1\ny = 2', 'x = 1\n'), { index: 6, remove: 5, insert: '' });
});

test('two devices seeding the same file get the same document, not doubled text', () => {
  const A = device();
  const B = device();
  A.live.seed('a.py', 'print(1)\n', 1);
  B.live.seed('a.py', 'print(1)\n', 1);
  type(A, 'a.py', 9, 'print(2)\n');
  deliver(A, B);
  assert.equal(B.live.text('a.py'), 'print(1)\nprint(2)\n');
  // Each catching up with the other's whole state changes nothing.
  B.live.applyRemote('a.py', A.live.snapshot('a.py').doc);
  A.live.applyRemote('a.py', B.live.snapshot('a.py').doc);
  assert.equal(A.live.text('a.py'), 'print(1)\nprint(2)\n');
  assert.equal(B.live.text('a.py'), 'print(1)\nprint(2)\n');
});

test('typing at the same place at the same time: both keep both, in the same order', () => {
  const A = device();
  const B = device();
  A.live.seed('a.py', 'x = \n', 1);
  B.live.seed('a.py', 'x = \n', 1);
  type(A, 'a.py', 4, '111');
  type(B, 'a.py', 4, '222');
  deliver(A, B);
  deliver(B, A);
  assert.equal(A.live.text('a.py'), B.live.text('a.py'));
  assert.match(A.live.text('a.py'), /^x = (111222|222111)\n$/);
});

test('a teammate’s edits are shown (onText) and not sent on; my typing is sent and not echoed', () => {
  const A = device();
  const B = device();
  A.live.seed('a.py', 'a\n', 1);
  B.live.seed('a.py', 'a\n', 1);
  B.shown.length = 0;
  type(A, 'a.py', 2, 'b\n');
  assert.equal(A.sent.length, 1);
  assert.equal(A.shown.filter((s) => s.origin === LOCAL).length, 0);
  deliver(A, B);
  assert.deepEqual(B.shown.at(-1), { path: 'a.py', text: 'a\nb\n', origin: 'remote' });
  assert.equal(B.sent.length, 0);
});

test('offline edits on both sides merge when they catch up (state vectors)', () => {
  const A = device();
  const B = device();
  A.live.seed('a.py', 'one\ntwo\nthree\n', 3);
  B.live.seed('a.py', 'one\ntwo\nthree\n', 3);
  type(A, 'a.py', 0, '# A\n');
  type(B, 'a.py', 14, 'four\n');
  A.sent.length = 0;
  B.sent.length = 0; // lost while offline
  // B joins again: asks A for what it lacks, then sends A what A lacks.
  B.live.applyRemote('a.py', A.live.diffFor('a.py', B.live.stateVector('a.py')));
  A.live.applyRemote('a.py', B.live.diffFor('a.py', A.live.stateVector('a.py')));
  assert.equal(A.live.text('a.py'), '# A\none\ntwo\nthree\nfour\n');
  assert.equal(B.live.text('a.py'), A.live.text('a.py'));
  assert.equal(A.live.diffFor('a.py', B.live.stateVector('a.py')), null, 'nothing left to send');
});

test('opening from the saved copy, brought up to date the same way on every device', () => {
  const A = device();
  A.live.seed('a.py', 'v1\n', 1);
  type(A, 'a.py', 3, 'v2\n');
  const saved = { revision: 2, doc: A.live.snapshot('a.py').doc };
  // An older build saved revision 3 as plain text since.
  const file = { content: 'v1\nv2\nv3\n', revision: 3 };
  const B = device();
  const C = device();
  B.live.load('a.py', file, saved);
  C.live.load('a.py', file, saved);
  assert.equal(B.live.text('a.py'), file.content);
  assert.equal(B.live.snapshot('a.py').doc, C.live.snapshot('a.py').doc, 'same document on both');
  type(B, 'a.py', 0, '# B\n');
  deliver(B, C);
  assert.equal(C.live.text('a.py'), '# B\nv1\nv2\nv3\n');
});

test('a saved copy newer than the file listing is kept, not taken back to the older text', () => {
  const A = device();
  A.live.seed('a.py', 'v1\n', 1);
  type(A, 'a.py', 3, 'v2\n');
  const saved = { revision: 3, doc: A.live.snapshot('a.py').doc }; // saved after the listing was read
  const B = device();
  B.live.load('a.py', { content: 'v1\n', revision: 2 }, saved);
  assert.equal(B.live.text('a.py'), 'v1\nv2\n');
});

test('undo undoes only my own typing', () => {
  const A = device();
  const B = device();
  A.live.seed('a.py', '', 1);
  B.live.seed('a.py', '', 1);
  type(A, 'a.py', 0, 'mine ');
  deliver(A, B);
  type(B, 'a.py', 5, 'theirs');
  deliver(B, A);
  assert.equal(A.live.text('a.py'), 'mine theirs');
  A.live.undo('a.py');
  assert.equal(A.live.text('a.py'), 'theirs');
  assert.equal(A.shown.at(-1).origin, 'undo', 'undo is shown and saved');
  deliver(A, B);
  assert.equal(B.live.text('a.py'), 'theirs', 'the undo reaches the teammate');
  A.live.redo('a.py');
  deliver(A, B);
  assert.equal(B.live.text('a.py'), 'mine theirs');
});

test('setText (an edit made outside the editor) goes in as the difference', () => {
  const A = device();
  const B = device();
  A.live.seed('a.py', 'a = 1\nb = 2\n', 1);
  B.live.seed('a.py', 'a = 1\nb = 2\n', 1);
  type(B, 'a.py', 0, '# note\n');
  A.live.setText('a.py', 'a = 1\nb = 3\n');
  deliver(A, B);
  deliver(B, A);
  assert.equal(A.live.text('a.py'), '# note\na = 1\nb = 3\n');
  assert.equal(B.live.text('a.py'), A.live.text('a.py'));
});

test('a large paste (200 KB) arrives whole', () => {
  const A = device();
  const B = device();
  A.live.seed('big.py', '', 1);
  B.live.seed('big.py', '', 1);
  const big = '# ' + 'x'.repeat(200 * 1024) + '\n';
  type(A, 'big.py', 0, big);
  deliver(A, B);
  assert.equal(B.live.text('big.py').length, big.length);
});

test('renamed and removed files', () => {
  const A = device();
  A.live.seed('a.py', 'x\n', 1);
  A.live.rename('a.py', 'b.py');
  assert.equal(A.live.text('b.py'), 'x\n');
  assert.equal(A.live.has('a.py'), false);
  type(A, 'b.py', 0, 'y');
  assert.equal(A.sent.at(-1).path, 'b.py');
  A.live.drop('b.py');
  assert.equal(A.live.has('b.py'), false);
});
