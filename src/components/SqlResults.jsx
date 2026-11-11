import { useState } from 'react';
import { X, Loader2, AlertCircle, CheckCircle2, Square, RotateCcw, Copy } from 'lucide-react';
import IconButton from './IconButton.jsx';

// SQL workspace, bottom: what each statement of the last run returned, and
// the runs before it.

// A statement as one short line, without its comments.
const shortSql = (sql) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);

function cellText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'blob' in value) return `BLOB (${value.blob} bytes)`;
  return String(value);
}

const csvField = (v) => {
  const text = cellText(v) ?? '';
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function Grid({ result }) {
  return (
    <div className="sql-grid-wrap">
      <table className="sql-grid">
        <thead>
          <tr>
            <th className="sql-rownum" aria-label="Row" />
            {result.columns.map((c, i) => (
              <th key={i} className="mono">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, r) => (
            <tr key={r}>
              <td className="sql-rownum">{r + 1}</td>
              {row.map((v, i) => {
                const text = cellText(v);
                return (
                  <td key={i} className={`mono ${text === null ? 'is-null' : typeof v === 'number' ? 'is-number' : ''}`}>
                    {text === null ? 'NULL' : text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Statement({ result, index, onCopied }) {
  if (result.error) {
    return (
      <div className="sql-statement">
        <div className="callout callout-error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <div className="callout-body">
            <p className="callout-title">
              Error in statement {index + 1}
              {result.line ? `, line ${result.line}` : ''}
            </p>
            <p className="mono">{result.error}</p>
            {result.sql && <p className="sql-snippet mono">{shortSql(result.sql)}</p>}
          </div>
        </div>
      </div>
    );
  }
  const query = result.columns.length > 0;
  const copy = async () => {
    const text = [result.columns.map(csvField).join(','), ...result.rows.map((r) => r.map(csvField).join(','))].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onCopied('Copied as CSV');
    } catch {
      onCopied('Couldn’t copy to the clipboard');
    }
  };
  return (
    <div className="sql-statement">
      <div className="sql-statement-head">
        <span className="sql-index">{index + 1}</span>
        <span className="sql-snippet mono" title={result.sql}>
          {shortSql(result.sql)}
        </span>
        <span className="sql-meta">
          {query
            ? `${result.total} row${result.total === 1 ? '' : 's'}${result.truncated ? ` (first ${result.rows.length} shown)` : ''}`
            : result.modified
              ? `${result.modified} row${result.modified === 1 ? '' : 's'} changed`
              : 'Done'}
          {' · '}
          {result.ms} ms
        </span>
        {query && result.rows.length > 0 && <IconButton icon={Copy} label="Copy as CSV" className="icon-btn-sm" onClick={copy} />}
      </div>
      {query ? (
        result.rows.length ? (
          <Grid result={result} />
        ) : (
          <p className="sql-empty">No rows.</p>
        )
      ) : (
        <p className="sql-done">
          <CheckCircle2 size={14} aria-hidden="true" /> {result.modified ? `${result.modified} row${result.modified === 1 ? '' : 's'} changed` : 'Done'}
        </p>
      )}
    </div>
  );
}

export default function SqlResults({ sql, onClose, onRerun, notify }) {
  const [tab, setTab] = useState('results');
  const { result, status, history } = sql;
  const results = result?.results || [];

  return (
    <section className="results-inner sql-results" aria-label="SQL results">
      <div className="results-header">
        <div className="results-tabs" role="tablist" aria-label="SQL results">
          {[
            ['results', 'Results'],
            ['history', 'History'],
          ].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={`results-tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>
              {label}
              {id === 'history' && history.length > 0 && <span className="tab-count">{history.length}</span>}
            </button>
          ))}
        </div>
        {status === 'running' && (
          <button type="button" className="btn btn-secondary btn-sm push-right" onClick={sql.stop}>
            <Square size={12} fill="currentColor" aria-hidden="true" /> Stop
          </button>
        )}
        <IconButton icon={X} label="Close results" className={`icon-btn-sm ${status === 'running' ? '' : 'push-right'}`} onClick={onClose} />
      </div>

      <div className="results-scroll sql-results-body">
        {tab === 'history' ? (
          history.length ? (
            <ul className="sql-history">
              {history.map((h, i) => (
                <li key={h.at + i}>
                  <span className={`sql-history-dot ${h.ok ? 'is-ok' : 'is-error'}`} aria-label={h.ok ? 'succeeded' : 'had an error'} />
                  <span className="sql-snippet mono" title={h.sql}>
                    {h.label || shortSql(h.sql)}
                  </span>
                  <span className="sql-meta">{new Date(h.at).toLocaleTimeString()}</span>
                  <IconButton icon={RotateCcw} label="Run again" className="icon-btn-sm" onClick={() => onRerun(h.sql)} disabled={status !== 'idle'} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-text pad">Runs appear here.</p>
          )
        ) : status === 'running' ? (
          <p className="muted-text pad">
            <Loader2 size={14} className="spin" aria-hidden="true" /> Running…
          </p>
        ) : !result ? (
          <p className="muted-text pad">Run SQL to see results here. Click a table on the left to see its rows.</p>
        ) : (
          <>
            <p className="sql-summary">
              {result.label || `${results.length} statement${results.length === 1 ? '' : 's'}`} on <span className="mono">{result.database}</span>
              {result.changed && ' · changes saved'}
              {result.ms != null && ` · ${result.ms} ms`}
            </p>
            {result.stopped && <p className="muted-text pad">Stopped. The database is as it was last saved.</p>}
            {result.error && <p className="field-error pad">{result.error}</p>}
            {results.map((r, i) => (
              <Statement key={i} result={r} index={i} onCopied={notify} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
