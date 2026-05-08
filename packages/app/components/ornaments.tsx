"use client";
import { useState, forwardRef } from "react";
import type {
  InputHTMLAttributes,
  CSSProperties,
  ReactNode,
  MouseEventHandler,
} from "react";

export const ArtNouveauArch = ({
  className = "",
  style = {},
}: {
  className?: string;
  style?: CSSProperties;
}) => (
  <svg
    viewBox="0 0 600 220"
    className={className}
    style={style}
    aria-hidden="true"
    preserveAspectRatio="none"
  >
    <g fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M0,210 C0,80 100,30 300,30 C500,30 600,80 600,210" />
      <path
        d="M20,210 C20,95 110,52 300,52 C490,52 580,95 580,210"
        opacity="0.5"
      />
      <path
        d="M150,210 C150,140 220,110 300,110 C380,110 450,140 450,210"
        opacity="0.7"
      />
      <circle cx="300" cy="60" r="6" fill="currentColor" />
      <circle cx="160" cy="120" r="3" fill="currentColor" />
      <circle cx="440" cy="120" r="3" fill="currentColor" />
      <path d="M300,30 C260,10 240,10 220,20 M300,30 C340,10 360,10 380,20" />
    </g>
  </svg>
);

export const Divider = ({ className = "" }: { className?: string }) => (
  <svg
    viewBox="0 0 600 24"
    className={className}
    aria-hidden="true"
    style={{ width: "100%", height: 24, color: "var(--brass)" }}
  >
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M0,12 H260" />
      <path d="M340,12 H600" />
      <path d="M280,12 q10,-10 20,0 q10,10 20,0" />
      <circle cx="300" cy="12" r="2.5" fill="currentColor" />
    </g>
  </svg>
);

export const CornerOrnament = ({ flip = "" }: { flip?: string }) => (
  <svg
    viewBox="0 0 40 40"
    width="32"
    height="32"
    style={{ transform: flip || undefined, color: "var(--brass)" }}
    aria-hidden="true"
  >
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2,2 L18,2" />
      <path d="M2,2 L2,18" />
      <path
        d="M2,2 Q14,4 16,16 Q4,14 2,2 Z"
        fill="currentColor"
        opacity="0.15"
      />
      <circle cx="6" cy="6" r="1.4" fill="currentColor" />
    </g>
  </svg>
);

export const GearIcon = ({
  size = 24,
  color = "currentColor",
  spinning = false,
}: {
  size?: number;
  color?: string;
  spinning?: boolean;
}) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    style={{
      color,
      animation: spinning ? "spin 14s linear infinite" : undefined,
    }}
    aria-hidden="true"
  >
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="12" cy="12" r="3.6" />
      <circle cx="12" cy="12" r="8" />
      {Array.from({ length: 12 }).map((_, i) => {
        const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
        const a = (i / 12) * Math.PI * 2;
        const x1 = r6(12 + Math.cos(a) * 8);
        const y1 = r6(12 + Math.sin(a) * 8);
        const x2 = r6(12 + Math.cos(a) * 10);
        const y2 = r6(12 + Math.sin(a) * 10);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
    </g>
  </svg>
);

export const OrlojMark = ({ size = 56 }: { size?: number }) => (
  <svg viewBox="0 0 80 80" width={size} height={size} aria-hidden="true">
    <defs>
      <radialGradient id="orloj-face" cx="50%" cy="50%">
        <stop offset="0%" stopColor="#1d4a3f" />
        <stop offset="60%" stopColor="#143a31" />
        <stop offset="100%" stopColor="#0c2a23" />
      </radialGradient>
    </defs>
    <circle cx="40" cy="40" r="38" fill="#b8893a" />
    <circle cx="40" cy="40" r="34" fill="url(#orloj-face)" />
    {Array.from({ length: 12 }).map((_, i) => {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
      const x1 = r6(40 + Math.cos(a) * 30);
      const y1 = r6(40 + Math.sin(a) * 30);
      const x2 = r6(40 + Math.cos(a) * 33);
      const y2 = r6(40 + Math.sin(a) * 33);
      return (
        <line
          key={i}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="#d4a449"
          strokeWidth="1.4"
        />
      );
    })}
    <circle
      cx="40"
      cy="40"
      r="22"
      fill="none"
      stroke="#d4a449"
      strokeWidth="0.6"
      opacity="0.6"
    />
    <circle
      cx="40"
      cy="40"
      r="14"
      fill="none"
      stroke="#d4a449"
      strokeWidth="0.4"
      opacity="0.5"
    />
    <line
      x1="40"
      y1="40"
      x2="40"
      y2="16"
      stroke="#d4a449"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <line
      x1="40"
      y1="40"
      x2="56"
      y2="46"
      stroke="#d4a449"
      strokeWidth="1"
      strokeLinecap="round"
    />
    <circle cx="40" cy="40" r="3" fill="#d4a449" />
    <circle cx="40" cy="40" r="1" fill="#1a1612" />
  </svg>
);

export const Pill = ({
  tone = "ink",
  children,
  style = {},
}: {
  tone?: string;
  children: ReactNode;
  style?: CSSProperties;
}) => {
  const map: Record<string, { bg: string; color: string; border: string }> = {
    ink: { bg: "transparent", color: "var(--ink)", border: "var(--line)" },
    brass: {
      bg: "rgba(184,137,58,0.12)",
      color: "var(--brass-deep)",
      border: "rgba(184,137,58,0.45)",
    },
    verdigris: {
      bg: "rgba(47,110,94,0.12)",
      color: "var(--verdigris-deep)",
      border: "rgba(47,110,94,0.4)",
    },
    wine: {
      bg: "rgba(138,53,38,0.10)",
      color: "var(--wine)",
      border: "rgba(138,53,38,0.35)",
    },
    blue: {
      bg: "rgba(42,74,110,0.10)",
      color: "var(--stained-blue)",
      border: "rgba(42,74,110,0.35)",
    },
  };
  const t = map[tone] || map.ink;
  return (
    <span
      className="smallcaps"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        background: t.bg,
        color: t.color,
        border: `1px solid ${t.border}`,
        fontFamily: "var(--font-ui)",
        fontSize: 11,
        fontWeight: 500,
        ...style,
      }}
    >
      {children}
    </span>
  );
};

