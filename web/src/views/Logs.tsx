import { S, sMono } from "../tokens";
import { SPanel, SBtn, Loading, ErrorNote } from "../components/ui";
import { api } from "../api";
import { useApi, useIsMobile } from "../hooks";

const OUTCOME_COLOR: Record<string, string> = { ok: S.green, info: S.textDim, warn: S.amber, fail: S.red };

export function Logs() {
  const mobile = useIsMobile();
  const { data, error, loading, reload } = useApi(() => api.dashboard());
  if (loading) return <Loading label="loading logs" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return (
    <div style={{ padding: mobile ? 10 : 14, gap: 12, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Logs</h1>
        <span style={{ ...sMono, fontSize: 10, color: S.textMute, marginLeft: 6 }}>processing pipeline · live tail</span>
        <div style={{ flex: 1 }} />
        <SBtn variant="ghost" onClick={reload}>↻ Refresh</SBtn>
      </div>
      <SPanel title="Activity" subtitle={`${data.activity.length} recent events`}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 640, borderCollapse: "collapse", ...sMono, fontSize: 11 }}>
            <tbody>
              {data.activity.map((a, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${S.border}` }}>
                  <td style={{ padding: "6px 12px", color: S.textMute, width: 70 }}>{a.time}</td>
                  <td style={{ padding: "6px 8px", color: OUTCOME_COLOR[a.outcome], width: 8 }}>●</td>
                  <td style={{ padding: "6px 8px", color: S.textDim, width: 150 }}>
                    {a.podcastSlug}
                    {a.episodeNumber && <span style={{ color: S.textMute }}> #{a.episodeNumber}</span>}
                  </td>
                  <td style={{ padding: "6px 8px", color: S.accent, width: 90 }}>{a.stage}</td>
                  <td style={{ padding: "6px 12px 6px 8px", color: S.text }}>{a.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SPanel>
    </div>
  );
}
