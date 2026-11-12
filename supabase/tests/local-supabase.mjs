// A local stand-in for the two Supabase services Cowork uses, for tests and
// development without a staging project:
//
//   /auth/v1/signup, /auth/v1/token?grant_type=password, /auth/v1/logout,
//   /auth/v1/user
//       Accounts with a password, "Confirm email" off: sign-up returns a
//       session at once. Users are rows in auth.users (so the migration's
//       username trigger runs); passwords are kept in memory (scrypt).
//   /rest/v1/rpc/cowork_*
//       The migration's functions, run in Postgres as the signed-in user
//       (role authenticated, JWT claims set), as PostgREST does, so the
//       real access rules apply. Errors use PostgREST's codes and statuses.
//   /realtime/v1/websocket
//       Realtime with private channels only (Phoenix protocol 2.0.0, as
//       realtime-js speaks it): presence and broadcast. A join is authorized
//       the way Supabase Realtime does it: the policies on realtime.messages
//       (002_cowork_realtime.sql) are run as the joining user with
//       realtime.topic() set to the channel; no read access, no join.
//   /functions/v1/cowork-ai
//       The shared-AI Edge Function (supabase/functions/cowork-ai/index.ts),
//       the same file, run here in Node. It calls the service-role-only
//       functions with SERVICE_KEY below, as the real service role key.
//
// Usage (Postgres with tests/local_auth_stub.sql and the migration applied):
//   COWORK_TEST_DB=postgres://postgres@127.0.0.1:54329/cowork_e2e node supabase/tests/local-supabase.mjs
// then build the app with VITE_COWORK_MODE=live,
// VITE_TANDEM_SUPABASE_URL=http://127.0.0.1:54400 and any VITE_TANDEM_SUPABASE_KEY.

import http from 'node:http';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 54400);
const SECRET = 'local-stand-in-secret';
export const SERVICE_KEY = 'local-stand-in-service-role';
const pool = new pg.Pool({ connectionString: process.env.COWORK_TEST_DB || 'postgres://postgres@127.0.0.1:54329/cowork_e2e' });
const passwords = new Map(); // email -> { salt, hash }
const hashOf = (password, salt) => scryptSync(password, salt, 32);
// GoTrue's error shape: { code: <http status>, error_code, msg }.
const authError = (res, status, error_code, msg) => send(res, status, { code: status, error_code, msg });

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function sign(claims) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
function verify(token) {
  const [head, body, sig] = (token || '').split('.');
  if (!sig || createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url') !== sig) return null;
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  return claims.exp * 1000 > Date.now() ? claims : null;
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version, content-profile, accept-profile, prefer',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });

// PostgREST: PTxyz sets HTTP status xyz; insufficient privilege is 401/403.
function pgError(e) {
  const status = /^PT\d{3}$/.test(e.code) ? Number(e.code.slice(2)) : e.code === '42501' ? 403 : 400;
  return [status, { code: e.code, message: e.message, details: null, hint: null }];
}

async function session(id, email, meta) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: meta || {}, created_at: new Date().toISOString() };
  return {
    access_token: sign({ sub: id, email, role: 'authenticated', aud: 'authenticated', exp }),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    refresh_token: randomUUID(),
    user,
  };
}

async function rpc(fn, args, claims, service = false) {
  if (!/^cowork_[a-z_]+$/.test(fn)) return [404, { code: 'PGRST202', message: `Could not find the function public.${fn}` }];
  const names = Object.keys(args);
  if (names.some((n) => !/^p_[a-z_]+$/.test(n))) return [400, { code: 'PGRST100', message: 'Bad argument name' }];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${service ? 'service_role' : claims ? 'authenticated' : 'anon'}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(service ? { role: 'service_role' } : claims || { role: 'anon' })]);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
    const { rows } = await client.query(sql, names.map((n) => args[n]));
    await client.query('commit');
    return [200, rows[0].r];
  } catch (e) {
    await client.query('rollback');
    return pgError(e);
  } finally {
    client.release();
  }
}

