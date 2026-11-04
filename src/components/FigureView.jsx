import ScatterChart, { LegendSwatch } from './ScatterChart.jsx';

// A figure the program drew itself (real runs): matplotlib's SVG, shown as
// an image. Inside <img>, scripts in an SVG never run.
function FigureImage({ figure }) {
  const src =
    figure.format === 'svg'
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(figure.data)}`
      : `data:image/png;base64,${figure.data}`;
  return (
    <figure className="figure figure-image">
      <img src={src} alt={`Chart: ${figure.title}`} draggable={false} />
    </figure>
  );
}

// One matplotlib-style figure: one or more panels side by side, with a
// legend when a panel has several series. Real runs show the program's own image.
export default function FigureView({ figure }) {
  if (figure.kind === 'image') return <FigureImage figure={figure} />;
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
