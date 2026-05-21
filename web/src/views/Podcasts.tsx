import { Link } from "react-router-dom";
import { S, sMono, fmtHoursMinutes, fmtUsd } from "../tokens";
import { SPanel, SStatus, SArt, Loading, ErrorNote } from "../components/ui";
import { AddFeedButton } from "../components/AddFeedButton";
import { api, type PodcastCard } from "../api";
import { useApi, useIsMobile } from "../hooks";

function Tile({ p }: { p: PodcastCard }) {
  return (
    <Link to={`/podcasts/${p.slug}`} style={{ display: "flex", gap: 12, padding: 14 }}>
      <SArt title={p.name} slug={p.slug} color={p.color} size={64} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: S.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
          <SStatus s={p.status} />
        </div>
        <div style={{ ...sMono, fontSize: 10.5, color: S.textMute, marginTop: 2 }}>{p.host}</div>
        <div style={{ display: "flex", gap: 14, marginTop: 7, ...sMono, fontSize: 10.5, color: S.textDim, flexWrap: "wrap" }}>
          <span>
            {p.processed}/{p.episodes} <span style={{ color: S.textMute }}>ep</span>
          </span>
          {p.failed > 0 && <span style={{ color: S.red }}>{p.failed} fail</span>}
          {p.quarantined > 0 && <span style={{ color: S.red }}>{p.quarantined} q</span>}
          <span>
            <span style={{ color: S.textMute }}>saved</span> {fmtHoursMinutes(p.savedSeconds)}
          </span>
          <span>
            <span style={{ color: S.textMute }}>30d</span> {fmtUsd(p.spend30dUsd)}
          </span>
        </div>
        <div style={{ ...sMono, fontSize: 10.5, color: S.textMute, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ color: S.textDim }}>{p.latestRelative}</span> · {p.lastEpisodeTitle}
        </div>
      </div>
    </Link>
  );
}

export function Podcasts() {
  const mobile = useIsMobile();
  const { data, error, loading } = useApi(() => api.dashboard());
  if (loading) return <Loading label="loading podcasts" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  const cols = mobile ? 1 : 3;
  return (
    <div style={{ padding: mobile ? 10 : 14, gap: 12, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Podcasts</h1>
        <span style={{ ...sMono, fontSize: 10, color: S.textMute, marginLeft: 6 }}>{data.podcasts.length} configured</span>
        <div style={{ flex: 1 }} />
        <AddFeedButton />
      </div>
      <SPanel title="Feeds" subtitle="sorted by recent activity">
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)` }}>
          {data.podcasts.map((p, i) => (
            <div
              key={p.slug}
              style={{
                minWidth: 0,
                borderRight: !mobile && i % cols !== cols - 1 ? `1px solid ${S.border}` : "none",
                borderBottom: `1px solid ${S.border}`,
              }}
            >
              <Tile p={p} />
            </div>
          ))}
        </div>
      </SPanel>
    </div>
  );
}
