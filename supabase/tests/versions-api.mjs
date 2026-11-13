// Tandem Cowork: backups and restore, larger files and lighter reloads, at
// the API (005_cowork_versions.sql), against the local stand-in or staging.
//
//   node supabase/tests/versions-api.mjs <supabase url> <publishable key>
//
// Checks: members back up (named or not); a backup stores only texts it
// doesn't have yet; automatic backups are skipped when nothing changed or the
// last is recent; the list and a file's text in a backup; restoring one file
// (members) and the whole project (owners only): files back, files added
// since removed, the live copy of a restored file dropped; the current files
// are backed up first, so a restore can be undone; naming and deleting;
// outsiders refused; files up to 10 MB; the reload's file list without texts,
// and the texts of chosen files.

import crypto from 'node:crypto';

const [BASE, KEY] = process.argv.slice(2);
const tag = crypto.randomBytes(3).toString('hex');
const PASS = `pw-${crypto.randomBytes(9).toString('base64url')}`;
let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? 'ok   ' : 'FAILED: ') + msg);
  if (!ok) failures++;
};

const headers = (token) => ({ apikey: KEY, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) });
async function signUp(username) {
  const r = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email: `${username}@accounts.tandem.invalid`, password: PASS, data: { username } }),
  });
  const s = await r.json();
  if (!s.access_token) throw new Error(`sign-up failed: ${JSON.stringify(s)}`);
  return { token: s.access_token, id: s.user.id, username };
}
async function rpc(who, fn, args = {}) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers(who?.token), body: JSON.stringify(args) });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}
const files = async (who, project) => Object.fromEntries((await rpc(who, 'cowork_project', { p_project: project })).data.files.map((f) => [f.path, f]));
const save = async (who, project, path, content) => {
  const f = (await files(who, project))[path];
  return rpc(who, 'cowork_save_file', { p_project: project, p_path: path, p_content: content, p_revision: f.revision });
};

const A = await signUp(`vown_${tag}`);
const B = await signUp(`vmem_${tag}`);
const C = await signUp(`vout_${tag}`);
const project = (await rpc(A, 'cowork_create_project', { p_name: `Versions ${tag}` })).data.id;
await rpc(A, 'cowork_create_file', { p_project: project, p_path: 'main.py', p_content: 'print("v1")\n' });
await rpc(A, 'cowork_create_file', { p_project: project, p_path: 'data.csv', p_content: 'a,b\n1,2\n' });
await rpc(A, 'cowork_invite', { p_project: project, p_username: B.username, p_role: 'member' });
const inv = (await rpc(B, 'cowork_overview')).data.invitations.find((i) => i.project_id === project);
await rpc(B, 'cowork_accept_invitation', { p_invitation: inv.id });
check(true, `owner ${A.username}, member ${B.username}, outsider ${C.username}; main.py and data.csv`);

// Back up.
const first = await rpc(B, 'cowork_create_version', { p_project: project, p_name: 'first draft' });
check(first.status === 200 && first.data.name === 'first draft' && first.data.file_count === 2, 'a member backs up the project with a name (2 files)');
const storage1 = (await rpc(A, 'cowork_versions', { p_project: project })).data.storage;
check(storage1 === 'print("v1")\n'.length + 'a,b\n1,2\n'.length, `the backup stores the two texts (${storage1} bytes)`);

// Change things: edit main.py, add notes.md, remove data.csv.
await save(A, project, 'main.py', 'print("v2")\n');
await rpc(A, 'cowork_create_file', { p_project: project, p_path: 'notes.md', p_content: '# notes\n' });
await rpc(A, 'cowork_remove_file', { p_project: project, p_path: 'data.csv' });

const auto = await rpc(B, 'cowork_auto_version', { p_project: project });
check(auto.status === 200 && auto.data === null, 'an automatic backup right after another backup is skipped');
const second = await rpc(A, 'cowork_create_version', { p_project: project, p_name: '' });
check(second.status === 200 && second.data.name === null && second.data.file_count === 2, 'a backup without a name');
const storage2 = (await rpc(A, 'cowork_versions', { p_project: project })).data.storage;
check(storage2 - storage1 === 'print("v2")\n'.length + '# notes\n'.length, `the second backup stored only the new texts (+${storage2 - storage1} bytes)`);

// The list, and a file in a backup.
const list = (await rpc(B, 'cowork_versions', { p_project: project })).data;
check(list.versions.length === 2 && list.versions[0].id === second.data.id && list.versions[1].name === 'first draft', 'the list: newest first');
check(list.versions[1].created_by === B.username && list.versions[1].files.map((f) => f.path).join() === 'data.csv,main.py', '…with who made it and its files');
const old = await rpc(B, 'cowork_version_file', { p_project: project, p_version: first.data.id, p_path: 'main.py' });
check(old.data?.content === 'print("v1")\n', 'a file’s text in a backup');
check((await rpc(B, 'cowork_version_file', { p_project: project, p_version: first.data.id, p_path: 'notes.md' })).status === 404, '…a file that wasn’t there then: 404');

