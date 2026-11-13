import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Square, X, Check, Loader2, Code2, BarChart3, AlertCircle, ArrowDown, RotateCcw, Sparkles, ChevronRight, MessageSquareText, Wrench, Lightbulb, FileCode2, Table2, History, Users, Package, Play, ShieldCheck, Zap, Hand, CornerDownRight } from 'lucide-react';
import Menu, { MenuItem } from './Menu.jsx';
import { AI_MODES, AI_MODE_ORDER, autoAllowed } from '../state/useAssistantActions.js';
import TandemMark from './TandemMark.jsx';
import Markdown from './Markdown.jsx';
import ProposalCard from './ProposalCard.jsx';
import IconButton from './IconButton.jsx';
import { DEMO_PROMPTS } from '../services/aiService.js';
import { IS_LOCAL } from '../runtime/config.js';

const chipIcon = (type) => (type === 'chart' ? BarChart3 : type === 'error' ? AlertCircle : Code2);

function ContextChip({ chip, onRemove, onOpen }) {
  const Icon = chipIcon(chip.type);
  // A code reference in a sent message is a link back to those lines.
  if (onOpen && chip.type === 'selection' && chip.path && chip.startLine) {
    return (
      <button
        type="button"
        className="context-chip context-chip-link"
        onClick={() => onOpen(chip)}
        title={`Show ${chip.label} in the editor`}
      >
        <Icon size={14} aria-hidden="true" />
        <span className="context-chip-label">{chip.label}</span>
      </button>
    );
  }
  return (
    <span className="context-chip" title={chip.text ? chip.text.slice(0, 400) : chip.label}>
      <Icon size={14} aria-hidden="true" />
      <span className="context-chip-label">{chip.label}</span>
      {onRemove && (
        <button type="button" className="context-chip-remove" aria-label={`Remove ${chip.label}`} onClick={onRemove}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

// While working: one live line with the current step, not a growing checklist.
function WorkingLine({ stages, onCancel }) {
  const current = stages.at(-1)?.label || 'Starting';
  return (
    <div className="working-line" role="status" aria-live="polite">
      <Loader2 size={14} className="spin" aria-hidden="true" />
      <span key={current} className="working-label">
        {current}
      </span>
      <button type="button" className="link-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

// Once done: the steps fold into one quiet line that can be opened.
function StepTrace({ stages }) {
  if (!stages?.length) return null;
  return (
    <details className="msg-trace">
      <summary>
        <ChevronRight size={12} aria-hidden="true" className="msg-trace-chevron" />
        Done in {stages.length} {stages.length === 1 ? 'step' : 'steps'}
      </summary>
      <ol>
        {stages.map((s, i) => (
          <li key={i}>{s.label}</li>
        ))}
      </ol>
    </details>
  );
}

const actionTitle = (a) =>
  a.type === 'install'
    ? `Install ${a.packages.join(', ')}`
    : `Run ${a.path.split('/').pop()}${a.cells ? ` · cell${a.cells.length > 1 ? 's' : ''} ${cellRange(a.cells)}` : ''}`;
function cellRange(cells) {
  const parts = [];
  for (let i = 0; i < cells.length; i++) {
    let j = i;
    while (j + 1 < cells.length && cells[j + 1] === cells[j] + 1) j++;
    parts.push(j > i ? `${cells[i]}–${cells[j]}` : `${cells[i]}`);
    i = j;
  }
  return parts.join(', ');
}

// What an answer asked Tandem to do: each with its state, and the buttons
// the mode leaves to the person (Install, Run, Skip; Stop while it runs).
function ActionCards({ message, mode, actionHandlers, proposalPending }) {
  const actions = message.actions || [];
  if (!actions.length) return null;
  const firstWaiting = actions.find((a) => a.status === 'pending');
  const anyRunning = actions.some((a) => a.status === 'running');
  return (
    <ul className="ai-actions" aria-label="What the assistant asked Tandem to do">
      {actions.map((a) => {
        const Icon = a.type === 'install' ? Package : Play;
        const waiting = a.status === 'pending';
        const myTurn = waiting && a.id === firstWaiting?.id && !anyRunning;
        const auto = waiting && autoAllowed(mode, a);
        const verb = a.type === 'install' ? 'Install' : proposalPending ? 'Apply change & run' : 'Run';
        return (
          <li key={a.id} className={`ai-action is-${a.status}`}>
            <span className="ai-action-icon" aria-hidden="true">
              {a.status === 'running' ? <Loader2 size={15} className="spin" /> : a.status === 'done' ? <Check size={15} /> : a.status === 'failed' ? <AlertCircle size={15} /> : <Icon size={15} />}
            </span>
            <div className="ai-action-main">
              <span className="ai-action-title">{actionTitle(a)}</span>
              <span className="ai-action-state" aria-live="polite">
                {a.status === 'running'
                  ? a.type === 'install'
                    ? 'Installing into the project’s environment…'
                    : 'Running…'
                  : a.status === 'done'
                    ? a.type === 'install'
                      ? 'Installed.'
                      : a.result?.summary || 'Finished.'
                    : a.status === 'failed'
                      ? a.stopped
                        ? 'Stopped.'
                        : a.type === 'install'
                          ? `Didn’t install: ${a.result?.message || 'pip reported an error.'}`
                          : a.result?.summary || 'Failed.'
                      : a.status === 'skipped'
                        ? a.note || 'Skipped.'
                        : auto
                          ? 'Starting…'
                          : myTurn
                            ? 'Waiting for you.'
                            : 'After the step above.'}
              </span>
              {a.type === 'install' && a.log && (a.status === 'running' || a.status === 'failed') && (
                <pre className="ai-action-log">{a.log.split('\n').slice(-6).join('\n')}</pre>
              )}
            </div>
            <div className="ai-action-buttons">
              {a.status === 'running' && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => actionHandlers.stop()}>
                  <Square size={13} aria-hidden="true" /> Stop
                </button>
              )}
              {myTurn && !auto && (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => actionHandlers.skip(message.id, a.id)}>
                    Skip
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => actionHandlers.approve(message.id, a.id)}>
                    <Icon size={14} aria-hidden="true" /> {verb}
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// The results Tandem sent back to the assistant (the next step's question).
function ResultsMessage({ message }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg msg-results">
      <button type="button" className="msg-results-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <CornerDownRight size={14} aria-hidden="true" />
        <span>Tandem sent the results to the assistant</span>
        <ChevronRight size={14} aria-hidden="true" className={`msg-results-chevron${open ? ' is-open' : ''}`} />
      </button>
      {open && <pre className="msg-results-text">{message.text}</pre>}
    </div>
  );
}

function Message({ message, proposalView, handlers, onSuggestion, onAction, onRetry, onCancel, onShowResults, onGoToCode, busy, mode, actionHandlers }) {
  if (message.role === 'user' && message.kind === 'results') return <ResultsMessage message={message} />;
  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        {message.context?.length > 0 && (
          <div className="msg-context">
            {message.context.map((c, i) => (
              <ContextChip key={i} chip={c} onOpen={onGoToCode} />
            ))}
          </div>
        )}
        <div className="msg-user-text">{message.text}</div>
      </div>
    );
  }

  if (message.kind === 'analysis' && message.analysis) return <RunAnalysis analysis={message.analysis} onShowResults={onShowResults} />;

  const working = message.status === 'working';
  return (
    <article className={`msg msg-assistant status-${message.status}`} aria-label="Tandem reply">
      {working && <WorkingLine stages={message.stages || []} onCancel={onCancel} />}
      {message.status === 'cancelled' && (
        <p className="msg-muted">
          <Square size={12} aria-hidden="true" /> {message.text}
        </p>
      )}
      {message.status === 'failed' && (
        <div className="msg-error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{message.text}</span>
          {message.retry && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onRetry(message.retry)}>
              <RotateCcw size={16} aria-hidden="true" /> Try again
            </button>
          )}
        </div>
      )}
      {message.status === 'done' && <StepTrace stages={message.stages} />}
      {message.status === 'done' && message.text && (
        <div className={message.kind === 'limitation' ? 'msg-limitation' : 'msg-body'}>
          {message.kind === 'limitation' && <span className="limitation-tag">Demo limitation</span>}
          <Markdown text={message.text} />
        </div>
      )}
      {message.proposalId && proposalView(message.proposalId) && (
        <ProposalCard view={proposalView(message.proposalId)} handlers={handlers} />
      )}
      {actionHandlers && (
        <ActionCards
          message={message}
          mode={mode}
          actionHandlers={actionHandlers}
          proposalPending={!!message.proposalId && proposalView(message.proposalId)?.proposal?.status === 'pending'}
        />
      )}
      {message.limit && (
        <div className="ai-limit">
          <span>Stopped after {message.step} steps in a row, so you can check what happened.</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => actionHandlers?.continueChain(message)}>
            Continue
          </button>
        </div>
      )}
      {message.action && (
        <button type="button" className="btn btn-secondary btn-sm msg-action" onClick={() => onAction(message.action)}>
          {message.action.type === 'open-ai-settings' ? <Sparkles size={16} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}{' '}
          {message.action.label}
        </button>
      )}
      {message.suggestions?.length > 0 && (
        <div className="suggestions">
          {message.suggestions.map((s) => (
            <button key={s} type="button" className="suggestion" disabled={busy} onClick={() => onSuggestion(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

// Shown after a run of code that Tandem changed. Built from the run record,
// so nothing here exists before the code has actually run. Sections are
// sibling groups (no card inside a card) and the heading carries the state.
function RunAnalysis({ analysis, onShowResults }) {
  return (
    <article className="msg-analysis" aria-label={`Results of run ${analysis.runNumber}`} data-analysis={analysis.runId}>
      <header className="analysis-heading">
        <h3 className="analysis-title">Analysis complete</h3>
        <p className="analysis-sub">
          Run #{analysis.runNumber} of {analysis.path} finished. Here’s a summary from its {analysis.real ? 'output' : 'sample data'}:
        </p>
      </header>
      <ul className="analysis-group analysis-checks" aria-label="What ran">
        {analysis.checks.map((c) => (
          <li key={c}>
            <Check size={14} aria-hidden="true" />
            <span>{c}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="analysis-results-link" onClick={() => onShowResults?.('Charts')}>
        <BarChart3 size={16} aria-hidden="true" />
        <span>
          <span className="analysis-results-title">Metrics and chart</span>
          <span className="analysis-results-sub">Run #{analysis.runNumber} in Results</span>
        </span>
        <ChevronRight size={16} aria-hidden="true" className="analysis-results-chevron" />
      </button>
      <div className="analysis-group analysis-insight">
        <Lightbulb size={16} aria-hidden="true" className="analysis-insight-icon" />
        <div>
          <p className="analysis-insight-title">Insight</p>
          <p>{analysis.insight}</p>
        </div>
      </div>
      <details className="analysis-next" open>
        <summary>
          <ChevronRight size={14} aria-hidden="true" className="analysis-next-chevron" />
          Next steps
        </summary>
        <ul>
          {analysis.nextSteps.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}

// The demo assistant's prepared tasks, each tied to a sample file.
const STARTERS = [
  {
    icon: BarChart3,
    title: 'Compare model results',
    detail: 'Add a decision tree to main.py and compare it with linear regression',
    prompt: DEMO_PROMPTS.compare,
    file: 'main.py',
  },
  {
    icon: MessageSquareText,
    title: 'Explain main.py',
    detail: 'Walk through what the script does',
    prompt: DEMO_PROMPTS.explainMain,
    file: 'main.py',
  },
  { icon: Wrench, title: 'Fix summary.py', detail: 'It stops with an error when it runs', prompt: DEMO_PROMPTS.fixSummary, file: 'summary.py' },
];

const runSummary = (run) => {
  if (!run) return 'None yet';
  const status = run.status === 'success' ? 'completed' : run.status === 'error' ? 'failed' : 'stopped';
  return `#${run.number} · ${run.path} · ${status}`;
};

// The assistant before the first message: what it can see, what it can do,
// and how a change flows. Every value comes from the open project.
function EmptyConversation({ onSuggestion, project }) {
  const lastRun = project?.lastRun;
  // Only offer tasks whose file is in this project.
  const starters = project?.files ? STARTERS.filter((s) => project.files.includes(s.file)) : STARTERS;
  const dataset = project?.dataset;
  return (
    <div className="assistant-empty">
      <header className="assistant-intro">
        <span className="assistant-intro-mark" aria-hidden="true">
          <TandemMark size={18} />
        </span>
        <div>
          <p className="assistant-empty-title">Work on {project?.name ?? 'this project'}</p>
          <p className="assistant-empty-text">Ask for a change, an explanation or a fix. Nothing is applied until you accept it.</p>
        </div>
      </header>

      {project && (
        <section className="assistant-section" aria-labelledby="ctx-title">
          <h3 className="section-label" id="ctx-title">
            Context
          </h3>
          <ul className="group-card context-list">
            <li>
              <FileCode2 size={16} aria-hidden="true" />
              <span className="context-name mono">{project.activePath ?? 'No file open'}</span>
              <span className="context-meta">{project.activePath ? `${project.activeLines} lines` : ''}</span>
            </li>
            {dataset && (
              <li>
                <Table2 size={16} aria-hidden="true" />
                <span className="context-name mono">{dataset.path.split('/').pop()}</span>
                <span className="context-meta">
                  {dataset.rows} rows · {dataset.cols} columns
                </span>
              </li>
            )}
            <li>
              <History size={16} aria-hidden="true" />
              <span className="context-name">Last run</span>
              <span className="context-meta">{runSummary(lastRun)}</span>
            </li>
          </ul>
        </section>
      )}

      {starters.length > 0 && (
      <section className="assistant-section" aria-labelledby="starter-title">
        <h3 className="section-label" id="starter-title">
          Suggested
        </h3>
        <div className="group-card starters">
          {starters.map(({ icon: Icon, title, detail, prompt }) => (
            <button key={prompt} type="button" className="starter" onClick={() => onSuggestion(prompt)} title={prompt}>
              <span className="starter-icon" aria-hidden="true">
                <Icon size={16} />
              </span>
              <span className="starter-text">
                <span className="starter-name">{title}</span>
                <span className="starter-prompt">{detail}</span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="starter-chevron" />
            </button>
          ))}
        </div>
      </section>
      )}

      <section className="assistant-section" aria-labelledby="flow-title">
        <h3 className="section-label" id="flow-title">
          How changes work
        </h3>
        <ol className="flow-steps">
          <li>
            <span className="flow-num">1</span>
            <span>
              <strong>Ask.</strong> Describe what you want.
            </span>
          </li>
          <li>
            <span className="flow-num">2</span>
            <span>
              <strong>Review.</strong> The change opens in the editor as a diff.
            </span>
          </li>
          <li>
            <span className="flow-num">3</span>
            <span>
              <strong>Run.</strong> Results and a summary appear here.
            </span>
          </li>
        </ol>
      </section>
    </div>
  );
}

const Composer = forwardRef(function Composer({ busy, context, onRemoveContext, onSend, onCancel, suggestions, placeholder }, ref) {
  const [text, setText] = useState('');
  const textareaRef = useRef(null);

  // Let the parent focus the textarea (e.g. after "Ask AI").
  useEffect(() => {
    if (!ref) return;
    ref.current = { focus: () => textareaRef.current?.focus(), setText };
  }, [ref]);

  // Grow with the content up to a limit.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 168) + 'px';
  }, [text]);

  const submit = () => {
    if (busy || !text.trim()) return;
    onSend(text);
    setText('');
  };

  return (
    <div className="composer-wrap">
      {suggestions.length > 0 && !busy && (
        <div className="suggestions suggestions-composer">
          {suggestions.map((s) => (
            <button key={s} type="button" className="suggestion" onClick={() => onSend(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div
        className={`composer ${text ? 'has-text' : ''}`}
        onClick={(e) => e.target === e.currentTarget && textareaRef.current?.focus()}
      >
        {context.length > 0 && (
          <div className="composer-context">
            {context.map((c, i) => (
              <ContextChip key={`${c.type}-${c.label}`} chip={c} onRemove={() => onRemoveContext(i)} />
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message the assistant"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-footer">
          <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
          {busy ? (
            <button type="button" className="send-btn send-btn-stop" aria-label="Stop generating" data-tooltip="Stop generating" onClick={onCancel}>
              <Square size={12} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              aria-label="Send"
              data-tooltip="Send"
              disabled={!text.trim()}
              onClick={submit}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

const MODE_ICON = { ask: Hand, safe: ShieldCheck, auto: Zap };

// How much the assistant may do on its own (useAssistantActions).
function ModeMenu({ mode = 'ask', onMode }) {
  const Icon = MODE_ICON[mode] || Hand;
  return (
    <Menu
      label="What the assistant may do on its own"
      role="menu"
      renderTrigger={(props) => (
        <button type="button" className={`btn btn-ghost btn-sm ai-mode is-${mode}`} data-tooltip={AI_MODES[mode]?.note} {...props}>
          <Icon size={14} aria-hidden="true" /> {AI_MODES[mode]?.short}
        </button>
      )}
    >
      {(close) =>
        AI_MODE_ORDER.map((m) => (
          <MenuItem
            key={m}
            close={close}
            role="menuitemradio"
            checked={m === mode}
            icon={MODE_ICON[m]}
            label={AI_MODES[m].label}
            description={AI_MODES[m].note}
            onSelect={() => onMode(m)}
          />
        ))
      }
    </Menu>
  );
}

export default function AssistantPanel({
  messages,
  busy,
  proposalView,
  handlers,
  draftContext,
  onRemoveContext,
  onSend,
  onCancel,
  onSuggestion,
  onAction,
  onRetry,
  composerRef,
  onClose,
  composerSuggestions,
  project,
  onShowResults,
  onGoToCode,
  onConnectAI,
  aiModel,
  aiMode,
  onAIMode,
  actionHandlers,
}) {
  const listRef = useRef(null);
  const contentRef = useRef(null);
  const atBottom = useRef(true);
  const lastScrollTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const skipJump = useRef(false);

  // Follow new content only while the reader is at the bottom. Only scrolling
  // up un-sticks it, so programmatic scrolls can't race with new content.
  const onScroll = () => {
    const el = listRef.current;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (el.scrollTop < lastScrollTop.current - 2) atBottom.current = distance < 48;
    else if (distance < 48) atBottom.current = true;
    lastScrollTop.current = el.scrollTop;
    if (atBottom.current) setShowJump(false);
  };

  useEffect(() => {
    const el = listRef.current;
    const content = contentRef.current;
    if (!el || !content) return undefined;
    let lastHeight = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const grew = content.offsetHeight > lastHeight;
      lastHeight = content.offsetHeight;
      if (atBottom.current) {
        el.scrollTop = el.scrollHeight;
        lastScrollTop.current = el.scrollTop;
      } else if (grew && !skipJump.current) setShowJump(true);
      skipJump.current = false;
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Sending always shows what was just asked, wherever the reader had
  // scrolled to.
  const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id;
  const shownUserId = useRef(lastUserId);
  useLayoutEffect(() => {
    if (!lastUserId || lastUserId === shownUserId.current) return;
    shownUserId.current = lastUserId;
    const el = listRef.current;
    if (!el) return;
    atBottom.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
    setShowJump(false);
  }, [lastUserId]);

  // A finished-run summary is the answer to the whole task: show it from its
  // heading rather than from its last line.
  const lastAnalysis = [...messages].reverse().find((m) => m.kind === 'analysis')?.analysis?.runId;
  const shownAnalysis = useRef(lastAnalysis);
  useLayoutEffect(() => {
    if (!lastAnalysis || lastAnalysis === shownAnalysis.current) return;
    shownAnalysis.current = lastAnalysis;
    const el = listRef.current;
    const target = el?.querySelector(`[data-analysis="${lastAnalysis}"]`);
    if (!target) return;
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12;
    if (top + el.clientHeight < el.scrollHeight) {
      atBottom.current = false;
      skipJump.current = true;
    }
    el.scrollTop = top;
    lastScrollTop.current = el.scrollTop;
  }, [lastAnalysis]);

  const jump = () => {
    const el = listRef.current;
    atBottom.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setShowJump(false);
  };

  return (
    <section className="assistant-inner" aria-label="AI assistant">
      <div className="panel-header">
        <span className="panel-title">Assistant</span>
        {IS_LOCAL ? (
          aiModel ? (
            <span
              className={`sim-tag ai-model-tag${aiModel.shared ? ' is-shared' : ''}`}
              data-tooltip={`${aiModel.label} · ${aiModel.model}. ${aiModel.note ? `${aiModel.note} ` : ''}Every change it proposes needs your review.`}
            >
              {aiModel.shared && <Users size={12} aria-hidden="true" />}
              {aiModel.model}
              {aiModel.shared && <span className="sr-only"> (shared)</span>}
            </span>
          ) : (
            <span className="sim-tag" data-tooltip="Connect an AI model in AI settings to use the assistant.">
              No AI connected
            </span>
          )
        ) : (
          <span className="sim-tag" data-tooltip="Responses are prepared for a few sample tasks. No AI service is connected.">
            Simulated
          </span>
        )}
        {onConnectAI && (
          <button type="button" className="btn btn-secondary btn-sm assistant-connect" onClick={onConnectAI}>
            AI settings
          </button>
        )}
        {onAIMode && <ModeMenu mode={aiMode} onMode={onAIMode} />}
        <IconButton icon={X} label="Hide assistant" className="push-right" onClick={onClose} tooltipSide="left" />
      </div>
      <div className="assistant-messages" ref={listRef} onScroll={onScroll}>
        <div className="assistant-messages-content" ref={contentRef}>
        {messages.length === 0 ? (
          <EmptyConversation onSuggestion={onSuggestion} project={project} />
        ) : (
          messages.map((m) => (
            <Message
              key={m.id}
              message={m}
              proposalView={proposalView}
              handlers={handlers}
              onSuggestion={onSuggestion}
              onAction={onAction}
              onRetry={onRetry}
              onCancel={onCancel}
              onShowResults={onShowResults}
              onGoToCode={onGoToCode}
              busy={busy}
              mode={aiMode}
              actionHandlers={actionHandlers}
            />
          ))
        )}
        </div>
      </div>
      {showJump && (
        <button type="button" className="jump-latest" onClick={jump}>
          <ArrowDown size={16} aria-hidden="true" /> Latest
        </button>
      )}
      <Composer
        ref={composerRef}
        busy={busy}
        context={draftContext}
        onRemoveContext={onRemoveContext}
        onSend={onSend}
        onCancel={onCancel}
        suggestions={composerSuggestions}
        placeholder={project?.activePath ? `Ask about ${project.activePath.split('/').pop()}…` : 'Ask for a change…'}
      />
    </section>
  );
}
