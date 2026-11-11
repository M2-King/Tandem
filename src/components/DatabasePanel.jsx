import { useState } from 'react';
import { ChevronRight, Database, KeyRound, Plus, RefreshCw, Table2, Eye, GraduationCap, Loader2 } from 'lucide-react';
import IconButton from './IconButton.jsx';

// SQL workspace, left side: which database is open and what is in it.
// Clicking a table shows its first 100 rows; the arrow lists its columns.
export default function DatabasePanel({ sql, onNewDatabase, onPreview }) {
  const [open, setOpen] = useState({});
  const { databases, dbPath, choosing, tables, status } = sql;

  return (
    <section className="db-panel" aria-label="Database">
      <div className="panel-header">
        <span className="panel-title">Database</span>
        {status === 'opening' && <Loader2 size={13} className="spin push-right" aria-label="Opening" />}
        <IconButton icon={RefreshCw} label="Reload from disk" className={`icon-btn-sm ${status === 'opening' ? '' : 'push-right'}`} onClick={sql.reload} disabled={!dbPath} />
        <IconButton icon={Plus} label="New database…" className="icon-btn-sm" onClick={onNewDatabase} />
      </div>

      {databases.length > 0 ? (
        <label className="db-choose">
          <span className="sr-only">Database file</span>
          <select className="field-input mono" value={dbPath || choosing || ''} onChange={(e) => sql.open(e.target.value)} disabled={status !== 'idle'}>
            {!dbPath && !choosing && <option value="">Choose a database…</option>}
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="db-empty">
          <p>No database in this project yet.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={sql.createPractice}>
            <GraduationCap size={14} aria-hidden="true" /> Create the practice database
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onNewDatabase}>
            <Plus size={14} aria-hidden="true" /> New empty database
          </button>
        </div>
      )}

      {dbPath && (
        <ul className="db-tables" role="tree" aria-label={`Tables in ${dbPath}`}>
          {tables.length === 0 && <li className="db-note">No tables yet. Try CREATE TABLE …</li>}
          {tables.map((t) => (
            <li key={t.name} role="treeitem" aria-expanded={!!open[t.name]}>
              <div className="db-table">
                <button type="button" className="db-twisty" aria-label={open[t.name] ? `Hide columns of ${t.name}` : `Show columns of ${t.name}`} onClick={() => setOpen((o) => ({ ...o, [t.name]: !o[t.name] }))}>
                  <ChevronRight size={13} className={`folder-chevron ${open[t.name] ? 'is-open' : ''}`} aria-hidden="true" />
                </button>
                <button type="button" className="db-table-name" onClick={() => (onPreview ? onPreview(t.name) : sql.preview(t.name))} title={`Show rows of ${t.name}`} disabled={status !== 'idle'}>
                  {t.type === 'view' ? <Eye size={14} aria-hidden="true" /> : <Table2 size={14} aria-hidden="true" />}
                  <span className="mono">{t.name}</span>
                  <span className="db-count">{t.count ?? ''}</span>
                </button>
              </div>
              {open[t.name] && (
                <ul className="db-columns" role="group">
                  {t.columns.map((c) => (
                    <li key={c.name} role="treeitem">
                      {c.pk ? <KeyRound size={11} aria-label="primary key" /> : <span className="db-dot" aria-hidden="true" />}
                      <span className="mono">{c.name}</span>
                      <span className="db-type">{c.type || 'any'}{c.notnull && !c.pk ? ' · required' : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {databases.length > 0 && !databases.includes('practice.db') && (
        <button type="button" className="btn btn-ghost btn-sm db-practice" onClick={sql.createPractice}>
          <GraduationCap size={14} aria-hidden="true" /> Add the practice database
        </button>
      )}
      <p className="db-hint">
        <Database size={12} aria-hidden="true" /> SQLite. Changes are saved to the .db file as soon as a statement runs.
      </p>
    </section>
  );
}
