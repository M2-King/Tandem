// Cowork live mode: Supabase (Auth for sign-in codes; the cowork_*
// database functions for everything else).
//
// Configured at build time (.env.local, see .env.example):
//   VITE_COWORK_MODE=live
//   VITE_TANDEM_SUPABASE_URL=https://<project>.supabase.co
//   VITE_TANDEM_SUPABASE_KEY=<publishable key>
//
// The session lives in memory only for this milestone: reloading or
// restarting the app asks for a new sign-in code.

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

export const LIVE_PROBLEM = !COWORK_LIVE
  ? null
  : !/^https?:\/\/\S+$/.test(URL_)
    ? 'VITE_TANDEM_SUPABASE_URL is not set to the staging project’s URL.'
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

// ------------------------------------------------------------------ sign in

export async function sendCode(email) {
  const { error } = await supabase().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw toError(error, 'Couldn’t send a code.');
}

export async function verifyCode(email, token) {
  const { data, error } = await supabase().auth.verifyOtp({ email, token, type: 'email' });
  if (error) {
    if (/expired|invalid|otp/i.test(error.message || '')) throw new CoworkError('That code doesn’t match or has expired. Check the latest email, or send a new code.', 'otp');
    throw toError(error, 'Couldn’t sign in.');
  }
  return data.user;
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
export const invite = (id, email, role) => rpc('cowork_invite', { p_project: id, p_email: email, p_role: role });
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
