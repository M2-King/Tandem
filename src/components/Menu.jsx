import { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

// Dropdown menu with keyboard support. Focus returns to the trigger when
// it closes. `renderTrigger(props)` must spread props onto a <button>.
export default function Menu({ renderTrigger, children, align = 'end', label, className = '', role = 'menu' }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const items = () => [...(menuRef.current?.querySelectorAll('[role^="menuitem"]:not([disabled]), [data-menu-item]') || [])];
    (items()[0] || menuRef.current)?.focus();
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target) && !triggerRef.current?.contains(e.target)) close(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = items();
        if (!list.length) return;
        const i = list.indexOf(document.activeElement);
        const nextIndex = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[nextIndex]?.focus();
      } else if (e.key === 'Tab') {
        close(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return (
    <div className={`menu-anchor ${className}`}>
      {renderTrigger({
        ref: triggerRef,
        'aria-haspopup': role === 'menu' ? 'menu' : 'dialog',
        'aria-expanded': open,
        onClick: () => setOpen((o) => !o),
      })}
      {open && (
        <div ref={menuRef} className={`menu menu-${align} menu-role-${role}`} role={role} aria-label={label} tabIndex={-1}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon: Icon, label, description, onSelect, close, role = 'menuitem', checked, disabled }) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemradio' ? !!checked : undefined}
      className="menu-item"
      disabled={disabled}
      onClick={() => {
        close?.();
        onSelect?.();
      }}
    >
      {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="menu-item-icon" />}
      <span className="menu-item-text">
        <span className="menu-item-label">{label}</span>
        {description && <span className="menu-item-desc">{description}</span>}
      </span>
      {role === 'menuitemradio' && checked && <Check size={16} aria-hidden="true" className="menu-item-check" />}
    </button>
  );
}
