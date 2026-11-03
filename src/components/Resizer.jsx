import { useRef } from 'react';

// A 1px separator with a ~6px draggable hit area. While dragging, the
// `is-resizing` class on <body> turns off panel transitions so the panel
// follows the pointer without lag. Arrow keys resize too.
export default function Resizer({ orientation = 'vertical', value, onResize, label, step = 16, className = '' }) {
  const start = useRef(null);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, value };
    document.body.classList.add('is-resizing', orientation === 'vertical' ? 'resizing-col' : 'resizing-row');
  };
  const onPointerMove = (e) => {
    if (!start.current) return;
    const delta = orientation === 'vertical' ? e.clientX - start.current.x : e.clientY - start.current.y;
    onResize(start.current.value, delta);
  };
  const end = () => {
    start.current = null;
    document.body.classList.remove('is-resizing', 'resizing-col', 'resizing-row');
  };
  const onKeyDown = (e) => {
    const keys = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    onResize(value, e.key === keys[0] ? -step : step);
  };

  return (
    <div
      className={`resizer resizer-${orientation} ${className}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    />
  );
}
