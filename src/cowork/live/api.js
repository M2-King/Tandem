// Cowork live mode: Supabase (Auth for username + password accounts; the
// cowork_* database functions for everything else).
//
// Configured at build time (.env.local, see .env.example):
//   VITE_COWORK_MODE=live
//   VITE_TANDEM_SUPABASE_URL=https://<project>.supabase.co
//   VITE_TANDEM_SUPABASE_KEY=<publishable key>
//
// Optional: VITE_TANDEM_ACCOUNT_DOMAIN (see below).
//
// The session lives in memory only for this milestone: reloading or
// restarting the app asks to sign in again.

import { createClient } from '@supabase/supabase-js';

const env = import.meta.env;
export const COWORK_LIVE = env.VITE_COWORK_MODE === 'live';
const URL_ = (env.VITE_TANDEM_SUPABASE_URL || '').trim().replace(/\/+$/, '');
const KEY = (env.VITE_TANDEM_SUPABASE_KEY || '').trim();

// Only a publishable (or legacy anon) key may ship in the app.
function keyProblem(key) {
  if (!key) return 'VITE_TANDEM_SUPABASE_KEY is not set.';
  if (/^sb_secret_/.test(key)) return 'VITE_TANDEM_SUPABASE_KEY is a secret key. Use the project’s publishable key.';
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (claims.role === 'service_role') return 'VITE_TANDEM_SUPABASE_KEY is the service-role key. Use the publishable (anon) key.';
    } catch {
      // not a JWT: a publishable key
    }
  }
  return null;
}

const DOMAIN_SETTING = (env.VITE_TANDEM_ACCOUNT_DOMAIN || '').trim().toLowerCase();

export const LIVE_PROBLEM = !COWORK_LIVE
  ? null
  : !/^https?:\/\/\S+$/.test(URL_)
    ? 'VITE_TANDEM_SUPABASE_URL is not set to the staging project’s URL.'
    : DOMAIN_SETTING === 'tandem.org'
      ? 'VITE_TANDEM_ACCOUNT_DOMAIN can’t be tandem.org (its mail isn’t yours).'
      : keyProblem(KEY);