export const Btn = ({
  kind = "primary",
  size = "md",
  children,
  onClick,
  type = "button",
  disabled,
  style = {},
  ...rest
}: {
  kind?: string;
  size?: string;
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  style?: CSSProperties;
  [key: string]: unknown;
}) => {
  const sizes: Record<string, CSSProperties> = {
    sm: { padding: "8px 14px", fontSize: 13 },
    md: { padding: "12px 22px", fontSize: 14 },
    lg: { padding: "16px 30px", fontSize: 15 },
  };
  const kinds: Record<string, CSSProperties> = {
    primary: {
      background: "var(--ink)",
      color: "var(--parchment)",
      border: "1px solid var(--ink)",
    },
    brass: {
      background: "var(--brass)",
      color: "var(--ink)",
      border: "1px solid var(--brass-deep)",
    },
    verdigris: {
      background: "var(--verdigris)",
      color: "var(--parchment)",
      border: "1px solid var(--verdigris-deep)",
    },
    ghost: {
      background: "transparent",
      color: "var(--ink)",
      border: "1px solid var(--line)",
    },
    outline: {
      background: "transparent",
      color: "var(--ink)",
      border: "1.5px solid var(--ink)",
    },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="smallcaps"
      style={{
        ...(sizes[size] || sizes.md),
        ...(kinds[kind] || kinds.primary),
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "var(--font-ui)",
        fontWeight: 600,
        letterSpacing: "0.16em",
        borderRadius: 0,
        transition:
          "transform 0.18s ease, background 0.18s ease, color 0.18s ease, box-shadow 0.18s ease",
        boxShadow:
          kind === "primary" || kind === "verdigris"
            ? "3px 3px 0 var(--brass)"
            : "none",
        ...style,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform =
          "translate(-1px,-1px)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.transform = "none";
      }}
      {...(rest as Record<string, unknown>)}
    >
      {children}
    </button>
  );
};

