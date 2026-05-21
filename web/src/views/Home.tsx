import { Link } from "react-router-dom";
import { S, sMono, fmtUsd, fmtHoursMinutes } from "../tokens";
import { SPanel, SBtn, SStatus, SArt, KpiCard, Loading, ErrorNote } from "../components/ui";
import { AddFeedButton } from "../components/AddFeedButton";
import { api, runAdminAction, type DashboardView, type PodcastCard } from "../api";
import { useApi, useIsMobile } from "../hooks";

const OUTCOME_COLOR: Record<string, string> = { ok: S.green, info: S.textDim, warn: S.amber, fail: S.red };

function PodcastTile({ p, mobile }: { p: PodcastCard; mobile: boolean }) {
  return (
    <Link to={`/podcasts/${p.slug}`} style={{ display: "flex", gap: 10, padding: 12 }}>
      <SArt title={p.name} slug={p.slug} color={p.color} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: S.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
          <SStatus s={p.status} />
        </div>
        <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 1 }}>{p.host}</div>
        <div style={{ display: "flex", gap: 14, marginTop: 6, ...sMono, fontSize: 10, color: S.textDim, flexWrap: "wrap" }}>
          <span>
            {p.processed}/{p.episodes} <span style={{ color: S.textMute }}>ep</span>
          </span>
          {p.failed > 0 && <span style={{ color: S.red }}>{p.failed} fail</span>}
          {p.quarantined > 0 && <span style={{ color: S.red }}>{p.quarantined} q</span>}
          <span>
            <span style={{ color: S.textMute }}>saved</span> {fmtHoursMinutes(p.savedSeconds)}
          </span>
        </div>
        {!mobile && (
          <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <span style={{ color: S.textDim }}>{p.latestRelative}</span> · {p.lastEpisodeTitle}
          </div>
        )}
      </div>
    </Link>
  );
}

function HomeBody({ data, mobile, reload }: { data: DashboardView; mobile: boolean; reload: () => void }) {
  const k = data.kpis;
  const healthy = data.podcasts.filter((p) => p.status === "ok" || p.status === "run").length;
  const attention = data.podcasts.length - healthy;
  const kpis: Array<[string, string, string, string?]> = [
    ["Podcasts", String(k.podcasts), `${healthy} healthy · ${attention} attn`],
    ["Episodes", String(k.episodes), `${k.processed} processed`],
    ["Failed", String(k.failed), `${k.quarantined} quarantined`, S.red],
    ["Time saved", fmtHoursMinutes(k.savedSeconds), `${k.avgAdsPct}% avg ads`],
    ["Cost today", fmtUsd(k.costToday), `of ${fmtUsd(k.costTodayBudget)} budget`],
    ["Queue", `${k.queueQueued} / ${k.queueRunning}`, `${k.queueQueued} queued · ${k.queueRunning} running`],
  ];
  const maxDaily = Math.max(15, ...data.cost.daily);
  const cols = mobile ? 2 : 6;

  return (
    <div style={{ padding: mobile ? 10 : 14, gap: 12, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 12 }}>
        {kpis.map(([kk, v, sub, col]) => (
          <KpiCard key={kk} k={kk} v={v} sub={sub} color={col} />
        ))}
      </div>

      <SPanel
        title="Podcasts"
        subtitle={`${data.podcasts.length} configured · sorted by recent activity`}
        right={
          <div style={{ display: "flex", gap: 6 }}>
            <AddFeedButton />
            <SBtn variant="soft" onClick={() => runAdminAction(() => api.reprocess({ scope: "global", lookbackDays: 1, downloadAudio: true }), reload)}>
              Process last 24h
            </SBtn>
          </div>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${mobile ? 1 : 4},1fr)` }}>
          {data.podcasts.map((p, i) => (
            <div
              key={p.slug}
              style={{
                minWidth: 0,
                borderRight: !mobile && i % 4 !== 3 ? `1px solid ${S.border}` : "none",
                borderBottom: `1px solid ${S.border}`,
              }}
            >
              <PodcastTile p={p} mobile={mobile} />
            </div>
          ))}
        </div>
      </SPanel>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1.4fr 1fr", gap: 12 }}>
        <SPanel title="Activity" subtitle="live tail" right={<SBtn variant="ghost">Pause</SBtn>}>
          <div style={{ overflow: "auto", maxHeight: 360 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", ...sMono, fontSize: 11 }}>
              <tbody>
                {data.activity.map((a, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${S.border}` }}>
                    <td style={{ padding: "5px 12px", color: S.textMute, width: 64 }}>{a.time}</td>
                    <td style={{ padding: "5px 8px", color: OUTCOME_COLOR[a.outcome], width: 8 }}>●</td>
                    <td style={{ padding: "5px 8px", color: S.textDim, width: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.podcastSlug}
                      {a.episodeNumber && <span style={{ color: S.textMute }}> #{a.episodeNumber}</span>}
                    </td>
                    <td style={{ padding: "5px 8px", color: S.accent, width: 72 }}>{a.stage}</td>
                    <td style={{ padding: "5px 12px 5px 8px", color: S.text }}>{a.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SPanel>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <SPanel title="Cost · today" right={<span style={{ ...sMono, fontSize: 10, color: S.textDim }}>{fmtUsd(data.cost.today)} / {fmtUsd(data.cost.todayBudget)}</span>}>
            <div style={{ padding: 12 }}>
              <div style={{ height: 6, background: S.panelHi, position: "relative" }}>
                <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, (data.cost.today / data.cost.todayBudget) * 100)}%`, background: S.accent }} />
              </div>
              <div style={{ display: "flex", gap: 2, marginTop: 14, alignItems: "flex-end", height: 60 }}>
                {data.cost.daily.map((v, i) => (
                  <div key={i} style={{ flex: 1, height: `${(v / maxDaily) * 100}%`, background: i === data.cost.daily.length - 1 ? S.accent : S.borderHi }} />
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", ...sMono, fontSize: 9, color: S.textMute, marginTop: 4 }}>
                <span>26d ago</span>
                <span>today</span>
              </div>
            </div>
          </SPanel>
          <SPanel title="Quick actions">
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <SBtn variant="primary" onClick={() => runAdminAction(() => api.reprocess({ scope: "global", lookbackDays: 1, downloadAudio: true }), reload)}>
                ▶ Process last 24h
              </SBtn>
              <SBtn variant="soft" onClick={() => runAdminAction(() => api.reprocess({ scope: "failed" }), reload)}>↻ Retry failed jobs</SBtn>
              <SBtn variant="soft" onClick={() => runAdminAction(() => api.resetAttempts({ allQuarantined: true }), reload)}>⌂ Reset quarantined</SBtn>
              <SBtn variant="ghost" onClick={() => runAdminAction(() => api.reprocess({ scope: "global" }), reload)}>↓ Re-fetch all feeds</SBtn>
              <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 6, lineHeight: 1.5 }}>
                Mutating actions require admin token.
                <br />
                Tokens are scoped per-host and rotate weekly.
              </div>
            </div>
          </SPanel>
        </div>
      </div>
      <FooterClock />
    </div>
  );
}

function FooterClock() {
  return <div style={{ ...sMono, fontSize: 10, color: S.textMute, padding: "0 2px 4px" }}>auto-refresh every 5s · queue worker: studio-01</div>;
}

export function Home() {
  const mobile = useIsMobile();
  const { data, error, loading, reload } = useApi(() => api.dashboard());
  if (loading) return <Loading label="loading dashboard" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return <HomeBody data={data} mobile={mobile} reload={reload} />;
}
