// Tandem Cowork: the shared AI (Supabase Edge Function "cowork-ai").
//
// A project owner shares their AI with the project (004_cowork_shared_ai.sql).
// When a member's own device has no AI connected, their assistant sends its
// request here instead; this function checks who they are and that they may
// use it, adds the owner's key on the server and asks the provider. The key
// never leaves the server, and members can't read it.
//
//   POST /functions/v1/cowork-ai
//   Authorization: Bearer <the member's access token>
//   { project_id, system, messages: [{ role, content }], max_tokens? }
//   → 200 { text, stop_reason, model, provider, shared_by, used_today, daily_limit, unlimited }
//   → 4xx/5xx { error }   (a sentence to show)
//
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function → Via
// Editor, name it cowork-ai, paste this file, and turn OFF "Verify JWT"
// (this function checks the sign-in itself, which works with the new API
// keys too). It needs no secrets of its own: SUPABASE_URL and the service
// role key are provided to every Edge Function.
//
// Plain JavaScript (no types), so the local stand-in can run the same file
// in Node (supabase/tests/local-supabase.mjs).

const MAX_TOKENS = 16000;
const MAX_MESSAGES = 40;
const MAX_CHARS = 600000; // all messages and the system prompt together
const TIMEOUT_MS = 280000;
// Models that take Anthropic's server-side refusal fallback.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const env = (name) => globalThis.Deno?.env.get(name) || '';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const fail = (status, error) => reply(status, { error });

// The service role key: the legacy one, or the first new secret key.
function serviceKey() {
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    return keys.default || Object.values(keys)[0] || '';
  } catch {
    return '';
  }
}
const serviceHeaders = (key) =>
  /^sb_secret_/.test(key) ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };

async function signedInUser(base, token, key) {
  const r = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY') || key, authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id || null;
}

async function rpc(base, key, fn, args) {
  const r = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...serviceHeaders(key), 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error(data?.message || `The database answered with HTTP ${r.status}.`);
    e.status = r.status;
    throw e;
  }
  return data;
}

function checkRequest(body) {
  if (!body || typeof body !== 'object') return 'Send JSON.';
  if (typeof body.project_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.project_id)) return 'Which project?';
  if (typeof body.system !== 'string') return 'The request has no instructions.';
  const m = body.messages;
  if (!Array.isArray(m) || !m.length || m.length > MAX_MESSAGES) return 'The request has no conversation.';
  let chars = body.system.length;
  for (const x of m) {
    if (!x || (x.role !== 'user' && x.role !== 'assistant') || typeof x.content !== 'string') return 'The conversation isn’t valid.';
    chars += x.content.length;
  }
  if (chars > MAX_CHARS) return 'The request is too long for the shared AI. Ask about fewer or smaller files.';
  if (m[m.length - 1].role !== 'user') return 'The conversation must end with a question.';
  return null;
}

// The provider's own error, made short.
async function providerError(r, label) {
  const data = await r.json().catch(() => null);
  const detail = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || '';
  if (r.status === 401 || r.status === 403) return `${label} refused the shared key (HTTP ${r.status}). The project owner should check it in Share.`;
  if (r.status === 404) return `${label} doesn’t know this model. The project owner can change it in Share.`;
  if (r.status === 429) return `${label} is rate limiting the shared key (429). Try again in a moment.`;
  return `${label} answered with HTTP ${r.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}.`;
}

async function ask(share, body, signal) {
  const max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
  if (share.provider === 'anthropic') {
    const headers = { 'content-type': 'application/json', 'x-api-key': share.api_key, 'anthropic-version': '2023-06-01' };
    const params = { model: share.model, max_tokens, system: body.system, messages: body.messages };
    if (FALLBACK_MODELS.has(share.model) && share.base_url === 'https://api.anthropic.com') {
      // If a safety classifier declines, Anthropic retries on a fallback model in the same call.
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      params.fallbacks = 'default';
    }
    const r = await fetch(`${share.base_url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(params), signal });
    if (!r.ok) throw new Error(await providerError(r, 'Anthropic'));
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, stop_reason: data.stop_reason || null, model: data.model || share.model };
  }
  const r = await fetch(`${share.base_url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${share.api_key}` },
    body: JSON.stringify({ model: share.model, max_tokens, messages: [{ role: 'system', content: body.system }, ...body.messages] }),
    signal,
  });
  if (!r.ok) throw new Error(await providerError(r, new URL(share.base_url).host));
  const data = await r.json();
  const choice = data?.choices?.[0];
  return { text: choice?.message?.content || '', stop_reason: choice?.finish_reason === 'length' ? 'max_tokens' : choice?.finish_reason || null, model: data.model || share.model };
}

export async function handle(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'Use POST.');
  const base = env('SUPABASE_URL').replace(/\/+$/, '');
  const key = serviceKey();
  if (!base || !key) return fail(500, 'The shared AI isn’t set up on the server.');

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const user = token ? await signedInUser(base, token, key).catch(() => null) : null;
  if (!user) return fail(401, 'Sign in again to use the shared AI.');

  const body = await req.json().catch(() => null);
  const problem = checkRequest(body);
  if (problem) return fail(400, problem);

  let share;
  try {
    share = await rpc(base, key, 'cowork_ai_use', { p_project: body.project_id, p_user: user });
  } catch (e) {
    return fail([403, 404, 409, 429].includes(e.status) ? e.status : 502, e.message);
  }
  if (!/^https:\/\//.test(share.base_url) && env('COWORK_AI_ALLOW_HTTP') !== '1') {
    return fail(400, 'The shared AI’s address must use https.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const answer = await ask(share, body, controller.signal);
    return reply(200, {
      ...answer,
      provider: share.provider,
      shared_by: share.shared_by,
      used_today: share.used_today,
      daily_limit: share.daily_limit,
      unlimited: share.unlimited,
    });
  } catch (e) {
    // A failed request doesn't count against the person's day.
    await rpc(base, key, 'cowork_ai_refund', { p_project: body.project_id, p_user: user }).catch(() => {});
    const message = e?.name === 'AbortError' ? 'The shared AI took too long to answer. Try a shorter question.' : e?.message || 'The shared AI couldn’t answer.';
    return fail(502, /^(Anthropic|[\w.-]+\.\w+) /.test(message) || /shared/.test(message) ? message : `Couldn’t reach the AI provider (${message}).`);
  } finally {
    clearTimeout(timer);
  }
}

globalThis.Deno?.serve?.(handle);
