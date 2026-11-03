// Predefined execution trace for price_stats.py (Step through and Debug).
//
// FUTURE INTEGRATION: a real debugger (for example debugpy or a Pyodide
// tracer) would produce these steps live. The UI only needs an array of
// { line, scope, globals, locals, output } objects.
//
// The trace is built by a hand-written simulation that mirrors the code in
// data/sampleProject.js (PRICE_STATS) line by line. Each step describes the
// line that is ABOUT to run and the variables at that moment, like pdb.

import { PRICE_STATS } from '../data/sampleProject.js';
import { normalizeWhitespace } from '../lib/text.js';

const repr = (value) => {
  if (Array.isArray(value)) return '[' + value.join(', ') + ']';
  if (typeof value === 'number' && !Number.isInteger(value)) return String(value);
  if (typeof value === 'function') return '<function average>';
  return String(value);
};
const typeOf = (name, value) => {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'number') return name === 'mean_price' ? 'float' : 'int';
  return typeof value;
};
const toVariables = (scope) =>
  Object.entries(scope).map(([name, value]) => ({ name, type: typeOf(name, value), value: repr(value) }));

function buildTrace() {
  const steps = [];
  const globals = {};
  const output = [];
  let locals = null; // set while inside average()

  const at = (line) =>
    steps.push({
      line,
      scope: locals ? 'average()' : 'module',
      globals: toVariables(globals),
      locals: locals ? toVariables(locals) : null,
      output: [...output],
    });

  at(3);
  globals.prices = [310, 425, 280, 515];
  at(6);
  globals.average = function average() {};
  at(13);
  // call average(prices)
  locals = { values: globals.prices };
  at(7);
  locals.total = 0;
  for (const value of locals.values) {
    at(8);
    locals.value = value;
    at(9);
    locals.total = locals.total + value;
  }
  at(8); // loop header runs once more and finds no items left
  at(10);
  const result = locals.total / locals.values.length;
  locals = null;
  globals.mean_price = result; // 382.5
  at(14);
  globals.above_mean = [];
  for (const price of globals.prices) {
    at(15);
    globals.price = price;
    at(16);
    if (price > globals.mean_price) {
      at(17);
      globals.above_mean = [...globals.above_mean, price];
    }
  }
  at(15);
  at(19);
  output.push(`Mean price: ${repr(globals.mean_price)}`);
  at(20);
  output.push(`Above mean: ${repr(globals.above_mean)}`);
  return { steps, finalGlobals: toVariables(globals), finalOutput: [...output] };
}

export const TRACE = buildTrace();

export const EXECUTABLE_LINES = new Set(TRACE.steps.map((s) => s.line));

// The trace is only valid for the original code (line numbers must match).
export function traceMatches(code) {
  return normalizeWhitespace(code) === normalizeWhitespace(PRICE_STATS);
}

// Index of the next step after `fromIndex` that stops on a breakpoint,
// or -1 if execution would run to the end.
export function nextBreakpointIndex(fromIndex, breakpointLines) {
  for (let i = fromIndex + 1; i < TRACE.steps.length; i++) {
    if (breakpointLines.includes(TRACE.steps[i].line)) return i;
  }
  return -1;
}
