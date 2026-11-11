// A local stand-in for the two Supabase services Cowork uses, for tests and
// development without a staging project:
//
//   /auth/v1/otp, /auth/v1/verify, /auth/v1/logout, /auth/v1/user
//       Email sign-in codes. No email is sent: the latest code for an
//       address is at /__test/code?email=... (this stand-in only).
//   /rest/v1/rpc/cowork_*
//       The migration's functions, run in Postgres as the signed-in user
//       (role authenticated, JWT claims set), as PostgREST does, so the
//       real access rules apply. Errors use PostgREST's codes and statuses.
//
// Usage (Postgres with tests/local_auth_stub.sql and the migration applied):
//   COWORK_TEST_DB=postgres://postgres@127.0.0.1:54329/cowork_e2e node supabase/tests/local-supabase.mjs
// then build the app with VITE_COWORK_MODE=live,
// VITE_TANDEM_SUPABASE_URL=http://127.0.0.1:54400 and any VITE_TANDEM_SUPABASE_KEY.

import http from 'node:http';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';

const PORT = Number(process.env.PORT || 54400);
const SECRET = 'local-stand-in-secret';
const pool = new pg.Pool({ connectionString: process.env.COWORK_TEST_DB || 'postgres://postgres@127.0.0.1:54329/cowork_e2e' });
const codes = new Map(); // email -> { code, expires }

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

async function session(email) {
  const { rows } = await pool.query(
    'insert into auth.users (id, email) values ($1, $2) on conflict (email) do update set email = excluded.email returning id',
    [randomUUID(), email]
  );
  const id = rows[0].id;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() };
  return {
    access_token: sign({ sub: id, email, role: 'authenticated', aud: 'authenticated', exp }),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    refresh_token: randomUUID(),
    user,
  };
}

async function rpc(fn, args, claims) {
  if (!/^cowork_[a-z_]+$/.test(fn)) return [404, { code: 'PGRST202', message: `Could not find the function public.${fn}` }];
  const names = Object.keys(args);
  if (names.some((n) => !/^p_[a-z_]+$/.test(n))) return [400, { code: 'PGRST100', message: 'Bad argument name' }];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${claims ? 'authenticated' : 'anon'}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims || { role: 'anon' })]);
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

http
  .createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204);
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    try {
      if (path === '/auth/v1/otp' && req.method === 'POST') {
        const { email } = await readBody(req);
        if (!email) return send(res, 400, { code: 400, msg: 'Email is required', error_code: 'validation_failed' });
        const code = String(randomInt(0, 1e6)).padStart(6, '0');
        codes.set(email.toLowerCase(), { code, expires: Date.now() + 10 * 60 * 1000 });
        return send(res, 200, {});
      }
      if (path === '/auth/v1/verify' && req.method === 'POST') {
        const { email, token } = await readBody(req);
        const entry = codes.get((email || '').toLowerCase());
        if (!entry || entry.code !== token || entry.expires < Date.now()) {
          return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        }
        codes.delete(email.toLowerCase());
        return send(res, 200, await session(email.toLowerCase()));
      }
      if (path === '/auth/v1/logout') return send(res, 204);
      const claims = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (path === '/auth/v1/user') {
        if (!claims) return send(res, 401, { code: 401, msg: 'invalid JWT' });
        return send(res, 200, { id: claims.sub, email: claims.email, aud: 'authenticated', role: 'authenticated' });
      }
      const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path);
      if (m && req.method === 'POST') {
        const [status, body] = await rpc(m[1], await readBody(req), claims);
        return send(res, status, body);
      }
      if (path === '/__test/code') return send(res, 200, { code: codes.get((url.searchParams.get('email') || '').toLowerCase())?.code || null });
      return send(res, 404, { message: 'Not found' });
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Local Supabase stand-in on http://127.0.0.1:${PORT}`));