// The Edge Function, as Supabase runs it: a web Request in, a Response out.
let edgeHandle = null;
async function edgeFunction(req, res) {
  if (!edgeHandle) {
    const vars = { SUPABASE_URL: `http://127.0.0.1:${PORT}`, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_ANON_KEY: 'local', COWORK_AI_ALLOW_HTTP: '1' };
    globalThis.Deno = { env: { get: (name) => vars[name] } }; // no Deno.serve: the file only exports handle
    edgeHandle = (await import(new URL('../functions/cowork-ai/index.ts', import.meta.url))).handle;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await edgeHandle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    try {
      if (path === '/auth/v1/signup' && req.method === 'POST') {
        const { email: raw, password, data } = await readBody(req);
        const email = (raw || '').toLowerCase();
        if (!email || !password) return authError(res, 400, 'validation_failed', 'Signup requires a valid password');
        if (password.length < 8) return authError(res, 422, 'weak_password', 'Password should be at least 8 characters.');
        const exists = await pool.query('select 1 from auth.users where email = $1', [email]);
        if (exists.rows.length) return authError(res, 422, 'user_already_exists', 'User already registered');
        const id = randomUUID();
        try {
          await pool.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [id, email, JSON.stringify(data || {})]);
        } catch {
          return authError(res, 500, 'unexpected_failure', 'Database error saving new user');
        }
        const salt = randomBytes(16);
        passwords.set(email, { salt, hash: hashOf(password, salt) });
        return send(res, 200, await session(id, email, data));
      }
      if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password' && req.method === 'POST') {
        const { email: raw, password } = await readBody(req);
        const email = (raw || '').toLowerCase();
        const stored = passwords.get(email);
        const ok = stored && password && timingSafeEqual(stored.hash, hashOf(password, stored.salt));
        if (!ok) return authError(res, 400, 'invalid_credentials', 'Invalid login credentials');
        const { rows } = await pool.query('select id, raw_user_meta_data from auth.users where email = $1', [email]);
        return send(res, 200, await session(rows[0].id, email, rows[0].raw_user_meta_data));
      }
      if (path === '/auth/v1/logout') return send(res, 204);
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      const service = bearer === SERVICE_KEY || (!bearer && req.headers.apikey === SERVICE_KEY);
      const claims = service ? null : verify(bearer);
      if (path === '/functions/v1/cowork-ai') return edgeFunction(req, res);
      if (path === '/auth/v1/user') {
        if (!claims) return send(res, 401, { code: 401, msg: 'invalid JWT' });
        return send(res, 200, { id: claims.sub, email: claims.email, aud: 'authenticated', role: 'authenticated' });
      }
      const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path);
      if (m && req.method === 'POST') {
        const [status, body] = await rpc(m[1], await readBody(req), claims, service);
        return send(res, status, body);
      }
      return send(res, 404, { message: 'Not found' });
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
  })
server.listen(PORT, '127.0.0.1', () => console.log(`Local Supabase stand-in on http://127.0.0.1:${PORT}`));

// ------------------------------------------------------------------ Realtime

// What this caller may do on a private channel: { read: Set, write: Set } of
// 'broadcast' | 'presence'. As Supabase Realtime checks it: messages for the
// topic exist; as the caller (role, claims, realtime.topic), which can it
// select, and which may it insert? Rolled back: nothing is stored.
async function channelAccess(topic, claims) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("insert into realtime.messages (topic, extension, private) values ($1, 'broadcast', true), ($1, 'presence', true)", [topic]);
    await client.query(`set local role ${claims ? 'authenticated' : 'anon'}`);
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [JSON.stringify(claims || { role: 'anon' }), topic]);
    const { rows } = await client.query('select distinct extension from realtime.messages where topic = $1', [topic]);
    const read = new Set(rows.map((r) => r.extension));
    const write = new Set();
    for (const ext of ['broadcast', 'presence']) {
      await client.query('savepoint w');
      try {
        await client.query('insert into realtime.messages (topic, extension, private) values ($1, $2, true)', [topic, ext]);
        write.add(ext);
      } catch {
        // refused by the policy
      }
      await client.query('rollback to savepoint w');
    }
    return { read, write };
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

const topics = new Map(); // topic -> Set of members { socket, joinRef, key, meta, access, self }
const membersOf = (topic) => topics.get(topic) || new Set();
const sendFrame = (socket, frame) => socket.readyState === 1 && socket.send(JSON.stringify(frame));
const reply = (socket, joinRef, ref, topic, status, response = {}) => sendFrame(socket, [joinRef, ref, topic, 'phx_reply', { status, response }]);
const presenceOf = (m) => ({ metas: [{ ...m.meta, phx_ref: m.phxRef }] });

function presenceDiff(topic, joins, leaves) {
  for (const m of membersOf(topic)) sendFrame(m.socket, [m.joinRef, null, topic, 'presence_diff', { joins, leaves }]);
}
function leave(m) {
  const set = membersOf(m.topic);
  if (!set.delete(m)) return;
  if (!set.size) topics.delete(m.topic);
  if (m.meta) presenceDiff(m.topic, {}, { [m.key]: presenceOf(m) });
}
function broadcast(from, event, payload) {
  for (const m of membersOf(from.topic)) {
    if (m === from && !from.self) continue;
    sendFrame(m.socket, [m.joinRef, null, from.topic, 'broadcast', { type: 'broadcast', event, payload }]);
  }
}

