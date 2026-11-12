import { useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { createLiveText, isLiveTextPath, toBase64, SEED } from './liveText.js';

// Cowork live mode: live typing for the open project (see liveText.js for
// the documents, monacoBinding.js for the editor side).
//
// Messages on the project's private Realtime channel (usePresence):
//   doc        { from, path, update }      edits made here, batched every 80 ms
//   doc-sync   { from, files: [{ path, sv }] }   sent on joining: "here's what I have"
//   doc-reply  { from, to, path, update, sv }    what they lack, and what I have
//   saved      { from, path, revision }          saved here: others skip their backup save
// so devices that were apart (offline, joining late) send each other exactly
// what the other is missing, both ways.
//
// A project's documents start from their saved copies (cowork_file_docs,
// 003_cowork_live_text.sql). A file with no saved copy is started from its
// text once the others had a moment to send theirs (seeding is the same on
// every device, so two starting at once agree). Until then, and for files
// that aren't typed live (notebooks), editing works as before: saves and the
// 10-second sync.
//
// Without 003 on the server (cowork_file_docs missing) live typing stays off
// for the session and everything works as before. It can also be turned off
// on a device: localStorage 'tandem.coworkLiveTyping' = 'off'.

const SEND_EVERY = 80; // ms
const MAX_MESSAGE = 200 * 1024; // base64 characters; larger edits travel by saving
const SEED_AFTER_JOIN = 1200; // ms after joining: time for the others to answer
const SEED_AT_MOST = 4000; // ms after opening, whatever the connection does
const SEED_ALONE = 300; // ms after opening when there is no live connection

// With localStorage 'tandem.coworkDebug' = '1': every live typing message sent and received.
const debugOn = () => {
  try {
    return localStorage.getItem('tandem.coworkDebug') === '1';
  } catch {
    return false;
  }
};
const log = (...args) => debugOn() && console.info('[cowork live]', new Date().toISOString().slice(11, 23), ...args);

const switchedOff = () => {
  try {
    return localStorage.getItem('tandem.coworkLiveTyping') === 'off';
  } catch {
    return false;
  }
};

export const isMissingFunction = (e) => e?.code === 'PGRST202' || /could not find the function/i.test(e?.message || '');

export function useLiveText({ me, onText, getText, onSaved }) {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const L = useRef(null);
  const supported = useRef(!switchedOff());
  const pending = useRef(new Map()); // path -> { content, revision } waiting to start
  const outbox = useRef(new Map()); // path -> [update]
  const flushTimer = useRef(null);
  const seedTimer = useRef(null);
  const openedAt = useRef(0);
  const joinedAt = useRef(0);
  const presence = useRef('off');
  const sendRef = useRef(null);
  const meRef = useRef(me);
  meRef.current = me;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const getTextRef = useRef(getText);
  getTextRef.current = getText;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const api = useMemo(() => {
    const send = (event, payload) => !!sendRef.current?.(event, payload);
    const myId = () => meRef.current?.id;

    const flushOutbox = () => {
      flushTimer.current = null;
      for (const [path, list] of outbox.current) {
        const update = toBase64(list.length === 1 ? list[0] : Y.mergeUpdates(list));
        const sent = update.length <= MAX_MESSAGE && send('doc', { from: myId(), path, update });
        log('doc out', path, update.length, sent ? 'sent' : 'not sent');
      }
      outbox.current.clear();
    };

    const manager = () =>
      createLiveText({
        onText: (path, text, origin) => {
          onTextRef.current?.(path, text, origin);
          if (origin === SEED) bump(); // a file became live: the editor binds to it
        },
        onUpdate: (path, update) => {
          const list = outbox.current.get(path) || [];
          list.push(update);
          outbox.current.set(path, list);
          if (!flushTimer.current) flushTimer.current = setTimeout(flushOutbox, SEND_EVERY);
        },
      });

    // Start a waiting file: from what others sent, or from its text.
    const start = (path) => {
      const wait = pending.current.get(path);
      if (!wait || !L.current) return;
      pending.current.delete(path);
      const here = getTextRef.current?.(path);
      log('start', path, wait.revision, JSON.stringify((here || '').slice(0, 40)));
      L.current.seed(path, wait.content, wait.revision);
      // Typed here while it was waiting: keep that as an edit.
      if (here !== undefined && here !== wait.content && here !== L.current.text(path)) {
        L.current.setText(path, here);
        onTextRef.current?.(path, here, 'kept');
      }
    };
    const startDue = () => {
      clearTimeout(seedTimer.current);
      seedTimer.current = null;
      if (!pending.current.size || !L.current) return;
      const state = presence.current;
      const due =
        state === 'online' && joinedAt.current
          ? joinedAt.current + SEED_AFTER_JOIN
          : state === 'joining' || state === 'reconnecting'
            ? openedAt.current + SEED_AT_MOST
            : openedAt.current + SEED_ALONE;
      const wait = Math.min(due, openedAt.current + SEED_AT_MOST) - Date.now();
      if (wait > 0) {
        seedTimer.current = setTimeout(startDue, wait);
        return;
      }
      for (const path of [...pending.current.keys()]) start(path);
    };

    const syncRequest = () => {
      if (!L.current) return;
      const paths = new Set([...L.current.paths(), ...pending.current.keys()]);
      const files = [...paths].map((path) => ({ path, sv: L.current.has(path) ? L.current.stateVector(path) : null }));
      if (files.length) send('doc-sync', { from: myId(), files });
    };

    return {
      get supported() {
        return supported.current;
      },
      disable() {
        supported.current = false;
        this.end();
        bump();
      },
      isLive: (path) => !!L.current?.isReady(path),
      isLivePath: (path) => supported.current && isLiveTextPath(path),
      entry: (path) => L.current?.entry(path) || null,
      text: (path) => L.current?.text(path),

      // A project opened: its files, and the saved documents by path.
      begin(files, docs) {
        this.end();
        if (!supported.current) return;
        L.current = manager();
        openedAt.current = Date.now();
        joinedAt.current = 0;
        for (const f of files) {
          if (!isLiveTextPath(f.path)) continue;
          const saved = docs?.[f.path];
          if (saved) L.current.load(f.path, f, saved);
          else pending.current.set(f.path, { content: f.content, revision: f.revision });
        }
        startDue();
        bump();
      },
      end() {
        clearTimeout(flushTimer.current);
        clearTimeout(seedTimer.current);
        flushTimer.current = null;
        seedTimer.current = null;
        outbox.current.clear();
        pending.current.clear();
        L.current?.destroy();
        L.current = null;
      },

      // Files that appeared (created here or by a teammate): from a saved
      // document, else started from the text (right away when created here).
      add(file, saved, { here = false } = {}) {
        if (!L.current || !isLiveTextPath(file.path) || L.current.isReady(file.path)) return;
        if (saved) {
          pending.current.delete(file.path);
          L.current.load(file.path, file, saved);
          return;
        }
        pending.current.set(file.path, { content: file.content, revision: file.revision });
        if (here) start(file.path);
        else startDue();
      },
      // The server has a newer saved document of a live file: merge it in.
      merge(path, savedDoc) {
        if (L.current?.isReady(path)) L.current.applyRemote(path, savedDoc);
      },
      setText(path, text) {
        L.current?.setText(path, text);
      },
      // Text saved by an older build (no document): taken the same way everywhere.
      catchUp(path, content, revision) {
        log('catch-up', path, revision, JSON.stringify(content.slice(0, 40)), 'from', JSON.stringify((L.current?.text(path) || '').slice(0, 40)));
        L.current?.catchUp(path, content, revision);
      },
      snapshot: (path) => L.current?.snapshot(path) || null,
      // Saved here: the others needn't save these edits too.
      announceSaved(path, revision) {
        send('saved', { from: myId(), path, revision });
      },
      undo: (path) => L.current?.undo(path),
      redo: (path) => L.current?.redo(path),
      rename(from, to) {
        L.current?.rename(from, to);
        if (pending.current.has(from)) {
          pending.current.set(to, pending.current.get(from));
          pending.current.delete(from);
        }
        bump();
      },
      drop(path) {
        L.current?.drop(path);
        pending.current.delete(path);
        bump();
      },

      // The live connection (usePresence).
      sendRef,
      presenceChanged(state) {
        presence.current = state;
        startDue();
      },
      joined() {
        joinedAt.current = Date.now();
        syncRequest();
        startDue();
      },
      receive(event, payload) {
        if (!L.current || !payload || (!payload.path && event !== 'doc-sync')) return;
        if (payload.from === myId() || (payload.to && payload.to !== myId())) return;
        log(event, 'in', payload.path || '', payload.update?.length || 0);
        if (event === 'saved') {
          onSavedRef.current?.(payload.path, payload.revision);
          return;
        }
        if (event === 'doc') {
          L.current.applyRemote(payload.path, payload.update);
          if (pending.current.has(payload.path) && L.current.text(payload.path)) start(payload.path);
          return;
        }
        if (event === 'doc-sync') {
          for (const { path, sv } of payload.files || []) {
            if (!L.current.isReady(path)) continue;
            let update = L.current.diffFor(path, sv);
            if (update && update.length > MAX_MESSAGE) update = null;
            send('doc-reply', { from: myId(), to: payload.from, path, update, sv: L.current.stateVector(path) });
          }
          return;
        }
        if (event === 'doc-reply') {
          if (payload.update) L.current.applyRemote(payload.path, payload.update);
          if (pending.current.has(payload.path)) start(payload.path);
          // Send back what they lack (edits made here while apart).
          const theirs = payload.sv ? L.current.diffFor(payload.path, payload.sv) : null;
          if (theirs && theirs.length <= MAX_MESSAGE) send('doc', { from: myId(), path: payload.path, update: theirs });
        }
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // For the editor (LiveTextContext): the document of a live file, and undo.
  const editorContext = useMemo(
    () => ({ version, entry: (path) => api.entry(path), undo: (path) => api.undo(path), redo: (path) => api.redo(path) }),
    [version, api]
  );

  return { live: api, editorContext, version };
}
