// Cowork preview: the sample team, projects, invitations and files.
//
// Everything here is fixture data for the UI prototype. Nothing is sent
// anywhere; results are prepared from the sample CSV below so they match it.

import { newNotebookText } from '../lib/notebook.js';

// People. `hue` gives each one a colour (avatars, cursors, cell badges).
export const PEOPLE = {
  wei: { id: 'wei', name: 'Wei Lin', email: 'wei.lin@example.edu', hue: 212 },
  priya: { id: 'priya', name: 'Priya Nair', email: 'priya.nair@example.edu', hue: 330 },
  tom: { id: 'tom', name: 'Tom Okafor', email: 'tom.okafor@example.edu', hue: 150 },
  sara: { id: 'sara', name: 'Sara Kim', email: 'sara.kim@example.edu', hue: 36 },
  marco: { id: 'marco', name: 'Marco Rossi', email: 'marco.rossi@example.edu', hue: 268 },
  ana: { id: 'ana', name: 'Ana Silva', email: 'ana.silva@example.edu', hue: 190 },
};

export const initialsOf = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

// A person for an email that isn't one of the sample people (a new invite).
export function personForEmail(email) {
  const known = Object.values(PEOPLE).find((p) => p.email === email);
  if (known) return known;
  const local = email.split('@')[0] || email;
  const name = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  let hash = 0;
  for (const ch of email) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return { id: email, name: name || email, email, hue: hash };
}

// ---------------------------------------------------------------- Data Study

export const SURVEY_CSV = `Student ID,Age,Major,Hours Studied,Score
S01,19,biology,6,72
S02,21,Economics ,9,81
S03,20,psychology,4,64
S04,22,Computer Science,12,90
S05,19, Biology,8,77
S06,23,economics,5,
S07,20,Psychology,7,70
S08,21,computer science,10,86
S09,,Biology,9,80
S10,22,Economics,11,88
S11,20,Psychology,3,58
S12,19,Computer Science,8,79
S13,21,biology,5,66
S14,22,Economics,7,74
S15,20,psychology,10,83
S16,23,Computer Science,14,94
S17,19,Biology,11,85
S18,21,Economics,4,61
S19,20,Psychology,6,68
S20,22,computer science,9,82
S21,21,Biology,7,73
S22,20,Economics,12,91
S23,19,Psychology,8,76
S24,22,Computer Science,6,71
`;

const CLEAN_DATA_PY = `"""Clean the survey answers before analysis.

Reads data/survey.csv, tidies the column names and majors, drops answers
without an age or a score, and saves data/clean_survey.csv for
analysis.ipynb.
"""
import pandas as pd

RAW = "data/survey.csv"
CLEAN = "data/clean_survey.csv"


def clean_columns(df):
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    return df


df = pd.read_csv(RAW)
print(f"Loaded {len(df)} rows from {RAW}")

df = clean_columns(df)
df["major"] = df["major"].str.strip().str.title()
df = df.dropna(subset=["age", "score"])
print(f"Kept {len(df)} rows with an age and a score")

df.to_csv(CLEAN, index=False)
print(f"Saved {CLEAN}")
`;

const README_MD = `# Data Study

A shared project for the study-habits survey.

1. Run \`clean_data.py\` once to make \`data/clean_survey.csv\`.
2. Work in \`analysis.ipynb\`.

Python runs on each person's own device, so everyone has their own
variables and results.
`;

// Notebook cells (ids are fixed so sample results can be matched to cells).
export const NB_CELLS = {
  intro: {
    id: 'intro',
    cell_type: 'markdown',
    source: '# Survey analysis\nHow study hours relate to scores, by major. Run the cells from the top.',
  },
  load: {
    id: 'load',
    cell_type: 'code',
    source: 'import pandas as pd\n\ndf = pd.read_csv("data/clean_survey.csv")\ndf.head()',
  },
  byMajor: {
    id: 'by-major',
    cell_type: 'code',
    source: 'df.groupby("major")["score"].mean().round(1)',
  },
  hist: {
    id: 'hist',
    cell_type: 'code',
    source: 'ax = df["score"].plot.hist(bins=6, title="Scores")',
  },
  income: {
    id: 'income',
    cell_type: 'code',
    source: 'df["income"].median()',
  },
};

