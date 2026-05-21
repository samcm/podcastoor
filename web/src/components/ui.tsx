import type { CSSProperties, ReactNode } from "react";
import { S, sMono } from "../tokens";

export function SDot({ color, size = 8, glow = false }: { color: string; size?: number; glow?: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: size,
        background: color,
        boxShadow: glow ? `0 0 6px ${color}` : "none",
        flex: "0 0 auto",
      }}
    />
  );
}

export function SPanel({
  title,
  subtitle,
  right,
  children,
  style,
  bodyStyle,
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}) {
  return (
    <div style={{ border: `1px solid ${S.border}`, background: S.panel, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, ...style }}>
      {(title || right) && (
        <div style={{ minHeight: 30, borderBottom: `1px solid ${S.border}`, display: "flex", alignItems: "center", padding: "0 12px", gap: 8, flex: "0 0 auto", flexWrap: "wrap" }}>
          {title && <span style={{ ...sMono, fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: S.textDim }}>{title}</span>}
          {subtitle && <span style={{ ...sMono, fontSize: 10, color: S.textMute }}>· {subtitle}</span>}
          <div style={{ flex: 1 }} />
          {right}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", ...bodyStyle }}>{children}</div>
    </div>
  );
}

type BtnVariant = "ghost" | "primary" | "danger" | "soft";

export function SBtn({
  children,
  variant = "ghost",
  icon,
  onClick,
  disabled,
  title,
  type = "button",
}: {
  children: ReactNode;
  variant?: BtnVariant;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  const map: Record<BtnVariant, { bg: string; bd: string; fg: string }> = {
    ghost: { bg: "transparent", bd: S.border, fg: S.text },
    primary: { bg: S.accent, bd: S.accent, fg: "#1a1208" },
    danger: { bg: "transparent", bd: S.red, fg: S.red },
    soft: { bg: S.panelHi, bd: S.border, fg: S.text },
  };
  const v = map[variant];
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: v.bg,
        border: `1px solid ${v.bd}`,
        color: v.fg,
        padding: "4px 10px",
        ...sMono,
        fontSize: 10,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        borderRadius: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        whiteSpace: "nowrap",
      }}
    >
      {icon}
      {children}
    </button>
  );
}

const STATUS_MAP: Record<string, [string, string]> = {
  ok: [S.green, "OK"],
  run: [S.blue, "RUN"],
  running: [S.blue, "RUN"],
  queued: [S.textDim, "QUE"],
  completed: [S.green, "OK"],
  failed: [S.red, "FAIL"],
  fail: [S.red, "FAIL"],
  warn: [S.amber, "WARN"],
  retry: [S.amber, "RETRY"],
  quarantined: [S.red, "QUAR"],
  stalled: [S.red, "STALL"],
  "waiting-for-credits": [S.amber, "WAIT"],
  idle: [S.textMute, "—"],
  skipped: [S.textMute, "SKIP"],
  "dry-run": [S.textMute, "DRY"],
};

export function SStatus({ s }: { s: string }) {
  const [c, l] = STATUS_MAP[s] ?? [S.textDim, s];
  return (
    <span
      style={{
        ...sMono,
        fontSize: 9.5,
        letterSpacing: 0.8,
        color: c,
        border: `1px solid ${c}40`,
        background: `${c}14`,
        padding: "1px 5px",
        borderRadius: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        whiteSpace: "nowrap",
      }}
    >
      <SDot color={c} size={5} glow={s === "run" || s === "running"} />
      {l}
    </span>
  );
}

export function SArt({ title, slug, color, src, size = 56 }: { title: string; slug: string; color: string; src?: string; size?: number }) {
  const initials = title.split(" ").slice(0, 2).map((w) => w[0]).join("");
  return (
    <div style={{ width: size, height: size, background: color, position: "relative", overflow: "hidden", flex: "0 0 auto", display: "flex", alignItems: "flex-end", padding: 6 }}>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, ${color}, ${color}cc 40%, #00000060)` }} />
      {src && (
        <img
          src={src}
          alt={`${title} artwork`}
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      <div style={{ position: "absolute", top: 6, right: 6, ...sMono, fontSize: 9, color: "#ffffffb0" }}>{slug.slice(0, 3).toUpperCase()}</div>
      <div style={{ position: "relative", fontWeight: 700, fontSize: size * 0.32, color: "#fff", letterSpacing: -0.5, lineHeight: 1 }}>{initials}</div>
    </div>
  );
}

export function KpiCard({ k, v, sub, color }: { k: string; v: string; sub: string; color?: string }) {
  return (
    <div style={{ border: `1px solid ${S.border}`, background: S.panel, padding: "10px 12px" }}>
      <div style={{ ...sMono, fontSize: 10, letterSpacing: 1, color: S.textDim, textTransform: "uppercase" }}>{k}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: color ?? S.text, marginTop: 4, letterSpacing: -0.5, ...sMono }}>{v}</div>
      <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

export function Loading({ label = "loading" }: { label?: string }) {
  return <div style={{ ...sMono, fontSize: 11, color: S.textMute, padding: 24 }}>{label}…</div>;
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div style={{ ...sMono, fontSize: 11, color: S.red, padding: 16, border: `1px solid ${S.red}40`, background: `${S.red}10`, margin: 14 }}>
      error: {message}
    </div>
  );
}