// realtime-js sends broadcasts as a small binary frame (kind 3, userBroadcastPush).
function decodeBroadcastPush(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint8(0) !== 3) return null;
  const [joinLen, refLen, topicLen, eventLen, metaLen, encoding] = [1, 2, 3, 4, 5, 6].map((i) => view.getUint8(i));
  let offset = 7;
  const take = (n) => buf.subarray(offset, (offset += n)).toString('utf8');
  const joinRef = take(joinLen);
  const ref = take(refLen);
  const topic = take(topicLen);
  const event = take(eventLen);
  take(metaLen);
  const rest = buf.subarray(offset);
  return { joinRef, ref, topic, event, payload: encoding === 1 ? JSON.parse(rest.toString('utf8') || '{}') : null };
}

new WebSocketServer({ server, path: '/realtime/v1/websocket' }).on('connection', (socket) => {
  const joined = new Map(); // topic -> member
  socket.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        const push = decodeBroadcastPush(Buffer.from(data));
        const m = push && joined.get(push.topic);
        if (!m) return;
        if (!m.access.write.has('broadcast')) return reply(socket, push.joinRef, push.ref, push.topic, 'error', { reason: 'Unauthorized: You do not have permissions to write to this Channel topic' });
        broadcast(m, push.event, push.payload);
        return push.ref && reply(socket, push.joinRef, push.ref, push.topic, 'ok');
      }
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(data));
      if (topic === 'phoenix' && event === 'heartbeat') return reply(socket, null, ref, 'phoenix', 'ok');
      if (event === 'phx_join') {
        const topicName = topic.replace(/^realtime:/, '');
        const config = payload?.config || {};
        if (!config.private) return reply(socket, joinRef, ref, topic, 'error', { reason: 'PrivateOnly: This project only allows private channels' });
        const claims = verify(payload?.access_token);
        const access = await channelAccess(topicName, claims);
        if (!access.read.size) {
          return reply(socket, joinRef, ref, topic, 'error', { reason: `Unauthorized: You do not have permissions to read from this Channel topic: ${topicName}` });
        }
        const old = joined.get(topic);
        if (old) leave(old);
        const m = { socket, topic, joinRef, key: config.presence?.key || randomUUID(), meta: null, phxRef: randomUUID(), access, self: !!config.broadcast?.self };
        joined.set(topic, m);
        if (!topics.has(topic)) topics.set(topic, new Set());
        topics.get(topic).add(m);
        reply(socket, joinRef, ref, topic, 'ok', { postgres_changes: [] });
        const state = {};
        for (const other of membersOf(topic)) if (other.meta) state[other.key] = presenceOf(other);
        return sendFrame(socket, [joinRef, null, topic, 'presence_state', state]);
      }
      const m = joined.get(topic);
      if (!m) return reply(socket, joinRef, ref, topic, 'error', { reason: 'unmatched topic' });
      if (event === 'phx_leave') {
        joined.delete(topic);
        leave(m);
        return reply(socket, joinRef, ref, topic, 'ok');
      }
      if (event === 'access_token') return reply(socket, joinRef, ref, topic, 'ok');
      if (event === 'presence') {
        if (!m.access.write.has('presence')) return reply(socket, joinRef, ref, topic, 'error', { reason: 'Unauthorized: You do not have permissions to track presence on this Channel topic' });
        const before = m.meta ? { [m.key]: presenceOf(m) } : {};
        if (payload.event === 'track') {
          m.meta = payload.payload || {};
          m.phxRef = randomUUID();
          presenceDiff(topic, { [m.key]: presenceOf(m) }, before);
        } else if (payload.event === 'untrack' && m.meta) {
          m.meta = null;
          presenceDiff(topic, {}, before);
        }
        return reply(socket, joinRef, ref, topic, 'ok');
      }
      if (event === 'broadcast') {
        if (!m.access.write.has('broadcast')) return reply(socket, joinRef, ref, topic, 'error', { reason: 'Unauthorized' });
        broadcast(m, payload.event, payload.payload);
        return reply(socket, joinRef, ref, topic, 'ok');
      }
      return reply(socket, joinRef, ref, topic, 'ok');
    } catch (e) {
      console.error('realtime:', e.message);
    }
  });
  socket.on('close', () => {
    for (const m of joined.values()) leave(m);
    joined.clear();
  });
});
