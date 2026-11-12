import { useEffect, useRef, useState } from 'react';
import { HardDrive, Loader2 } from 'lucide-react';
import TandemMark from '../components/TandemMark.jsx';
import { Avatar } from './CoworkBits.jsx';
import { SuccessCheck, pause } from './motion.jsx';
import { TANDEM_DOMAIN, USERNAME_RULE, addressOf, normalizeUsername } from './accounts.js';

// Sign in to Shared projects with a Tandem account: a username and a
// password. Creating an account needs nothing else (no email to confirm);
// the account's Tandem address, username@tandem.org, is how people find and
// invite each other inside the app.
//
// Motion: the card rises in; switching between Sign in and Create account
// slides; a refused attempt shakes the field; success draws a check before
// the projects appear.

export default function SignInPage({ cowork, localName, notify }) {
  const [mode, setMode] = useState('signin'); // signin | signup
  const [step, setStep] = useState('form'); // form | done
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null); // { field, message }
  const [shakes, setShakes] = useState(0);
  const [welcome, setWelcome] = useState(null);
  const userRef = useRef(null);
  const passRef = useRef(null);
  const confirmRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);

  useEffect(() => {
    if (step === 'form') userRef.current?.focus();
  }, [mode, step]);

  // After a shake, put the cursor back in the field that needs fixing.
  useEffect(() => {
    if (!shakes || !error) return;
    const el = { username: userRef, confirm: confirmRef }[error.field]?.current || passRef.current;
    el?.focus();
    el?.select?.();
  }, [shakes, error]);

  const fail = (message, field = 'password') => {
    setError({ field, message });
    setShakes((n) => n + 1);
  };

  // Show the check, then the projects.
  const finish = async (person) => {
    setWelcome(person);
    setStep('done');
    await pause(900); // the welcome, then the projects
    if (!alive.current) return;
    await cowork.completeSignIn(person);
    notify(`Signed in as ${addressOf(person.username)}.`);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const u = normalizeUsername(username);
    if (mode === 'signup' && password !== confirm) return fail('The passwords don’t match.', 'confirm');
    setError(null);
    setBusy(true);
    try {
      const person = mode === 'signup' ? await cowork.signUp(u, password) : await cowork.signInWithPassword(u, password);
      if (!alive.current) return;
      setBusy(false);
      finish(person);
    } catch (err) {
      if (!alive.current) return;
      setBusy(false);
      const field = /username|account called|taken/i.test(err.message) ? 'username' : 'password';
      fail(err.message, field);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setShakes(0);
    setPassword('');
    setConfirm('');
  };

  if (step === 'done') {
    return (
      <div className="shared-page signin-page">
        <div className="signin-card signin-done" role="status" aria-live="polite">
          <SuccessCheck size={56} />
          <h1 className="signin-title">Welcome, {welcome.name.split(' ')[0]}</h1>
          <p className="signin-sub">
            Signed in as <span className="mono">{addressOf(welcome.username)}</span>. Opening your shared projects…
          </p>
        </div>
      </div>
    );
  }

  const signup = mode === 'signup';
  const errorFor = (field) =>
    error?.field === field ? (
      <p className="field-error" id={`signin-${field}-error`} role="alert">
        {error.message}
      </p>
    ) : null;
  const shake = (field) => (shakes && error?.field === field ? 'cw-shake' : undefined);
  const preview = normalizeUsername(username);

  return (
    <div className="shared-page signin-page">
      <div className="signin-card">
        <span className="signin-mark" aria-hidden="true">
          <TandemMark size={22} />
        </span>
        <h1 className="signin-title">{signup ? 'Create a Tandem account' : 'Sign in to Shared projects'}</h1>
        <p className="signin-sub">
          Tandem accounts are their own: a username and a password, nothing to confirm. Only people invited to a project can open it.
        </p>

        <div className="segmented signin-tabs" role="tablist" aria-label="Account">
          {[
            ['signin', 'Sign in'],
            ['signup', 'Create account'],
          ].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? 'is-active' : ''} onClick={() => switchMode(id)}>
              {label}
            </button>
          ))}
        </div>

        <form key={mode} className="signin-form signin-step" onSubmit={submit} noValidate>
          <label className="field" htmlFor="signin-username">
            <span className="field-label">Username</span>
          </label>
          <div key={`u-${shakes}`} className={shake('username')}>
            <input
              id="signin-username"
              ref={userRef}
              className="field-input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              disabled={busy}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              placeholder="priya"
              aria-invalid={error?.field === 'username'}
              aria-describedby={error?.field === 'username' ? 'signin-username-error' : 'signin-username-hint'}
            />
          </div>
          {errorFor('username') || (
            <p className="field-hint" id="signin-username-hint">
              {signup ? (
                <>
                  {USERNAME_RULE[0].toUpperCase() + USERNAME_RULE.slice(1)}. Your Tandem address:{' '}
                  <span className="mono">{preview ? addressOf(preview) : `name@${TANDEM_DOMAIN}`}</span>
                </>
              ) : (
                <>
                  Or your Tandem address, like <span className="mono">priya@{TANDEM_DOMAIN}</span>.
                </>
              )}
            </p>
          )}

          <label className="field" htmlFor="signin-password">
            <span className="field-label">Password</span>
          </label>
          <div key={`p-${shakes}`} className={shake('password')}>
            <input
              id="signin-password"
              ref={passRef}
              className="field-input"
              type="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              value={password}
              disabled={busy}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              aria-invalid={error?.field === 'password'}
              aria-describedby={error?.field === 'password' ? 'signin-password-error' : signup ? 'signin-password-hint' : undefined}
            />
          </div>
          {errorFor('password') ||
            (signup && (
              <p className="field-hint" id="signin-password-hint">
                At least 8 characters. There’s no email to reset it, so keep it somewhere safe.
              </p>
            ))}

          {signup && (
            <>
              <label className="field" htmlFor="signin-confirm">
                <span className="field-label">Password again</span>
              </label>
              <div key={`c-${shakes}`} className={shake('confirm')}>
                <input
                  id="signin-confirm"
                  ref={confirmRef}
                  className="field-input"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  disabled={busy}
                  onChange={(e) => {
                    setConfirm(e.target.value);
                    setError(null);
                  }}
                  aria-invalid={error?.field === 'confirm'}
                  aria-describedby={error?.field === 'confirm' ? 'signin-confirm-error' : undefined}
                />
              </div>
              {errorFor('confirm')}
            </>
          )}

          {!cowork.live && (
            <p className="field-hint">Preview: sample accounts sign in with any password of 8+ characters.</p>
          )}
          <button type="submit" className="btn btn-primary signin-submit" disabled={busy}>
            {busy && <Loader2 size={16} className="spin" aria-hidden="true" />}
            {busy ? (signup ? 'Creating account…' : 'Signing in…') : signup ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {cowork.configProblem && (
          <p className="field-error signin-config" role="alert">
            Cowork isn’t set up in this build: {cowork.configProblem}
          </p>
        )}

        {!cowork.live && !signup && (
          <div className="signin-samples" role="group" aria-labelledby="signin-samples-title">
            <p className="signin-samples-title" id="signin-samples-title">
              Preview: sign in as a sample person
            </p>
            {[
              ['wei', 'Owner of Data Study'],
              ['sara', 'Invited to Data Study'],
            ].map(([id, note]) => (
              <button key={id} type="button" className="signin-sample" onClick={() => finish(cowork.people[id])} disabled={busy}>
                <Avatar person={cowork.people[id]} size="sm" />
                <span className="signin-sample-text">
                  <span>
                    {cowork.people[id].name} <span className="signin-sample-note mono">{addressOf(id)}</span>
                  </span>
                  <span className="signin-sample-note">{note}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <button type="button" className="signin-device" onClick={() => cowork.go('local')}>
          <HardDrive size={14} aria-hidden="true" /> Back to {localName} on this device
        </button>
      </div>
    </div>
  );
}
