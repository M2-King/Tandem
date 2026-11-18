import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import DOMPurify from 'dompurify';

// ipywidgets in a notebook's output: the controls a cell displays (text
// boxes, dropdowns, sliders, checkboxes, buttons, boxes, Output, progress
// bars, tabs), drawn from the kernel's widget models (notebookSession.js).
// A change goes back to the kernel at once, so Python sees it: a later cell
// reads `slider.value`, a button runs its on_click.
//
// Models are only in the running kernel: a notebook opened again shows the
// widget's text until its cell runs again.

const REF = 'IPY_MODEL_';
const ref = (value) => (typeof value === 'string' && value.startsWith(REF) ? value.slice(REF.length) : null);
const clean = (html) => DOMPurify.sanitize(String(html ?? ''), { FORBID_TAGS: ['style', 'iframe', 'form', 'script'], FORBID_ATTR: ['style'] });

export const WIDGET_MIME = 'application/vnd.jupyter.widget-view+json';

function useWidgets(session) {
  useSyncExternalStore(session.subscribe, session.getWidgetVersion);
  return session.widgets;
}

// Layout (width, display, …) and the description's width from its style model.
function layoutOf(widgets, state) {
  const layout = widgets.get(ref(state.layout))?.state || {};
  const style = {};
  if (layout.display === 'none' || layout.visibility === 'hidden') style.display = 'none';
  for (const key of ['width', 'height', 'min_width', 'max_width', 'margin', 'padding', 'flex', 'align_items', 'justify_content', 'flex_flow']) {
    if (layout[key]) style[key.replace(/_(\w)/g, (_, c) => c.toUpperCase())] = layout[key];
  }
  if (layout.border) style.border = layout.border;
  return style;
}
const descriptionWidth = (widgets, state) => widgets.get(ref(state.style))?.state?.description_width || '';

// blank: the description's room kept empty (a checkbox's indent), so it lines up.
function Described({ widgets, state, children, className = '', blank = false }) {
  const width = descriptionWidth(widgets, state);
  return (
    <div className={`nbw-row ${className}`} style={layoutOf(widgets, state)}>
      {blank ? (
        <span className="nbw-label" aria-hidden="true" style={width ? { width, minWidth: width } : undefined} />
      ) : state.description ? (
        <label className="nbw-label" style={width ? { width, minWidth: width } : undefined} title={state.description_tooltip || state.tooltip || undefined}>
          {state.description_allow_html ? <span dangerouslySetInnerHTML={{ __html: clean(state.description) }} /> : state.description}
        </label>
      ) : null}
      <div className="nbw-control">{children}</div>
    </div>
  );
}

// Sends at most every `ms` while it changes, and always the last value.
function useThrottled(send, ms) {
  const timer = useRef(null);
  const next = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (value, now = false) => {
    next.current = value;
    if (now) {
      clearTimeout(timer.current);
      timer.current = null;
      send(value);
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      send(next.current);
    }, ms);
  };
}

const formatNumber = (value, step) => {
  if (typeof value !== 'number') return String(value ?? '');
  const decimals = String(step ?? '').split('.')[1]?.length;
  return decimals ? value.toFixed(Math.min(decimals, 6)) : String(value);
};

function Slider({ widgets, state, set, float }) {
  const [shown, setShown] = useState(state.value);
  useEffect(() => setShown(state.value), [state.value]);
  const send = useThrottled((v) => set({ value: v }), state.continuous_update === false ? 1e9 : 120);
  const vertical = state.orientation === 'vertical';
  const parse = (v) => (float ? parseFloat(v) : parseInt(v, 10));
  return (
    <Described widgets={widgets} state={state} className={vertical ? 'is-vertical' : ''}>
      <input
        type="range"
        className="nbw-slider"
        min={state.min}
        max={state.max}
        step={state.step ?? (float ? 0.1 : 1)}
        value={shown ?? 0}
        disabled={!!state.disabled}
        aria-label={state.description || 'Slider'}
        onChange={(e) => {
          const v = parse(e.target.value);
          setShown(v);
          send(v);
        }}
        onPointerUp={(e) => send(parse(e.currentTarget.value), true)}
        onKeyUp={(e) => send(parse(e.currentTarget.value), true)}
      />
      {state.readout !== false && <output className="nbw-readout">{formatNumber(shown, float ? state.step : null)}</output>}
    </Described>
  );
}

