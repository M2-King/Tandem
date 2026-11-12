// Database tests for live typing (003_cowork_live_text.sql): saving a file
// together with its Yjs document, reading the documents back, and who may.
// Same setup as cowork.test.mjs (Postgres with Supabase's auth schema or
// tests/local_auth_stub.sql, and migrations 001-003 applied):
//
//   COWORK_TEST_DB=postgres://postgres@127.0.0.1:54329/cowork_test npm run test:cowork-db

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const db = new pg.Client({ connectionString: process.env.COWORK_TEST_DB || 'postgres://postgres@127.0.0.1:54329/cowork_test' });
const DOMAIN = 'users.tandem.invalid';
const run = randomUUID().replace(/-/g, '').slice(0, 6);

async function signUp(username) {
  const id = randomUUID();
  await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [id, `${username}@${DOMAIN}`, JSON.stringify({ username })]);
  return { id, username };
}
async function as(who, sql, params = []) {
  await db.query('begin');
  try {
    await db.query(`set local role ${who ? 'authenticated' : 'anon'}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(who ? { sub: who.id, role: 'authenticated' } : { role: 'anon' })]);
    const result = await db.query(sql, params);
    await db.query('commit');
    return result.rows;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}
const call = async (who, fn, ...args) => (await as(who, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r;
const fails = (promise, code) => assert.rejects(promise, (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true));
const b64 = (s) => Buffer.from(s).toString('base64');
const docRow = async (project, path) => (await db.query('select revision, convert_from(doc, $3) as doc from public.cowork_file_docs where project_id = $1 and path = $2', [project, path, 'UTF8'])).rows[0];

let A, B, C, project;

before(async () => {
  await db.connect();
  A = await signUp(`lta_${run}`);
  B = await signUp(`ltb_${run}`);
  C = await signUp(`ltc_${run}`);
  project = (await call(A, 'cowork_create_project', `Live ${run}`)).id;
  const inv = await call(A, 'cowork_invite', project, B.username, 'member');
  await call(B, 'cowork_accept_invitation', inv.id);
  await call(A, 'cowork_create_file', project, 'a.py', 'x = 1\n');
});
after(() => db.end());

test('a save with its document keeps both, at the revision the save gave', async () => {
  const r = await call(A, 'cowork_save_file_doc', project, 'a.py', 'x = 2\n', 1, b64('doc-v2'));
  assert.equal(r.path, 'a.py');
  assert.equal(r.revision, 2);
  assert.equal((await call(A, 'cowork_project', project)).files.find((f) => f.path === 'a.py').content, 'x = 2\n');
  assert.deepEqual(await docRow(project, 'a.py'), { revision: 2, doc: 'doc-v2' });
  const docs = await call(B, 'cowork_file_docs', project);
  assert.deepEqual(docs, [{ path: 'a.py', revision: 2, doc: b64('doc-v2') }]);
});

test('a save over an older revision is refused and keeps the document as it was', async () => {
  await fails(call(B, 'cowork_save_file_doc', project, 'a.py', 'x = 3\n', 1, b64('doc-stale')), 'PT409');
  assert.deepEqual(await docRow(project, 'a.py'), { revision: 2, doc: 'doc-v2' });
  const r = await call(B, 'cowork_save_file_doc', project, 'a.py', 'x = 3\n', 2, b64('doc-v3'));
  assert.equal(r.revision, 3);
  assert.deepEqual(await docRow(project, 'a.py'), { revision: 3, doc: 'doc-v3' });
});

test('a plain save (older builds) leaves the document behind its file', async () => {
  await call(A, 'cowork_save_file', project, 'a.py', 'x = 4\n', 3);
  assert.equal((await call(A, 'cowork_file_docs', project))[0].revision, 3);
});

test('documents follow their file when renamed, and go when it is removed', async () => {
  await call(A, 'cowork_rename_file', project, 'a.py', 'b.py');
  const docs = await call(A, 'cowork_file_docs', project);
  assert.deepEqual(docs.map((d) => d.path), ['b.py']);
  await call(A, 'cowork_remove_file', project, 'b.py');
  assert.deepEqual(await call(A, 'cowork_file_docs', project), []);
  assert.equal((await db.query('select count(*)::int as n from public.cowork_file_docs where project_id = $1', [project])).rows[0].n, 0);
});

test('outsiders and anonymous callers can do nothing', async () => {
  await call(A, 'cowork_create_file', project, 'c.py', 'y = 1\n');
  await fails(call(C, 'cowork_file_docs', project), 'PT403');
  await fails(call(C, 'cowork_save_file_doc', project, 'c.py', 'hacked', 1, b64('d')), 'PT403');
  await fails(call(null, 'cowork_file_docs', project), '42501');
  await fails(call(null, 'cowork_save_file_doc', project, 'c.py', 'hacked', 1, b64('d')), '42501');
});

test('the table takes no direct reads or writes from the API', async () => {
  await fails(as(A, 'select * from public.cowork_file_docs'), '42501');
  await fails(as(A, "insert into public.cowork_file_docs (project_id, path, revision, doc) values ($1, 'c.py', 9, 'x')", [project]), '42501');
});

test('a document that is not base64, or empty, is refused before anything is saved', async () => {
  await fails(call(A, 'cowork_save_file_doc', project, 'c.py', 'y = 2\n', 1, '***not base64***'), 'PT400');
  await fails(call(A, 'cowork_save_file_doc', project, 'c.py', 'y = 2\n', 1, ''), 'PT400');
  assert.equal((await call(A, 'cowork_project', project)).files.find((f) => f.path === 'c.py').revision, 1);
});
