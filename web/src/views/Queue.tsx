import { S, sMono, fmtHm } from "../tokens";
import { SPanel, SBtn, SStatus, SDot, Loading, ErrorNote } from "../components/ui";
import { api, runAdminAction, type QueueRow } from "../api";
import { useAdminSession, useApi, useIsMobile } from "../hooks";

const CHIPS: Array<[string, string]> = [
  ["running", S.blue],
  ["queued", S.textDim],
  ["completed", S.green],
  ["failed", S.red],
  ["quarantined", S.red],
  ["waiting-for-credits", S.amber],
];

function stageLabel(row: QueueRow): string {
  return ["discovered", "completed", "reset"].includes(row.stage) ? "—" : row.stage;
}

function retryLabel(row: QueueRow): string {
  if (row.state === "quarantined") return "manual";
  return row.nextRetryAt ? fmtHm(row.nextRetryAt) : "—";
}

function RowActions({ row, reload, isAdmin }: { row: QueueRow; reload: () => void; isAdmin: boolean }) {
  if (!isAdmin) return row.state === "failed" || row.state === "quarantined" ? <SBtn variant="ghost">⌗ logs</SBtn> : null;
  const slug = row.podcastSlug;
  const episodeKey = row.episodeKey;
  const retryEpisode = () =>
    runAdminAction(async () => {
      await api.resetAttempts({ podcastSlug: slug, episodeKey, allQuarantined: false });
      await api.reprocess({ scope: "episode", podcastSlug: slug, episodeKey, force: true, downloadAudio: true });
    }, reload);
  if (row.state === "failed" || row.state === "quarantined" || row.state === "waiting-for-credits")
    return (
      <>
        <SBtn variant="ghost" onClick={retryEpisode}>↻ retry now</SBtn>{" "}
        <SBtn variant="ghost" onClick={() => runAdminAction(() => api.resetAttempts({ podcastSlug: slug, episodeKey, allQuarantined: false }), reload)}>reset</SBtn>
      </>
    );
  if (row.state === "queued") return <SBtn variant="ghost">✕ cancel</SBtn>;
  if (row.state === "running") return <SBtn variant="ghost">⏹ stop</SBtn>;
  if (row.state === "completed")
    return <SBtn variant="ghost" onClick={() => runAdminAction(() => api.reprocess({ scope: "episode", podcastSlug: slug, episodeKey, force: true, downloadAudio: true }), reload)} title={row.episodeTitle}>↻</SBtn>;
  return null;
}

function QueueBody({ rows, mobile, reload }: { rows: QueueRow[]; mobile: boolean; reload: () => void }) {
  const admin = useAdminSession();
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;

  return (
    <div style={{ padding: mobile ? 10 : 14, gap: 12, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: -0.2 }}>Queue & runs</h1>
        <span style={{ ...sMono, fontSize: 10, color: S.textMute, marginLeft: 6 }}>showing {rows.length} jobs</span>
        <div style={{ flex: 1 }} />
        <SBtn variant="ghost" onClick={reload}>↻ Refresh</SBtn>
        {admin.isAdmin && (
          <>
            <SBtn variant="soft">⏸ Pause queue</SBtn>
            <SBtn variant="primary" onClick={() => runAdminAction(() => api.reprocess({ scope: "failed" }), reload)}>▶ Drain retry pool</SBtn>
          </>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${mobile ? 2 : 6},1fr)`, gap: 8 }}>
        {CHIPS.map(([state, color]) => (
          <div key={state} style={{ border: `1px solid ${S.border}`, background: S.panel, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <SDot color={color} size={6} glow={state === "running"} />
            <span style={{ ...sMono, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: S.textDim }}>{state === "waiting-for-credits" ? "waiting" : state}</span>
            <span style={{ flex: 1 }} />
            <span style={{ ...sMono, fontSize: 18, color: S.text, letterSpacing: -0.5 }}>{counts[state] ?? 0}</span>
          </div>
        ))}
      </div>

      <SPanel title="Jobs" subtitle="newest first" right={<div style={{ display: "flex", gap: 6 }}><SBtn variant="ghost">All</SBtn><SBtn variant="soft">Failed</SBtn><SBtn variant="ghost">Completed</SBtn></div>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 1000, borderCollapse: "collapse", ...sMono, fontSize: 11 }}>
            <thead>
              <tr style={{ background: S.panelHi, borderBottom: `1px solid ${S.border}` }}>
                {["", "Podcast", "Episode", "Status", "Stage", "Attempt", "Last", "Next retry", "Model", "Last error", "Actions"].map((h, i) => (
                  <th key={i} style={{ padding: "8px 10px", textAlign: "left", fontSize: 9.5, letterSpacing: 1, color: S.textMute, textTransform: "uppercase", fontWeight: 500, position: "sticky", top: 0, background: S.panelHi }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isErr = r.state === "failed" || r.state === "quarantined";
                return (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${S.border}`, background: isErr ? `${S.red}06` : "transparent" }}>
                    <td style={{ padding: "8px 6px 8px 10px", width: 6 }}>
                      <div style={{ width: 3, height: 24, background: r.podcastColor }} />
                    </td>
                    <td style={{ padding: "8px 10px", color: S.text, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.podcastTitle}</td>
                    <td style={{ padding: "8px 10px", color: S.textDim, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.episodeTitle}</td>
                    <td style={{ padding: "8px 10px" }}><SStatus s={r.state} /></td>
                    <td style={{ padding: "8px 10px", color: stageLabel(r) === "—" ? S.textMute : S.accent }}>{stageLabel(r)}</td>
                    <td style={{ padding: "8px 10px", color: r.attempts >= 3 ? S.red : r.attempts >= 2 ? S.amber : S.textDim }}>
                      {r.attempts}
                      {r.attempts >= 3 && <span style={{ color: S.textMute }}>/{r.maxAttempts}</span>}
                    </td>
                    <td style={{ padding: "8px 10px", color: S.textDim }}>{fmtHm(r.lastAttemptAt)}</td>
                    <td style={{ padding: "8px 10px", color: retryLabel(r) === "manual" ? S.red : retryLabel(r) === "—" ? S.textMute : S.textDim }}>{retryLabel(r)}</td>
                    <td style={{ padding: "8px 10px", color: S.textMute, fontSize: 10 }}>{r.model}</td>
                    <td style={{ padding: "8px 10px", color: S.red, maxWidth: 360, whiteSpace: "normal", lineHeight: 1.35 }}>{r.lastError || <span style={{ color: S.textMute }}>—</span>}</td>
                    <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}><RowActions row={r} reload={reload} isAdmin={admin.isAdmin} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SPanel>

      <div style={{ display: "flex", justifyContent: "space-between", ...sMono, fontSize: 10, color: S.textMute, flexWrap: "wrap", gap: 8 }}>
        <span>auto-refresh every 5s</span>
        <span>queue worker: studio-01 · pid 18424 · uptime 4d 02h</span>
      </div>
    </div>
  );
}

export function Queue() {
  const mobile = useIsMobile();
  const { data, error, loading, reload } = useApi(() => api.queue());
  if (loading) return <Loading label="loading queue" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return <QueueBody rows={data.queue} mobile={mobile} reload={reload} />;
}
