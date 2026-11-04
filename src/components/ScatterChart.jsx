import { useEffect, useRef, useState } from 'react';

// SVG scatter plot for one figure panel. Sized to its container. Each
// series has a colour AND a marker shape, so identity never relies on
// colour alone. Hovering a point shows its values.

const COLORS = { series1: 'var(--series-1)', series2: 'var(--series-2)' };
const M = { top: 10, right: 24, bottom: 38, left: 52 };

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => span / s <= count) || 10 * pow;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(v));

function useSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

function Marker({ shape, x, y, color, size = 4.5, active }) {
  const r = active ? size + 1.5 : size;
  if (shape === 'square') {
    return (
      <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1.5} fill={color} stroke="var(--bg-surface)" strokeWidth={1.5} />
    );
  }
  return <circle cx={x} cy={y} r={r} fill={color} stroke="var(--bg-surface)" strokeWidth={1.5} />;
}

export function LegendSwatch({ shape, color }) {
  return (
    <svg width="12" height="12" aria-hidden="true" className="legend-swatch">
      {shape === 'square' ? (
        <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill={COLORS[color]} />
      ) : shape === 'dash' ? (
        <line x1="0" y1="6" x2="12" y2="6" stroke="var(--text-muted)" strokeWidth="1.5" strokeDasharray="3 2" />
      ) : (
        <circle cx="6" cy="6" r="4.5" fill={COLORS[color]} />
      )}
    </svg>
  );
}

export default function ScatterChart({ panel, xUnit = '', yUnit = '' }) {
  const [ref, { width, height }] = useSize();
  const [hover, setHover] = useState(null);

  const all = panel.series.flatMap((s) => s.points);
  let xMin = Math.min(...all.map((p) => p.x));
  let xMax = Math.max(...all.map((p) => p.x));
  let yMin = Math.min(...all.map((p) => p.y));
  let yMax = Math.max(...all.map((p) => p.y));
  if (panel.diagonal) {
    // Same scale on both axes so the y = x line is meaningful.
    xMin = yMin = Math.min(xMin, yMin);
    xMax = yMax = Math.max(xMax, yMax);
  }
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = Math.max(0, height - M.top - M.bottom);
  // Fewer ticks when the chart is small, so labels never crowd.
  const xCount = Math.max(2, Math.min(6, Math.floor(plotW / 70)));
  const yCount = Math.max(2, Math.min(6, Math.floor(plotH / 34)));
  const xTicks = niceTicks(xMin, xMax, panel.diagonal ? Math.min(xCount, yCount) : xCount);
  // A shared scale keeps the dashed y = x line honest.
  const yTicks = panel.diagonal ? xTicks : niceTicks(yMin, yMax, yCount);
  const x0 = xTicks[0];
  const x1 = xTicks[xTicks.length - 1];
  const y0 = yTicks[0];
  const y1 = yTicks[yTicks.length - 1];

  const sx = (v) => M.left + ((v - x0) / (x1 - x0)) * plotW;
  const sy = (v) => M.top + plotH - ((v - y0) / (y1 - y0)) * plotH;

  const points = panel.series.flatMap((s, si) =>
    s.points.map((p, pi) => ({ ...p, px: sx(p.x), py: sy(p.y), series: s, key: `${si}-${pi}` }))
  );

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bestD = 16 * 16; // hit radius bigger than the mark
    for (const p of points) {
      const d = (p.px - mx) ** 2 + (p.py - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    setHover(best);
  };

  const ready = plotW > 40 && plotH > 40;
  const label = `${panel.title}: scatter plot of ${panel.yLabel} against ${panel.xLabel}, ${points.length} points.`;

  return (
    <div className="chart" ref={ref}>
      {ready && (
        <svg width={width} height={height} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={M.left} x2={M.left + plotW} y1={sy(t)} y2={sy(t)} className="grid-line" />
              <text x={M.left - 8} y={sy(t)} className="tick-label" textAnchor="end" dominantBaseline="middle">
                {fmt(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={`x${t}`} x={sx(t)} y={M.top + plotH + 16} className="tick-label" textAnchor="middle">
              {fmt(t)}
            </text>
          ))}
          <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} className="axis-line" />
          <text x={M.left + plotW / 2} y={height - 4} className="axis-label" textAnchor="middle">
            {panel.xLabel}
          </text>
          <text
            transform={`translate(12 ${M.top + plotH / 2}) rotate(-90)`}
            className="axis-label"
            textAnchor="middle"
          >
            {panel.yLabel}
          </text>
          {panel.diagonal && (
            <line x1={sx(x0)} y1={sy(y0)} x2={sx(x1)} y2={sy(y1)} className="diagonal-line" />
          )}
          {points.map((p) => (
            <Marker
              key={p.key}
              shape={p.series.shape}
              x={p.px}
              y={p.py}
              color={COLORS[p.series.color]}
              active={hover?.key === p.key}
            />
          ))}
        </svg>
      )}
      {hover && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(hover.px + 12, width - 170),
            top: Math.max(hover.py - 52, 0),
          }}
        >
          {panel.series.length > 1 && (
            <div className="chart-tooltip-title">
              <LegendSwatch shape={hover.series.shape} color={hover.series.color} /> {hover.series.name}
            </div>
          )}
          <div>
            {panel.xLabel}: <strong>{fmt(hover.x)}{xUnit}</strong>
          </div>
          <div>
            {panel.yLabel}: <strong>{fmt(hover.y)}{yUnit}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
