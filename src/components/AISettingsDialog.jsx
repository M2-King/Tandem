import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, CheckCircle2, AlertCircle, KeyRound } from 'lucide-react';
import Dialog from './Dialog.jsx';

const ORDER = ['anthropic', 'openai', 'ollama'];
const KEY_PLACEHOLDER = { anthropic: 'sk-ant-…', openai: 'sk-…' };
const MODEL_PLACEHOLDER = { anthropic: 'claude-opus-5-5', openai: 'Model name from your provider', ollama: 'llama3.2' };

// Where the assistant's AI comes from. Keys are sent to the local runtime once
// and stored there; the browser only ever learns that a key is saved.
export default function AISettingsDialog({ backend, onClose, onSaved, tabComplete, onTabComplete }) {
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [tab, setTab] = useState('anthropic');
  const [forms, setForms] = useState({});
  const [busy, setBusy] = useState(null); // 'save' | 'test' | null
  const [error, setError] = useState(null);
  const [test, setTest] = useState({}); // provider -> result

  useEffect(() => {
    backend
      .aiSettings()
      .then((s) => {
        setSettings(s);
        setTab(s.active || 'anthropic');
        setForms(
          Object.fromEntries(
            ORDER.map((p) => [p, { model: s.providers[p].model, baseUrl: s.providers[p].base_url, key: '', replacing: false }])
          )
        );
      })
      .catch((e) => setLoadError(e.message));
  }, [backend]);

  const provider = settings?.providers[tab];
  const form = forms[tab];
  const result = test[tab];
  const models = useMemo(() => result?.models || [], [result]);
  const update = (patch) => {
    setForms((f) => ({ ...f, [tab]: { ...f[tab], ...patch } }));
    setError(null);
  };

  // Save this provider's fields (and the key, if one was typed).
  const save = async ({ activate } = {}) => {
    const body = { provider: tab, model: form.model };
    if (tab !== 'anthropic' || form.baseUrl !== provider.default_base_url) body.base_url = form.baseUrl;
    if (form.key.trim()) body.api_key = form.key.trim();
    if (activate !== undefined) body.activate = activate;
    const next = await backend.saveAISettings(body);
    setSettings(next);
    setForms((f) => ({ ...f, [tab]: { ...f[tab], key: '', replacing: false } }));
    return next;
  };

  const run = async (kind, fn) => {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const onTest = () =>
    run('test', async () => {
      await save();
      setTest((t) => ({ ...t, [tab]: { pending: true } }));
      const r = await backend.testAI(tab);
      setTest((t) => ({ ...t, [tab]: r }));
    });

  const onSave = (e) => {
    e.preventDefault();
    run('save', async () => {
      await save({ activate: true });
      onSaved?.(`${provider.label} saved for the assistant`);
      onClose();
    });
  };

  const removeKey = () =>
    run('save', async () => {
      const next = await backend.saveAISettings({ provider: tab, clear_key: true });
      setSettings(next);
      setTest((t) => ({ ...t, [tab]: undefined }));
    });

  const keyField = provider && (provider.needs_key || tab === 'openai');
  const showKeyInput = keyField && (!provider.has_key || form?.replacing);

  return (
    <Dialog title="AI settings" onClose={onClose} className="dialog-ai">
      <form onSubmit={onSave} className="ai-settings">
        <div className="ai-settings-head">
          <h2 className="dialog-title">AI settings</h2>
          <button type="button" className="icon-btn" aria-label="Close" data-tooltip="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="dialog-text">
          Choose the model the assistant will use. Keys are stored by the Tandem runtime on this computer, never in the
          browser, and are never passed to your code.
        </p>

        {loadError && <p className="field-error">Couldn’t load AI settings: {loadError}</p>}
        {!settings && !loadError && (
          <p className="ai-status is-pending">
            <Loader2 size={14} className="spin" aria-hidden="true" /> Loading…
          </p>
        )}

        {settings && form && (
          <>
            <div className="segmented ai-tabs" role="tablist" aria-label="Provider">
              {ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={tab === p}
                  className={tab === p ? 'is-active' : ''}
                  onClick={() => {
                    setTab(p);
                    setError(null);
                  }}
                >
                  {settings.providers[p].label}
                  {settings.active === p && <span className="ai-active-dot" aria-label="(in use)" />}
                </button>
              ))}
            </div>

            {keyField && (
              <div className="field">
                <span className="field-label" id="ai-key-label">
                  API key{tab === 'openai' ? ' (if your server needs one)' : ''}
                </span>
                {showKeyInput ? (
                  <input
                    className="field-input mono"
                    type="password"
                    aria-labelledby="ai-key-label"
                    value={form.key}
                    onChange={(e) => update({ key: e.target.value })}
                    placeholder={KEY_PLACEHOLDER[tab]}
                    autoComplete="off"
                    spellCheck={false}
                    data-autofocus
                  />
                ) : (
                  <div className="ai-saved-key">
                    <KeyRound size={14} aria-hidden="true" />
                    <span>
                      Saved key <span className="mono">{provider.key_hint}</span>
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm push-right" onClick={() => update({ replacing: true })}>
                      Replace
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={removeKey} disabled={!!busy}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            )}

            {tab !== 'anthropic' ? (
              <label className="field">
                <span className="field-label">Address</span>
                <input
                  className="field-input mono"
                  value={form.baseUrl}
                  onChange={(e) => update({ baseUrl: e.target.value })}
                  placeholder={provider.default_base_url}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            ) : (
              <details className="ai-advanced">
                <summary>Custom address</summary>
                <label className="field">
                  <span className="field-label">API address (for a proxy or gateway)</span>
                  <input
                    className="field-input mono"
                    value={form.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                    placeholder={provider.default_base_url}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
              </details>
            )}

            <label className="field">
              <span className="field-label">Model</span>
              <input
                className="field-input mono"
                value={form.model}
                onChange={(e) => update({ model: e.target.value })}
                placeholder={MODEL_PLACEHOLDER[tab]}
                list={models.length ? `ai-models-${tab}` : undefined}
                spellCheck={false}
                autoComplete="off"
              />
              {models.length > 0 && (
                <datalist id={`ai-models-${tab}`}>
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              )}
            </label>

            <div className="ai-test-row">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onTest} disabled={!!busy}>
                {busy === 'test' && <Loader2 size={14} className="spin" aria-hidden="true" />} Test connection
              </button>
              <p className={`ai-status ${result && !result.pending ? (result.ok && result.model_found !== false ? 'is-ok' : result.ok ? 'is-warn' : 'is-error') : ''}`} role="status">
                {result?.pending && 'Checking…'}
                {result && !result.pending && (
                  <>
                    {result.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}
                    {result.message}
                  </>
                )}
                {!result && 'Lists the available models; no tokens are used.'}
              </p>
            </div>

            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}

            {onTabComplete && (
              <label className="ai-toggle">
                <input type="checkbox" checked={!!tabComplete} onChange={(e) => onTabComplete(e.target.checked)} />
                <span>
                  <strong>Tab autocomplete.</strong> Suggests code as you type, in grey: Tab accepts it, Esc dismisses it,{' '}
                  {navigator.platform?.match(/Mac|iPad|iPhone/) ? '⌘→' : 'Ctrl+→'} takes one word. Each suggestion is a
                  small request to the model above.
                </span>
              </label>
            )}

            <p className="field-hint ai-note">
              Key stored in <span className="mono">{settings.stored_in}</span>. Once saved, the assistant sends your
              requests to this provider for real (no demo answers). Every change it proposes still needs your review
              before it is applied.
            </p>

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!!busy}>
                Save and use {provider.label}
              </button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}
