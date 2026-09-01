'use client';

export function Seg({ value, options, onChange }) {
  return (
    <div className="vdp-seg">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? 'active' : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Kpi({ label, value, delta, sub, isPP }) {
  const cls =
    delta == null
      ? 'flat'
      : delta > 5
        ? 'up'
        : delta < -5
          ? 'down'
          : 'flat';
  return (
    <div className="vdp-kpi">
      <div className="vdp-kpi-lbl">{label}</div>
      <div className="vdp-kpi-val mono">{value}</div>
      {delta == null ? (
        <div className="vdp-delta flat">{sub}</div>
      ) : (
        <div className={`vdp-delta ${cls}`}>
          {isPP
            ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts`
            : `${delta >= 0 ? '+' : ''}${Number(delta).toFixed(1)}%`}{' '}
          {sub}
        </div>
      )}
    </div>
  );
}

export function Card({ title, sub, actions, children, style, className }) {
  const periodSub =
    typeof sub === 'string' && / · (current|prior)\s*$/i.test(sub);
  const subClass = `vdp-cardsub${periodSub ? ' vdp-cardsub--period' : ''}`;

  return (
    <div className={`vdp-card${className ? ` ${className}` : ''}`} style={style}>
      {(title || actions) && (
        <div className="vdp-card-head">
          <div className="vdp-card-head__text">
            {title ? <h3>{title}</h3> : null}
            {sub ? <div className={subClass}>{sub}</div> : null}
          </div>
          {actions ? <div className="vdp-card-head__actions">{actions}</div> : null}
        </div>
      )}
      {!title && !actions && sub ? <div className={subClass}>{sub}</div> : null}
      {children}
    </div>
  );
}

export function Toolbar({ children }) {
  return <div className="vdp-toolbar">{children}</div>;
}

export function ToolbarGroup({ label, children }) {
  return (
    <div className="vdp-grp">
      {label && <label>{label}</label>}
      {children}
    </div>
  );
}
