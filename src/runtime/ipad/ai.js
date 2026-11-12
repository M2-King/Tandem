// The assistant on iPad: same behaviour as the desktop runtime (ai_chat.py),
// running in the page. Requests go through the app's local proxy
// (/api/ai/proxy/<provider>/...), which adds the API key from the iPad
// Keychain, so the key never reaches this page.

import Anthropic from '@anthropic-ai/sdk';

const PLACEHOLDER_KEY = 'tandem-proxy-key'; // replaced by the app with the real key
const MAX_FILE_CHARS = 120_000;
const MAX_OUTPUT_CHARS = 6_000;
const MAX_HISTORY = 12;
const MAX_TOKENS = 16_000;
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export const SYSTEM = `You are the coding assistant inside Tandem, a Python editor. The developer runs their code with Python on their iPad (Pyodide: CPython compiled to WebAssembly, with numpy, pandas, matplotlib and scikit-learn available); Tandem shows the output, charts, variables and tracebacks. Scripts can read input: the developer types it in Tandem's Output panel. There is no subprocess support and no real threads.

Be concise and specific, like a senior colleague. Name lines and variables.

When the developer asks for a change, or asks you to fix an error, propose ONE complete new version of ONE file in exactly this format:

<tandem-file path="relative/path.py">
...the complete new file content, every line...
</tandem-file>

Before the block, write one or two sentences saying what you changed and why. After the block, list the changes as short lines starting with "- ". Keep the developer's style and change only what is needed. Do not use a file block when you are only explaining or answering. Never claim you ran the code.`;

const FILE_BLOCK = /<tandem-file path="([^"\n]+)">\n?([\s\S]*?)\n?<\/tandem-file>/;

class AssistError extends Error {}

const insideProject = (path) => !!path && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..');

function contextMessage(request, projectFiles) {
  const parts = [`Project files:\n${projectFiles.slice(0, 300).map((p) => `- ${p}`).join('\n')}`];
  for (const [path, text] of Object.entries(request.files || {}).slice(0, 6)) {
    if (typeof text !== 'string' || !insideProject(path)) continue;
    const clipped = text.length <= MAX_FILE_CHARS ? text : `${text.slice(0, MAX_FILE_CHARS)}\n# … (file truncated)`;
    const numbered = clipped
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
      .join('\n');
    parts.push(`File ${path} (line numbers added for reference, not part of the file):\n${numbered}`);
  }
  if (request.active_path) parts.push(`The developer has ${request.active_path} open.`);
  for (const chip of request.context || []) {
    if (chip.type === 'selection') parts.push(`They selected lines ${chip.startLine}–${chip.endLine} of ${chip.path}.`);
    else if (chip.type === 'error') parts.push(`They are asking about the error in ${chip.path} at line ${chip.line}.`);
    else if (chip.type === 'chart') parts.push(`They are asking about a chart: ${chip.label}.`);
  }
  const run = request.last_run;
  if (run?.path) {
    const lines = [`Latest run of ${run.path}: ${run.status} (exit code ${run.exit_code}).`];
    const err = run.error;
    if (err?.type) lines.push(`Error: ${err.type}: ${err.message}${err.line ? ` at ${err.path} line ${err.line}` : ''}.`);
    const out = String(run.output || '').slice(-MAX_OUTPUT_CHARS);
    if (out.trim()) lines.push(`Output (stdout and stderr, last part):\n${out}`);
    parts.push(lines.join('\n'));
  }
  const hint = { fix: ' (they want a fix)', explain: ' (they want an explanation, no change)' }[request.intent] || '';
  parts.push(`Request${hint}: ${String(request.prompt || '').trim()}`);
  return parts.join('\n\n');
}

function history(request) {
  const merged = [];
  for (const m of (request.history || []).slice(-MAX_HISTORY)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.text || '').trim().slice(0, 8000);
    if (!content) continue;
    if (merged.length && merged.at(-1).role === role) merged.at(-1).content += `\n\n${content}`;
    else merged.push({ role, content });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  if (merged.length && merged.at(-1).role === 'user') merged.push({ role: 'assistant', content: '(noted)' });
  return merged;
}

