/** Fixed product logo — Login + Dashboard. */
export const LOGO_NAME = 'Smart Analytics v3';

export default function Logo({ size = 'md', showText = true, href }) {
  const dims = size === 'lg' ? 36 : size === 'sm' ? 22 : 28;
  const fontSize = size === 'lg' ? 18 : size === 'sm' ? 13 : 15;

  const inner = (
    <>
      <span
        className="sa-logo-mark"
        style={{ width: dims, height: dims }}
        aria-hidden
      >
        {/* Bars + pulse — matches slate/blue portal theme */}
        <svg
          width={dims * 0.58}
          height={dims * 0.58}
          viewBox="0 0 24 24"
          fill="none"
        >
          <rect x="3" y="13" width="4" height="8" rx="1.2" fill="currentColor" opacity="0.55" />
          <rect x="10" y="8" width="4" height="13" rx="1.2" fill="currentColor" opacity="0.8" />
          <rect x="17" y="3" width="4" height="18" rx="1.2" fill="currentColor" />
        </svg>
      </span>
      {showText && (
        <span className="sa-logo-text" style={{ fontSize }}>
          {LOGO_NAME}
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <a href={href} className={`sa-logo sa-logo--${size}`} aria-label={LOGO_NAME}>
        {inner}
      </a>
    );
  }

  return (
    <div className={`sa-logo sa-logo--${size}`} aria-label={LOGO_NAME}>
      {inner}
    </div>
  );
}
