// The Tandem mark: a T with a second, lighter stem. Two hands on one bar:
// the developer's stem is solid, Tandem's is half tone. One colour
// (currentColor), legible at 16px.
export default function TandemMark({ size = 18, className = '' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="3" width="16" height="3.5" rx="1.75" />
      <rect x="5" y="3" width="3.5" height="14" rx="1.75" />
      <rect x="11.5" y="6.5" width="3.5" height="7" rx="1.75" opacity="0.5" />
    </svg>
  );
}
