// Database tests for the Cowork migration: accounts, and the access rules as
// each kind of caller sees them. Runs against any Postgres with Supabase's
// auth schema (or tests/local_auth_stub.sql) and the migration applied:
//
//   COWORK_TEST_DB=postgres://postgres@127.0.0.1:54329/cowork_test npm run test:cowork-db
//
// Accounts are created the way Supabase Auth creates them (a row in
// auth.users with the username in its metadata); each call then runs as
// the `authenticated` role with that user's JWT claims, as the API does.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const db = new pg.Client({ connectionString: process.env.COWORK_TEST_DB || 'postgres://postgres@127.0.0.1:54329/cowork_test' });
const DOMAIN = 'users.tandem.invalid';
const run = randomUUID().replace(/-/g, '').slice(0, 6);

// Signs up an account (as Auth would) and returns { id, username }.
async function signUp(username, { email = `${username}@${DOMAIN}`, meta = { username } } = {}) {
  const id = randomUUID();
  await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [id, email, JSON.stringify(meta)]);
  return { id, username };
}

// Runs SQL as a signed-in user (or anonymously when who is null).
async function as(who, sql, params = []) {
  await db.query('begin');
  try {
    await db.query(`set local role ${who ? 'authenticated' : 'anon'}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(who ? { sub: who.id, role: 'authenticated' } : { role: 'anon' }),
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
});
after(() => db.end());

test('signing up claims a username; one username is one account', async () => {
  A = await signUp(`owner_${run}`);
  B = await signUp(`mate_${run}`);
  C = await signUp(`outsider_${run}`);
  const rows = (await db.query('select username from public.cowork_profiles where user_id = $1', [A.id])).rows;
  assert.equal(rows[0].username, A.username);
  // The same username again (Auth refuses the same address first; the profile is unique too).
  await assert.rejects(signUp(A.username, { email: `${A.username}@elsewhere.invalid` }), /duplicate key|unique/);
  // Usernames: 3-24 of a-z, 0-9, _, starting with a letter; address must match.
  for (const bad of ['ab', '1abc', 'has space', 'a'.repeat(25), 'dash-name']) {
    await assert.rejects(signUp(bad.toLowerCase(), { email: `x${run}@${DOMAIN}`, meta: { username: bad } }), /Choose a username/);
  }
  await assert.rejects(signUp(`spoof_${run}`, { email: `${A.username}x@${DOMAIN}` }), /Choose a username/);
  // Mixed case is stored lowercase.
  const mixed = await signUp(`case_${run}`, { meta: { username: `CASE_${run}` } });
  assert.equal((await db.query('select username from public.cowork_profiles where user_id = $1', [mixed.id])).rows[0].username, `case_${run}`);
  // An Auth user without a username (made some other way) gets no profile.
  const other = randomUUID();
  await db.query("insert into auth.users (id, email) values ($1, $2)", [other, `plain${run}@example.edu`]);
  assert.equal((await db.query('select * from public.cowork_profiles where user_id = $1', [other])).rows.length, 0);
});

test('anonymous callers can do nothing', async () => {
  await fails(call(null, 'cowork_overview'), '42501');
  await fails(as(null, 'select * from public.cowork_projects'), '42501');
  await fails(as(null, 'select * from public.cowork_profiles'), '42501');
});

test('a new project starts empty, with its creator as owner', async () => {
  project = (await call(A, 'cowork_create_project', '  Data Study  ')).id;
  const p = await call(A, 'cowork_project', project);
  assert.equal(p.name, 'Data Study');
  assert.equal(p.role, 'owner');
  assert.deepEqual(p.files, []);
  assert.deepEqual(p.members.map((m) => m.username), [A.username]);
  assert.equal((await call(A, 'cowork_overview')).me.username, A.username);
  await fails(call(A, 'cowork_create_project', '   '), 'PT400');
});

test('tables take no direct writes from the API', async () => {
  await fails(as(A, "insert into public.cowork_projects (name) values ('x')"), '42501');
  await fails(as(A, "update public.cowork_projects set name = 'x'"), '42501');
  await fails(as(A, 'delete from public.cowork_members'), '42501');
  await fails(as(A, "update public.cowork_profiles set username = 'taken'"), '42501');
  await fails(as(A, "insert into public.cowork_files (project_id, path) values ($1, 'x.py')", [project]), '42501');
});

test('an uninvited account cannot open a private project', async () => {
  await fails(call(C, 'cowork_project', project), 'PT403', /isn't available/);
  assert.equal((await as(C, 'select * from public.cowork_projects')).length, 0);
  assert.equal((await as(C, 'select * from public.cowork_members')).length, 0);
  assert.equal((await as(C, 'select * from public.cowork_files')).length, 0);
  assert.deepEqual((await as(C, 'select username from public.cowork_profiles')).map((r) => r.username), [C.username], 'sees only their own profile');
  const overview = await call(C, 'cowork_overview');
  assert.deepEqual(overview.projects, []);
  assert.deepEqual(overview.invitations, []);
  await fails(call(C, 'cowork_save_file', project, 'x.py', 'x', 1), 'PT403');
  await fails(call(C, 'cowork_create_file', project, 'x.py', 'x'), 'PT403');
});

test('owners invite by username; only that account sees the invitation', async () => {
  await fails(call(A, 'cowork_invite', project, 'not a name', 'member'), 'PT400');
  await fails(call(A, 'cowork_invite', project, `nobody_${run}`, 'member'), 'PT404', /no Tandem account called/);
  const inv = await call(A, 'cowork_invite', project, `@${B.username.toUpperCase()}`, 'member');
  assert.equal(inv.username, B.username);
  await fails(call(A, 'cowork_invite', project, B.username, 'member'), 'PT409', /already invited/);
  await fails(call(A, 'cowork_invite', project, A.username, 'member'), 'PT409', /already in this project/);
  assert.equal((await call(C, 'cowork_overview')).invitations.length, 0);
  const forB = (await call(B, 'cowork_overview')).invitations;
  assert.equal(forB.length, 1);
  assert.equal(forB[0].project_name, 'Data Study');
  assert.equal(forB[0].invited_by, A.username);
  // Invited isn't joined: still no project, no files.
  await fails(call(B, 'cowork_project', project), 'PT403');
  // Someone else can't take B's invitation, or invite themselves.
  await fails(call(C, 'cowork_accept_invitation', forB[0].id), 'PT404');
  await fails(call(C, 'cowork_invite', project, C.username, 'owner'), 'PT403');
});

test('the invitee joins as the invited role', async () => {
  const id = (await call(B, 'cowork_overview')).invitations[0].id;
  const joined = await call(B, 'cowork_accept_invitation', id);
  assert.equal(joined.role, 'member');
  const p = await call(B, 'cowork_project', project);
  assert.equal(p.role, 'member');
  assert.deepEqual(p.members.map((m) => m.username), [A.username, B.username]);
  assert.equal(p.invitations.length, 0);
  await fails(call(B, 'cowork_accept_invitation', id), 'PT404');
  // Teammates see each other's usernames, still not outsiders'.
  const seen = (await as(B, 'select username from public.cowork_profiles')).map((r) => r.username).sort();
  assert.deepEqual(seen, [A.username, B.username].sort());
});

test('members edit files; owners alone remove files and manage the project', async () => {
  const f = await call(B, 'cowork_create_file', project, 'clean_data.py', 'print("hi")\n');
  assert.equal(f.revision, 1);
  await fails(call(B, 'cowork_create_file', project, 'clean_data.py', ''), 'PT409', /already exists/);
  const seen = (await call(A, 'cowork_project', project)).files[0];
  assert.equal(seen.content, 'print("hi")\n');
  assert.equal(seen.updated_by, B.username);
  await call(B, 'cowork_rename_file', project, 'clean_data.py', 'src/clean.py');
  await fails(call(B, 'cowork_remove_file', project, 'src/clean.py'), 'PT403', /Only owners/);
  await fails(call(B, 'cowork_invite', project, C.username, 'member'), 'PT403');
  await fails(call(B, 'cowork_rename_project', project, 'Mine now'), 'PT403');
  await fails(call(B, 'cowork_set_archived', project, true), 'PT403');
  await fails(call(B, 'cowork_set_role', project, B.id, 'owner'), 'PT403');
  await call(A, 'cowork_rename_project', project, 'Data Study 2026');
});

test('a save only lands on the revision it started from', async () => {
  const start = (await call(A, 'cowork_project', project)).files.find((x) => x.path === 'src/clean.py').revision;
  const saved = await call(A, 'cowork_save_file', project, 'src/clean.py', 'v2', start);
  assert.equal(saved.revision, start + 1);
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
  await fails(call(B, 'cowork_create_file', project, 'big.txt', 'x'.repeat(1048577)), 'PT400', /1 MB/);
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
  assert.equal(listed.archived_by, A.username);
  await call(A, 'cowork_set_archived', project, false);
  assert.ok((await as(B, 'select * from public.cowork_files where project_id = $1', [project])).length > 0);
});

test('invitations can be declined or cancelled', async () => {
  const inv = await call(A, 'cowork_invite', project, C.username, 'member');
  await call(C, 'cowork_decline_invitation', inv.id);
  assert.equal((await call(C, 'cowork_overview')).invitations.length, 0);
  const again = await call(A, 'cowork_invite', project, C.username, 'member');
  await fails(call(B, 'cowork_cancel_invitation', again.id), 'PT403');
  await call(A, 'cowork_cancel_invitation', again.id);
  assert.equal((await call(C, 'cowork_overview')).invitations.length, 0);
  await fails(call(C, 'cowork_project', project), 'PT403');
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
  const inv = await call(A, 'cowork_invite', project, C.username, 'member');
  await call(C, 'cowork_accept_invitation', inv.id);
  await call(C, 'cowork_remove_member', project, C.id);
  await fails(call(C, 'cowork_project', project), 'PT403');
});

test('deleting an account removes its profile, memberships and invitations', async () => {
  const D = await signUp(`gone_${run}`);
  await call(A, 'cowork_invite', project, D.username, 'member');
  await db.query('delete from auth.users where id = $1', [D.id]);
  assert.equal((await db.query('select * from public.cowork_profiles where user_id = $1', [D.id])).rows.length, 0);
  assert.equal((await call(A, 'cowork_project', project)).invitations.length, 0);
});

// ------------------------------------------------------------------ Realtime (002_cowork_realtime.sql)
// Realtime Authorization, checked the way Supabase Realtime checks a join to
// a private channel: messages for the topic exist, then, as the caller with
// realtime.topic() set, which can it read (receive) and insert (send)?
async function channelAccess(who, topic) {
  await db.query('begin');
  try {
    await db.query("insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true), ($1, 'presence', true)", [topic]);
    await db.query(`set local role ${who ? 'authenticated' : 'anon'}`);
    await db.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [
      JSON.stringify(who ? { sub: who.id, role: 'authenticated' } : { role: 'anon' }),
      topic,
    ]);
    const read = (await db.query('select distinct extension from realtime.messages where topic = $1 order by 1', [topic])).rows.map((r) => r.extension);
    const write = [];
    for (const ext of ['broadcast', 'presence']) {
      await db.query('savepoint w');
      try {
        await db.query('insert into realtime.messages (topic, extension, private) values ($1, $2, true)', [topic, ext]);
        write.push(ext);
      } catch {
        // refused by the policy
      }
      await db.query('rollback to savepoint w');
    }
    return { read, write };
  } finally {
    await db.query('rollback');
  }
}

test('Realtime: only members may join a project’s private channel', async () => {
  const owner = await signUp(`rt_owner_${run}`);
  const member = await signUp(`rt_member_${run}`);
  const outsider = await signUp(`rt_out_${run}`);
  const pid = (await call(owner, 'cowork_create_project', 'Realtime check')).id;
  const inv = await call(owner, 'cowork_invite', pid, member.username, 'member');
  const topic = `cowork:${pid}`;
  const both = { read: ['broadcast', 'presence'], write: ['broadcast', 'presence'] };
  const none = { read: [], write: [] };

  assert.deepEqual(await channelAccess(owner, topic), both);
  assert.deepEqual(await channelAccess(member, topic), none, 'invited, not joined yet');
  await call(member, 'cowork_accept_invitation', inv.id);
  assert.deepEqual(await channelAccess(member, topic), both);
  assert.deepEqual(await channelAccess(outsider, topic), none);
  assert.deepEqual(await channelAccess(null, topic), none, 'no session');
  // Other topics never match: another project's, a malformed one, someone else's channel.
  const other = (await call(outsider, 'cowork_create_project', 'Not yours')).id;
  assert.deepEqual(await channelAccess(member, `cowork:${other}`), none);
  assert.deepEqual(await channelAccess(member, `cowork:${pid}x`), none);
  assert.deepEqual(await channelAccess(member, 'cowork:not-a-uuid'), none);
  assert.deepEqual(await channelAccess(member, `other:${pid}`), none);
  // Removed, or the project archived: no longer.
  await call(owner, 'cowork_remove_member', pid, member.id);
  assert.deepEqual(await channelAccess(member, topic), none);
  await call(owner, 'cowork_set_archived', pid, true);
  assert.deepEqual(await channelAccess(owner, topic), none);
  // The helper isn't callable without a session.
  await fails(as(null, 'select cowork_realtime.is_member($1)', [topic]), '42501');
});
