// node --test src/cowork/live/merge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEvents, hasEdit, mergeProject, retab } from './merge.js';

const file = (path, content, revision, updated_by = 'sara') => ({ path, content, revision, updated_by });
const local = (entries, edits = {}) => {
  const base = Object.fromEntries(entries.map(([p, c, r]) => [p, { content: c, revision: r }]));
  const files = Object.fromEntries(entries.map(([p, c]) => [p, c]));
  return { files: { ...files, ...edits }, base, conflicts: {} };
};

test('newer on the server, no edit here: take it in place', () => {
  const here = local([['Test.py', 'print(1)\n', 1], ['b.py', 'b', 1]]);
  const m = mergeProject(here, [file('Test.py', 'print(2)\n', 2), file('b.py', 'b', 1)]);
  assert.equal(m.files['Test.py'], 'print(2)\n');
  assert.deepEqual(m.base['Test.py'], { content: 'print(2)\n', revision: 2 });
  assert.deepEqual(m.conflicts, {});
  assert.deepEqual(m.events, [{ type: 'saved', path: 'Test.py', by: 'sara' }]);
  assert.equal(describeEvents(m.events, 'wei'), 'sara saved Test.py');
});

test('newer on the server, an edit here: keep the edit, mark a conflict', () => {
  const here = local([['Test.py', 'x = 1\n', 1]], { 'Test.py': 'x = 1  # mine\n' });
  const m = mergeProject(here, [file('Test.py', 'x = 2\n', 2)]);
  assert.equal(m.files['Test.py'], 'x = 1  # mine\n');
  assert.deepEqual(m.base['Test.py'], { content: 'x = 1\n', revision: 1 }); // still the old base
  assert.deepEqual(m.conflicts['Test.py'], { kind: 'newer', by: 'sara', revision: 2, content: 'x = 2\n' });
  assert.deepEqual(m.events, [{ type: 'conflict', path: 'Test.py', by: 'sara' }]);
  // The next reload with the same server copy doesn't announce it again.
  const again = mergeProject(m, [file('Test.py', 'x = 2\n', 2)]);
  assert.deepEqual(again.events, []);
  assert.equal(again.conflicts['Test.py'].revision, 2);
  // A third save moves the conflict to the newest copy.
  const third = mergeProject(m, [file('Test.py', 'x = 3\n', 3, 'li')]);
  assert.deepEqual(third.conflicts['Test.py'], { kind: 'newer', by: 'li', revision: 3, content: 'x = 3\n' });
});

test('newer on the server equal to the edit here: in step, no conflict (our own save landing)', () => {
  const here = local([['a.py', 'old', 1]], { 'a.py': 'new' });
  const m = mergeProject(here, [file('a.py', 'new', 2, 'wei')]);
  assert.deepEqual(m.conflicts, {});
  assert.deepEqual(m.base['a.py'], { content: 'new', revision: 2 });
  assert.equal(hasEdit(m.files, m.base, 'a.py'), false);
  assert.deepEqual(m.events, []);
});

test('same or older revision: nothing changes', () => {
  const here = local([['a.py', 'a', 3]], { 'a.py': 'typing' });
  const m = mergeProject(here, [file('a.py', 'a', 3)]);
  assert.equal(m.files['a.py'], 'typing');
  assert.deepEqual(m.events, []);
  const older = mergeProject(here, [file('a.py', 'a?', 2)]);
  assert.equal(older.files['a.py'], 'typing');
});

test('a file being saved is left for the next pass', () => {
  const here = local([['a.py', 'a', 1]], { 'a.py': 'a + more typing' });
  const m = mergeProject(here, [file('a.py', 'a +', 2, 'wei')], { busy: new Set(['a.py']) });
  assert.deepEqual(m.conflicts, {});
  assert.equal(m.files['a.py'], 'a + more typing');
  assert.equal(m.base['a.py'].revision, 1);
});

test('a removed file: gone here too, its tab closes', () => {
  const here = local([['a.py', 'a', 1], ['gone.py', 'g', 4]]);
  const m = mergeProject(here, [file('a.py', 'a', 1)]);
  assert.equal('gone.py' in m.files, false);
  assert.equal('gone.py' in m.base, false);
  assert.deepEqual(m.events, [{ type: 'removed', path: 'gone.py' }]);
  assert.equal(describeEvents(m.events, 'wei'), 'gone.py was removed');
  assert.deepEqual(retab({ open: ['a.py', 'gone.py'], active: 'gone.py' }, m.files, m.events), { open: ['a.py'], active: 'a.py' });
});

test('a removed file with an edit here: a conflict, the edit is kept', () => {
  const here = local([['a.py', 'a', 1], ['gone.py', 'g', 4]], { 'gone.py': 'g + mine' });
  const m = mergeProject(here, [file('a.py', 'a', 1)]);
  assert.equal(m.files['gone.py'], 'g + mine');
  assert.deepEqual(m.conflicts['gone.py'], { kind: 'removed' });
});

test('a renamed file: same text under the new path; tabs follow', () => {
  const here = local([['old.py', 'print("hi")\n', 2], ['b.py', 'b', 1]]);
  const m = mergeProject(here, [file('b.py', 'b', 1), file('new.py', 'print("hi")\n', 3)]);
  assert.equal('old.py' in m.files, false);
  assert.equal(m.files['new.py'], 'print("hi")\n');
  assert.deepEqual(m.base['new.py'], { content: 'print("hi")\n', revision: 3 });
  assert.deepEqual(m.events, [{ type: 'renamed', path: 'new.py', from: 'old.py', by: 'sara' }]);
  assert.equal(describeEvents(m.events, 'wei'), 'sara renamed old.py to new.py');
  assert.deepEqual(retab({ open: ['old.py', 'b.py'], active: 'old.py' }, m.files, m.events), { open: ['new.py', 'b.py'], active: 'new.py' });
});

test('a renamed file with an edit here: the edit moves to the new path', () => {
  const here = local([['old.py', 'v1', 2]], { 'old.py': 'v1 + mine' });
  const m = mergeProject(here, [file('new.py', 'v1', 3)]);
  assert.equal(m.files['new.py'], 'v1 + mine');
  assert.equal(hasEdit(m.files, m.base, 'new.py'), true); // to be saved under the new name
  assert.deepEqual(m.conflicts, {});
});

test('a file a teammate created appears', () => {
  const here = local([['a.py', 'a', 1]]);
  const m = mergeProject(here, [file('a.py', 'a', 1), file('notes.md', '# hi', 1)]);
  assert.equal(m.files['notes.md'], '# hi');
  assert.deepEqual(m.events, [{ type: 'created', path: 'notes.md', by: 'sara' }]);
});

test('a pending conflict (save refused) settles into newer once the copy arrives', () => {
  const here = local([['a.py', 'a', 1]], { 'a.py': 'mine' });
  here.conflicts = { 'a.py': { kind: 'pending' } };
  const m = mergeProject(here, [file('a.py', 'theirs', 2)]);
  assert.equal(m.conflicts['a.py'].kind, 'newer');
  assert.equal(m.conflicts['a.py'].content, 'theirs');
});

test('notes leave out our own changes and group several', () => {
  assert.equal(describeEvents([{ type: 'saved', path: 'a.py', by: 'wei' }], 'wei'), null);
  assert.equal(
    describeEvents([{ type: 'saved', path: 'a.py', by: 'sara' }, { type: 'created', path: 'b.py', by: 'sara' }], 'wei'),
    'sara changed 2 files: a.py, b.py'
  );
});
