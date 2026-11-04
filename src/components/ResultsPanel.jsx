import { useEffect, useState } from 'react';
import { X, Play, Loader2, AlertCircle, RotateCcw, MessageSquarePlus, Wrench, Maximize2, ArrowRight, Info, GitCompare } from 'lucide-react';
import IconButton from './IconButton.jsx';
import FigureView from './FigureView.jsx';
import { MetricsList } from './MetricsTable.jsx';
import { RunStatus, runTitle, formatTime, formatDuration } from './runFormat.jsx';

const TABS = ['Output', 'Variables', 'Charts', 'Runs'];

function Empty({ title, text, children }) {
  return (
    <div className="results-empty">
      <p className="empty-title">{title}</p>
      {text && <p className="empty-text">{text}</p>}
      {children}
    </div>
  );
}

function RunMeta({ run }) {
  return (
    <div className="run-meta">
      <span className="run-meta-title">{runTitle(run)}</span>
      <span className="run-meta-detail" data-tooltip="Fingerprint of the code this run used. Later edits don't change it.">
        snapshot {run.snapshotHash} · {run.versionLabel}
      </span>
      <RunStatus status={run.status} />
      <span className="run-meta-detail">{formatDuration(run.durationMs)} (simulated)</span>
    </div>
  );
}