function notebookText(cells) {
  const nb = {
    cells: cells.map((c) =>
      c.cell_type === 'code'
        ? { id: c.id, cell_type: 'code', metadata: {}, source: c.source, execution_count: null, outputs: [] }
        : { id: c.id, cell_type: 'markdown', metadata: {}, source: c.source }
    ),
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3 (ipykernel)', language: 'python' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return `${JSON.stringify(nb, null, 1)}\n`;
}

const DATA_STUDY_FILES = {
  'clean_data.py': CLEAN_DATA_PY,
  'analysis.ipynb': notebookText([NB_CELLS.intro, NB_CELLS.load, NB_CELLS.byMajor, NB_CELLS.hist, NB_CELLS.income]),
  'data/survey.csv': SURVEY_CSV,
  'README.md': README_MD,
};

const THESIS_FILES = {
  'responses.py': `"""Count survey responses per week."""\nimport pandas as pd\n\nresponses = pd.read_csv("responses.csv")\nprint(responses.groupby("week").size())\n`,
  'responses.csv': 'week,respondent\n1,r01\n1,r02\n2,r03\n',
  'notes.md': '# Thesis survey\n\nDraft questions and response counts.\n',
};

const LAB_FILES = {
  'week1.py': `"""Week 1: means and medians."""\nvalues = [4, 8, 15, 16, 23, 42]\nprint(sum(values) / len(values))\n`,
  'README.md': '# Stats 201 lab notes\n\nOne file per week.\n',
};

// A new shared project starts with these.
export function starterFiles(name) {
  return {
    'main.py': `print("Hello from ${name.replace(/"/g, "'")}")\n`,
    'notebook.ipynb': newNotebookText(),
  };
}

const ago = (minutes) => Date.now() - minutes * 60 * 1000;

// Projects. Membership roles: owner | member. Invitations are pending.
export function initialProjects() {
  return [
    {
      id: 'data-study',
      name: 'Data Study',
      members: [
        { id: 'wei', role: 'owner' },
        { id: 'priya', role: 'member' },
        { id: 'tom', role: 'member' },
      ],
      invites: [{ email: PEOPLE.sara.email, role: 'member', by: 'wei', at: ago(60 * 26) }],
      files: { ...DATA_STUDY_FILES },
      open: ['clean_data.py', 'analysis.ipynb'],
      edited: { by: 'priya', at: ago(4) },
      sample: true,
    },
    {
      id: 'lab-notes',
      name: 'Stats 201 Lab Notes',
      members: [
        { id: 'priya', role: 'owner' },
        { id: 'wei', role: 'member' },
        { id: 'tom', role: 'member' },
        { id: 'ana', role: 'member' },
      ],
      invites: [],
      files: { ...LAB_FILES },
      open: ['week1.py'],
      edited: { by: 'ana', at: ago(60 * 30) },
    },
    {
      id: 'thesis-survey',
      name: 'Thesis Survey',
      members: [
        { id: 'marco', role: 'owner' },
        { id: 'ana', role: 'member' },
      ],
      invites: [{ email: PEOPLE.wei.email, role: 'member', by: 'marco', at: ago(60 * 3) }],
      files: { ...THESIS_FILES },
      open: ['responses.py'],
      edited: { by: 'marco', at: ago(60 * 3) },
    },
  ];
}

// Who is where in the sample project. Each teammate moves through a few
// spots in turn, so the preview shows live activity.
export const PRESENCE_SCRIPT = {
  'data-study': [
    {
      person: 'priya',
      path: 'clean_data.py',
      steps: [
        { select: 'dropna(subset=["age", "score"])' },
        { caretAfter: 'df["major"] = df["major"].str.strip().str.title()' },
        { select: 'def clean_columns(df):' },
        { caretAfter: 'print(f"Kept {len(df)} rows with an age and a score")' },
      ],
    },
    {
      person: 'tom',
      path: 'analysis.ipynb',
      cell: 'income',
      steps: [{ caretAfter: 'df["income"]' }, { caretAfter: '.median()' }, { select: '"income"' }],
    },
  ],
};

// ---------------------------------------------------------------- sample results

function parseCsv(text) {
  const [head, ...rows] = text.trim().split('\n');
  const cols = head.split(',');
  return rows.map((row) => {
    const cells = row.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').trim()]));
  });
}

const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// The cleaned survey, as clean_data.py makes it.
export function cleanSurvey() {
  const raw = parseCsv(SURVEY_CSV);
  return {
    loaded: raw.length,
    rows: raw
      .filter((r) => r.Age !== '' && r.Score !== '')
      .map((r) => ({
        student_id: r['Student ID'],
        age: Number(r.Age),
        major: titleCase(r.Major.trim()),
        hours_studied: Number(r['Hours Studied']),
        score: Number(r.Score),
      })),
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function headTable(rows) {
  const cols = ['student_id', 'age', 'major', 'hours_studied', 'score'];
  const body = rows
    .slice(0, 5)
    .map((r, i) => `<tr><th>${i}</th>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="dataframe"><thead><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}

function headText(rows) {
  const cols = ['student_id', 'age', 'major', 'hours_studied', 'score'];
  const widths = cols.map((c) => Math.max(c.length, ...rows.slice(0, 5).map((r) => String(r[c]).length)));
  const line = (cells) => cells.map((v, i) => String(v).padStart(widths[i])).join('  ');
  return [`   ${line(cols)}`, ...rows.slice(0, 5).map((r, i) => `${i}  ${line(cols.map((c) => r[c]))}`)].join('\n');
}

function meansByMajor(rows) {
  const groups = {};
  for (const r of rows) (groups[r.major] ||= []).push(r.score);
  const majors = Object.keys(groups).sort();
  const width = Math.max(...majors.map((m) => m.length), 'major'.length);
  const lines = majors.map((m) => {
    const mean = groups[m].reduce((a, b) => a + b, 0) / groups[m].length;
    return `${m.padEnd(width)}    ${mean.toFixed(1)}`;
  });
  return `major\n${lines.join('\n')}\nName: score, dtype: float64`;
}

// A histogram of scores as SVG, drawn the way the notebook shows charts.
function histogramSvg(rows, bins = 6) {
  const scores = rows.map((r) => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const step = (max - min) / bins;
  const counts = Array(bins).fill(0);
  for (const s of scores) counts[Math.min(bins - 1, Math.floor((s - min) / step))] += 1;
  const W = 420;
  const H = 240;
  const pad = { l: 36, r: 12, t: 28, b: 30 };
  const top = Math.max(...counts);
  const bw = (W - pad.l - pad.r) / bins;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const bars = counts
    .map((c, i) => `<rect x="${(pad.l + i * bw + 1).toFixed(1)}" y="${y(c).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(H - pad.b - y(c)).toFixed(1)}" fill="#4c72b0"/>`)
    .join('');
  const ticks = [0, Math.ceil(top / 2), top]
    .map((v) => `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e4e4e4" stroke-width="0.8"/>`)
    .join('');
  const xs = [0, bins / 2, bins]
    .map((i) => `<text x="${pad.l + i * bw}" y="${H - pad.b + 16}" text-anchor="middle">${Math.round(min + i * step)}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="11" fill="#444"><rect width="${W}" height="${H}" fill="#fff"/><text x="${W / 2}" y="16" text-anchor="middle" font-size="12" fill="#222">Scores</text>${ticks}${bars}${xs}<text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle">Frequency</text></svg>`;
}

const normalize = (code) => code.replace(/\s+/g, ' ').trim();

// Sample results for the sample notebook's cells, by cell id. A cell whose
// code no longer matches gets no sample result (the preview says so).
export function sampleCellResult(cellId, code) {
  const original = Object.values(NB_CELLS).find((c) => c.id === cellId);
  if (!original || normalize(original.source) !== normalize(code)) return null;
  const { rows } = cleanSurvey();
  if (cellId === 'load') {
    return { outputs: [{ output_type: 'execute_result', data: { 'text/html': headTable(rows), 'text/plain': headText(rows) }, metadata: {} }] };
  }
  if (cellId === 'by-major') {
    return { outputs: [{ output_type: 'execute_result', data: { 'text/plain': meansByMajor(rows) }, metadata: {} }] };
  }
  if (cellId === 'hist') {
    return { outputs: [{ output_type: 'display_data', data: { 'image/svg+xml': histogramSvg(rows), 'text/plain': '<Figure size 640x480 with 1 Axes>' }, metadata: {} }] };
  }
  if (cellId === 'income') {
    return {
      error: true,
      outputs: [
        {
          output_type: 'error',
          ename: 'KeyError',
          evalue: "'income'",
          traceback: [
            'KeyError                                  Traceback (most recent call last)',
            'Cell In[4], line 1',
            '----> 1 df["income"].median()',
            '',
            "KeyError: 'income'",
          ],
        },
      ],
    };
  }
  return null;
}

// Sample output for running a script.
// Lines added after the sample code: a print of a string shows its text;
// anything else is noted as not run by the preview.
function addedLines(extra) {
  const lines = [];
  let skipped = false;
  for (const line of extra.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^print\((["'])([^"'\\]*)\1\)$/.exec(line);
    if (m) lines.push({ text: m[2], kind: 'out' });
    else if (!line.startsWith('#')) skipped = true;
  }
  if (skipped) lines.push({ text: '[Preview: the other lines you added have no sample result]', kind: 'err' });
  return lines;
}

export function sampleScriptResult(path, code, projectId) {
  const base = CLEAN_DATA_PY.trimEnd();
  if (projectId === 'data-study' && path === 'clean_data.py' && code.trimEnd().startsWith(base)) {
    const { loaded, rows } = cleanSurvey();
    return {
      status: 'success',
      lines: [
        { text: `Loaded ${loaded} rows from data/survey.csv`, kind: 'out' },
        { text: `Kept ${rows.length} rows with an age and a score`, kind: 'out' },
        { text: 'Saved data/clean_survey.csv', kind: 'out' },
        ...addedLines(code.trimEnd().slice(base.length)),
      ],
      variables: [
        { name: 'CLEAN', type: 'str', value: "'data/clean_survey.csv'" },
        { name: 'RAW', type: 'str', value: "'data/survey.csv'" },
        { name: 'df', type: 'DataFrame', value: `${rows.length} rows × 5 columns` },
      ],
    };
  }
  // A new project's main.py: a print of a string.
  const hello = /^print\("([^"\\]*)"\)\s*$/.exec(code.trim());
  if (hello) return { status: 'success', lines: [{ text: hello[1], kind: 'out' }], variables: [] };
  return null;
}
