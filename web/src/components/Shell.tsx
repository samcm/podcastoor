import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { S, sMono, fmtUsd } from "../tokens";
import { SDot } from "./ui";
import { api } from "../api";
import { useIsMobile } from "../hooks";

const NAV: Array<{ id: string; label: string; path: string; icon: string }> = [
  { id: "home", label: "Dashboard", path: "/", icon: "M3 9l6-5 6 5v6H3z" },
  { id: "pods", label: "Podcasts", path: "/podcasts", icon: "M9 3a6 6 0 100 12 6 6 0 000-12zm0 3a3 3 0 110 6 3 3 0 010-6z" },
  { id: "queue", label: "Queue", path: "/queue", icon: "M3 4h12M3 9h12M3 14h12" },
  { id: "cost", label: "Costs", path: "/costs", icon: "M9 2v14M5 5h6a2 2 0 010 4H7a2 2 0 000 4h6" },
  { id: "tune", label: "Tuning", path: "/tuning", icon: "M3 4h7M14 4h1M3 9h2M9 9h6M3 14h10M14 14h1" },
  { id: "logs", label: "Logs", path: "/logs", icon: "M4 3h10v12H4z M6 6h6M6 9h6M6 12h4" },
];

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now.toISOString().slice(11, 19);
}

function useTopbarStats() {
  const [stats, setStats] = useState<{ queue: number; retry: number; failed: number; quarantined: number; costToday: number; costBudget: number } | undefined>();
  useEffect(() => {
    let cancelled = false;
    api
      .dashboard()
      .then((d) => {
        if (cancelled) return;
        const q = d.queueCounts;
        setStats({
          queue: (q.queued ?? 0) + (q.running ?? 0),
          retry: q["waiting-for-credits"] ?? 0,
          failed: q.failed ?? 0,
          quarantined: q.quarantined ?? 0,
          costToday: d.cost.today,
          costBudget: d.cost.todayBudget,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return stats;
}

function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="6" width="2" height="6" fill={S.accent} />
        <rect x="4" y="3" width="2" height="12" fill={S.accent} />
        <rect x="7" y="1" width="2" height="16" fill={S.accent} />
        <rect x="10" y="4" width="2" height="10" fill={S.accent} />
        <rect x="13" y="7" width="2" height="4" fill={S.accent} />
      </svg>
      <span style={{ fontWeight: 600, letterSpacing: 0.5, fontSize: 13 }}>PODCASTOOR</span>
      <span style={{ ...sMono, fontSize: 11, color: S.textMute, marginLeft: 4 }}>v2.4.1</span>
    </div>
  );
}

function TopBar({ mobile }: { mobile: boolean }) {
  const clock = useClock();
  const stats = useTopbarStats();
  return (
    <div style={{ height: 42, borderBottom: `1px solid ${S.border}`, background: S.panel, display: "flex", alignItems: "center", padding: "0 16px", gap: 16, flex: "0 0 auto", position: "sticky", top: 0, zIndex: 30 }}>
      <Link to="/" style={{ display: "flex", alignItems: "center" }}>
        <Logo />
      </Link>
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 14, ...sMono, fontSize: 11, color: S.textDim }}>
        {!mobile && (
          <>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <SDot color={S.green} glow /> queue {stats?.queue ?? "—"}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <SDot color={S.amber} /> retry {stats?.retry ?? "—"}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <SDot color={S.red} /> fail {stats?.failed ?? "—"}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <SDot color={S.amber} /> quar {stats?.quarantined ?? "—"}
            </span>
            <span style={{ color: S.textMute }}>·</span>
          </>
        )}
        <span>
          cost today <span style={{ color: S.accent }}>{stats ? fmtUsd(stats.costToday) : "—"}</span>
          {!mobile && stats ? ` / ${stats.costBudget.toFixed(2)}` : ""}
        </span>
        {!mobile && <span style={{ color: S.textMute }}>·</span>}
        {!mobile && <span>{clock} UTC</span>}
      </div>
    </div>
  );
}

function isActive(id: string, pathname: string): boolean {
  if (id === "home") return pathname === "/";
  if (id === "pods") return pathname.startsWith("/podcasts");
  if (id === "queue") return pathname.startsWith("/queue");
  if (id === "cost") return pathname.startsWith("/costs");
  if (id === "tune") return pathname.startsWith("/tuning");
  if (id === "logs") return pathname.startsWith("/logs");
  return false;
}

function Rail({ pathname }: { pathname: string }) {
  return (
    <div style={{ width: 64, borderRight: `1px solid ${S.border}`, background: S.panel, display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 0", gap: 6, flex: "0 0 auto", position: "sticky", top: 42, alignSelf: "flex-start", height: "calc(100dvh - 42px)", overflowY: "auto" }}>
      {NAV.map((item) => {
        const on = isActive(item.id, pathname);
        return (
          <Link
            key={item.id}
            to={item.path}
            title={item.label}
            style={{
              width: 44,
              height: 44,
              borderRadius: 2,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              background: on ? S.panelHi : "transparent",
              borderBottom: `2px solid ${on ? S.accent : "transparent"}`,
              color: on ? S.text : S.textDim,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4}>
              <path d={item.icon} />
            </svg>
            <span style={{ fontSize: 9, letterSpacing: 0.3, textTransform: "uppercase" }}>{item.label}</span>
          </Link>
        );
      })}
      <div style={{ flex: 1 }} />
      <div style={{ ...sMono, fontSize: 9, color: S.textMute, writingMode: "vertical-rl", transform: "rotate(180deg)", marginBottom: 8 }}>host: studio-01</div>
    </div>
  );
}

function BottomNav({ pathname }: { pathname: string }) {
  return (
    <div style={{ display: "flex", borderTop: `1px solid ${S.border}`, background: S.panel, flex: "0 0 auto", position: "sticky", bottom: 0, zIndex: 30 }}>
      {NAV.filter((n) => n.id !== "pods").map((item) => {
        const on = isActive(item.id, pathname);
        return (
          <Link
            key={item.id}
            to={item.path}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, padding: "8px 0", color: on ? S.accent : S.textDim, borderTop: `2px solid ${on ? S.accent : "transparent"}` }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4}>
              <path d={item.icon} />
            </svg>
            <span style={{ fontSize: 9, letterSpacing: 0.3, textTransform: "uppercase" }}>{item.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

export function Shell({ children }: { active?: string; children: ReactNode }) {
  const { pathname } = useLocation();
  const mobile = useIsMobile();
  return (
    <div style={{ minHeight: "100dvh", background: S.bg, color: S.text, fontFamily: S.font, fontSize: 13, lineHeight: 1.4, display: "flex", flexDirection: "column" }}>
      <TopBar mobile={mobile} />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {!mobile && <Rail pathname={pathname} />}
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      </div>
      {mobile && <BottomNav pathname={pathname} />}
    </div>
  );
}
