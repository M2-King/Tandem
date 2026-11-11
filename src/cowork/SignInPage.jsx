import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, HardDrive, Loader2, Mail } from 'lucide-react';
import TandemMark from '../components/TandemMark.jsx';
import { Avatar } from './CoworkBits.jsx';
import { SuccessCheck, pause } from './motion.jsx';
import { personForEmail } from './fixtures.js';

// Sign in to Shared projects: an email, then a 6-digit code sent to it.
// Preview: no email is sent; the sample code is shown on the page.
//
// Motion: the card rises in; each step slides in; a wrong code shakes the
// field; a correct one draws a check before the projects appear.
export const SAMPLE_CODE = '246810';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignInPage({ cowork, localName, notify }) {
  const [step, setStep] = useState('email'); // email | code | done
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [shakes, setShakes] = useState(0);
  const [welcome, setWelcome] = useState(null); // the person signing in
  const emailRef = useRef(null);
  const codeRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);

  useEffect(() => {
    if (step === 'email') emailRef.current?.focus();
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  // After a shake the field is new; put the cursor back in it.
  useEffect(() => {
    if (!shakes) return;
    const el = (step === 'code' ? codeRef : emailRef).current;
    el?.focus();
    el?.select();
  }, [shakes, step]);

  const fail = (message) => {
    setError(message);
    setShakes((n) => n + 1);
  };

  // Show the check, then the projects. Live mode passes the signed-in user.
  const finish = async (idOrEmail, user = null) => {
    const person =
      user || cowork.people[idOrEmail] || Object.values(cowork.people).find((p) => p.email === idOrEmail) || personForEmail(idOrEmail);
    setWelcome(person);
    setStep('done');
    await Promise.all([pause(900), user ? cowork.completeSignIn(user) : null]);
    if (!alive.current) return;
    if (user) notify(`Signed in as ${user.email}.`);
    else notify(`Signed in as ${cowork.signIn(idOrEmail).name}.`);
  };

  const submitEmail = async (e) => {
    e.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address)) return fail('Enter your email address, like name@example.edu.');
    setEmail(address);
    setError(null);
    setBusy(true);
    try {
      // Live: the code is emailed by the sign-in service. Preview: a pause.
      await (cowork.live ? cowork.sendCode(address) : pause(650));
    } catch (err) {
      if (!alive.current) return;
      setBusy(false);
      return fail(err.message);
    }
    if (!alive.current) return;
    setBusy(false);
    setCode('');
    setStep('code');
  };

  const submitCode = async (e) => {
    e.preventDefault();
    if (busy) return;
    const typed = code.replace(/\s/g, '');
    if (typed.length !== 6) return fail('Enter the 6-digit code from the email.');
    setBusy(true);
    if (cowork.live) {
      try {
        const user = await cowork.verifyCode(email, typed);
        if (!alive.current) return;
        setBusy(false);
        return finish(user.email, user);
      } catch (err) {
        if (!alive.current) return;
        setBusy(false);
        return fail(err.message);
      }
    }
    await pause(450); // "checking"
    if (!alive.current) return;
    setBusy(false);
    if (typed !== SAMPLE_CODE) {
      fail('That code doesn’t match. Check the latest email, or send a new code.');
      return;
    }
    finish(email);
  };

  if (step === 'done') {
    return (
      <div className="shared-page signin-page">
        <div className="signin-card signin-done" role="status" aria-live="polite">
          <SuccessCheck size={56} />
          <h1 className="signin-title">Welcome, {welcome.name.split(' ')[0]}</h1>
          <p className="signin-sub">Signed in. Opening your shared projects…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="shared-page signin-page">
      <div className="signin-card">
        <span className="signin-mark" aria-hidden="true">
          <TandemMark size={22} />
        </span>
        <h1 className="signin-title">Sign in to Shared projects</h1>
        <p className="signin-sub">
          Shared projects use a Tandem Cowork account, separate from your other accounts. Only people invited to a project can open it.
        </p>

        {step === 'email' ? (
          <form key="email" className="signin-form signin-step" onSubmit={submitEmail} noValidate>
            <label className="field" htmlFor="signin-email">
              <span className="field-label">Email</span>
            </label>
            <div key={`shake-${shakes}`} className={shakes ? 'cw-shake' : undefined}>
              <input
                id="signin-email"
                ref={emailRef}
                className="field-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                disabled={busy}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                placeholder="name@example.edu"
                aria-invalid={!!error}
                aria-describedby={error ? 'signin-error' : undefined}
              />
            </div>
            {error && (
              <p className="field-error" id="signin-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn-primary signin-submit" disabled={busy}>
              {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}
              {busy ? 'Sending code…' : 'Email me a sign-in code'}
            </button>
          </form>
        ) : (
          <form key="code" className="signin-form signin-step" onSubmit={submitCode} noValidate>
            <p className="signin-sent">
              We sent a 6-digit code to <strong>{email}</strong>. It works for 10 minutes.
            </p>
            <label className="field" htmlFor="signin-code">
              <span className="field-label">Code</span>
            </label>
            <div key={`shake-${shakes}`} className={shakes ? 'cw-shake' : undefined}>
              <input
                id="signin-code"
                ref={codeRef}
                className="field-input mono signin-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                disabled={busy}
                onChange={(e) => {
                  setCode(e.target.value.replace(/[^\d ]/g, ''));
                  setError(null);
                }}
                placeholder="000000"
                aria-invalid={!!error}
                aria-describedby={error ? 'signin-error' : 'signin-code-hint'}
              />
            </div>
            {error ? (
              <p className="field-error" id="signin-error" role="alert">
                {error}
              </p>
            ) : (
              <p className="field-hint" id="signin-code-hint">
                {cowork.live ? (
                  'The email comes from Tandem’s sign-in service. Check spam if it isn’t there in a minute.'
                ) : (
                  <>
                    Preview: no email is sent. The code is <span className="mono">{SAMPLE_CODE}</span>.
                  </>
                )}
              </p>
            )}
            <button type="submit" className="btn btn-primary signin-submit" disabled={busy}>
              {busy && <Loader2 size={16} className="spin" aria-hidden="true" />}
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <div className="signin-links">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setStep('email');
                  setError(null);
                  setShakes(0);
                }}
              >
                <ArrowLeft size={14} aria-hidden="true" /> Use a different email
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (!cowork.live) return notify(`Preview: a new code would be sent to ${email}.`);
                  try {
                    await cowork.sendCode(email);
                    notify(`Sent a new code to ${email}.`);
                  } catch (err) {
                    fail(err.message);
                  }
                  return undefined;
                }}
              >
                Send a new code
              </button>
            </div>
          </form>
        )}

        {cowork.configProblem && (
          <p className="field-error signin-config" role="alert">
            Cowork isn’t set up in this build: {cowork.configProblem}
          </p>
        )}

        {step === 'email' && !cowork.live && (
          <div className="signin-samples" role="group" aria-labelledby="signin-samples-title">
            <p className="signin-samples-title" id="signin-samples-title">
              Preview: sign in as a sample person
            </p>
            {[
              ['wei', 'Owner of Data Study'],
              ['sara', 'Invited to Data Study'],
            ].map(([id, note]) => (
              <button key={id} type="button" className="signin-sample" onClick={() => finish(id)} disabled={busy}>
                <Avatar person={cowork.people[id]} size="sm" />
                <span className="signin-sample-text">
                  <span>{cowork.people[id].name}</span>
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
