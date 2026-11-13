import { useCallback, useEffect, useRef } from 'react';
import { MAX_STEPS } from './useAssistant.js';

// What the assistant may do on its own (the mode is chosen in its panel):
//   ask   every action and every change waits for a click
//   safe  changes to project files are applied and runs start on their own
//         (Undo stays); installing packages still waits for a click
//   auto  everything happens on its own
export const AI_MODES = {
  ask: { label: 'Ask each time', short: 'Ask first', note: 'Every change, install and run waits for your click.' },
  safe: { label: 'Auto for safe actions', short: 'Auto: safe', note: 'Changes are applied and runs start on their own (you can undo). Installing packages still asks.' },
  auto: { label: 'Auto for everything', short: 'Auto: all', note: 'Changes, installs and runs all happen on their own. It stops after 8 steps.' },
};
export const AI_MODE_ORDER = ['ask', 'safe', 'auto'];

export const autoAllowed = (mode, action) => mode === 'auto' || (mode === 'safe' && action.type === 'run');
const FINAL = new Set(['done', 'failed', 'skipped']);
const clip = (text, max) => (text.length > max ? `…${text.slice(-max)}` : text);

// The results the assistant reads next (as the next message of the conversation).
export function resultsText(actions) {
  const lines = ['Results of what you asked Tandem to do:'];
  for (const a of actions) {
    if (a.type === 'install') {
      const what = `Install ${a.packages.join(', ')}`;
      if (a.status === 'done') lines.push(`- ${what}: installed.`);
      else if (a.status === 'skipped') lines.push(`- ${what}: not done (the developer skipped it).`);
      else lines.push(`- ${what}: failed. ${a.result?.message || ''}${a.result?.log ? `\npip's last lines:\n${clip(a.result.log, 2500)}` : ''}`);
    } else {
      const what = `Run ${a.path}${a.cells ? ` (cells ${a.cells.join(', ')})` : ''}`;
      if (a.status === 'skipped') lines.push(`- ${what}: not done (the developer skipped it).`);
      else lines.push(`- ${what}: ${a.result?.summary || (a.status === 'done' ? 'finished.' : 'failed.')}${a.result?.detail ? `\n${clip(a.result.detail, 4000)}` : ''}`);
    }
  }
  return lines.join('\n');
}

// Carries out the assistant's actions, on its own or when clicked, as the
// mode says; when every action of an answer has ended, sends the results
// back so the assistant can take the next step (at most MAX_STEPS in a row).
//
// perform: { install(packages, onLog) → { ok, message, log }, run(action) →
// { ok, summary, detail }, stop(action) } (App: the runtime's installer, the
// script runner, the notebook's kernel).
export function useAssistantActions({ assistant, mode, accept, perform, send }) {
  const latest = useRef({});
  latest.current = { assistant, mode, accept, perform, send };
  const running = useRef(null); // { messageId, actionId, stopped }
  const queue = useRef(Promise.resolve());

  const messageOf = (id) => latest.current.assistant.messages.find((m) => m.id === id);

  // Every action has ended: send the results, unless the person stopped or
  // skipped everything, or the chain is long enough.
  const finish = useCallback((messageId, actions) => {
    const message = messageOf(messageId);
    if (!actions.length || !actions.every((a) => FINAL.has(a.status))) return;
    if (actions.every((a) => a.status === 'skipped') || actions.some((a) => a.stopped)) return;
    const step = (message?.step || 0) + 1;
    if (step > MAX_STEPS) {
      latest.current.assistant.markLimit?.(messageId, resultsText(actions));
      return;
    }
    latest.current.send({ prompt: resultsText(actions), kind: 'results', step });
  }, []);

  const execute = useCallback(async (messageId, actionId) => {
    const { assistant: a, perform: p } = latest.current;
    const action = messageOf(messageId)?.actions?.find((x) => x.id === actionId);
    if (!action || action.status !== 'pending') return null;
    running.current = { messageId, actionId, stopped: false };
    a.updateAction(messageId, actionId, { status: 'running', startedAt: Date.now() });
    let result;
    try {
      result =
        action.type === 'install'
          ? await p.install(action.packages, (log) => a.updateAction(messageId, actionId, { log: clip(log, 4000) }))
          : await p.run(action);
    } catch (e) {
      result = { ok: false, message: e?.message || String(e), summary: `failed: ${e?.message || e}` };
    }
    const stopped = running.current?.stopped;
    running.current = null;
    const patch = { status: result.ok ? 'done' : 'failed', result, stopped: !!stopped, endedAt: Date.now() };
    a.updateAction(messageId, actionId, patch);
    return { ...action, ...patch };
  }, []);

  // Go through an answer's actions in order: run what may run on its own (or
  // what was just clicked), stop at the first that waits for a click.
  const advance = useCallback(
    (messageId, clicked = null) => {
      queue.current = queue.current.then(async () => {
        const message = messageOf(messageId);
        if (!message?.actions?.length) return;
        const done = new Map();
        for (const action of message.actions) {
          const now = done.get(action.id) || messageOf(messageId)?.actions?.find((x) => x.id === action.id) || action;
          if (FINAL.has(now.status)) continue;
          if (now.status === 'running') return;
          if (now.id !== clicked && !autoAllowed(latest.current.mode, now)) return; // waits for a click
          const ended = await execute(messageId, now.id);
          if (ended) done.set(now.id, ended);
          if (ended?.stopped) break;
        }
        const actions = (messageOf(messageId)?.actions || []).map((x) => done.get(x.id) || x);
        finish(messageId, actions);
      });
      return queue.current;
    },
    [execute, finish]
  );

  // A new answer: apply its change if the mode allows, then its actions.
  const onAnswer = useCallback(
    (res) => {
      if (!res?.messageId) return;
      if (res.proposalId && latest.current.mode !== 'ask') latest.current.accept(res.proposalId);
      if (res.actions?.length) setTimeout(() => advance(res.messageId), 0); // after the answer is in the conversation
    },
    [advance]
  );

  // Clicked: "Install", "Run" (applying the answer's change first, if it waits).
  const approve = useCallback(
    (messageId, actionId) => {
      const message = messageOf(messageId);
      const action = message?.actions?.find((x) => x.id === actionId);
      if (action?.type === 'run' && message.proposalId) {
        const proposal = latest.current.assistant.proposals[message.proposalId];
        if (proposal?.status === 'pending') latest.current.accept(message.proposalId);
      }
      return advance(messageId, actionId);
    },
    [advance]
  );

  const skip = useCallback(
    (messageId, actionId) => {
      latest.current.assistant.updateAction(messageId, actionId, { status: 'skipped' });
      setTimeout(() => advance(messageId), 0);
    },
    [advance]
  );

  const stop = useCallback(() => {
    if (!running.current) return;
    running.current.stopped = true;
    const message = messageOf(running.current.messageId);
    const action = message?.actions?.find((x) => x.id === running.current.actionId);
    if (action) latest.current.perform.stop(action);
  }, []);

  // A new request from the person: what earlier answers still wait for is skipped.
  const skipWaiting = useCallback(() => {
    for (const m of latest.current.assistant.messages) {
      for (const a of m.actions || []) {
        if (a.status === 'pending') latest.current.assistant.updateAction(m.id, a.id, { status: 'skipped', note: 'Skipped: you asked something new.' });
      }
    }
  }, []);

  // Switching to a more automatic mode lets what waits go ahead.
  const previousMode = useRef(mode);
  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    const last = [...latest.current.assistant.messages].reverse().find((m) => m.role === 'assistant');
    if (last?.actions?.some((a) => a.status === 'pending')) advance(last.id);
  }, [mode, advance]);

  // After the step limit: the person looked and wants it to go on.
  const continueChain = useCallback((message) => {
    if (!message?.limitPrompt) return;
    latest.current.assistant.patchLimit?.(message.id);
    latest.current.send({ prompt: message.limitPrompt, kind: 'results', step: 1 });
  }, []);

  return { onAnswer, approve, skip, stop, skipWaiting, continueChain, isRunning: () => !!running.current };
}
