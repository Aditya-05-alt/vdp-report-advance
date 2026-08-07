'use client';

/** Visible loading status for VDP pages (matches VDP blue accent). */
export default function VdpLoadingBanner({
  active,
  label = 'Loading data…',
  detail = null,
}) {
  if (!active) return null;
  return (
    <div className="vdp-load-banner" role="status" aria-live="polite" aria-busy="true">
      <span className="vdp-load-spinner" aria-hidden="true" />
      <div className="vdp-load-text">
        <strong>{label}</strong>
        {detail ? <span className="vdp-load-detail">{detail}</span> : null}
      </div>
    </div>
  );
}

/** Inline block placeholder used inside cards while first load. */
export function VdpLoadingBlock({ label = 'Loading…', minHeight = 120 }) {
  return (
    <div className="vdp-load-block" style={{ minHeight }} role="status" aria-busy="true">
      <span className="vdp-load-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