function RangeSlider({ widgets, state, set, float }) {
  const [lo, hi] = Array.isArray(state.value) ? state.value : [state.min, state.max];
  const parse = (v) => (float ? parseFloat(v) : parseInt(v, 10));
  const send = useThrottled((v) => set({ value: v }), 120);
  return (
    <Described widgets={widgets} state={state}>
      <input type="range" className="nbw-slider" min={state.min} max={state.max} step={state.step} value={lo} disabled={!!state.disabled} aria-label="From"
        onChange={(e) => send([Math.min(parse(e.target.value), hi), hi])} />
      <input type="range" className="nbw-slider" min={state.min} max={state.max} step={state.step} value={hi} disabled={!!state.disabled} aria-label="To"
        onChange={(e) => send([lo, Math.max(parse(e.target.value), lo)])} />
      <output className="nbw-readout">{formatNumber(lo, state.step)}–{formatNumber(hi, state.step)}</output>
    </Described>
  );
}

function TextBox({ widgets, state, set, event, multiline, password }) {
  const [text, setText] = useState(state.value ?? '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(state.value ?? '');
  }, [state.value]);
  const send = useThrottled((v) => set({ value: v }), state.continuous_update === false ? 1e9 : 300);
  const props = {
    className: 'field-input nbw-input',
    value: text,
    placeholder: state.placeholder || undefined,
    disabled: !!state.disabled,
    'aria-label': state.description || 'Text',
    onFocus: () => (focused.current = true),
    onBlur: (e) => {
      focused.current = false;
      send(e.target.value, true);
    },
    onChange: (e) => {
      setText(e.target.value);
      send(e.target.value);
    },
  };
  return (
    <Described widgets={widgets} state={state}>
      {multiline ? (
        <textarea {...props} rows={state.rows || 3} />
      ) : (
        <input
          {...props}
          type={password ? 'password' : 'text'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              send(e.currentTarget.value, true);
              event({ event: 'submit' });
            }
          }}
        />
      )}
    </Described>
  );
}

function NumberBox({ widgets, state, set, float }) {
  const [text, setText] = useState(String(state.value ?? ''));
  useEffect(() => setText(String(state.value ?? '')), [state.value]);
  const commit = (raw) => {
    let v = float ? parseFloat(raw) : parseInt(raw, 10);
    if (Number.isNaN(v)) return setText(String(state.value ?? ''));
    if (state.min != null) v = Math.max(state.min, v);
    if (state.max != null) v = Math.min(state.max, v);
    setText(String(v));
    if (v !== state.value) set({ value: v });
  };
  return (
    <Described widgets={widgets} state={state}>
      <input
        className="field-input nbw-input nbw-number"
        type="number"
        value={text}
        step={state.step ?? (float ? 'any' : 1)}
        min={state.min ?? undefined}
        max={state.max ?? undefined}
        disabled={!!state.disabled}
        aria-label={state.description || 'Number'}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
      />
    </Described>
  );
}

