// Tab autocomplete, like Cursor: after a short pause in typing, the AI model
// suggests what comes next as grey "ghost text". Tab accepts it, Esc dismisses
// it, Ctrl/⌘+→ accepts one word at a time (Monaco's built-in keys).

import { monaco } from './monacoSetup.js';

const LANGUAGES = ['python', 'sql', 'javascript', 'typescript', 'html', 'css', 'shell', 'r', 'java', 'c', 'cpp', 'markdown'];
const PAUSE_MS = 450; // wait for a pause in typing, so each keystroke isn't a request
const PREFIX_CHARS = 6000;
const SUFFIX_CHARS = 2000;

let config = { complete: null, enabled: () => false, onError: null };
let registered = false;
const cache = new Map(); // prefix+suffix → text (the last few answers)

// `complete(body, signal)` → { text }, `enabled()` → whether to ask now.
export function configureInlineCompletions(next) {
  config = { ...config, ...next };
  if (registered) return;
  registered = true;
  for (const language of LANGUAGES) {
    monaco.languages.registerInlineCompletionsProvider(language, { provideInlineCompletions, disposeInlineCompletions() {} });
  }
}

const wait = (ms, token) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    token.onCancellationRequested(() => {
      clearTimeout(t);
      resolve();
    });
  });

// Notebook cells are "W6.ipynb#<cell id>"; the model sees the notebook's name.
const pathOf = (model) => decodeURIComponent(model.uri.path.replace(/^\//, '')) || 'untitled';

async function provideInlineCompletions(model, position, context, token) {
  const empty = { items: [] };
  if (!config.complete || !config.enabled()) return empty;
  const line = model.getLineContent(position.lineNumber);
  const after = line.slice(position.column - 1);
  // In the middle of a word, or with code right after the cursor: no suggestion.
  if (/^[\w]/.test(after) || after.trim().length > 3) return empty;

  const offset = model.getOffsetAt(position);
  const text = model.getValue();
  const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
  const suffix = text.slice(offset, offset + SUFFIX_CHARS);
  if (!prefix.trim()) return empty;
  const key = `${prefix}\u0000${suffix}`;

  let suggestion = cache.get(key);
  if (suggestion === undefined) {
    // Asked by the keyboard shortcut: no pause.
    if (context.triggerKind !== monaco.languages.InlineCompletionTriggerKind.Explicit) await wait(PAUSE_MS, token);
    if (token.isCancellationRequested) return empty;
    const controller = new AbortController();
    const off = token.onCancellationRequested(() => controller.abort());
    try {
      const result = await config.complete({ path: pathOf(model), language: model.getLanguageId(), prefix, suffix }, controller.signal);
      suggestion = result?.text || '';
      if (result?.error) config.onError?.(result.error);
    } catch {
      return empty; // cancelled (typing went on) or offline
    } finally {
      off.dispose();
    }
    cache.set(key, suggestion);
    if (cache.size > 30) cache.delete(cache.keys().next().value);
  }
  if (!suggestion || token.isCancellationRequested) return empty;
  return {
    items: [{ insertText: suggestion, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }],
  };
}
