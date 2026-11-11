// Database tests for the Cowork migration: the access rules, as each kind
// of caller sees them. Runs against any Postgres with the migration applied
// and Supabase's auth schema (or tests/local_auth_stub.sql):
//
//   COWORK_TEST_DB=postgres://postgres@127.0.0.1:54329/cowork_test node --test supabase/tests/cowork.test.mjs
//
// Each call runs as the `authenticated` role with the user's JWT claims, as
// the Supabase API does, inside a transaction.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const db = new pg.Client({ connectionString: process.env.COWORK_TEST_DB || 'postgres://postgres@127.0.0.1:54329/cowork_test' });

const users = {};
async function user(name) {
  const id = randomUUID();
  const email = `${name}.${id.slice(0, 6)}@example.edu`;
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  users[name] = { id, email };
  return users[name];
}

// Runs SQL as a signed-in user (or anonymously when who is null).
async function as(who, sql, params = []) {
  await db.query('begin');
  try {
    await db.query(`set local role ${who ? 'authenticated' : 'anon'}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(who ? { sub: who.id, email: who.email, role: 'authenticated' } : { role: 'anon' }),
    ]);
    const result = await db.query(sql, params);
    await db.query('commit');
    return result.rows;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}
const call = async (who, fn, ...args) => {
  const rows = await as(who, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args);
  return rows[0].r;
};
const fails = async (promise, code, pattern) => {
  await assert.rejects(promise, (e) => {
    if (code) assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
};

let A, B, C, project;

before(async () => {
  await db.connect();
  A = await user('owner');
  B = await user('teammate');
  C = await user('outsider');
});
after(() => db.end());

test('anonymous callers can do nothing', async () => {
  await fails(call(null, 'cowork_overview'), '42501');
  await fails(as(null, 'select * from public.cowork_projects'), '42501');
});

test('a new project starts empty, with its creator as owner', async () => {
  project = (await call(A, 'cowork_create_project', '  Data Study  ')).id;
  const p = await call(A, 'cowork_project', project);
  assert.equal(p.name, 'Data Study');
  assert.equal(p.role, 'owner');
  assert.deepEqual(p.files, []);
  assert.equal(p.members.length, 1);
  await fails(call(A, 'cowork_create_project', '   '), 'PT400');
});

test('tables take no direct writes from the API', async () => {
  await fails(as(A, "insert into public.cowork_projects (name) values ('x')"), '42501');
  await fails(as(A, "update public.cowork_projects set name = 'x'"), '42501');
  await fails(as(A, 'delete from public.cowork_members'), '42501');
  await fails(as(A, "insert into public.cowork_files (project_id, path) values ($1, 'x.py')", [project]), '42501');
});

test('outsiders see nothing of a project', async () => {
  await fails(call(C, 'cowork_project', project), 'PT403', /isn't available/);
  assert.equal((await as(C, 'select * from public.cowork_projects')).length, 0);
  assert.equal((await as(C, 'select * from public.cowork_members')).length, 0);
  const overview = await call(C, 'cowork_overview');
  assert.deepEqual(overview.projects, []);
  assert.deepEqual(overview.invitations, []);
});

test('owners invite by email; the invitation waits for that email only', async () => {
  await fails(call(A, 'cowork_invite', project, 'not-an-email', 'member'), 'PT400');
  const inv = await call(A, 'cowork_invite', project, B.email.toUpperCase(), 'member');
  assert.equal(inv.email, B.email);
  await fails(call(A, 'cowork_invite', project, B.email, 'member'), 'PT409', /already invited/);
  await fails(call(A, 'cowork_invite', project, A.email, 'member'), 'PT409', /already in this project/);
  assert.equal((await call(C, 'cowork_overview')).invitations.length, 0);
  const forB = (await call(B, 'cowork_overview')).invitations;
  assert.equal(forB.length, 1);
  assert.equal(forB[0].project_name, 'Data Study');
  assert.equal(forB[0].invited_by_email, A.email);
  // Not a member yet: no project, no files.
  await fails(call(B, 'cowork_project', project), 'PT403');
  // Someone else can't take B's invitation.
  await fails(call(C, 'cowork_accept_invitation', forB[0].id), 'PT404');
  await fails(call(C, 'cowork_invite', project, C.email, 'owner'), 'PT403');
});

test('the invitee joins as the invited role', async () => {
  const id = (await call(B, 'cowork_overview')).invitations[0].id;
  const joined = await call(B, 'cowork_accept_invitation', id);
  assert.equal(joined.role, 'member');
  const p = await call(B, 'cowork_project', project);
  assert.equal(p.role, 'member');
  assert.equal(p.members.length, 2);
  assert.equal(p.invitations.length, 0);
  await fails(call(B, 'cowork_accept_invitation', id), 'PT404');
});

test('members edit files; owners alone remove files and manage the project', async () => {
  const f = await call(B, 'cowork_create_file', project, 'clean_data.py', 'print("hi")\n');
  assert.equal(f.revision, 1);
  await fails(call(B, 'cowork_create_file', project, 'clean_data.py', ''), 'PT409', /already exists/);
  assert.equal((await call(A, 'cowork_project', project)).files[0].content, 'print("hi")\n');
  await call(B, 'cowork_rename_file', project, 'clean_data.py', 'src/clean.py');
  await fails(call(B, 'cowork_remove_file', project, 'src/clean.py'), 'PT403', /Only owners/);
  await fails(call(B, 'cowork_invite', project, C.email, 'member'), 'PT403');
  await fails(call(B, 'cowork_rename_project', project, 'Mine now'), 'PT403');
  await fails(call(B, 'cowork_set_archived', project, true), 'PT403');
  await fails(call(B, 'cowork_set_role', project, B.id, 'owner'), 'PT403');
  await call(A, 'cowork_rename_project', project, 'Data Study 2026');
});

test('a save only lands on the revision it started from', async () => {
  const start = (await call(A, 'cowork_project', project)).files.find((x) => x.path === 'src/clean.py').revision;
  const saved = await call(A, 'cowork_save_file', project, 'src/clean.py', 'v2', start);
  assert.equal(saved.revision, start + 1);
  // B edited the same starting revision: refused, nothing overwritten.
  await fails(call(B, 'cowork_save_file', project, 'src/clean.py', 'B version', start), 'PT409', /saved .* first/);
  assert.equal((await call(B, 'cowork_project', project)).files.find((x) => x.path === 'src/clean.py').content, 'v2');
  await call(B, 'cowork_save_file', project, 'src/clean.py', 'v3', saved.revision);
  await fails(call(A, 'cowork_save_file', project, 'gone.py', 'x', 1), 'PT404', /renamed or removed/);
});

test('file names and sizes are checked', async () => {
  for (const bad of ['../etc/passwd', '.env', '/abs.py', 'a//b.py', 'dir/', 'x\\y.py', 'a/./b.py']) {
    await fails(call(B, 'cowork_create_file', project, bad, ''), 'PT400');
  }
  await call(B, 'cowork_create_file', project, 'data/survey.csv', 'a,b\n');
  const big = 'x'.repeat(1048577);
  await fails(call(B, 'cowork_create_file', project, 'big.txt', big), 'PT400', /1 MB/);
  await call(B, 'cowork_create_file', project, 'just-fits.txt', 'x'.repeat(1048576));
  await call(A, 'cowork_remove_file', project, 'just-fits.txt');
});

test('a project always keeps an owner', async () => {
  await fails(call(A, 'cowork_set_role', project, A.id, 'member'), 'PT409', /needs an owner/);
  await fails(call(A, 'cowork_remove_member', project, A.id), 'PT409', /needs an owner/);
  await call(A, 'cowork_set_role', project, B.id, 'owner');
  await call(A, 'cowork_set_role', project, A.id, 'member');
  assert.equal((await call(A, 'cowork_project', project)).role, 'member');
  await call(B, 'cowork_set_role', project, A.id, 'owner');
  await call(A, 'cowork_set_role', project, B.id, 'member');
});

test('an archived project is closed until an owner restores it', async () => {
  await call(A, 'cowork_set_archived', project, true);
  await fails(call(B, 'cowork_project', project), 'PT409', /archived/);
  await fails(call(B, 'cowork_save_file', project, 'data/survey.csv', 'x', 1), 'PT409', /archived/);
  assert.equal((await as(B, 'select * from public.cowork_files where project_id = $1', [project])).length, 0);
  const listed = (await call(B, 'cowork_overview')).projects.find((p) => p.id === project);
  assert.ok(listed.archived_at, 'still listed, as archived');
  await call(A, 'cowork_set_archived', project, false);
  assert.ok((await as(B, 'select * from public.cowork_files where project_id = $1', [project])).length > 0);
});

test('invitations can be declined or cancelled', async () => {
  const inv = await call(A, 'cowork_invite', project, C.email, 'member');
  await call(C, 'cowork_decline_invitation', inv.id);
  assert.equal((await call(C, 'cowork_overview')).invitations.length, 0);
  const again = await call(A, 'cowork_invite', project, C.email, 'member');
  await fails(call(B, 'cowork_cancel_invitation', again.id), 'PT403');
  await call(A, 'cowork_cancel_invitation', again.id);
  assert.equal((await call(C, 'cowork_overview')).invitations.length, 0);
});

test('a removed member loses access at once', async () => {
  await call(A, 'cowork_remove_member', project, B.id);
  await fails(call(B, 'cowork_project', project), 'PT403', /isn't available/);
  await fails(call(B, 'cowork_save_file', project, 'data/survey.csv', 'x', 1), 'PT403');
  assert.equal((await as(B, 'select * from public.cowork_files where project_id = $1', [project])).length, 0);
  assert.equal((await as(B, 'select * from public.cowork_members where project_id = $1', [project])).length, 0);
  assert.deepEqual((await call(B, 'cowork_overview')).projects, []);
});

test('members can leave', async () => {
  const inv = await call(A, 'cowork_invite', project, C.email, 'member');
  await call(C, 'cowork_accept_invitation', inv.id);
  await call(C, 'cowork_remove_member', project, C.id);
  await fails(call(C, 'cowork_project', project), 'PT403');
});
