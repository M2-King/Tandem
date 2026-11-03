// Metrics are calculated from the fixed sample arrays (see lib/metrics.js).

const ROWS = [
  { key: 'mae', label: 'MAE', hint: 'Mean absolute error, $k (lower is better)', digits: 1 },
  { key: 'rmse', label: 'RMSE', hint: 'Root mean squared error, $k (lower is better)', digits: 1 },
  { key: 'r2', label: 'R²', hint: 'Coefficient of determination (higher is better, 1 is perfect)', digits: 3 },
];

const show = (m, row) => (m && m[row.key] != null ? m[row.key].toFixed(row.digits) : '—');

// Compact list for one run.
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
              {m.replace('Linear regression', 'Linear').replace('Decision tree', 'Tree')}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.filter((row) => models.some((m) => metrics[m][row.key] != null)).map((row) => (
          <tr key={row.key}>
            <th scope="row" title={row.hint}>
              {row.label}
            </th>
            {models.map((m) => (
              <td key={m}>{show(metrics[m], row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Side-by-side comparison of two runs.
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
          ROWS.map((row, i) => (
            <tr key={model + row.key} className={i === 0 ? 'group-start' : ''}>
              {i === 0 && (
                <th scope="rowgroup" rowSpan={ROWS.length}>
                  {model}
                </th>
              )}
              <th scope="row" title={row.hint}>
                {row.label}
              </th>
              <td>{show(runA.metrics?.[model], row)}</td>
              <td>{show(runB.metrics?.[model], row)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
