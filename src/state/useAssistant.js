import { useCallback, useRef, useState } from 'react';
import { usePersistedState } from './usePersistedState.js';
import { STORAGE_KEYS } from '../lib/storage.js';
import { uid } from '../lib/id.js';
import { diffStats } from '../lib/diff.js';
import { sendAssistantRequest } from '../services/aiService.js';

const createChat = () => ({ messages: [], proposals: {} });

// A request can't still be running after a reload, so mark it cancelled.
function restore(saved) {
  if (!Array.isArray(saved?.messages)) return null;
  return {
    proposals: saved.proposals || {},
    messages: saved.messages.map((m) =>
      m.status === 'working' ? { ...m, status: 'cancelled', text: 'Cancelled when the page was closed. No files were changed.' } : m
    ),
  };
}

// Conversation, proposals, and the composer's context chips.
//
// Proposal lifecycle: pending → accepted | rejected | discarded,
// and accepted → undone. A pending proposal is "stale" when its file no
// longer matches `baseContent` (computed by the UI, never stored).
export function useAssistant({ getFiles, getActivePath, onSave, request = sendAssistantRequest }) {
  const [chat, setChat] = usePersistedState(STORAGE_KEYS.chat, createChat, { restore, onSave });
  const [draftContext, setDraftContext] = useState([]);
  const controllerRef = useRef(null);

  const busy = chat.messages.some((m) => m.status === 'working');

  const patchMessage = useCallback(
    (id, fn) => setChat((c) => ({ ...c, messages: c.messages.map((m) => (m.id === id ? fn(m) : m)) })),
    [setChat]
  );

  const send = useCallback(
    async ({ prompt, intent = 'chat', context = [] }) => {
      const text = prompt.trim();
      if (!text || controllerRef.current) return null;
      const assistantId = uid('msg');
      setChat((c) => ({
        ...c,
        messages: [
          ...c.messages,
          { id: uid('msg'), role: 'user', text, context },
          { id: assistantId, role: 'assistant', status: 'working', stages: [] },
        ],
      }));

      // The proposal is based on the files as they were when the request
      // started. If the user edits during generation, it arrives stale.
      const files = getFiles();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const history = chat.messages
          .filter((m) => (m.role === 'user' || m.status === 'done') && m.text && m.kind !== 'analysis')
          .map((m) => ({ role: m.role, text: m.text }));
        const result = await request({
          prompt: text,
          intent,
          context,
          files,
          history,
          activePath: getActivePath(),
          signal: controller.signal,
          onStage: (label) =>
            patchMessage(assistantId, (m) => ({
              ...m,
              stages: [...m.stages.map((s) => ({ ...s, done: true })), { label, done: false }],
            })),
        });

        if (result.kind === 'proposal') {
          const proposalId = uid('change');
          const baseContent = files[result.path];
          const stats = diffStats(baseContent, result.newContent);
          setChat((c) => ({
            proposals: {
              ...c.proposals,
              [proposalId]: {
                id: proposalId,
                path: result.path,
                baseContent,
                newContent: result.newContent,
                summary: result.summary,
                reason: result.text,
                added: stats.added,
                removed: stats.removed,
                status: 'pending',
                request: { prompt: text, intent, context },
              },
            },
            messages: c.messages.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    status: 'done',
                    text: result.text,
                    proposalId,
                    stages: [...m.stages.map((s) => ({ ...s, done: true })), { label: 'Ready for review', done: true }],
                  }
                : m
            ),
          }));
          return { proposalId, path: result.path };
        }

        patchMessage(assistantId, (m) => ({
          ...m,
          status: 'done',
          stages: [],
          kind: result.kind,
          text: result.text,
          suggestions: result.suggestions || [],
          action: result.action || null,
        }));
        return null;
      } catch (error) {
        const cancelled = error?.name === 'AbortError';
        patchMessage(assistantId, (m) => ({
          ...m,
          status: cancelled ? 'cancelled' : 'failed',
          stages: [],
          text: cancelled
            ? 'Cancelled. No files were changed.'
            : error?.userMessage || 'Something went wrong while preparing a response. No files were changed.',
          retry: cancelled ? null : { prompt: text, intent, context },
        }));
        return null;
      } finally {
        controllerRef.current = null;
      }
    },
    [getFiles, getActivePath, patchMessage, setChat, request, chat.messages]
  );

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  // A finished-run summary (see analysisService). Added once per run.
  const addAnalysis = useCallback(
    (analysis) =>
      setChat((c) =>
        c.messages.some((m) => m.analysis?.runId === analysis.runId)
          ? c
          : {
              ...c,
              messages: [
                ...c.messages,
                { id: uid('msg'), role: 'assistant', status: 'done', kind: 'analysis', analysis, createdAt: Date.now() },
              ],
            }
      ),
    [setChat]
  );

  const updateProposal = useCallback(
    (id, patch) =>
      setChat((c) => (c.proposals[id] ? { ...c, proposals: { ...c.proposals, [id]: { ...c.proposals[id], ...patch } } } : c)),
    [setChat]
  );

  // Only one selection chip and one chart chip at a time; any number of files (@ mentions).
  const addContext = useCallback((chip) => {
    setDraftContext((list) => [
      ...list.filter((c) => (chip.type === 'file' ? !(c.type === 'file' && c.path === chip.path) : c.type !== chip.type)),
      chip,
    ]);
  }, []);
  const removeContext = useCallback((index) => setDraftContext((list) => list.filter((_, i) => i !== index)), []);
  const clearContext = useCallback(() => setDraftContext([]), []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    setChat(createChat());
    setDraftContext([]);
  }, [setChat]);

  return {
    messages: chat.messages,
    proposals: chat.proposals,
    busy,
    send,
    cancel,
    addAnalysis,
    updateProposal,
    draftContext,
    addContext,
    removeContext,
    clearContext,
    reset,
  };
}
