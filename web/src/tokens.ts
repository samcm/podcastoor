import type { CSSProperties } from "react";

// Studio direction — DAW-inspired operator console palette.
export const S = {
  bg: "#0d0d10",
  panel: "#15151a",
  panelHi: "#1c1c22",
  border: "#26262e",
  borderHi: "#34343d",
  text: "#dcdce0",
  textDim: "#8d8d96",
  textMute: "#5e5e66",
  accent: "#f08740", // warm orange
  accentDim: "#a05a2a",
  red: "#e85a47", // removed
  amber: "#d8a23f", // mark-only / partial
  green: "#5ab886", // chapter / kept
  blue: "#5fa2d8", // splice / info
  font: "'IBM Plex Sans', -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

export const sMono: CSSProperties = { fontFamily: S.mono, fontVariantNumeric: "tabular-nums" };

export function fmtTime(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

export function fmtDur(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${m}m ${String(ss).padStart(2, "0")}s`;
}

export function fmtHoursMinutes(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

export function fmtClock(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(11, 19);
}

export function relativeFromIso(iso?: string): string {
  if (!iso) return "—";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return "—";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// HH:MM clock used in retry/last columns.
export function fmtHm(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(11, 16);
}
