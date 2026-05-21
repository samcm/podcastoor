import { useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { S, sMono, fmtTime, fmtDur, fmtHoursMinutes, fmtUsd, relativeFromIso } from "../tokens";
import { SPanel, SBtn, SStatus, SArt, Loading, ErrorNote } from "../components/ui";
import { api, runAdminAction, type DeepDive, type DeepDiveEpisode } from "../api";
import { useApi, useIsMobile } from "../hooks";

function episodeNumber(ep: DeepDiveEpisode): number {
  const m = /-ep-(\d+)/.exec(ep.guid ?? "") ?? /(\d+)/.exec(ep.title);
  return m ? Number(m[1]) : 0;
}

function countAction(ep: DeepDiveEpisode, action: string): number {
  return ep.decisions.filter((d) => d.action === action).length;
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <>
      <span style={{ color: S.textMute }}>{label}</span>
      <span style={{ color: color ?? S.text }}>{value}</span>
    </>
  );
}

function ReprocessOptions({ options, setOptions }: { options: Record<string, boolean>; setOptions: (o: Record<string, boolean>) => void }) {
  const items: Array<[string, string]> = [
    ["reuseTranscript", "reuse transcript"],
    ["skipArtwork", "skip artwork"],
    ["dryRun", "dry run"],
    ["force", "force (ignore manifest)"],
  ];
  return (
    <div style={{ marginTop: 10, padding: "8px 10px", background: S.panelHi, border: `1px solid ${S.border}` }}>
      <div style={{ ...sMono, fontSize: 9.5, letterSpacing: 0.8, color: S.textMute, textTransform: "uppercase" }}>Options for reprocess</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, ...sMono, fontSize: 11 }}>
        {items.map(([key, label]) => (
          <label key={key} style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={options[key] ?? false} onChange={(e) => setOptions({ ...options, [key]: e.target.checked })} style={{ accentColor: S.accent }} /> {label}
          </label>
        ))}
      </div>
    </div>
  );
}

