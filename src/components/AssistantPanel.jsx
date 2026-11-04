import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Square, X, Check, Loader2, Code2, BarChart3, AlertCircle, ArrowDown, RotateCcw, ChevronRight, MessageSquareText, Wrench, Lightbulb, FileCode2, Table2, History } from 'lucide-react';
import { MetricsList } from './MetricsTable.jsx';
import TandemMark from './TandemMark.jsx';
import Markdown from './Markdown.jsx';
import ProposalCard from './ProposalCard.jsx';
import IconButton from './IconButton.jsx';
import { DEMO_PROMPTS } from '../services/aiService.js';

const chipIcon = (type) => (type === 'chart' ? BarChart3 : type === 'error' ? AlertCircle : Code2);

function ContextChip({ chip, onRemove }) {
  const Icon = chipIcon(chip.type);
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

function Stages({ stages, working }) {
  return (
    <ol className="stages" aria-live="polite">
      {stages.map((s, i) => (
        <li key={i} className={s.done ? 'is-done' : 'is-active'}>
          {s.done ? <Check size={14} aria-hidden="true" /> : <Loader2 size={14} className="spin" aria-hidden="true" />}
          <span>{s.label}</span>
        </li>
      ))}
      {working && !stages.length && (
        <li className="is-active">
          <Loader2 size={14} className="spin" aria-hidden="true" />
          <span>Starting</span>
        </li>
      )}
    </ol>
  );
}

function Message({ message, proposalView, handlers, onSuggestion, onAction, onRetry, onCancel, busy }) {
  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        {message.context?.length > 0 && (
          <div className="msg-context">
            {message.context.map((c, i) => (
              <ContextChip key={i} chip={c} />
            ))}
          </div>
        )}
        <div className="msg-user-text">{message.text}</div>
      </div>
    );
  }

  if (message.kind === 'analysis' && message.analysis) return <RunAnalysis analysis={message.analysis} />;

  const working = message.status === 'working';
  const stateLabel = { working: 'Working', failed: 'Failed', cancelled: 'Cancelled' }[message.status];
  return (
    <article className={`msg msg-assistant status-${message.status}`} aria-label="Tandem reply">
      {/* The panel already says who is talking; only a status earns a header row. */}
      {stateLabel && (
        <header className="msg-head">
          <TandemMark size={14} className="msg-head-mark" />
          <span className={`msg-head-state state-${message.status}`}>{stateLabel}</span>
        </header>
      )}
      {(working || message.stages?.length > 0) && <Stages stages={message.stages || []} working={working} />}
      {working && (
        <button type="button" className="btn btn-ghost btn-sm stage-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
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
      {message.status === 'done' && message.text && (
        <div className={message.kind === 'limitation' ? 'msg-limitation' : undefined}>
          {message.kind === 'limitation' && <span className="limitation-tag">Demo limitation</span>}
          <Markdown text={message.text} />
        </div>
      )}
      {message.proposalId && proposalView(message.proposalId) && (
        <ProposalCard view={proposalView(message.proposalId)} handlers={handlers} />
      )}
      {message.action && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAction(message.action)}>
          <RotateCcw size={16} aria-hidden="true" /> {message.action.label}
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
function RunAnalysis({ analysis }) {
  return (
    <article className="msg-analysis" aria-label={`Results of run ${analysis.runNumber}`} data-analysis={analysis.runId}>
      <header className="analysis-heading">
        <h3 className="analysis-title">Analysis complete</h3>
        <p className="analysis-sub">
          Run #{analysis.runNumber} of {analysis.path} finished. Here’s a summary from its sample data:
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
      <div className="analysis-group analysis-metrics">
        <MetricsList metrics={analysis.metrics} />
      </div>
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

const STARTERS = [
  {
    icon: BarChart3,
    title: 'Compare model results',
    detail: 'Add a decision tree to main.py and compare it with linear regression',
    prompt: DEMO_PROMPTS.compare,
  },
  { icon: MessageSquareText, title: 'Explain main.py', detail: 'Walk through what the script does', prompt: DEMO_PROMPTS.explainMain },
  { icon: Wrench, title: 'Fix summary.py', detail: 'It stops with an error when it runs', prompt: DEMO_PROMPTS.fixSummary },
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

      <section className="assistant-section" aria-labelledby="starter-title">
        <h3 className="section-label" id="starter-title">
          Suggested
        </h3>
        <div className="group-card starters">
          {STARTERS.map(({ icon: Icon, title, detail, prompt }) => (
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
        <span className="sim-tag" data-tooltip="Responses are prepared for a few sample tasks. No AI service is connected.">
          Simulated
        </span>
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
              busy={busy}
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
