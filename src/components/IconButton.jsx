import { forwardRef } from 'react';

// Icon-only button. `label` is used for the accessible name and tooltip.
const IconButton = forwardRef(function IconButton(
  { label, icon: Icon, pressed, size = 16, className = '', tooltipSide, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-btn ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      data-tooltip={label}
      data-tooltip-side={tooltipSide}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
});

export default IconButton;