function PodcastBody({ data, mobile, reload }: { data: DeepDive; mobile: boolean; reload: () => void }) {
  const navigate = useNavigate();
  const [options, setOptions] = useState<Record<string, boolean>>({ reuseTranscript: true });
  const demo = data.demo ?? {};
  const accent = data.accentColor ?? S.accent;
  const conf = data.config.effectiveProcessing.confidenceThreshold;
  const confOverride = conf !== data.config.processing.confidenceThreshold;
  const det = data.config.detection;
  const podcastBody = { scope: "podcast" as const, podcastSlug: data.slug, ...options };

  const savedSeconds = data.episodes.reduce((sum, episode) => sum + Math.max(0, episode.audio.removedSeconds ?? 0), 0);
  const sourceSeconds = data.episodes.reduce((sum, episode) => sum + Math.max(0, episode.originalDurationSeconds ?? 0), 0);
  const avgAdsPct = sourceSeconds > 0 ? Number(((savedSeconds / sourceSeconds) * 100).toFixed(1)) : 0;
  const artworkUrl = data.metadata.localArtworkUrl ?? data.metadata.sourceImageUrl;

  const stats: Array<[string, string, string?]> = [
    ["EPISODES", String(demo.episodes ?? data.metadata.manifestCount)],
    ["PROCESSED", String(demo.processed ?? data.metadata.processedCount)],
    ["FAILED", String(demo.failed ?? 0), S.red],
    ["QUARANTINED", String(demo.quarantined ?? 0), S.red],
    ["TIME SAVED", fmtHoursMinutes(demo.savedSeconds ?? savedSeconds), S.accent],
    ["AVG ADS", `${demo.avgAdsPct ?? avgAdsPct}%`],
    ["SPEND 30D", fmtUsd(demo.spend30dUsd ?? 0)],
    ["LATEST", demo.latestRelative ?? "—"],
  ];

  const config: Array<[string, string, "override" | "global"]> = [
    ["Confidence", conf.toFixed(2), confOverride ? "override" : "global"],
    ["Pre-pad", `${det.prePaddingSeconds}s`, "global"],
    ["Post-pad", `${det.postPaddingSeconds}s`, "global"],
    ["Min cut", `${det.minSegmentSeconds}s`, "global"],
    ["Max cut", `${det.maxSegmentSeconds}s`, "global"],
    ["Marker tone", data.config.audio.jingle.enabled ? "on" : "off", "global"],
    ["STT model", data.metadata.transcriptionModel, "global"],
    ["Detection", data.config.llm.enabled ? data.config.llm.model : "disabled", "global"],
    ["Reuse tx", "yes", "global"],
  ];

  return (
    <div style={{ padding: mobile ? 10 : 14, gap: 12, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, ...sMono, fontSize: 11, color: S.textDim, flexWrap: "wrap" }}>
        <Link to="/" style={{ color: S.textMute }}>podcasts</Link>
        <span style={{ color: S.textMute }}>/</span>
        <span style={{ color: S.text }}>{data.slug}</span>
        <div style={{ flex: 1 }} />
        <SBtn variant="ghost"><a href={data.feedUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>Open original feed ↗</a></SBtn>
        <SBtn variant="soft" onClick={() => navigator.clipboard?.writeText(data.subscriptionUrl)}>Copy proxied URL</SBtn>
        <SBtn variant="primary" onClick={() => runAdminAction(() => api.reprocess({ scope: "podcast", podcastSlug: data.slug, force: true }), reload)}>▶ Reprocess all</SBtn>
      </div>

      <SPanel>
        <div style={{ padding: 16, display: "flex", gap: 16, flexDirection: mobile ? "column" : "row" }}>
          <SArt title={data.name} slug={data.slug} color={accent} src={artworkUrl} size={mobile ? 112 : 168} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.3 }}>{data.name}</h1>
              <SStatus s={demo.failed && demo.failed >= 3 ? "fail" : "ok"} />
            </div>
            <div style={{ ...sMono, fontSize: 11, color: S.textDim, marginTop: 3 }}>{data.host ?? "—"} · publishes weekly</div>
            <p style={{ margin: "8px 0 0", fontSize: 12, color: S.textDim, maxWidth: 680, lineHeight: 1.5 }}>{data.metadata.description ?? data.metadata.feedError ?? "—"}</p>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginTop: 12, ...sMono, fontSize: 10.5, maxWidth: 760 }}>
              <span style={{ color: S.textMute }}>SOURCE</span>
              <span style={{ color: S.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.feedUrl}</span>
              <span style={{ color: S.textMute }}>PROXIED</span>
              <span style={{ color: S.accent, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.subscriptionUrl}</span>
              <span style={{ color: S.textMute }}>VARIANTS</span>
              <span style={{ color: S.textDim }}>ad-free.xml · clean.xml · chapters-only.xml</span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "6px 18px", alignSelf: "flex-start", ...sMono, fontSize: 11, color: S.textDim, borderLeft: mobile ? "none" : `1px solid ${S.border}`, paddingLeft: mobile ? 0 : 16, minWidth: 200 }}>
            {stats.map(([l, v, c]) => (
              <Stat key={l} label={l} value={v} color={c} />
            ))}
          </div>
        </div>
      </SPanel>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 320px", gap: 12 }}>
        <SPanel title="Episodes" subtitle="processed history" right={<div style={{ display: "flex", gap: 6 }}><SBtn variant="ghost">Filter</SBtn><SBtn variant="ghost">Last 30d</SBtn></div>}>
          <div style={{ overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", ...sMono, fontSize: 11 }}>
              <thead>
                <tr style={{ background: S.panelHi, borderBottom: `1px solid ${S.border}` }}>
                  {["#", "Title", "Published", "Status", "Source", "Processed", "Saved", "Cuts", "Marks", "Cost", ""].map((h, i) => (
                    <th key={i} style={{ padding: "7px 8px", textAlign: i > 2 ? "right" : "left", fontSize: 9.5, letterSpacing: 1, color: S.textMute, textTransform: "uppercase", fontWeight: 500, position: "sticky", top: 0, background: S.panelHi, ...(i === 0 ? { width: 36 } : {}) }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.episodes.map((e) => {
                  const n = episodeNumber(e);
                  const src = e.originalDurationSeconds ?? 0;
                  const proc = e.processedDurationSeconds ?? 0;
                  const saved = Math.max(0, e.audio.removedSeconds ?? src - proc);
                  const cuts = countAction(e, "remove");
                  const marks = countAction(e, "mark-only");
                  const note = e.modelNotes?.[0];
                  return (
                    <tr key={e.episodeKey} style={{ borderBottom: `1px solid ${S.border}`, cursor: "pointer" }} onClick={() => navigate(`/podcasts/${data.slug}/episodes/${e.episodeKey}`)}>
                      <td style={{ padding: "8px 8px", color: S.textMute }}>{n || "—"}</td>
                      <td style={{ padding: "8px 8px" }}>
                        <div style={{ fontFamily: S.font, fontSize: 12, color: S.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>{e.title}</div>
                        {note && <div style={{ fontSize: 10, color: e.audio.status === "completed" ? S.textMute : S.red, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>↳ {note}</div>}
                      </td>
                      <td style={{ padding: "8px 8px", color: S.textDim }}>{relativeFromIso(e.pubDate)}</td>
                      <td style={{ padding: "8px 8px" }}><SStatus s={e.audio.status} /></td>
                      <td style={{ padding: "8px 8px", color: S.textDim, textAlign: "right" }}>{fmtTime(src)}</td>
                      <td style={{ padding: "8px 8px", color: proc ? S.text : S.textMute, textAlign: "right" }}>{proc ? fmtTime(proc) : "—"}</td>
                      <td style={{ padding: "8px 8px", color: saved > 0 ? S.accent : S.textMute, textAlign: "right" }}>{saved > 0 ? fmtDur(saved) : "—"}</td>
                      <td style={{ padding: "8px 8px", color: cuts ? S.red : S.textMute, textAlign: "right" }}>{cuts || "—"}</td>
                      <td style={{ padding: "8px 8px", color: marks ? S.amber : S.textMute, textAlign: "right" }}>{marks || "—"}</td>
                      <td style={{ padding: "8px 8px", color: S.textDim, textAlign: "right" }}>{fmtUsd(e.costs.actualUsd)}</td>
                      <td style={{ padding: "8px 8px", color: S.textMute, textAlign: "right" }}>›</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SPanel>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <SPanel title="Effective config" right={<Link to="/tuning"><SBtn variant="ghost">Edit</SBtn></Link>}>
            <div style={{ padding: 12, display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 10px", ...sMono, fontSize: 11 }}>
              {config.map(([k, v, src]) => (
                <div key={k} style={{ display: "contents" }}>
                  <div>
                    <span style={{ color: S.textMute }}>{k}</span> <span style={{ color: S.text }}>{v}</span>
                  </div>
                  <span style={{ color: src === "override" ? S.accent : S.textMute, fontSize: 9, letterSpacing: 1, textTransform: "uppercase" }}>{src}</span>
                </div>
              ))}
            </div>
          </SPanel>
          <SPanel title="Manual actions">
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <SBtn variant="primary" onClick={() => runAdminAction(() => api.reprocess({ ...podcastBody, maxEpisodes: 1 }), reload)}>▶ Reprocess latest</SBtn>
              <SBtn variant="soft" onClick={() => runAdminAction(() => api.resetAttempts({ podcastSlug: data.slug }), reload)}>↻ Retry failed</SBtn>
              <SBtn variant="soft" onClick={() => runAdminAction(() => api.resetAttempts({ podcastSlug: data.slug, allQuarantined: true }), reload)}>⌂ Reset quarantined</SBtn>
              <SBtn variant="ghost" onClick={() => runAdminAction(() => api.reprocess({ scope: "podcast", podcastSlug: data.slug }), reload)}>↓ Re-fetch feed</SBtn>
              <SBtn variant="ghost" onClick={() => runAdminAction(() => api.reprocess({ scope: "podcast", podcastSlug: data.slug }), reload)}>⌗ Regenerate proxied feed</SBtn>
              <SBtn variant="danger">⊘ Pause podcast</SBtn>
              <ReprocessOptions options={options} setOptions={setOptions} />
            </div>
          </SPanel>
        </div>
      </div>
    </div>
  );
}

export function Podcast() {
  const { slug = "" } = useParams();
  const mobile = useIsMobile();
  const { data, error, loading, reload } = useApi(() => api.deepDive(slug), [slug]);
  if (loading) return <Loading label="loading podcast" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return <PodcastBody data={data} mobile={mobile} reload={reload} />;
}
