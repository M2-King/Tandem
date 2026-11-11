// Motion for the Cowork preview: short pauses that let a state be seen
// (sending, joining, signed in), and the drawn check used on success.
// With "Reduce motion" on nothing moves (the CSS only animates under
// prefers-reduced-motion: no-preference); the states still show briefly.

export const calm = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A pause that lets a state be read ("Sending code…", "You're in") stays
// with reduced motion; one that only waits for movement (motionOnly) doesn't.
export const pause = (ms, { motionOnly = false } = {}) =>
  new Promise((resolve) => setTimeout(resolve, motionOnly && calm() ? 0 : ms));

export function SuccessCheck({ size = 44 }) {
  return (
    <svg className="cw-check" width={size} height={size} viewBox="0 0 44 44" aria-hidden="true">
      <circle className="cw-check-ring" cx="22" cy="22" r="20" fill="none" strokeWidth="2.5" />
      <path className="cw-check-mark" d="M13 22.5l6 6 12-13" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
