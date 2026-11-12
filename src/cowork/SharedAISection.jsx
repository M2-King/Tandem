import { useEffect, useRef, useState } from 'react';
import { KeyRound, Lock, Sparkles } from 'lucide-react';

// Share: the AI an owner shares with the project (live mode, useSharedAI).
// Owners share a provider, model and API key with a daily number of
// requests per person; members whose device has no AI of its own use it.
// The key goes to the server once and never comes back to anyone.

const MODELS = {
  anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-2'],
  openai: [],
};
const DEFAULTS = { anthropic: 'claude-sonnet-5-5', openai: '' };
const PROVIDER_NAME = { anthropic: 'Claude', openai: 'an OpenAI-compatible model' };

function ShareForm({ sharedAI, share, onDone, notify }) {
  const [provider, setProvider] = useState(share?.provider || 'anthropic');
  const [model, setModel] = useState(share?.model || DEFAULTS.anthropic);
  const [baseUrl, setBaseUrl] = useState(share?.provider === 'openai' ? share.base_url || '' : '');
  const [apiKey, setApiKey] = useState('');
  const [limit, setLimit] = useState(String(share?.daily_limit || 30));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const keepKey = !!share && share.provider === provider;

  const pick = (p) => {
    setProvider(p);
    setModel(share?.provider === p ? share.model : DEFAULTS[p]);
    setError('');
  };
  const submit = async (e) => {
    e.preventDefault();
    const dailyLimit = Number(limit);
    if (!model.trim()) return setError('Enter the model to share.');
    if (!keepKey && !apiKey.trim()) return setError('Enter the API key to share.');
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) return setError('Requests per person per day: 1 to 1000.');
    setBusy(true);
    setError('');
    try {
      await sharedAI.save({ provider, model: model.trim(), baseUrl: provider === 'openai' ? baseUrl.trim() : '', apiKey: apiKey.trim(), dailyLimit });
      notify?.(share ? 'Shared AI updated.' : `Your AI is shared with this project.`);
      onDone();
    } catch (err) {
      setError(err.message || 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ai-share-form" onSubmit={submit} noValidate>
      <div className="segmented ai-share-provider" role="radiogroup" aria-label="Provider">
        {[
          ['anthropic', 'Anthropic (Claude)'],
          ['openai', 'OpenAI-compatible'],
        ].map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={provider === id} className={provider === id ? 'is-active' : ''} onClick={() => pick(id)}>
            {label}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field-label">Model</span>
        <input className="field-input mono" value={model} onChange={(e) => setModel(e.target.value)} list="ai-share-models" spellCheck={false} placeholder={provider === 'openai' ? 'gpt-…' : ''} />
        <datalist id="ai-share-models">
          {MODELS[provider].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      {provider === 'openai' && (
        <label className="field">
          <span className="field-label">API address</span>
          <input className="field-input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} />
        </label>
      )}
      <label className="field">
        <span className="field-label">API key</span>
        <input
          className="field-input mono"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keepKey ? `Saved (ends in ${share.key_hint}). Leave empty to keep it.` : provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
        />
      </label>
      <label className="field ai-share-limit">
        <span className="field-label">Requests per person per day</span>
        <input className="field-input" type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} />
      </label>
      <p className="field-hint ai-share-note">
        <Lock size={13} aria-hidden="true" /> The key is kept on the Tandem server. Nobody in the project can see it, and it isn’t shown to you
        again either. Every request is billed to your account; your own requests have no limit.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="ai-share-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : share ? 'Save changes' : 'Share with this project'}
        </button>
      </div>
    </form>
  );
}

export default function SharedAISection({ sharedAI, isOwner, notify }) {
  const [editing, setEditing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const share = sharedAI.share;
  // When the form closes, focus goes back to the section (so Escape still closes Share).
  const sectionRef = useRef(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) sectionRef.current?.querySelector('.ai-share-card button')?.focus();
    wasEditing.current = editing;
  }, [editing, share]);
  const stop = async () => {
    setStopping(true);
    try {
      await sharedAI.stop();
      notify?.('Stopped sharing your AI. The key was deleted from the server.');
    } catch (e) {
      notify?.(e.message || 'Couldn’t stop sharing. Try again.');
    } finally {
      setStopping(false);
    }
  };

  return (
    <section className="ai-share" aria-labelledby="share-ai" ref={sectionRef}>
      <h3 className="share-section-title" id="share-ai">
        AI for everyone
      </h3>
      {editing && isOwner ? (
        <ShareForm sharedAI={sharedAI} share={share} onDone={() => setEditing(false)} notify={notify} />
      ) : share ? (
        <div className="ai-share-card">
          <span className="ai-share-icon" aria-hidden="true">
            <Sparkles size={16} />
          </span>
          <span className="ai-share-text">
            <span className="ai-share-title">
              {share.shared_by_me ? 'You share' : `${share.shared_by} shares`} {PROVIDER_NAME[share.provider]} · <span className="mono">{share.model}</span>
            </span>
            <span className="ai-share-detail">
              {share.shared_by_me
                ? `Members without their own AI use it, up to ${share.daily_limit} requests a day each. Key ends in ${share.key_hint}.`
                : `You’ve used ${share.used_today} of ${share.daily_limit} requests today (they reset at midnight UTC). With your own AI connected, the assistant uses yours.`}
            </span>
          </span>
          {isOwner && (
            <span className="ai-share-buttons">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
                Change
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={stop} disabled={stopping}>
                {stopping ? 'Stopping…' : 'Stop sharing'}
              </button>
            </span>
          )}
        </div>
      ) : isOwner ? (
        <div className="ai-share-card is-empty">
          <span className="ai-share-icon" aria-hidden="true">
            <KeyRound size={16} />
          </span>
          <span className="ai-share-text">
            <span className="ai-share-title">Share your AI with this project</span>
            <span className="ai-share-detail">Teammates without an AI subscription can use the assistant with your key, without seeing it.</span>
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>
            Share your AI
          </button>
        </div>
      ) : (
        <p className="share-empty">No AI is shared with this project. An owner can share theirs here.</p>
      )}
    </section>
  );
}
