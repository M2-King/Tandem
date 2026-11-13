import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

// The Terminal tab: a shell in the project folder, with the project's
// environment first on PATH (runtime/terminals.py), drawn by xterm.js.
// The shell lives on while the panel is hidden or another tab shows: the
// terminal (and its element) is kept here and moved into the tab when it
// shows again. When the shell ends, a key starts a new one.

let current = null; // { term, fit, element, handle, ended, backend }
let loading = null;

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

async function load() {
  loading ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]);
  const [{ Terminal }, { FitAddon }] = await loading;
  return { Terminal, FitAddon };
}

function startShell(session) {
  const { term } = session;
  session.ended = false;
  session.handle = session.backend.startTerminal(
    { cols: term.cols, rows: term.rows },
    {
      onStart: (e) => {
        session.info = { cwd: e.cwd, env: e.env };
        session.onState?.(session.info);
      },
      onOutput: (data) => term.write(data),
      onExit: (_code, problem) => {
        session.ended = true;
        term.write(`\r\n\x1b[2m${problem || 'The shell ended.'} Press any key for a new one.\x1b[0m\r\n`);
      },
      onRejected: (message) => {
        session.ended = true;
        term.write(`\x1b[31m${message}\x1b[0m\r\n\x1b[2mPress any key to try again.\x1b[0m\r\n`);
      },
    }
  );
}

async function ensureSession(backend) {
  if (current && current.backend === backend) return current;
  current?.handle?.kill();
  current?.term?.dispose();
  const { Terminal, FitAddon } = await load();
  const term = new Terminal({
    allowTransparency: true,
    cursorBlink: true,
    fontFamily: css('--font-code', 'Menlo, Consolas, monospace'),
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: {
      background: 'rgba(0, 0, 0, 0)',
      foreground: css('--text-primary', '#edf0f4'),
      cursor: css('--accent', '#809bdc'),
      selectionBackground: 'rgba(128, 155, 220, 0.35)',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const element = document.createElement('div');
  element.className = 'terminal-surface';
  const session = { term, fit, element, handle: null, ended: true, backend, onState: null };
  term.onData((data) => {
    if (session.ended) startShell(session);
    else session.handle?.write(data);
  });
  term.onResize(({ cols, rows }) => session.handle?.resize(cols, rows));
  current = session;
  return session;
}

export default function TerminalView({ backend, visible }) {
  const host = useRef(null);
  const [session, setSession] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    ensureSession(backend).then(
      (s) => alive && setSession(s),
      (e) => alive && setError(e?.message || String(e))
    );
    return () => {
      alive = false;
    };
  }, [backend]);

  useEffect(() => {
    if (!session || !host.current) return undefined;
    session.onState = setInfo;
    setInfo(session.info || null);
    host.current.appendChild(session.element);
    if (!session.term.element) session.term.open(session.element);
    const refit = () => {
      if (!host.current?.offsetParent) return; // hidden
      try {
        session.fit.fit();
      } catch {
        // not laid out yet
      }
    };
    refit();
    if (session.ended && !session.handle) startShell(session);
    const observer = new ResizeObserver(refit);
    observer.observe(host.current);
    const el = host.current;
    return () => {
      observer.disconnect();
      if (session.element.parentNode === el) el.removeChild(session.element);
      session.onState = null;
    };
  }, [session]);

  useEffect(() => {
    if (!visible || !session) return;
    requestAnimationFrame(() => {
      try {
        session.fit.fit();
      } catch {
        // hidden
      }
      session.term.focus();
    });
  }, [visible, session]);

  return (
    <div className="terminal-view">
      {(info?.env || info?.cwd) && (
        <p className="terminal-note">
          {info.env ? (
            <>
              <span className="terminal-env">{info.env}</span> active ·{' '}
            </>
          ) : null}
          <span className="mono">{info.cwd}</span>
        </p>
      )}
      {error && <p className="terminal-note is-error">The terminal couldn’t load: {error}</p>}
      {!session && !error && (
        <p className="terminal-note">
          <Loader2 size={14} className="spin" aria-hidden="true" /> Starting the terminal…
        </p>
      )}
      <div className="terminal-host" ref={host} />
    </div>
  );
}
