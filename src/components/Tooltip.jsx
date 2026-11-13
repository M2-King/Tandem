import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';

// One tooltip layer for the whole app. Any element with `data-tooltip`
// gets a tooltip on hover or keyboard focus. Rendering it at the top level
// (position: fixed) keeps it from being clipped by panels.
export default function TooltipLayer() {
  const [tip, setTip] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    const show = (target, delay) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (!target.isConnected) return;
        const rect = target.getBoundingClientRect();
        setTip({ text: target.dataset.tooltip, rect, side: target.dataset.tooltipSide || 'bottom' });
      }, delay);
    };
    const hide = () => {
      clearTimeout(timer.current);
      setTip(null);
    };
    const onOver = (e) => {
      const target = e.target.closest?.('[data-tooltip]');
      if (target && target.dataset.tooltip) show(target, 450);
      else hide();
    };
    const onFocus = (e) => {
      const target = e.target.closest?.('[data-tooltip]');
      if (target && target.dataset.tooltip && target.matches(':focus-visible')) show(target, 150);
    };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', hide);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', hide);
      document.removeEventListener('keydown', hide);
      window.removeEventListener('blur', hide);
      clearTimeout(timer.current);
    };
  }, []);

  if (!tip) return null;
  const { rect, side } = tip;
  const style = {};
  if (side === 'top') {
    style.left = rect.left + rect.width / 2;
    style.top = rect.top - 6;
    style.transform = 'translate(-50%, -100%)';
  } else if (side === 'left') {
    style.left = rect.left - 6;
    style.top = rect.top + rect.height / 2;
    style.transform = 'translate(-100%, -50%)';
  } else if (side === 'right') {
    style.left = rect.right + 8;
    style.top = rect.top + rect.height / 2;
    style.transform = 'translateY(-50%)';
  } else {
    style.left = Math.min(Math.max(rect.left + rect.width / 2, 60), window.innerWidth - 60);
    style.top = rect.bottom + 6;
    style.transform = 'translateX(-50%)';
  }
  // On the page itself, above dialogs too (they are on the page: Dialog.jsx).
  return createPortal(
    <div className="tooltip" role="tooltip" style={style}>
      {tip.text}
    </div>,
    document.body
  );
}