function Choice({ widgets, state, set, kind }) {
  const labels = state._options_labels || [];
  const index = state.index;
  if (kind === 'dropdown' || kind === 'select') {
    return (
      <Described widgets={widgets} state={state}>
        <select
          className="field-input nbw-select"
          size={kind === 'select' ? Math.min(state.rows || 5, Math.max(2, labels.length)) : undefined}
          value={index ?? ''}
          disabled={!!state.disabled}
          aria-label={state.description || 'Choose'}
          onChange={(e) => set({ index: e.target.value === '' ? null : Number(e.target.value) })}
        >
          {index == null && kind === 'dropdown' && <option value="">—</option>}
          {labels.map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
      </Described>
    );
  }
  if (kind === 'multiple') {
    const chosen = Array.isArray(index) ? index : [];
    return (
      <Described widgets={widgets} state={state}>
        <select
          multiple
          className="field-input nbw-select"
          size={Math.min(state.rows || 5, Math.max(2, labels.length))}
          value={chosen.map(String)}
          disabled={!!state.disabled}
          aria-label={state.description || 'Choose'}
          onChange={(e) => set({ index: [...e.target.selectedOptions].map((o) => Number(o.value)) })}
        >
          {labels.map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
      </Described>
    );
  }
  // radio buttons and toggle buttons
  return (
    <Described widgets={widgets} state={state}>
      <div className={kind === 'toggles' ? 'nbw-toggles' : 'nbw-radios'} role="radiogroup" aria-label={state.description || 'Choose'}>
        {labels.map((label, i) =>
          kind === 'toggles' ? (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={index === i}
              className={`btn btn-sm ${index === i ? 'btn-primary' : 'btn-secondary'}`}
              disabled={!!state.disabled}
              onClick={() => set({ index: i })}
            >
              {label}
            </button>
          ) : (
            <label key={i} className="nbw-radio">
              <input type="radio" checked={index === i} disabled={!!state.disabled} onChange={() => set({ index: i })} /> {label}
            </label>
          )
        )}
      </div>
    </Described>
  );
}

const BUTTON_STYLE = { primary: 'btn-primary', success: 'nbw-success', info: 'nbw-info', warning: 'nbw-warning', danger: 'nbw-danger' };

function Children({ session, widgets, state, cellId, renderOutput }) {
  return (state.children || []).map((child, i) => {
    const id = ref(child);
    return id ? <WidgetModel key={id + i} session={session} widgets={widgets} id={id} cellId={cellId} renderOutput={renderOutput} /> : null;
  });
}

function Tabs({ session, widgets, state, cellId, renderOutput, accordion }) {
  const children = (state.children || []).map(ref).filter(Boolean);
  const titles = state.titles || state._titles || {};
  const titleOf = (i) => (Array.isArray(titles) ? titles[i] : titles[i] ?? titles[String(i)]) || `Page ${i + 1}`;
  const [open, setOpen] = useState(state.selected_index ?? 0);
  useEffect(() => setOpen(state.selected_index ?? 0), [state.selected_index]);
  return (
    <div className={accordion ? 'nbw-accordion' : 'nbw-tabs'} style={layoutOf(widgets, state)}>
      {!accordion && (
        <div className="nbw-tab-row" role="tablist">
          {children.map((id, i) => (
            <button key={id} type="button" role="tab" aria-selected={open === i} className={`results-tab ${open === i ? 'is-active' : ''}`} onClick={() => setOpen(i)}>
              {titleOf(i)}
            </button>
          ))}
        </div>
      )}
      {children.map((id, i) => (
        <div key={id}>
          {accordion && (
            <button type="button" className="nbw-accordion-head" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
              {titleOf(i)}
            </button>
          )}
          {open === i && <WidgetModel session={session} widgets={widgets} id={id} cellId={cellId} renderOutput={renderOutput} />}
        </div>
      ))}
    </div>
  );
}

function WidgetModel({ session, widgets, id, cellId, renderOutput }) {
  const model = widgets.get(id);
  if (!model) return null;
  const state = model.state;
  const set = (patch) => session.setWidget(id, patch, cellId);
  const event = (content) => session.widgetEvent(id, content, cellId);
  const props = { widgets, state, set, event };
  switch (state._model_name) {
    case 'VBoxModel':
    case 'BoxModel':
    case 'GridBoxModel':
      return (
        <div className="nbw-box is-column" style={layoutOf(widgets, state)}>
          <Children session={session} widgets={widgets} state={state} cellId={cellId} renderOutput={renderOutput} />
        </div>
      );
    case 'HBoxModel':
      return (
        <div className="nbw-box is-row" style={layoutOf(widgets, state)}>
          <Children session={session} widgets={widgets} state={state} cellId={cellId} renderOutput={renderOutput} />
        </div>
      );
    case 'TabModel':
      return <Tabs session={session} widgets={widgets} state={state} cellId={cellId} renderOutput={renderOutput} />;
    case 'AccordionModel':
    case 'StackModel':
      return <Tabs session={session} widgets={widgets} state={state} cellId={cellId} renderOutput={renderOutput} accordion />;
    case 'IntSliderModel':
      return <Slider {...props} />;
    case 'FloatSliderModel':
      return <Slider {...props} float />;
    case 'IntRangeSliderModel':
      return <RangeSlider {...props} />;
    case 'FloatRangeSliderModel':
      return <RangeSlider {...props} float />;
    case 'TextModel':
    case 'ComboboxModel':
      return <TextBox {...props} />;
    case 'PasswordModel':
      return <TextBox {...props} password />;
    case 'TextareaModel':
      return <TextBox {...props} multiline />;
    case 'IntTextModel':
    case 'BoundedIntTextModel':
      return <NumberBox {...props} />;
    case 'FloatTextModel':
    case 'BoundedFloatTextModel':
      return <NumberBox {...props} float />;
    case 'DropdownModel':
      return <Choice {...props} kind="dropdown" />;
    case 'SelectModel':
      return <Choice {...props} kind="select" />;
    case 'SelectMultipleModel':
      return <Choice {...props} kind="multiple" />;
    case 'RadioButtonsModel':
      return <Choice {...props} kind="radios" />;
    case 'ToggleButtonsModel':
      return <Choice {...props} kind="toggles" />;
    case 'CheckboxModel':
      return (
        <Described widgets={widgets} state={{ ...state, description: '' }} blank={state.indent !== false}>
          <label className="nbw-check">
            <input type="checkbox" checked={!!state.value} disabled={!!state.disabled} onChange={(e) => set({ value: e.target.checked })} />
            {state.description}
          </label>
        </Described>
      );
    case 'ToggleButtonModel':
      return (
        <Described widgets={widgets} state={{ ...state, description: '' }}>
          <button
            type="button"
            aria-pressed={!!state.value}
            className={`btn btn-sm ${state.value ? 'btn-primary' : 'btn-secondary'}`}
            disabled={!!state.disabled}
            title={state.tooltip || undefined}
            onClick={() => set({ value: !state.value })}
          >
            {state.description || 'Toggle'}
          </button>
        </Described>
      );
    case 'ButtonModel':
      return (
        <div className="nbw-row" style={layoutOf(widgets, state)}>
          <button
            type="button"
            className={`btn btn-sm ${BUTTON_STYLE[state.button_style] || 'btn-secondary'}`}
            disabled={!!state.disabled}
            title={state.tooltip || undefined}
            onClick={() => event({ event: 'click' })}
          >
            {state.description || 'Button'}
          </button>
        </div>
      );
    case 'LabelModel':
      return (
        <Described widgets={widgets} state={state}>
          <span className="nbw-text">{state.value}</span>
        </Described>
      );
    case 'HTMLModel':
    case 'HTMLMathModel':
      return (
        <Described widgets={widgets} state={state}>
          <div className="nbw-html" dangerouslySetInnerHTML={{ __html: clean(state.value) }} />
        </Described>
      );
    case 'IntProgressModel':
    case 'FloatProgressModel': {
      const span = (state.max ?? 100) - (state.min ?? 0) || 1;
      const pct = Math.max(0, Math.min(100, (((state.value ?? 0) - (state.min ?? 0)) / span) * 100));
      return (
        <Described widgets={widgets} state={state}>
          <div className={`nbw-progress is-${state.bar_style || 'plain'}`} role="progressbar" aria-valuenow={state.value} aria-valuemin={state.min} aria-valuemax={state.max}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </Described>
      );
    }
    case 'ColorPickerModel':
      return (
        <Described widgets={widgets} state={state}>
          <input type="color" value={state.value || '#000000'} disabled={!!state.disabled} onChange={(e) => set({ value: e.target.value })} aria-label={state.description || 'Colour'} />
        </Described>
      );
    case 'OutputModel':
      return (
        <div className="nbw-output" style={layoutOf(widgets, state)}>
          {(state.outputs || []).map((o, i) => (
            <div key={i}>{renderOutput(o)}</div>
          ))}
        </div>
      );
    case 'LayoutModel':
    case 'DescriptionStyleModel':
    case 'SliderStyleModel':
    case 'ButtonStyleModel':
    case 'ProgressStyleModel':
    case 'ToggleButtonsStyleModel':
    case 'CheckboxStyleModel':
    case 'TextStyleModel':
    case 'HTMLStyleModel':
    case 'LabelStyleModel':
      return null;
    default:
      return (
        <p className="nbw-unsupported">
          This control ({String(state._model_name || 'unknown').replace(/Model$/, '')}) can’t be shown in Tandem yet.
        </p>
      );
  }
}

// One widget view in a cell's output (application/vnd.jupyter.widget-view+json).
export default function WidgetView({ session, view, fallback, cellId, renderOutput }) {
  const widgets = useWidgets(session);
  const id = view?.model_id;
  if (!id || !widgets.has(id)) {
    return (
      <div className="nbw-missing">
        {fallback && <pre className="nb-stream">{fallback}</pre>}
        <p className="nbw-note">Run this cell to use its controls.</p>
      </div>
    );
  }
  return (
    <div className="nbw-root">
      <WidgetModel session={session} widgets={widgets} id={id} cellId={cellId} renderOutput={renderOutput} />
    </div>
  );
}