export const FramedCard = ({
  children,
  tone = "parchment",
  padding = 24,
  style = {},
  hoverable = false,
  onClick,
}: {
  children: ReactNode;
  tone?: string;
  padding?: number;
  style?: CSSProperties;
  hoverable?: boolean;
  onClick?: () => void;
}) => {
  const bg =
    tone === "parchment"
      ? "var(--parchment-2)"
      : tone === "paper"
      ? "rgba(241,233,212,0.6)"
      : tone === "verdigris"
      ? "var(--verdigris-deep)"
      : tone === "ink"
      ? "var(--ink)"
      : tone;
  const isDark = tone === "verdigris" || tone === "ink";
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        position: "relative",
        background: bg,
        color: isDark ? "var(--parchment)" : "var(--ink)",
        border: "1px solid var(--line)",
        padding,
        cursor: onClick ? "pointer" : "default",
        boxShadow:
          hoverable && hover
            ? "6px 6px 0 var(--brass)"
            : "3px 3px 0 var(--line-soft)",
        transform: hoverable && hover ? "translate(-2px,-2px)" : "none",
        transition: "transform 0.18s ease, box-shadow 0.18s ease",
        ...style,
      }}
    >
      <div style={{ position: "absolute", top: 6, left: 6 }}>
        <CornerOrnament />
      </div>
      <div style={{ position: "absolute", top: 6, right: 6 }}>
        <CornerOrnament flip="scaleX(-1)" />
      </div>
      <div style={{ position: "absolute", bottom: 6, left: 6 }}>
        <CornerOrnament flip="scaleY(-1)" />
      </div>
      <div style={{ position: "absolute", bottom: 6, right: 6 }}>
        <CornerOrnament flip="scale(-1,-1)" />
      </div>
      {children}
    </div>
  );
};

export const StainedPanel = ({
  width = 300,
  height = 380,
  seed = 1,
}: {
  width?: number;
  height?: number;
  seed?: number;
}) => {
  const palette = [
    "#2f6e5e",
    "#1d4a3f",
    "#b8893a",
    "#8a3526",
    "#2a4a6e",
    "#d4a449",
    "#c97a5b",
  ];
  const pick = (i: number) => palette[(seed * 7 + i * 3) % palette.length];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="100%"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`sg-${seed}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={pick(0)} />
          <stop offset="1" stopColor={pick(1)} />
        </linearGradient>
      </defs>
      <rect
        width={width}
        height={height}
        fill={`url(#sg-${seed})`}
        opacity="0.9"
      />
      <g stroke="#1a1612" strokeWidth="2" fill="none">
        <path
          d={`M0,${height * 0.35} Q${width / 2},${height * 0.25} ${width},${
            height * 0.4
          }`}
        />
        <path
          d={`M0,${height * 0.65} Q${width / 2},${height * 0.55} ${width},${
            height * 0.7
          }`}
        />
        <path
          d={`M${width * 0.5},0 Q${width * 0.45},${height * 0.5} ${
            width * 0.55
          },${height}`}
        />
      </g>
      <circle
        cx={width * 0.5}
        cy={height * 0.35}
        r={Math.min(width, height) * 0.14}
        fill={pick(2)}
        stroke="#1a1612"
        strokeWidth="2"
      />
      <circle
        cx={width * 0.5}
        cy={height * 0.35}
        r={Math.min(width, height) * 0.07}
        fill={pick(5)}
        stroke="#1a1612"
        strokeWidth="1.5"
      />
    </svg>
  );
};

export const SectionHeader = ({
  eyebrow,
  title,
  subtitle,
  align = "left",
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  align?: "left" | "center";
}) => (
  <div
    style={{
      textAlign: align,
      maxWidth: 720,
      margin: align === "center" ? "0 auto" : "0",
    }}
  >
    {eyebrow && (
      <div
        className="smallcaps"
        style={{ color: "var(--brass-deep)", fontSize: 12, marginBottom: 10 }}
      >
        ✦ {eyebrow} ✦
      </div>
    )}
    <h2
      className="display"
      style={{
        fontSize: "clamp(28px, 4vw, 44px)",
        margin: 0,
        lineHeight: 1.1,
        color: "var(--ink)",
      }}
    >
      {title}
    </h2>
    {subtitle && (
      <p
        className="poetic"
        style={{
          fontSize: "clamp(16px, 1.6vw, 20px)",
          color: "var(--ink-soft)",
          marginTop: 12,
          marginBottom: 0,
        }}
      >
        {subtitle}
      </p>
    )}
  </div>
);

