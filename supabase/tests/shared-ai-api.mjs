// Tandem Cowork: the shared AI, at the API (004_cowork_shared_ai.sql and the
// cowork-ai Edge Function), against the local stand-in or staging.
//
//   node supabase/tests/shared-ai-api.mjs <supabase url> <publishable key>
//
// A fake AI provider runs on this computer, so the stand-in is needed for the
// requests that reach it (the function only calls http addresses when
// COWORK_AI_ALLOW_HTTP=1, as the stand-in sets).
//
// Checks: only an owner can share; the key never comes back to anyone (not
// to members, not to the owner, not through the table, not through the
// service-role functions); a member's request reaches the provider with the
// owner's key and counts against their day; the limit holds and a failed
// request doesn't count; the owner has no limit; people outside the project
// and signed-out requests are refused; OpenAI-compatible works too; after
// sharing stops, members are told nothing is shared.

import http from 'node:http';
import crypto from 'node:crypto';

const [BASE, KEY] = process.argv.slice(2);
const tag = crypto.randomBytes(3).toString('hex');
const PASS = `pw-${crypto.randomBytes(9).toString('base64url')}`;
const SECRET_KEY = `sk-ant-test-${crypto.randomBytes(12).toString('hex')}`;
let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? 'ok   ' : 'FAILED: ') + msg);
  if (!ok) failures++;
};