// Restore one file (a member).
await rpc(A, 'cowork_save_file_doc', {
  p_project: project, p_path: 'main.py', p_content: 'print("v3")\n', p_revision: (await files(A, project))['main.py'].revision,
  p_doc: Buffer.from('a live copy').toString('base64'),
});
check((await rpc(A, 'cowork_file_docs', { p_project: project })).data.some((d) => d.path === 'main.py'), 'main.py has a live copy');
const revBefore = (await files(B, project))['main.py'].revision;
const one = await rpc(B, 'cowork_restore_version', { p_project: project, p_version: first.data.id, p_path: 'main.py' });
check(one.status === 200 && JSON.stringify(one.data.restored) === '["main.py"]' && one.data.removed.length === 0, 'a member restores main.py from “first draft”');
const afterOne = await files(B, project);
check(afterOne['main.py'].content === 'print("v1")\n' && afterOne['main.py'].revision === revBefore + 1 && afterOne['main.py'].updated_by === B.username, '…main.py is back as it was, saved as a new revision by the member');
check(!(await rpc(A, 'cowork_file_docs', { p_project: project })).data.some((d) => d.path === 'main.py'), '…and its old live copy is dropped (everyone starts again from the restored text)');
check(!!one.data.backup, '…after backing up what was there (so it can be undone)');

// Restore the whole project: owners only.
check((await rpc(B, 'cowork_restore_version', { p_project: project, p_version: first.data.id })).status === 403, 'a member can’t restore the whole project (403)');
const all = await rpc(A, 'cowork_restore_version', { p_project: project, p_version: first.data.id });
const afterAll = await files(A, project);
check(all.status === 200 && JSON.stringify(Object.keys(afterAll).sort()) === '["data.csv","main.py"]', 'the owner restores the whole project: exactly the files of “first draft”');
check(afterAll['data.csv'].content === 'a,b\n1,2\n' && JSON.stringify(all.data.removed) === '["notes.md"]', '…data.csv is back, notes.md (added since) removed');

// Undo: the backup taken before the restore.
const undo = await rpc(A, 'cowork_restore_version', { p_project: project, p_version: all.data.backup });
const afterUndo = await files(A, project);
check(undo.status === 200 && JSON.stringify(Object.keys(afterUndo).sort()) === '["main.py","notes.md"]' && afterUndo['notes.md'].content === '# notes\n', 'restoring the backup taken before the restore undoes it');
const reasons = (await rpc(A, 'cowork_versions', { p_project: project })).data.versions.map((v) => v.reason);
check(reasons.filter((r) => r === 'before-restore').length >= 2, `the list shows the backups taken before restoring (${reasons.join(', ')})`);

// Name, delete.
const auto1 = (await rpc(A, 'cowork_versions', { p_project: project })).data.versions.find((v) => v.auto);
const named = await rpc(B, 'cowork_name_version', { p_project: project, p_version: auto1.id, p_name: 'keep this' });
const kept = (await rpc(A, 'cowork_versions', { p_project: project })).data.versions.find((v) => v.id === auto1.id);
check(named.status === 200 && kept.name === 'keep this' && kept.auto === false, 'naming an automatic backup keeps it');
check((await rpc(B, 'cowork_delete_version', { p_project: project, p_version: second.data.id })).status === 403, 'a member can’t delete someone else’s backup (403)');
check((await rpc(B, 'cowork_delete_version', { p_project: project, p_version: first.data.id })).status === 200, '…but can delete their own');
const del = await rpc(A, 'cowork_delete_version', { p_project: project, p_version: second.data.id });
check(del.status === 200 && !(await rpc(A, 'cowork_versions', { p_project: project })).data.versions.some((v) => v.id === second.data.id), 'the owner deletes a backup');

// Outsiders.
for (const [fn, args] of [
  ['cowork_versions', { p_project: project }],
  ['cowork_create_version', { p_project: project, p_name: 'x' }],
  ['cowork_version_file', { p_project: project, p_version: auto1.id, p_path: 'main.py' }],
  ['cowork_restore_version', { p_project: project, p_version: auto1.id, p_path: 'main.py' }],
]) {
  check((await rpc(C, fn, args)).status === 403, `someone outside the project: ${fn} refused (403)`);
}

// Larger files.
const big = 'x'.repeat(5 * 1024 * 1024);
check((await rpc(A, 'cowork_create_file', { p_project: project, p_path: 'big.txt', p_content: big })).status === 200, 'a 5 MB file is accepted');
const tooBig = await rpc(A, 'cowork_create_file', { p_project: project, p_path: 'huge.txt', p_content: 'y'.repeat(10 * 1024 * 1024 + 1) });
check(tooBig.status === 400 && /10 MB/.test(tooBig.data?.message || ''), `over 10 MB is refused: “${tooBig.data?.message}”`);

// Lighter reloads.
const state = (await rpc(B, 'cowork_project_state', { p_project: project })).data;
const bigEntry = state.files.find((f) => f.path === 'big.txt');
check(bigEntry && bigEntry.size === big.length && !('content' in bigEntry) && JSON.stringify(state).length < 5000, `the reload’s file list has no texts (${JSON.stringify(state).length} bytes for a project with a 5 MB file)`);
const some = (await rpc(B, 'cowork_file_contents', { p_project: project, p_paths: ['main.py'] })).data;
check(some.length === 1 && some[0].path === 'main.py' && typeof some[0].content === 'string' && some[0].revision >= 1, 'the texts of only the files asked for');
check((await rpc(C, 'cowork_project_state', { p_project: project })).status === 403, 'outsiders can’t list the files (403)');

console.log(failures ? `${failures} FAILED` : 'All versions API checks passed.');
process.exit(failures ? 1 : 0);
