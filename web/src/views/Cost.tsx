import { S, sMono, fmtUsd } from "../tokens";
import { SPanel, SBtn, SDot, Loading, ErrorNote } from "../components/ui";
import { api, type CostView } from "../api";
import { useApi, useIsMobile } from "../hooks";

function KpiBox({ k, v, sub, frac, color }: { k: string; v: string; sub: string; frac: number; color?: string }) {
  return (
    <div style={{ border: `1px solid ${S.border}`, background: S.panel, padding: "12px 14px" }}>
      <div style={{ ...sMono, fontSize: 10, letterSpacing: 1, color: S.textDim, textTransform: "uppercase" }}>{k}</div>
      <div style={{ ...sMono, fontSize: 24, color: color ?? S.text, marginTop: 4, letterSpacing: -0.5 }}>{v}</div>
      <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 2 }}>{sub}</div>
      {frac > 0 && (
        <div style={{ height: 3, background: S.panelHi, marginTop: 8 }}>
          <div style={{ height: "100%", width: `${Math.min(frac, 1) * 100}%`, background: color ?? S.accent }} />
        </div>
      )}
    </div>
  );
}

function Spark({ c }: { c: CostView }) {
  const max = Math.max(15, ...c.daily);
  return (
    <div style={{ border: `1px solid ${S.border}`, background: S.panel, padding: "12px 14px" }}>
      <div style={{ ...sMono, fontSize: 10, letterSpacing: 1, color: S.textDim, textTransform: "uppercase", display: "flex", justifyContent: "space-between" }}>
        <span>Daily spend · last 26d</span>
        <span style={{ color: S.accent }}>today {fmtUsd(c.today)}</span>
      </div>
      <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 48, marginTop: 8 }}>
        {c.daily.map((v, i) => {
          const last = i === c.daily.length - 1;
          return <div key={i} style={{ flex: 1, height: `${(v / max) * 100}%`, background: last ? S.accent : v > 12 ? S.amber : S.borderHi }} />;
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", ...sMono, fontSize: 9, color: S.textMute, marginTop: 4 }}>
        <span>26d ago</span>
        <span>$0</span>
        <span>budget {fmtUsd(c.todayBudget)}/day</span>
      </div>
    </div>
  );
}

function CostBody({ c, mobile }: { c: CostView; mobile: boolean }) {
  return (
    <div style={{ padding: mobile ? 10 : 14, gap: 12, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Cost dashboard</h1>
        <span style={{ ...sMono, fontSize: 10, color: S.textMute, marginLeft: 6 }}>billing month: {c.month}</span>
        <div style={{ flex: 1 }} />
        <SBtn variant="ghost">Export CSV</SBtn>
        <SBtn variant="ghost">Configure budget</SBtn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(4,1fr) 1.6fr", gap: 12 }}>
        <KpiBox k="Today" v={fmtUsd(c.today)} sub={`of ${fmtUsd(c.todayBudget)}`} frac={c.today / c.todayBudget} />
        <KpiBox k="Month" v={fmtUsd(c.monthTotal)} sub={`of ${fmtUsd(c.monthBudget)}`} frac={c.monthTotal / c.monthBudget} />
        <KpiBox k="Projected" v={fmtUsd(c.projected)} sub="+12% vs last month" frac={1} color={S.amber} />
        <KpiBox k="Per-episode" v={fmtUsd(c.perEpisode)} sub="avg this month" frac={0} />
        <Spark c={c} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 12 }}>
        <SPanel title="By provider · model · stage" subtitle="month-to-date">
          <div style={{ padding: "10px 0", overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", ...sMono, fontSize: 11 }}>
              <thead>
                <tr>
                  {["Provider · model", "Stage", "Calls", "Units", "Spend", "Share"].map((h, i) => (
                    <th key={i} style={{ padding: "4px 12px", textAlign: i > 1 ? "right" : "left", fontSize: 9, letterSpacing: 1, color: S.textMute, textTransform: "uppercase", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.byProvider.map((p, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${S.border}` }}>
                    <td style={{ padding: "8px 12px" }}><div style={{ color: S.text }}>{p.name}</div></td>
                    <td style={{ padding: "8px 12px", color: S.accent }}>{p.stage}</td>
                    <td style={{ padding: "8px 12px", color: S.textDim, textAlign: "right" }}>{p.calls}</td>
                    <td style={{ padding: "8px 12px", color: S.textMute, textAlign: "right" }}>{p.units}</td>
                    <td style={{ padding: "8px 12px", color: S.text, textAlign: "right" }}>{fmtUsd(p.usd)}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right", width: 140 }}>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: S.textDim, width: 32, textAlign: "right" }}>{Math.round(p.share * 100)}%</span>
                        <div style={{ width: 80, height: 3, background: S.panelHi }}>
                          <div style={{ width: `${p.share * 100}%`, height: "100%", background: S.accent }} />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SPanel>

        <SPanel title="By podcast" subtitle="month-to-date · sorted by spend" right={<SBtn variant="ghost">Drill in</SBtn>}>
          <div style={{ padding: "10px 12px" }}>
            {c.byPodcast.map((row, i) => {
              const max = c.byPodcast[0]?.usd || 1;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${S.border}` }}>
                  <div style={{ width: 4, height: 22, background: row.color }} />
                  <span style={{ fontSize: 12, color: S.text, width: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title}</span>
                  <div style={{ flex: 1, height: 6, background: S.panelHi, position: "relative", minWidth: 40 }}>
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(row.usd / max) * 100}%`, background: S.accent }} />
                  </div>
                  <span style={{ ...sMono, fontSize: 11, color: S.text, width: 60, textAlign: "right" }}>{fmtUsd(row.usd)}</span>
                  <span style={{ ...sMono, fontSize: 10, color: S.textMute, width: 56, textAlign: "right" }}>{(row.share * 100).toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </SPanel>
      </div>

      {c.warning && (
        <div style={{ border: `1px solid ${S.amber}50`, background: `${S.amber}10`, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, ...sMono, fontSize: 11, flexWrap: "wrap" }}>
          <SDot color={S.amber} />
          <span style={{ color: S.amber }}>BUDGET</span>
          <span style={{ color: S.text }}>Projected to hit {Math.round(c.warning.projectedPct * 100)}% of monthly budget at current rate.</span>
          <span style={{ color: S.textMute }}>{c.warning.topPodcast} contributes {Math.round(c.warning.topPodcastShare * 100)}% of spend; consider raising its confidence threshold.</span>
          <div style={{ flex: 1 }} />
          <SBtn variant="ghost">Dismiss</SBtn>
        </div>
      )}
    </div>
  );
}

export function Cost() {
  const mobile = useIsMobile();
  const { data, error, loading } = useApi(() => api.cost());
  if (loading) return <Loading label="loading costs" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return <CostBody c={data} mobile={mobile} />;
}