function OutputLines({ lines }) {
  return (
    <pre className="output-lines">
      {lines.map((l, i) => (
        <div key={i} className={l.kind === 'err' ? 'line-err' : undefined}>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function NoticeCallout({ notice, onResetFile, onDismiss }) {
  return (
    <div className="callout callout-warning" role="status">
      <Info size={16} aria-hidden="true" />
      <div className="callout-body">
        <p className="callout-title">{notice.title}</p>
        <p>{notice.detail}</p>
        <div className="callout-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onResetFile(notice.resetPath)}>
            <RotateCcw size={16} aria-hidden="true" /> Reset {notice.resetPath.split('/').pop()} to sample
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function OutputView({ session, traceView, notice, run, runTarget, actions }) {
  if (session?.mode === 'run') {
    return (
      <div className="results-scroll">
        <div className="run-meta">
          <span className="run-meta-title">Running {session.path}</span>
          <span className="run-state status-running">
            <Loader2 size={16} className="spin" aria-hidden="true" /> Running (simulated)
          </span>
        </div>
        <OutputLines lines={session.output} />
      </div>
    );
  }
  if (traceView) {
    return (
      <div className="results-scroll">
        <div className="run-meta">
          <span className="run-meta-title">{session.path}</span>
          <span className="run-meta-detail">{traceView.finished ? 'Finished' : 'Paused'} · simulated trace</span>
        </div>
        {traceView.output.length ? (
          <OutputLines lines={traceView.output.map((text) => ({ text }))} />
        ) : (
          <p className="muted-text pad">No output yet. The print calls are at lines 19–20.</p>
        )}
      </div>
    );
  }
  return (
    <div className="results-scroll">
      {notice && <NoticeCallout notice={notice} onResetFile={actions.onResetFile} onDismiss={actions.onDismissNotice} />}
      {notice ? (
        run && <p className="muted-text pad">Earlier results are kept in the Runs tab.</p>
      ) : run ? (
        <>
          <RunMeta run={run} />
          {run.error && (
            <div className="callout callout-error" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <div className="callout-body">
                <p className="callout-title">
                  {run.error.type} in {run.error.path}, line {run.error.line}
                </p>
                <p>{run.error.explanation}</p>
                <div className="callout-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => actions.onAskFix(run)}>
                    <Wrench size={16} aria-hidden="true" /> Ask AI to fix
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => actions.onGoToLine(run.error.path, run.error.line)}
                  >
                    Go to line {run.error.line}
                  </button>
                </div>
              </div>
            </div>
          )}
          {run.status === 'stopped' && (
            <p className="muted-text pad">Stopped before finishing. Output above is partial.</p>
          )}
          <OutputLines lines={run.output} />
        </>
      ) : (
        <Empty title="No output yet" text={`Run ${runTarget} to see its output here.`}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={actions.onRun}>
            <Play size={16} fill="currentColor" aria-hidden="true" /> Run {runTarget}
          </button>
        </Empty>
      )}
    </div>
  );
}

function VariableTable({ variables, changed = [], stepKey }) {
  return (
    <table className="var-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Type</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {variables.map((v) => {
          const isChanged = changed.includes(v.name);
          return (
            <tr key={isChanged ? `${v.name}-${stepKey}` : v.name} className={isChanged ? 'is-changed' : undefined}>
              <td className="var-name">
                {v.name}
                {isChanged && <span className="changed-mark">changed</span>}
              </td>
              <td className="var-type">{v.type}</td>
              <td className="var-value">{v.value}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function VariablesView({ traceView, run }) {
  if (traceView) {
    return (
      <div className="results-scroll">
        <div className="run-meta">
          <span className="run-meta-title">
            {traceView.finished ? 'Variables at the end' : `Before line ${traceView.line} runs`}
          </span>
          <span className="run-meta-detail">simulated trace of price_stats.py</span>
        </div>
        {traceView.locals && (
          <div className="var-group">
            <div className="var-group-title">Locals · {traceView.scope}</div>
            <VariableTable variables={traceView.locals} changed={traceView.changed} stepKey={traceView.stepKey} />
          </div>
        )}
        <div className="var-group">
          <div className="var-group-title">Globals</div>
          {traceView.globals.length ? (
            <VariableTable variables={traceView.globals} changed={traceView.changed} stepKey={traceView.stepKey} />
          ) : (
            <p className="muted-text pad">No variables yet.</p>
          )}
        </div>
      </div>
    );
  }
  if (!run) {
    return <Empty title="No variables yet" text="Variables appear after a run, or while stepping through code." />;
  }
  return (
    <div className="results-scroll">
      <div className="run-meta">
        <span className="run-meta-title">Variables at the end of run #{run.number}</span>
        <span className="run-meta-detail">{run.path} · sample data</span>
      </div>
      {run.variables.length ? (
        <VariableTable variables={run.variables} />
      ) : (
        <p className="muted-text pad">This run stopped before any variables were recorded.</p>
      )}
    </div>
  );
}

// The figure fills the panel; its controls live in the results header
// (see ChartControls) so there is one row of chrome, not two.
function ChartsView({ run, figure }) {
  if (!run) return <Empty title="No charts yet" text="Charts appear here when a run creates plots." />;
  if (!figure) {
    return (
      <Empty
        title={`Run #${run.number} didn’t create any charts`}
        text={run.path === 'main.py' ? undefined : 'Run main.py to see its charts.'}
      />
    );
  }
  return (
    <div className="charts-body">
      <FigureView figure={figure} />
      {run.metrics && (
        <aside className="charts-metrics" aria-label="Metrics">
          <MetricsList metrics={run.metrics} />
        </aside>
      )}
    </div>
  );
}

function ChartControls({ run, runs, figure, index, onIndex, actions }) {
  const others = runs.filter((r) => r.id !== run.id && r.figures.length > 0);
  return (
    <div className="results-actions">
      <span className="results-run-label" data-tooltip={`${figure.title} · sample data`}>
        Run #{run.number}
      </span>
      {run.figures.length > 1 && (
        <div className="segmented" role="tablist" aria-label="Figures">
          {run.figures.map((f, i) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={i === index}
              className={i === index ? 'is-active' : ''}
              onClick={() => onIndex(i)}
              data-tooltip={f.title}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <label className="compare-select" data-tooltip="Compare with another run">
          <GitCompare size={16} aria-hidden="true" />
          <select
            value=""
            onChange={(e) => e.target.value && actions.onExpand(run.id, e.target.value)}
            aria-label="Compare with another run"
          >
            <option value="">Compare with…</option>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                Run #{r.number} · {r.versionLabel}
              </option>
            ))}
          </select>
        </label>
      )}
      <IconButton icon={MessageSquarePlus} label="Ask AI to modify this chart" onClick={() => actions.onAskModify(run, figure)} />
      <IconButton icon={Maximize2} label="Expand results" onClick={() => actions.onExpand(run.id, null)} />
    </div>
  );
}

function RunsView({ runs, selectedRunId, onSelect, onCompare }) {
  const [picked, setPicked] = useState([]);
  if (!runs.length) return <Empty title="No runs yet" text="Each run is recorded with its code snapshot and results." />;
  const toggle = (id) =>
    setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(-2)));
  return (
    <div className="results-scroll">
      <div className="runs-toolbar">
        <span className="muted-text">Select two runs to compare them.</span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={picked.length !== 2}
          onClick={() => onCompare(picked[0], picked[1])}
        >
          <GitCompare size={16} aria-hidden="true" /> Compare
        </button>
      </div>
      <table className="runs-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Compare</span>
            </th>
            <th scope="col">Run</th>
            <th scope="col">Code snapshot</th>
            <th scope="col">Status</th>
            <th scope="col">Time</th>
            <th scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {[...runs].reverse().map((run) => (
            <tr key={run.id} className={run.id === selectedRunId ? 'is-selected' : undefined}>
              <td>
                <input
                  type="checkbox"
                  checked={picked.includes(run.id)}
                  onChange={() => toggle(run.id)}
                  aria-label={`Select run #${run.number} to compare`}
                />
              </td>
              <td className="run-cell-title">{runTitle(run)}</td>
              <td className="muted-text">
                <code>{run.snapshotHash}</code> · {run.versionLabel}
              </td>
              <td>
                <RunStatus status={run.status} />
              </td>
              <td className="muted-text">{formatTime(run.createdAt)}</td>
              <td>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelect(run.id)}>
                  {run.id === selectedRunId ? 'Showing' : 'Show'} <ArrowRight size={16} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ResultsPanel({ tab, onTab, session, traceView, notice, runs, run, runTarget, newCharts, actions, onClose }) {
  const [figureIndex, setFigureIndex] = useState(null);
  useEffect(() => setFigureIndex(null), [run?.id]);
  const figures = run?.figures || [];
  const index = Math.min(figureIndex ?? figures.length - 1, figures.length - 1); // newest figure first
  const figure = figures[index] || null;

  return (
    <section className="results-inner" aria-label="Results">
      <div className="results-header">
        <div className="results-tabs" role="tablist" aria-label="Results">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={`results-tab ${tab === name ? 'is-active' : ''}`}
              onClick={() => onTab(name)}
            >
              {name}
              {name === 'Charts' && newCharts && tab !== 'Charts' && (
                <span className="new-dot" aria-label="new charts" />
              )}
              {name === 'Charts' && figures.length > 0 && <span className="count-badge">{figures.length}</span>}
              {name === 'Runs' && runs.length > 0 && <span className="count-badge">{runs.length}</span>}
            </button>
          ))}
        </div>
        <span className="sim-tag" data-tooltip="Python execution is simulated with prepared sample results.">
          Simulated
        </span>
        <div className="push-right results-header-end">
          {tab === 'Charts' && figure && (
            <ChartControls run={run} runs={runs} figure={figure} index={index} onIndex={setFigureIndex} actions={actions} />
          )}
          <IconButton icon={X} label="Hide results" onClick={onClose} tooltipSide="left" />
        </div>
      </div>
      <div className="results-content" role="tabpanel" aria-label={tab}>
        {tab === 'Output' && (
          <OutputView session={session} traceView={traceView} notice={notice} run={run} runTarget={runTarget} actions={actions} />
        )}
        {tab === 'Variables' && <VariablesView traceView={traceView} run={run} />}
        {tab === 'Charts' && <ChartsView run={run} figure={figure} />}
        {tab === 'Runs' && (
          <RunsView runs={runs} selectedRunId={run?.id} onSelect={actions.onSelectRun} onCompare={actions.onExpand} />
        )}
      </div>
    </section>
  );
}