// The fake provider: Anthropic's /v1/messages and OpenAI's /chat/completions.
const seen = [];
const provider = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data || '{}');
    seen.push({ path: req.url, key: req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, ''), body });
    const last = body.messages?.at(-1)?.content || '';
    res.setHeader('content-type', 'application/json');
    if (/please fail/.test(last)) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: { message: 'overloaded' } }));
    }
    if (req.url === '/v1/messages') {
      return res.end(JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: `anthropic says: ${last}` }] }));
    }
    res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `openai says: ${last}` } }] }));
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${provider.address().port}`;

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
async function ask(who, project, question, extra = {}) {
  const r = await fetch(`${BASE}/functions/v1/cowork-ai`, {
    method: 'POST',
    headers: headers(who?.token),
    body: JSON.stringify({ project_id: project, system: 'You are a test.', messages: [{ role: 'user', content: question }], ...extra }),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const hasKey = (x) => JSON.stringify(x ?? null).includes(SECRET_KEY);

const A = await signUp(`aiown_${tag}`);
const B = await signUp(`aimem_${tag}`);
const C = await signUp(`aiout_${tag}`);
const project = (await rpc(A, 'cowork_create_project', { p_name: `AI ${tag}` })).data.id;
await rpc(A, 'cowork_invite', { p_project: project, p_username: B.username, p_role: 'member' });
const invitation = (await rpc(B, 'cowork_overview')).data.invitations.find((i) => i.project_id === project);
await rpc(B, 'cowork_accept_invitation', { p_invitation: invitation.id });
check(true, `owner ${A.username}, member ${B.username}, outsider ${C.username}, project ${project.slice(0, 8)}…`);

// Nothing shared yet.
check((await rpc(B, 'cowork_ai_share', { p_project: project })).data === null, 'nothing is shared at first');
check((await ask(B, project, 'hi')).status === 404, 'asking before anything is shared: 404 (nothing shared)');

// Only owners share; the key is checked.
const share = (who, extra = {}) =>
  rpc(who, 'cowork_set_ai_share', { p_project: project, p_provider: 'anthropic', p_model: 'claude-sonnet-5-5', p_base_url: FAKE, p_api_key: SECRET_KEY, p_daily_limit: 2, ...extra });
check((await share(B)).status === 403, 'a member can’t share an AI (403)');
check((await share(C)).status === 403, 'someone outside the project can’t either (403)');
check((await share(A, { p_api_key: '' })).status === 400, 'sharing needs a key the first time (400)');
check((await share(A, { p_base_url: 'http://example.com' })).status === 400, 'a plain-http address elsewhere is refused (400)');
const shared = await share(A);
check(shared.status === 200 && shared.data.model === 'claude-sonnet-5-5' && shared.data.shared_by_me === true, 'the owner shares Claude with the project');
check(!hasKey(shared.data) && shared.data.key_hint === SECRET_KEY.slice(-4), '…and gets back only the key’s last 4 characters');

// What members see: no key, no address.
const seenByB = (await rpc(B, 'cowork_ai_share', { p_project: project })).data;
check(seenByB && seenByB.shared_by === A.username && seenByB.daily_limit === 2 && seenByB.used_today === 0, `the member sees: shared by ${A.username}, 2 a day, 0 used`);
check(!hasKey(seenByB) && seenByB.key_hint === null && seenByB.base_url === null, '…and no key, key hint or address');
check((await rpc(C, 'cowork_ai_share', { p_project: project })).status === 403, 'outsiders can’t see what is shared (403)');

// The key can't be read any other way.
for (const [who, name] of [[B, 'member'], [A, 'owner']]) {
  const t = await fetch(`${BASE}/rest/v1/cowork_ai_shares?select=*`, { headers: headers(who.token) });
  const body = await t.text();
  check(!body.includes(SECRET_KEY), `the ${name} can’t read the key from the table (HTTP ${t.status})`);
  const u = await rpc(who, 'cowork_ai_use', { p_project: project, p_user: who.id });
  check(u.status >= 400 && !hasKey(u.data), `the ${name} can’t call cowork_ai_use, the function that returns the key (HTTP ${u.status})`);
}

// A member asks: the provider gets the owner's key; the answer comes back.
seen.length = 0;
const first = await ask(B, project, 'What is 2 + 2?');
check(first.status === 200 && first.data.text === 'anthropic says: What is 2 + 2?', 'the member’s question is answered through the shared AI');
check(seen.length === 1 && seen[0].key === SECRET_KEY && seen[0].path === '/v1/messages', '…the provider got the owner’s key (added on the server)');
check(seen[0].body.model === 'claude-sonnet-5-5' && seen[0].body.max_tokens <= 16000, '…with the shared model and a capped answer length');
check(!hasKey(first.data) && first.data.used_today === 1 && first.data.daily_limit === 2 && first.data.shared_by === A.username, '…the answer says 1 of 2 used today, and has no key');

// A failed request doesn't count.
const failed = await ask(B, project, 'please fail');
check(failed.status === 502 && /Anthropic answered with HTTP 500/.test(failed.data.error), `a provider failure is reported: “${failed.data?.error}”`);
check((await rpc(B, 'cowork_ai_share', { p_project: project })).data.used_today === 1, '…and didn’t count (still 1 used)');

// The limit.
check((await ask(B, project, 'second')).status === 200, 'second request of 2: answered');
const over = await ask(B, project, 'third');
check(over.status === 429 && /today.s 2 requests/.test(over.data.error), `third request: 429 “${over.data?.error}”`);

// The owner has no limit.
let ownerOk = true;
for (let i = 0; i < 3; i++) ownerOk = ownerOk && (await ask(A, project, `owner ${i}`)).status === 200;
const ownerSeen = (await rpc(A, 'cowork_ai_share', { p_project: project })).data;
check(ownerOk && ownerSeen.used_today === 0, 'the owner who shared it has no limit (3 requests, none counted)');

// Outsiders and signed-out requests.
check((await ask(C, project, 'hi')).status === 403, 'someone outside the project is refused (403)');
check((await ask(null, project, 'hi')).status === 401, 'a request without sign-in is refused (401)');
check((await ask({ token: 'not-a-token' }, project, 'hi')).status === 401, 'a made-up token is refused (401)');
check((await ask(B, project, 'hi', { messages: [] })).status === 400, 'a malformed request is refused (400)');

// Changing the model keeps the key; OpenAI-compatible works.
const kept = await share(A, { p_model: 'claude-opus-5-5', p_api_key: '', p_daily_limit: 5 });
check(kept.status === 200 && kept.data.model === 'claude-opus-5-5' && kept.data.key_hint === SECRET_KEY.slice(-4), 'changing the model without re-entering the key keeps the key');
const oa = await share(A, { p_provider: 'openai', p_model: 'gpt-test', p_base_url: `${FAKE}/v1`, p_api_key: 'sk-openai-test-123456', p_daily_limit: 5 });
seen.length = 0;
const oaAnswer = await ask(B, project, 'from openai?');
check(oa.status === 200 && oaAnswer.status === 200 && oaAnswer.data.text === 'openai says: from openai?', 'an OpenAI-compatible provider works too');
check(seen[0]?.path === '/v1/chat/completions' && seen[0]?.key === 'sk-openai-test-123456' && seen[0]?.body.messages[0].role === 'system', '…with its key as a Bearer token and the instructions as the system message');

// Stop sharing.
check((await rpc(B, 'cowork_stop_ai_share', { p_project: project })).status === 403, 'a member can’t stop the sharing (403)');
await rpc(A, 'cowork_stop_ai_share', { p_project: project });
check((await rpc(B, 'cowork_ai_share', { p_project: project })).data === null, 'after the owner stops: nothing shared');
const after = await ask(B, project, 'hi');
check(after.status === 404 && /No AI is shared/.test(after.data.error), '…and asking says no AI is shared (404)');

provider.close();
console.log(failures ? `${failures} FAILED` : 'All shared-AI API checks passed.');
process.exit(failures ? 1 : 0);
