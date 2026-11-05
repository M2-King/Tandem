// The real assistant: the local runtime asks the AI model chosen in AI
// settings. Same result shapes as the demo service (aiService.js), so the
// review → accept → undo flow is unchanged. Nothing is written or run here.

const lineText = (l) => (typeof l === 'string' ? l : l?.text ?? '');

export function createRealAssistant({ backend, getLastRun, getModelLabel }) {
  return async function sendRealAssistantRequest({ prompt, intent, context, files, activePath, history, signal, onStage }) {
    // The files the request is about: the open file, plus any file a context chip names.
    const paths = new Set([activePath, ...context.map((c) => c.path)].filter((p) => p && typeof files[p] === 'string'));
    const sent = Object.fromEntries([...paths].map((p) => [p, files[p]]));
    const target = context.find((c) => c.path)?.path || activePath;
    const run = getLastRun(target);

    onStage?.(paths.size ? `Reading ${[...paths].join(', ')}` : 'Reading the project');
    onStage?.(`Asking ${getModelLabel() || 'the AI model'}`);
    const result = await backend.assist(
      {
        prompt,
        intent,
        context,
        files: sent,
        active_path: activePath,
        history: history.slice(-12),
        last_run: run
          ? {
              path: run.path,
              status: run.status,
              exit_code: run.exitCode ?? null,
              error: run.error || null,
              output: (run.output || []).map(lineText).join('\n').slice(-6000),
            }
          : null,
      },
      signal
    );

    if (result.kind === 'proposal' && typeof files[result.path] !== 'string') {
      // Review works on files that exist; show a new file as code to create.
      return { kind: 'answer', text: `${result.text}\n\nNew file **${result.path}**:\n\n\`\`\`python\n${result.new_content}\`\`\`` };
    }
    if (result.kind === 'proposal') {
      onStage?.('Preparing changes');
      return { kind: 'proposal', path: result.path, newContent: result.new_content, text: result.text, summary: result.summary };
    }
    if (result.kind === 'setup') {
      return { kind: 'answer', text: result.text, action: { type: 'open-ai-settings', label: 'Open AI settings' } };
    }
    if (result.kind === 'error') {
      const error = new Error(result.text);
      error.userMessage = `${result.text} No files were changed.`;
      throw error;
    }
    return { kind: 'answer', text: result.text };
  };
}