export function parseReply(text, request) {
  const match = FILE_BLOCK.exec(text);
  if (!match) return { kind: 'answer', text: text.trim() || '(The model returned an empty answer.)' };
  let path = match[1].trim();
  if (path.startsWith('./')) path = path.slice(2);
  const before = text.slice(0, match.index).trim();
  if (!insideProject(path)) {
    return { kind: 'answer', text: `The model proposed a change to ${path}, which is outside this project, so it was ignored.\n\n${before}` };
  }
  let next = match[2];
  const base = (request.files || {})[path];
  if (typeof base === 'string' && base.endsWith('\n') && !next.endsWith('\n')) next += '\n';
  const after = text.slice(match.index + match[0].length).trim().split('\n');
  const bullet = (l) => /^\s*[-*] /.test(l);
  const summary = after.filter(bullet).map((l) => l.trim().slice(2).trim()).slice(0, 8);
  if (typeof base === 'string' && next === base) {
    return { kind: 'answer', text: `${before}\n\n(The suggested file is the same as yours, so there is nothing to apply.)` };
  }
  return { kind: 'proposal', path, new_content: next, text: before || `Proposed change to ${path}.`, summary };
}

export function createIpadAI({ api, token, settings }) {
  const proxyBase = (provider) => `${window.location.origin}/api/ai/proxy/${provider}`;

  const anthropic = () =>
    new Anthropic({
      apiKey: PLACEHOLDER_KEY,
      baseURL: proxyBase('anthropic'),
      dangerouslyAllowBrowser: true, // the page only reaches the app's own proxy
      defaultHeaders: { 'x-tandem-token': token },
      maxRetries: 1,
      timeout: 300_000,
    });

  async function proxyJSON(provider, path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(`${proxyBase(provider)}/${path}`, {
        method,
        headers: { 'x-tandem-token': token, authorization: `Bearer ${PLACEHOLDER_KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new AssistError('Couldn’t reach the provider. Check your internet connection.');
    }
    const data = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) throw new AssistError(`The provider refused the key (HTTP ${response.status}). Check it in AI settings.`);
    if (!response.ok) {
      const detail = data?.error?.message || data?.error || data?.detail || '';
      throw new AssistError(`The provider answered with HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}.`);
    }
    if (data === null) throw new AssistError('The provider didn’t answer with JSON. Is this the API address?');
    return data;
  }

  const anthropicError = (e) => {
    if (e instanceof Anthropic.AuthenticationError) return 'Anthropic refused the API key (401). Check it in AI settings.';
    if (e instanceof Anthropic.PermissionDeniedError) return 'This API key isn’t allowed to use that model (403).';
    if (e instanceof Anthropic.NotFoundError) return 'Anthropic doesn’t know that model. Pick one in AI settings.';
    if (e instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic (429). Try again in a moment.';
    if (e instanceof Anthropic.APIConnectionError) return 'Couldn’t reach Anthropic. Check your internet connection.';
    if (e instanceof Anthropic.APIError) return `Anthropic answered with HTTP ${e.status}.`;
    return null;
  };

  async function active() {
    const s = await settings();
    const name = s.active;
    const p = s.providers?.[name];
    if (!p || !p.model) return null;
    if (name === 'anthropic' && !p.has_key) return null;
    return { provider: name, label: p.label, model: p.model, base_url: p.base_url };
  }

  async function test(provider) {
    const s = await settings();
    const p = s.providers[provider];
    if (provider === 'anthropic' && !p.has_key) return { ok: false, message: 'Save an API key first.' };
    const started = performance.now();
    let models;
    try {
      if (provider === 'anthropic') {
        models = [];
        for await (const m of anthropic().models.list({ limit: 100 })) models.push(m.id);
      } else if (provider === 'openai') {
        const data = await proxyJSON('openai', 'models');
        models = (data.data || []).map((m) => String(m.id)).sort();
      } else {
        const data = await proxyJSON('ollama', 'api/tags');
        models = (data.models || []).map((m) => String(m.name)).sort();
      }
    } catch (e) {
      return { ok: false, message: anthropicError(e) || e.message };
    }
    const count = `${models.length} model${models.length === 1 ? '' : 's'} available`;
    const latency_ms = Math.round(performance.now() - started);
    if (!p.model) return { ok: true, models, latency_ms, model_found: null, message: `Connected · ${count}. Choose a model below.` };
    if (models.length && !models.includes(p.model)) {
      return { ok: true, models, latency_ms, model_found: false, message: `Connected, but “${p.model}” isn’t in this account’s model list.` };
    }
    return { ok: true, models, latency_ms, model_found: models.includes(p.model), message: `Connected · ${count}.` };
  }

  // A shared project's file list comes with the request (its files aren't this iPad's).
  const projectPaths = async (request) =>
    Array.isArray(request.file_list) ? request.file_list : (await (await api('/api/files')).json()).files.map((f) => f.path);

  async function assist(request, signal) {
    // The app sends shared_ai when the project's shared AI is the one to use.
    if (request.shared_ai) return assistShared(request, signal);
    const provider = await active();
    if (!provider) {
      return {
        kind: 'setup',
        text: `No AI model is connected yet. Open **AI settings**, add your Anthropic, OpenAI-compatible or Ollama model, and use it for the assistant. Then ask again.${
          Array.isArray(request.file_list) ? ' In a shared project, an owner can also share their AI with everyone in it (**Share**, then **Share your AI**).' : ''
        }`,
      };
    }
    const messages = [...history(request), { role: 'user', content: contextMessage(request, await projectPaths(request)) }];
    let text;
    try {
      if (provider.provider === 'anthropic') {
        const params = { model: provider.model, max_tokens: MAX_TOKENS, system: SYSTEM, messages };
        const client = anthropic();
        // If a safety classifier declines, Anthropic retries on a fallback model in the same call.
        const useFallback = FALLBACK_MODELS.has(provider.model) && provider.base_url.replace(/\/$/, '') === 'https://api.anthropic.com';
        const response = useFallback
          ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
          : await client.messages.create(params, { signal });
        if (response.stop_reason === 'refusal') return { kind: 'error', text: 'The model declined this request.' };
        text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (response.stop_reason === 'max_tokens') text += '\n\n[cut off: the answer was too long]';
      } else if (provider.provider === 'openai') {
        const data = await proxyJSON('openai', 'chat/completions', {
          method: 'POST',
          body: { model: provider.model, messages: [{ role: 'system', content: SYSTEM }, ...messages] },
        });
        text = data?.choices?.[0]?.message?.content || '';
      } else {
        const data = await proxyJSON('ollama', 'api/chat', {
          method: 'POST',
          body: { model: provider.model, stream: false, messages: [{ role: 'system', content: SYSTEM }, ...messages] },
        });
        text = data?.message?.content || '';
      }
    } catch (e) {
      if (e?.name === 'AbortError' || e instanceof Anthropic.APIUserAbortError) throw e;
      return { kind: 'error', text: anthropicError(e) || e.message };
    }
    return { ...parseReply(text, request), model: provider.model, provider: provider.label };
  }

  // No AI of your own: the AI the project's owner shares, through the
  // cowork-ai Edge Function, which adds the owner's key on the server.
  async function assistShared(request, signal) {
    // The function writes the instructions and reads the files from the
    // project; this sends the question and what it points at.
    const shared = request.shared_ai;
    let response;
    try {
      response = await fetch(shared.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${shared.token}`, apikey: shared.apikey },
        body: JSON.stringify({
          project_id: shared.project_id,
          mode: 'ipad',
          prompt: request.prompt,
          intent: request.intent || 'chat',
          context: request.context || [],
          active_path: request.active_path,
          paths: Object.keys(request.files || {}).slice(0, 6),
          last_run: request.last_run,
          history: (request.history || []).slice(-8).map((m) => ({ role: m.role, text: m.text })),
        }),
        signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return { kind: 'error', text: 'Couldn’t reach the shared AI. Check your internet connection.' };
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) return { kind: 'error', text: data?.error || `The shared AI answered with HTTP ${response.status}.` };
    if (data.stop_reason === 'refusal') return { kind: 'error', text: 'The model declined this request.' };
    let text = String(data.text || '');
    if (data.stop_reason === 'max_tokens') text += '\n\n[cut off: the answer was too long]';
    return {
      ...parseReply(text, request),
      model: data.model,
      provider: `Shared by ${data.shared_by || 'the owner'}`,
      shared: { shared_by: data.shared_by, used_today: data.used_today, daily_limit: data.daily_limit, unlimited: data.unlimited },
    };
  }

  return { active, test, assist };
}
