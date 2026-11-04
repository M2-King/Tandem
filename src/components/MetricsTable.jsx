// Metrics are calculated from the fixed sample arrays (see lib/metrics.js).

import { LegendSwatch } from './ScatterChart.jsx';

const ROWS = [
  { key: 'mae', label: 'MAE', hint: 'Mean absolute error, $k (lower is better)', digits: 1, better: 'low' },
  { key: 'rmse', label: 'RMSE', hint: 'Root mean squared error, $k (lower is better)', digits: 1, better: 'low' },
  { key: 'r2', label: 'R²', hint: 'Coefficient of determination (higher is better, 1 is perfect)', digits: 3, better: 'high' },
];

// The same marks the charts use, so a column reads as "the blue circles".
export const SERIES = {
  'Linear regression': { short: 'Linear', shape: 'circle', color: 'series1' },
  'Decision tree': { short: 'Tree', shape: 'square', color: 'series2' },
};

const show = (m, row) => (m && m[row.key] != null ? m[row.key].toFixed(row.digits) : '—');

// Index of the better value in a row, or -1 when there's nothing to compare.
function bestIndex(values, row) {
  const present = values.map((v, i) => [v, i]).filter(([v]) => v != null);
  if (present.length < 2) return -1;
  const sorted = present.sort((a, b) => (row.better === 'low' ? a[0] - b[0] : b[0] - a[0]));
  return sorted[0][0] === sorted[1][0] ? -1 : sorted[0][1];
}

function Cell({ value, best }) {
  return (
    <td className={best ? 'is-best' : undefined}>
      {value}
      {best && <span className="sr-only"> (better)</span>}
    </td>
  );
}

export function ModelHeading({ model }) {
  const s = SERIES[model];
  return (
    <span className="model-heading">
      {s && <LegendSwatch shape={s.shape} color={s.color} />}
      {s?.short ?? model}
    </span>
  );
}

// Compact table for one run. The better value in each row is set in the
// primary colour and weight; nothing else is coloured.
export function MetricsList({ metrics }) {
  if (!metrics) return null;
  const models = Object.keys(metrics);
  return (
    <table className="metrics-table">
      <thead>
        <tr>
          <th scope="col">Test data</th>
          {models.map((m) => (
            <th scope="col" key={m}>
              <ModelHeading model={m} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.filter((row) => models.some((m) => metrics[m][row.key] != null)).map((row) => {
          const best = bestIndex(models.map((m) => metrics[m]?.[row.key]), row);
          return (
            <tr key={row.key}>
              <th scope="row" title={row.hint}>
                {row.label}
              </th>
              {models.map((m, i) => (
                <Cell key={m} value={show(metrics[m], row)} best={i === best} />
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Side-by-side comparison of two runs; the better run per row is marked.
export function MetricsComparison({ runA, runB }) {
  const models = [...new Set([...Object.keys(runA?.metrics || {}), ...Object.keys(runB?.metrics || {})])];
  if (!models.length) return <p className="muted-text">Neither run printed model metrics.</p>;
  return (
    <table className="metrics-table metrics-compare">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">Metric</th>
          <th scope="col">Run #{runA.number}</th>
          <th scope="col">Run #{runB.number}</th>
        </tr>
      </thead>
      <tbody>
        {models.flatMap((model) =>
          ROWS.map((row, i) => {
            const best = bestIndex([runA.metrics?.[model]?.[row.key], runB.metrics?.[model]?.[row.key]], row);
            return (
              <tr key={model + row.key} className={i === 0 ? 'group-start' : ''}>
                {i === 0 && (
                  <th scope="rowgroup" rowSpan={ROWS.length}>
                    <ModelHeading model={model} />
                  </th>
                )}
                <th scope="row" title={row.hint}>
                  {row.label}
                </th>
                <Cell value={show(runA.metrics?.[model], row)} best={best === 0} />
                <Cell value={show(runB.metrics?.[model], row)} best={best === 1} />
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
