import { useState } from 'react';
import { X, MessageSquarePlus, Table2 } from 'lucide-react';
import Dialog from './Dialog.jsx';
import FigureView from './FigureView.jsx';
import { MetricsList, MetricsComparison } from './MetricsTable.jsx';
import { RunStatus } from './runFormat.jsx';
import { TEST_ACTUAL, LINEAR_PRED, TREE_PRED } from '../data/sampleResults.js';
import { IS_LOCAL } from '../runtime/config.js';

const version = (run) => (run.versionLabel ? ` · ${run.versionLabel}` : '');

function RunColumn({ run }) {
  return (
    <div className="expanded-col">
      <div className="expanded-col-head">
        <span className="run-meta-title">Run #{run.number}</span>
        <span className="run-meta-detail">
          {run.path} · snapshot {run.snapshotHash}
          {version(run)}
        </span>
        <RunStatus status={run.status} />
      </div>
      {run.figures.length ? (
        run.figures.map((f) => (
          <div className="expanded-figure" key={f.id}>
            {f.panels.length > 1 && <p className="expanded-figure-title">{f.title}</p>}
            <FigureView figure={f} />
          </div>
        ))
      ) : (
        <p className="muted-text">This run didn’t create any charts.</p>
      )}
    </div>
  );
}

function SampleDataTable({ includeTree }) {
  return (
    <table className="metrics-table data-table">
      <caption>Test homes (sample data, $k)</caption>
      <thead>
        <tr>
          <th scope="col">Home</th>
          <th scope="col">Actual</th>
          <th scope="col">Linear regression</th>
          {includeTree && <th scope="col">Decision tree</th>}
        </tr>
      </thead>
      <tbody>
        {TEST_ACTUAL.map((actual, i) => (
          <tr key={i}>
            <th scope="row">{i + 1}</th>
            <td>{actual}</td>
            <td>{LINEAR_PRED[i].toFixed(1)}</td>
            {includeTree && <td>{TREE_PRED[i].toFixed(1)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Larger view of a run's charts, optionally compared with a second run.
export default function ResultsDialog({ runs, initialA, initialB, onClose, onAskModify }) {
  const [aId, setAId] = useState(initialA);
  const [bId, setBId] = useState(initialB || '');
  const [showData, setShowData] = useState(false);
  const runA = runs.find((r) => r.id === aId) || runs.at(-1);
  const runB = runs.find((r) => r.id === bId && r.id !== runA.id) || null;
  // The data table shows the demo's prepared sample predictions, so only in Demo mode.
  const hasPredictions = !IS_LOCAL && [runA, runB].some((r) => r?.metrics?.['Decision tree']);

  const runOptions = runs.map((r) => (
    <option key={r.id} value={r.id}>
      Run #{r.number} · {r.path}
      {version(r)}
    </option>
  ));

  return (
    <Dialog title="Results" onClose={onClose} className="dialog-results">
      <div className="dialog-header">
        <h2 className="dialog-title">Results</h2>
        {!IS_LOCAL && <span className="sample-tag">Sample data</span>}
        <div className="dialog-header-controls">
          <label className="field-inline">
            <span>Run</span>
            <select value={runA.id} onChange={(e) => setAId(e.target.value)}>
              {runOptions}
            </select>
          </label>
          <label className="field-inline">
            <span>Compare with</span>
            <select value={runB?.id || ''} onChange={(e) => setBId(e.target.value)}>
              <option value="">None</option>
              {runOptions}
            </select>
          </label>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" data-tooltip="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="dialog-body">
        <div className={`expanded-grid ${runB ? 'is-compare' : ''}`}>
          <RunColumn run={runA} />
          {runB && <RunColumn run={runB} />}
        </div>
        <div className="expanded-footer">
          <div className="expanded-metrics">
            <h3 className="section-title">Metrics on the 10 test homes</h3>
            {runB ? (
              <MetricsComparison runA={runA} runB={runB} />
            ) : runA.metrics ? (
              <MetricsList metrics={runA.metrics} />
            ) : (
              <p className="muted-text">This run didn’t print model metrics.</p>
            )}
            <p className="muted-text small">
              {IS_LOCAL
                ? 'Read from the program’s own `results` variable when the run ended.'
                : 'Calculated from the fixed sample predictions. A different model isn’t necessarily better: on this small sample, compare the errors before drawing conclusions.'}
            </p>
          </div>
          <div className="expanded-side-actions">
            {hasPredictions && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowData((s) => !s)} aria-expanded={showData}>
                <Table2 size={16} aria-hidden="true" /> {showData ? 'Hide' : 'Show'} data table
              </button>
            )}
            {runA.figures.length > 0 && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAskModify(runA, runA.figures.at(-1))}>
                <MessageSquarePlus size={16} aria-hidden="true" /> Ask AI to modify
              </button>
            )}
          </div>
        </div>
        {showData && hasPredictions && <SampleDataTable includeTree />}
      </div>
    </Dialog>
  );
}