let client = null;
function supabase() {
  if (LIVE_PROBLEM) throw new CoworkError(`Cowork isn’t configured: ${LIVE_PROBLEM}`, 'config');
  if (!client) {
    client = createClient(URL_, KEY, {
      auth: {
        persistSession: false, // in memory for this milestone
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export class CoworkError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Network failures read as such; database messages are written for people.
function toError(error, fallback) {
  if (!error) return new CoworkError(fallback);
  const offline = /fetch|network|Failed to|Load failed/i.test(error.message || '') && !error.code;
  if (offline) return new CoworkError('Can’t reach Tandem Cowork. Check the connection and try again.', 'offline');
  if (error.status === 429 || /rate limit|too many/i.test(error.message || '')) {
    return new CoworkError('Too many tries. Wait a minute, then try again.', 'rate', 429);
  }
  return new CoworkError(error.message || fallback, error.code, error.status);
}

async function rpc(fn, args = {}) {
  let result;
  try {
    result = await supabase().rpc(fn, args);
  } catch (e) {
    throw toError(e, 'Something went wrong.');
  }
  if (result.error) throw toError(result.error, 'Something went wrong.');
  return result.data;
}

// ------------------------------------------------------------------ accounts
//
// A username and password. Supabase Auth needs an email, so each account is
// stored as <username>@<ACCOUNT_DOMAIN>, a domain that never receives mail
// (".invalid" is reserved for exactly that). People never see it: the app
// shows the Tandem address username@tandem.org. Using a real domain here
// would let whoever reads that domain's mail sign in as anyone.

const ACCOUNT_DOMAIN = DOMAIN_SETTING || 'accounts.tandem.invalid';
const accountEmail = (username) => `${username}@${ACCOUNT_DOMAIN}`;

const CONFIRM_OFF =
  'Tandem Cowork accounts can’t be confirmed by email. Ask the admin to turn off “Confirm email” in the Supabase project (Authentication → Sign In / Providers → Email).';

export async function signUp(username, password) {
  const { data, error } = await supabase().auth.signUp({ email: accountEmail(username), password, options: { data: { username } } });
  if (error) {
    const m = error.message || '';
    if (error.code === 'user_already_exists' || /already registered|already exists/i.test(m)) {
      throw new CoworkError(`The username ${username} is taken. Choose another.`, 'taken');
    }
    if (error.code === 'weak_password' || /password/i.test(m)) throw new CoworkError(m || 'Choose a stronger password.', 'password');
    if (error.code === 'signup_disabled' || /signups not allowed/i.test(m)) throw new CoworkError('Creating accounts is turned off for Tandem Cowork right now.', 'closed');
    if (/database error saving new user/i.test(m)) throw new CoworkError('That username can’t be used. Use 3 to 24 letters, numbers or _, starting with a letter.', 'username');
    if (error.code === 'email_address_invalid' || /email.*invalid|invalid.*email/i.test(m)) {
      throw new CoworkError('Tandem Cowork can’t create accounts with this setup: the sign-in service refused the account address. Ask the admin to check VITE_TANDEM_ACCOUNT_DOMAIN.', 'config');
    }
    throw toError(error, 'Couldn’t create the account.');
  }
  if (!data.session) throw new CoworkError(CONFIRM_OFF, 'confirm');
  return { id: data.user.id, username };
}

export async function signInWithPassword(username, password) {
  const { data, error } = await supabase().auth.signInWithPassword({ email: accountEmail(username), password });
  if (error) {
    if (error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message || '')) {
      throw new CoworkError('Wrong username or password.', 'credentials');
    }
    if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message || '')) throw new CoworkError(CONFIRM_OFF, 'confirm');
    throw toError(error, 'Couldn’t sign in.');
  }
  return { id: data.user.id, username: data.user.user_metadata?.username || username };
}

export async function signOut() {
  try {
    await supabase().auth.signOut();
  } catch {
    // signed out locally either way
  }
}

// ------------------------------------------------------------------ data

export const overview = () => rpc('cowork_overview');
export const openProject = (id) => rpc('cowork_project', { p_project: id });
export const createProject = (name) => rpc('cowork_create_project', { p_name: name });
export const renameProject = (id, name) => rpc('cowork_rename_project', { p_project: id, p_name: name });
export const setArchived = (id, archived) => rpc('cowork_set_archived', { p_project: id, p_archived: archived });
export const invite = (id, username, role) => rpc('cowork_invite', { p_project: id, p_username: username, p_role: role });
export const searchAccounts = (query) => rpc('cowork_search_accounts', { p_query: query });
export const cancelInvitation = (invitationId) => rpc('cowork_cancel_invitation', { p_invitation: invitationId });
export const acceptInvitation = (invitationId) => rpc('cowork_accept_invitation', { p_invitation: invitationId });
export const declineInvitation = (invitationId) => rpc('cowork_decline_invitation', { p_invitation: invitationId });
export const setRole = (id, userId, role) => rpc('cowork_set_role', { p_project: id, p_user: userId, p_role: role });
export const removeMember = (id, userId) => rpc('cowork_remove_member', { p_project: id, p_user: userId });
export const createFile = (id, path, content) => rpc('cowork_create_file', { p_project: id, p_path: path, p_content: content });
export const saveFile = (id, path, content, revision) =>
  rpc('cowork_save_file', { p_project: id, p_path: path, p_content: content, p_revision: revision });
export const renameFile = (id, from, to) => rpc('cowork_rename_file', { p_project: id, p_from: from, p_to: to });
export const removeFile = (id, path) => rpc('cowork_remove_file', { p_project: id, p_path: path });
// Live typing (003_cowork_live_text.sql): a file saved with its Yjs document,
// and the saved documents of a project, by path ({ revision, doc }).
export const saveFileDoc = (id, path, content, revision, doc) =>
  rpc('cowork_save_file_doc', { p_project: id, p_path: path, p_content: content, p_revision: revision, p_doc: doc });
export const fileDocs = async (id) => Object.fromEntries((await rpc('cowork_file_docs', { p_project: id })).map((d) => [d.path, d]));

// ------------------------------------------------------------------ realtime
//
// One private Realtime channel per project, cowork:<project id>: presence
// (who is here, which file, where the cursor is) and broadcast (cursor
// moves). Realtime Authorization (002_cowork_realtime.sql) lets only the
// project's members join. Nothing sent here is stored.
//
// handlers: onPresence(state) with { userId: [meta, …] }, onCursor(payload),
// onMessage(event, payload) for live typing (doc, doc-sync, doc-reply),
// onStatus(status, error) with SUBSCRIBED | CHANNEL_ERROR | TIMED_OUT | CLOSED.
//
// The client keeps one channel per topic and hands back an existing one, so a
// channel left before (by us, or closed by the server) is removed first and a
// rejoin always gets a fresh channel.
export function projectChannel(projectId, userId, { onPresence, onCursor, onMessage, onStatus }) {
  const sb = supabase();
  const topic = `cowork:${projectId}`;
  let channel = null;
  let closed = false;
  (async () => {
    for (const old of sb.getChannels().filter((c) => c.topic === `realtime:${topic}`)) {
      try {
        await sb.removeChannel(old);
      } catch {
        // gone either way
      }
    }
    try {
      await sb.realtime.setAuth(); // the signed-in session's token: private channels need it
    } catch {
      // subscribe reports the failure
    }
    if (closed) return;
    channel = sb.channel(topic, {
      config: { private: true, presence: { key: userId }, broadcast: { self: false, ack: false } },
    });
    channel.on('presence', { event: 'sync' }, () => !closed && onPresence(channel.presenceState()));
    channel.on('broadcast', { event: 'cursor' }, ({ payload }) => !closed && onCursor(payload));
    for (const event of ['doc', 'doc-sync', 'doc-reply', 'saved']) {
      channel.on('broadcast', { event }, ({ payload }) => !closed && onMessage?.(event, payload));
    }
    channel.subscribe((status, error) => !closed && onStatus?.(status, error));
  })();
  return {
    track: (meta) => (closed || !channel ? Promise.resolve() : channel.track(meta)),
    cursor: (payload) => (closed || !channel ? Promise.resolve() : channel.send({ type: 'broadcast', event: 'cursor', payload })),
    send: (event, payload) => (closed || !channel ? Promise.resolve() : channel.send({ type: 'broadcast', event, payload })),
    close: () => {
      if (closed) return;
      closed = true;
      if (channel) sb.removeChannel(channel).catch(() => {});
    },
  };
}
