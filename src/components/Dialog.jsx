import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// Modal dialog. Keeps focus inside, closes on Escape, and returns focus to
// whatever was focused before it opened.
//
// Focus can fall out of a dialog onto the page (a focused button that gets
// disabled while it works, a part that is replaced): Escape still closes the
// topmost dialog then, and Tab goes back into it.
const open = []; // the dialogs on screen, topmost last

export default function Dialog({ title, onClose, children, className = '', labelledBy }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const focusables = () =>
      [...node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.disabled
      );
    (node.querySelector('[data-autofocus]') || focusables()[0] || node).focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const list = focusables();
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    node.addEventListener('keydown', onKey);
    open.push(node);
    const onPageKey = (e) => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (!lost || open[open.length - 1] !== node) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        (focusables()[0] || node).focus();
      }
    };
    document.addEventListener('keydown', onPageKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onPageKey);
      open.splice(open.indexOf(node), 1);
      if (previous && previous.isConnected) previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On the page itself, not inside whatever opened it: a dialog opened from
  // another dialog (or from glass, whose blur would hold it in) always covers
  // the whole window.
  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