export const Identicon = ({
  seed = "orloj",
  size = 40,
}: {
  seed?: string;
  size?: number;
}) => {
  const hash = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0);
  const palette = [
    "#2f6e5e",
    "#b8893a",
    "#8a3526",
    "#2a4a6e",
    "#1d4a3f",
    "#c97a5b",
    "#d4a449",
  ];
  const c1 = palette[hash % palette.length];
  const c2 = palette[(hash * 3) % palette.length];
  const c3 = palette[(hash * 7) % palette.length];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ borderRadius: 4, border: "1px solid var(--line)" }}
    >
      <rect width="24" height="24" fill={c1} />
      {Array.from({ length: 5 }).map((_, r) =>
        Array.from({ length: 3 }).map((_, c) => {
          const v = ((hash >> (r * 3 + c)) ^ (hash * (c + 1))) & 1;
          if (!v) return null;
          const cell = c === 2 ? c2 : c3;
          return (
            <g key={`${r}-${c}`}>
              <rect x={c * 4 + 6} y={r * 4 + 2} width="4" height="4" fill={cell} />
              <rect
                x={(4 - c) * 4 + 6}
                y={r * 4 + 2}
                width="4"
                height="4"
                fill={cell}
              />
            </g>
          );
        })
      )}
    </svg>
  );
};

export const Tag = ({
  children,
  color = "var(--brass-deep)",
}: {
  children: ReactNode;
  color?: string;
}) => (
  <span
    className="mono"
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "2px 8px",
      fontSize: 11,
      color,
      border: `1px solid ${color}`,
      borderRadius: 0,
      letterSpacing: "0.04em",
      background: "rgba(241,233,212,0.4)",
    }}
  >
    {children}
  </span>
);

export const Field = ({
  label,
  hint,
  children,
  error,
  style,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  error?: string;
  style?: CSSProperties;
}) => (
  <label style={{ display: "block", ...style }}>
    <div
      className="smallcaps"
      style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 6 }}
    >
      {label}
    </div>
    {children}
    {hint && !error && (
      <div
        style={{
          fontSize: 12,
          color: "var(--ink-soft)",
          marginTop: 6,
          fontStyle: "italic",
        }}
      >
        {hint}
      </div>
    )}
    {error && (
      <div style={{ fontSize: 12, color: "var(--wine)", marginTop: 6 }}>
        {error}
      </div>
    )}
  </label>
);

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { style?: CSSProperties }
>(({ style = {}, onFocus, onBlur, ...rest }, ref) => (
  <input
    ref={ref}
    {...rest}
    style={{
      width: "100%",
      padding: "12px 14px",
      background: "rgba(255,255,255,0.45)",
      border: "1px solid var(--line)",
      fontFamily:
        rest.type === "text" || !rest.type
          ? "var(--font-ui)"
          : "var(--font-mono)",
      fontSize: 14,
      color: "var(--ink)",
      outline: "none",
      borderRadius: 0,
      transition: "border-color 0.18s ease, background 0.18s ease",
      ...style,
    }}
    onFocus={(e) => {
      e.target.style.borderColor = "var(--brass)";
      e.target.style.background = "rgba(255,255,255,0.7)";
      onFocus && onFocus(e);
    }}
    onBlur={(e) => {
      e.target.style.borderColor = "var(--line)";
      e.target.style.background = "rgba(255,255,255,0.45)";
      onBlur && onBlur(e);
    }}
  />
));
Input.displayName = "Input";

export const ChoiceCard = ({
  active,
  onClick,
  title,
  desc,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  icon: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      textAlign: "left",
      padding: 16,
      background: active ? "rgba(184,137,58,0.18)" : "rgba(255,255,255,0.4)",
      border: active ? "1.5px solid var(--brass)" : "1px solid var(--line)",
      cursor: "pointer",
      display: "flex",
      gap: 12,
      alignItems: "flex-start",
      transition: "background 0.18s ease, border 0.18s ease",
    }}
  >
    <div style={{ flexShrink: 0, color: "var(--brass-deep)" }}>{icon}</div>
    <div>
      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>
        {title}
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--ink-soft)",
          marginTop: 4,
          lineHeight: 1.5,
        }}
      >
        {desc}
      </div>
    </div>
  </button>
);

export const Select = ({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) => (
  <div style={{ position: "relative" }}>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        padding: "12px 32px 12px 14px",
        appearance: "none",
        background: "rgba(255,255,255,0.45)",
        border: "1px solid var(--line)",
        fontFamily: "var(--font-ui)",
        fontSize: 13,
        color: "var(--ink)",
        cursor: "pointer",
        borderRadius: 0,
      }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
    <span
      style={{
        position: "absolute",
        right: 14,
        top: "50%",
        transform: "translateY(-50%)",
        pointerEvents: "none",
        color: "var(--ink-soft)",
      }}
    >
      ▾
    </span>
  </div>
);
