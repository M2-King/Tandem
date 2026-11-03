import ScatterChart, { LegendSwatch } from './ScatterChart.jsx';

// One matplotlib-style figure: one or more panels side by side, with a
// legend when a panel has several series.
export default function FigureView({ figure }) {
  return (
    <figure className="figure">
      <div className="figure-panels">
        {figure.panels.map((panel, i) => (
          <div className="figure-panel" key={i}>
            <div className="figure-panel-head">
              <span className="figure-panel-title">{panel.title}</span>
              {panel.legend && (
                <span className="legend">
                  {panel.series.map((s) => (
                    <span key={s.name} className="legend-item">
                      <LegendSwatch shape={s.shape} color={s.color} /> {s.name}
                    </span>
                  ))}
                  {panel.diagonal && (
                    <span className="legend-item">
                      <LegendSwatch shape="dash" /> Perfect prediction
                    </span>
                  )}
                </span>
              )}
            </div>
            <ScatterChart panel={panel} />
          </div>
        ))}
      </div>
    </figure>
  );
}
