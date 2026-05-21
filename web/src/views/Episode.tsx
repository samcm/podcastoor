import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { S, sMono, fmtTime, fmtDur } from "../tokens";
import { SPanel, SBtn, SStatus, SArt, Loading, ErrorNote } from "../components/ui";
import { api, type EpisodeView } from "../api";
import { useApi, useIsMobile } from "../hooks";

type Kind = "source" | "processed";
type DecisionRow = EpisodeView["decisions"][number];
type TranscriptRow = EpisodeView["transcript"][number];

const TRANSCRIPT_FOLLOW_PAUSED_KEY = "podcastoor.transcriptFollowPaused";

function Waveform({ kind }: { kind: Kind }) {
  return (
    <svg viewBox="0 0 1000 60" preserveAspectRatio="none" style={{ position: "absolute", left: 0, right: 0, top: 22, height: 60, width: "100%" }}>
      {Array.from({ length: 200 }).map((_, i) => {
        const seed = Math.sin(i * 0.7 + (kind === "source" ? 0 : 1.3)) * Math.sin(i * 0.13 + 2);
        const h = 6 + Math.abs(seed) * 22 + Math.sin(i * 1.7) * 4;
        return <rect key={i} x={i * 5} y={30 - h / 2} width={3} height={h} fill={S.textMute} opacity={0.45} />;
      })}
    </svg>
  );
}

function TimeButton({ value, muted = false, onClick }: { value: number; muted?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        ...sMono,
        border: "none",
        background: "transparent",
        padding: 0,
        color: muted ? S.textMute : S.accent,
        cursor: "pointer",
        fontSize: "inherit",
        textDecoration: "underline",
        textDecorationColor: `${S.accent}55`,
        textUnderlineOffset: 2,
      }}
    >
      {fmtTime(value)}
    </button>
  );
}

function readTranscriptFollowPaused(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(TRANSCRIPT_FOLLOW_PAUSED_KEY) === "1";
}

function writeTranscriptFollowPaused(paused: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRANSCRIPT_FOLLOW_PAUSED_KEY, paused ? "1" : "0");
}

function transcriptStart(row: TranscriptRow, kind: Kind): number | null {
  return kind === "source" ? row.src : row.proc;
}

function transcriptEnd(row: TranscriptRow, kind: Kind): number | null {
  return kind === "source" ? row.srcEnd : row.procEnd;
}

function findActiveTranscriptIndex(rows: TranscriptRow[], kind: Kind, seconds: number): number {
  let nearest = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const start = transcriptStart(rows[i], kind);
    if (start === null) continue;
    const end = Math.max(start + 0.5, transcriptEnd(rows[i], kind) ?? start + 0.5);
    if (seconds >= start) nearest = i;
    if (seconds >= start && seconds < end) return i;
    if (start > seconds && nearest >= 0) break;
  }
  return nearest;
}

function Timeline({ ep, kind, currentTime, onSeek }: { ep: EpisodeView; kind: Kind; currentTime: number; onSeek: (kind: Kind, seconds: number) => void }) {
  const dur = (kind === "source" ? ep.durSource : ep.durProc) || 1;
  const chapters = kind === "source" ? ep.chaptersSource : ep.chaptersFinal;
  const pct = (t: number) => (t / dur) * 100;
  const seekFromClientX = (clientX: number, target: HTMLDivElement) => {
    const rect = target.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(kind, ratio * dur);
  };
  return (
    <div
      onClick={(event) => {
        seekFromClientX(event.clientX, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key === "Home") onSeek(kind, 0);
        if (event.key === "End") onSeek(kind, dur);
        if (event.key === "ArrowLeft") onSeek(kind, Math.max(0, currentTime - 10));
        if (event.key === "ArrowRight") onSeek(kind, Math.min(dur, currentTime + 10));
      }}
      role="button"
      tabIndex={0}
      aria-label={`${kind} audio timeline`}
      style={{ position: "relative", height: 108, padding: "18px 0 14px", background: S.panelHi, border: `1px solid ${S.border}`, cursor: "crosshair" }}
    >
      <Waveform kind={kind} />
      {ep.decisions.map((d) => {
        if (kind === "processed" && d.action === "remove") return null;
        const t0 = kind === "source" ? d.src0 : d.proc;
        const t1 = kind === "source" ? d.src1 : d.proc + d.dur;
        const left = pct(t0);
        const width = Math.max(0.3, pct(t1 - t0));
        const col = d.action === "remove" ? S.red : S.amber;
        return (
          <div
            key={d.i}
            style={{
              position: "absolute",
              left: `${left}%`,
              width: `${width}%`,
              top: 18,
              bottom: 14,
              background: d.action === "remove" ? `${col}40` : "transparent",
              borderTop: `2px solid ${col}`,
              borderBottom: `2px solid ${col}`,
              backgroundImage: d.action === "mark" ? `repeating-linear-gradient(45deg, ${col}30 0 4px, transparent 4px 8px)` : undefined,
            }}
          />
        );
      })}
      {chapters.map((c, i) => (
        <div key={i} style={{ position: "absolute", left: `${pct(c.t)}%`, top: 0, bottom: 0, width: 0 }}>
          <div style={{ position: "absolute", top: 0, left: -3, width: 6, height: 6, background: S.green, transform: "rotate(45deg)" }} />
          <div style={{ position: "absolute", top: 0, bottom: 14, left: 0, width: 1, background: `${S.green}40` }} />
        </div>
      ))}
      {kind === "processed" &&
        ep.decisions
          .filter((d) => d.action === "remove")
          .map((d) => (
            <div key={`sp${d.i}`} style={{ position: "absolute", left: `${pct(d.proc)}%`, top: 18, bottom: 14, width: 1, background: S.blue }}>
              <div style={{ position: "absolute", top: -4, left: -3, width: 7, height: 7, background: S.blue, border: `1px solid ${S.bg}` }} />
            </div>
          ))}
      <div style={{ position: "absolute", left: `${pct(currentTime)}%`, top: 14, bottom: 10, width: 2, background: S.accent, boxShadow: `0 0 8px ${S.accent}` }}>
        <div style={{ position: "absolute", top: -6, left: -5, width: 12, height: 8, background: S.accent, clipPath: "polygon(0 0, 100% 0, 50% 100%)" }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 14, display: "flex", justifyContent: "space-between", padding: "0 6px", ...sMono, fontSize: 9.5, color: S.textMute }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <span key={i}>{fmtTime(dur * f)}</span>
        ))}
      </div>
    </div>
  );
}

function Transport({ ep, kind, currentTime, playing, onToggle, onSeek }: { ep: EpisodeView; kind: Kind; currentTime: number; playing: boolean; onToggle: (kind: Kind) => void; onSeek: (kind: Kind, seconds: number) => void }) {
  const dur = kind === "source" ? ep.durSource : ep.durProc;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: S.panel, border: `1px solid ${S.border}`, borderBottom: "none", flexWrap: "wrap" }}>
      <div style={{ ...sMono, fontSize: 10, letterSpacing: 1, color: kind === "source" ? S.textDim : S.accent, textTransform: "uppercase" }}>{kind === "source" ? "SRC" : "OUT"}</div>
      <button onClick={() => onToggle(kind)} style={{ width: 26, height: 26, background: S.accent, color: "#1a1208", border: "none", cursor: "pointer", fontSize: 12 }}>{playing ? "⏸" : "▶"}</button>
      <button onClick={() => onSeek(kind, 0)} style={{ width: 26, height: 26, background: "transparent", color: S.textDim, border: `1px solid ${S.border}`, cursor: "pointer" }}>↺</button>
      <div style={{ ...sMono, fontSize: 11, color: S.text }}>
        {fmtTime(currentTime)} <span style={{ color: S.textMute }}>/ {fmtTime(dur)}</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ ...sMono, fontSize: 10, color: S.textDim, display: "flex", gap: 10 }}>
        <span>1.0×</span>
        <span>−6dB</span>
        <span>{kind === "source" ? "mp3 128k" : "mp3 96k + tones"}</span>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: "flex", gap: 14, ...sMono, fontSize: 10, color: S.textDim, alignItems: "center", flexWrap: "wrap" }}>
      <span><span style={{ display: "inline-block", width: 10, height: 8, background: `${S.red}80`, border: `1.5px solid ${S.red}`, verticalAlign: "middle" }} /> removed</span>
      <span><span style={{ display: "inline-block", width: 10, height: 8, background: `repeating-linear-gradient(45deg, ${S.amber}50 0 2px, transparent 2px 4px)`, border: `1.5px solid ${S.amber}`, verticalAlign: "middle" }} /> mark-only</span>
      <span><span style={{ display: "inline-block", width: 6, height: 6, background: S.green, transform: "rotate(45deg)", verticalAlign: "middle" }} /> chapter</span>
      <span><span style={{ display: "inline-block", width: 7, height: 7, background: S.blue, verticalAlign: "middle" }} /> splice</span>
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...sMono, fontSize: 9, letterSpacing: 1, color: S.textMute, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
      <div style={{ color: S.text, fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>{children}</div>
    </div>
  );
}

function DecisionDetail({ d, onSeek }: { d: DecisionRow; onSeek: (kind: Kind, seconds: number, play?: boolean) => void }) {
  const alignment = d.alignment;
  return (
    <td colSpan={10} style={{ padding: 0, background: S.panelHi, borderTop: `1px solid ${S.borderHi}` }}>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
          <DetailField label="Source window">
            <TimeButton value={d.src0} onClick={() => onSeek("source", d.src0, true)} /> <span style={{ color: S.textMute }}>to</span>{" "}
            <TimeButton value={d.src1} onClick={() => onSeek("source", d.src1, true)} /> <span style={{ color: S.textMute }}>({fmtDur(d.src1 - d.src0)})</span>
          </DetailField>
          <DetailField label="Processed splice">
            <TimeButton value={d.proc} onClick={() => onSeek("processed", d.proc, true)} />
          </DetailField>
          <DetailField label="Decision">{d.action}</DetailField>
          <DetailField label="Confidence">{Math.round(d.conf * 100)}%</DetailField>
          <DetailField label="Advertiser">{d.who}</DetailField>
          <DetailField label="Detector">{d.source}</DetailField>
          <DetailField label="Boundary method">{alignment?.method ?? d.method}</DetailField>
          <DetailField label="Segment indexes">
            {alignment?.startSegmentIndex ?? "—"} <span style={{ color: S.textMute }}>to</span> {alignment?.endSegmentIndex ?? "—"}
          </DetailField>
        </div>

        <DetailField label="Reason">{d.reason || "—"}</DetailField>

        {(alignment?.startAnchorText || alignment?.endAnchorText) && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <DetailField label="Start anchor">{alignment.startAnchorText ?? "—"}</DetailField>
            <DetailField label="End anchor">{alignment.endAnchorText ?? "—"}</DetailField>
          </div>
        )}

        {d.text && <DetailField label="Matched text">{d.text}</DetailField>}

        <pre style={{ margin: 0, padding: 10, border: `1px solid ${S.border}`, background: S.bg, color: S.textDim, overflow: "auto", maxHeight: 220, ...sMono, fontSize: 10.5, lineHeight: 1.45 }}>
          {JSON.stringify(d, null, 2)}
        </pre>
      </div>
    </td>
  );
}

function EpisodeBody({ ep, mobile }: { ep: EpisodeView; mobile: boolean }) {
  const audioRefs = {
    source: useRef<HTMLAudioElement>(null),
    processed: useRef<HTMLAudioElement>(null),
  };
  const [playing, setPlaying] = useState<Kind | null>(null);
  const [activeKind, setActiveKind] = useState<Kind>("processed");
  const [times, setTimes] = useState<Record<Kind, number>>({ source: 0, processed: 0 });
  const [expandedDecisions, setExpandedDecisions] = useState<Set<number>>(() => new Set());
  const [transcriptFollowPaused, setTranscriptFollowPaused] = useState(readTranscriptFollowPaused);
  const transcriptRowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const audioFor = (kind: Kind) => audioRefs[kind].current;
  const seek = (kind: Kind, seconds: number, play = false) => {
    setActiveKind(kind);
    const audio = audioFor(kind);
    if (!audio) return;
    const duration = kind === "source" ? ep.durSource : ep.durProc;
    const next = Math.max(0, Math.min(Number.isFinite(duration) ? duration : seconds, seconds));
    audio.currentTime = next;
    setTimes((current) => ({ ...current, [kind]: next }));
    if (play) {
      const other = kind === "source" ? audioRefs.processed.current : audioRefs.source.current;
      other?.pause();
      void audio.play().then(() => setPlaying(kind)).catch(() => setPlaying(null));
    }
  };
  const toggle = (kind: Kind) => {
    setActiveKind(kind);
    const audio = audioFor(kind);
    if (!audio) return;
    if (playing === kind && !audio.paused) {
      audio.pause();
      setPlaying(null);
      return;
    }
    const other = kind === "source" ? audioRefs.processed.current : audioRefs.source.current;
    other?.pause();
    void audio.play().then(() => setPlaying(kind)).catch(() => setPlaying(null));
  };
  const toggleDecisionExpanded = (decisionIndex: number) => {
    setExpandedDecisions((current) => {
      const next = new Set(current);
      if (next.has(decisionIndex)) next.delete(decisionIndex);
      else next.add(decisionIndex);
      return next;
    });
  };
  const toggleTranscriptFollow = () => {
    setTranscriptFollowPaused((current) => {
      const next = !current;
      writeTranscriptFollowPaused(next);
      return next;
    });
  };
  const activeTranscriptKind = playing ?? activeKind;
  const activeTranscriptIndex = useMemo(
    () => findActiveTranscriptIndex(ep.transcript, activeTranscriptKind, times[activeTranscriptKind]),
    [ep.transcript, activeTranscriptKind, times]
  );
  useEffect(() => {
    if (transcriptFollowPaused || activeTranscriptIndex < 0) return;
    transcriptRowRefs.current[activeTranscriptIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeTranscriptIndex, transcriptFollowPaused]);
  const seekTranscriptRow = (row: TranscriptRow) => {
    const kind: Kind = activeTranscriptKind === "source" || row.proc === null ? "source" : "processed";
    seek(kind, kind === "source" ? row.src : row.proc ?? row.src, true);
  };

  const headStats: Array<[string, string, string]> = [
    ["SOURCE", fmtTime(ep.durSource), S.textDim],
    ["PROCESSED", fmtTime(ep.durProc), S.text],
    ["SAVED", fmtDur(ep.saved), S.accent],
    ["CUTS", String(ep.cuts), S.red],
    ["MARKS", String(ep.marks), S.amber],
    ["COST", `$${ep.cost.toFixed(2)}`, S.text],
  ];
  return (
    <div style={{ padding: mobile ? 10 : 14, gap: 10, display: "flex", flexDirection: "column" }}>
      <audio
        ref={audioRefs.source}
        src={ep.links.sourceAudio}
        preload="metadata"
        onTimeUpdate={(event) => {
          const time = event.currentTarget.currentTime;
          setTimes((current) => ({ ...current, source: time }));
        }}
        onPause={() => setPlaying((current) => (current === "source" ? null : current))}
        onEnded={() => setPlaying((current) => (current === "source" ? null : current))}
      />
      <audio
        ref={audioRefs.processed}
        src={ep.links.processedAudio}
        preload="metadata"
        onTimeUpdate={(event) => {
          const time = event.currentTarget.currentTime;
          setTimes((current) => ({ ...current, processed: time }));
        }}
        onPause={() => setPlaying((current) => (current === "processed" ? null : current))}
        onEnded={() => setPlaying((current) => (current === "processed" ? null : current))}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, ...sMono, fontSize: 11, color: S.textDim, flexWrap: "wrap" }}>
        <Link to="/" style={{ color: S.textMute }}>podcasts</Link>
        <span style={{ color: S.textMute }}>/</span>
        <Link to={`/podcasts/${ep.podcastSlug}`}>{ep.podcastSlug}</Link>
        <span style={{ color: S.textMute }}>/</span>
        <span style={{ color: S.text }}>ep {ep.number}</span>
        <div style={{ flex: 1 }} />
        <SStatus s={ep.status} />
        <SBtn variant="ghost"><a href={ep.links.manifest} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>Manifest ↗</a></SBtn>
        <SBtn variant="ghost"><a href={ep.links.transcriptJson} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>Transcript JSON</a></SBtn>
        <SBtn variant="ghost"><a href={ep.links.transcriptVtt} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>VTT</a></SBtn>
        <SBtn variant="ghost"><a href={ep.links.chaptersJson} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>Chapters JSON</a></SBtn>
        <SBtn variant="primary">▶ Reprocess</SBtn>
      </div>

      <SPanel>
        <div style={{ padding: 14, display: "flex", gap: 16, alignItems: "flex-start", flexDirection: mobile ? "column" : "row" }}>
          <div style={{ display: "flex", gap: 14, flex: 1, minWidth: 0, alignItems: "flex-start", flexDirection: mobile ? "column" : "row" }}>
            <SArt title={ep.podcast} slug={ep.podcastSlug} color={ep.podcastColor} src={ep.podcastArtworkUrl} size={mobile ? 104 : 132} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: -0.2 }}>{ep.title}</h1>
              <div style={{ ...sMono, fontSize: 11, color: S.textDim, marginTop: 3 }}>
                {ep.podcast} · ep {ep.number} · published {ep.pubAt}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: mobile ? 16 : 24, ...sMono, fontSize: 11, flexWrap: "wrap" }}>
            {headStats.map(([k, v, c]) => (
              <div key={k}>
                <div style={{ fontSize: 9, letterSpacing: 1.2, color: S.textMute, textTransform: "uppercase" }}>{k}</div>
                <div style={{ fontSize: 18, color: c, marginTop: 2, letterSpacing: -0.3 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </SPanel>

      <SPanel title="Timelines" subtitle="source → processed" right={<Legend />}>
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 0 }}>
          <Transport ep={ep} kind="source" currentTime={times.source} playing={playing === "source"} onToggle={toggle} onSeek={seek} />
          <Timeline ep={ep} kind="source" currentTime={times.source} onSeek={(kind, seconds) => seek(kind, seconds, true)} />
          <div style={{ height: 14 }} />
          <Transport ep={ep} kind="processed" currentTime={times.processed} playing={playing === "processed"} onToggle={toggle} onSeek={seek} />
          <Timeline ep={ep} kind="processed" currentTime={times.processed} onSeek={(kind, seconds) => seek(kind, seconds, true)} />
        </div>
      </SPanel>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1.4fr 1fr", gap: 12 }}>
        <SPanel title="Decisions" subtitle={`${ep.decisions.length} total · ${ep.marks} mark-only`}>
          <div style={{ overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", ...sMono, fontSize: 10.5 }}>
              <thead>
                <tr style={{ background: S.panelHi, borderBottom: `1px solid ${S.border}` }}>
                  {["#", "Source", "→ Out", "Dur", "Action", "Conf", "Entity", "Reason", "Method", ""].map((h, i) => (
                    <th key={i} style={{ padding: "6px 8px", textAlign: "left", fontSize: 9, letterSpacing: 1, color: S.textMute, textTransform: "uppercase", fontWeight: 500, position: "sticky", top: 0, background: S.panelHi }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ep.decisions.map((d) => {
                  const partial = d.conf < 0.7;
                  const col = d.action === "remove" ? S.red : S.amber;
                  const expanded = expandedDecisions.has(d.i);
                  return (
                    <Fragment key={d.i}>
                      <tr
                        onClick={() => seek("source", d.src0, true)}
                        style={{ borderBottom: expanded ? "none" : `1px solid ${S.border}`, background: expanded ? `${S.blue}08` : d.action === "mark" ? `${S.amber}08` : "transparent", cursor: "pointer" }}
                      >
                        <td style={{ padding: "6px 8px", color: S.textMute }}>{d.i}</td>
                        <td style={{ padding: "6px 8px", color: S.text }}>
                          <TimeButton value={d.src0} onClick={() => seek("source", d.src0, true)} />
                          <span style={{ color: S.textMute }}>–</span>
                          <TimeButton value={d.src1} onClick={() => seek("source", d.src1, true)} />
                        </td>
                        <td style={{ padding: "6px 8px", color: d.action === "remove" ? S.textMute : S.text }}>
                          {d.action === "remove" ? <TimeButton value={d.proc} muted onClick={() => seek("processed", d.proc, true)} /> : <TimeButton value={d.proc} onClick={() => seek("processed", d.proc, true)} />}
                        </td>
                        <td style={{ padding: "6px 8px", color: S.textDim }}>{d.dur}s</td>
                        <td style={{ padding: "6px 8px" }}>
                          <span style={{ color: col, ...sMono, fontSize: 9.5, border: `1px solid ${col}50`, padding: "1px 5px", textTransform: "uppercase", letterSpacing: 0.8 }}>{d.action}</span>
                        </td>
                        <td style={{ padding: "6px 8px", color: partial ? S.amber : S.textDim }}>{d.conf.toFixed(2)}</td>
                        <td style={{ padding: "6px 8px", color: S.text, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.who}</td>
                        <td style={{ padding: "6px 8px", color: S.textDim, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.reason}</td>
                        <td style={{ padding: "6px 8px", color: S.textMute, fontSize: 9.5 }}>{d.method}</td>
                        <td style={{ padding: "4px 8px", textAlign: "right" }}>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            title={expanded ? "Hide decision details" : "Show decision details"}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleDecisionExpanded(d.i);
                            }}
                            style={{ ...sMono, fontSize: 9.5, color: expanded ? S.accent : S.textDim, background: expanded ? `${S.accent}12` : "transparent", border: `1px solid ${expanded ? S.accent : S.border}`, padding: "2px 6px", cursor: "pointer", textTransform: "uppercase" }}
                          >
                            {expanded ? "hide" : "view"}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <DecisionDetail d={d} onSeek={seek} />
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SPanel>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <SPanel
            title="Transcript"
            subtitle={`${ep.transcript.length} rows · following ${activeTranscriptKind === "source" ? "source" : "output"} ${fmtTime(times[activeTranscriptKind])}`}
            right={
              <>
                <SBtn variant={transcriptFollowPaused ? "soft" : "ghost"} onClick={toggleTranscriptFollow}>
                  {transcriptFollowPaused ? "Resume follow" : "Pause follow"}
                </SBtn>
                <SBtn variant="ghost">Show all</SBtn>
                <SBtn variant="ghost">Removed only</SBtn>
              </>
            }
          >
            <div style={{ overflow: "auto", maxHeight: 360 }}>
              {ep.transcript.map((r, i) => {
                const cmap: Record<string, string> = { kept: S.textDim, removed: S.red, partial: S.amber };
                const active = i === activeTranscriptIndex;
                const bg = active ? `${S.accent}18` : r.status === "partial" ? `${S.amber}10` : r.status === "removed" ? `${S.red}08` : "transparent";
                return (
                  <div
                    key={i}
                    ref={(node) => {
                      transcriptRowRefs.current[i] = node;
                    }}
                    aria-current={active ? "true" : undefined}
                    onClick={() => seekTranscriptRow(r)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "58px 58px 14px 1fr",
                      gap: 8,
                      padding: "7px 12px",
                      borderBottom: `1px solid ${active ? S.accent : S.border}`,
                      borderLeft: active ? `3px solid ${S.accent}` : "3px solid transparent",
                      background: bg,
                      cursor: "pointer",
                      boxShadow: active ? `inset 0 0 0 1px ${S.accent}26` : "none",
                    }}
                  >
                    <span style={{ ...sMono, fontSize: 10, color: S.textMute }}><TimeButton value={r.src} muted onClick={() => seek("source", r.src, true)} /></span>
                    <span style={{ ...sMono, fontSize: 10, color: r.proc === null ? S.textMute : S.accent }}>
                      {r.proc === null ? "—" : <TimeButton value={r.proc} onClick={() => seek("processed", r.proc!, true)} />}
                    </span>
                    <span style={{ ...sMono, fontSize: 9, color: cmap[r.status], letterSpacing: 0.6, textTransform: "uppercase", alignSelf: "center" }}>{r.status === "kept" ? "·" : r.status === "partial" ? "½" : "✕"}</span>
                    <span style={{ fontSize: 11.5, color: r.status === "removed" ? S.textMute : S.text, textDecoration: r.status === "removed" ? "line-through" : "none", lineHeight: 1.5 }}>{r.text}</span>
                  </div>
                );
              })}
              {ep.transcript.length === 0 && <div style={{ ...sMono, fontSize: 11, color: S.textMute, padding: 12 }}>no transcript on disk for this episode</div>}
            </div>
          </SPanel>

          <SPanel title="Chapters" subtitle="source → final">
            <div style={{ padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, ...sMono, fontSize: 10.5 }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1, color: S.textMute, textTransform: "uppercase", marginBottom: 4 }}>Source · {ep.chaptersSource.length}</div>
                {ep.chaptersSource.slice(0, 8).map((c, i) => {
                  const isAd = /Sponsor/.test(c.label);
                  return (
                    <div key={i} onClick={() => seek("source", c.t, true)} style={{ display: "flex", gap: 6, padding: "2px 0", color: isAd ? S.red : S.textDim, cursor: "pointer" }}>
                      <span style={{ color: S.textMute, width: 42 }}><TimeButton value={c.t} muted onClick={() => seek("source", c.t, true)} /></span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                    </div>
                  );
                })}
                {ep.chaptersSource.length > 8 && <div style={{ color: S.textMute, fontSize: 9, marginTop: 2 }}>+ {ep.chaptersSource.length - 8} more</div>}
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: 1, color: S.textMute, textTransform: "uppercase", marginBottom: 4 }}>Final · {ep.chaptersFinal.length}</div>
                {ep.chaptersFinal.map((c, i) => (
                  <div key={i} onClick={() => seek("processed", c.t, true)} style={{ display: "flex", gap: 6, padding: "2px 0", color: S.text, cursor: "pointer" }}>
                    <span style={{ color: S.green, width: 42 }}><TimeButton value={c.t} onClick={() => seek("processed", c.t, true)} /></span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </SPanel>
        </div>
      </div>
    </div>
  );
}

export function Episode() {
  const { slug = "", key = "" } = useParams();
  const mobile = useIsMobile();
  const { data, error, loading } = useApi(() => api.episode(slug, key), [slug, key]);
  if (loading) return <Loading label="loading episode" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return <EpisodeBody ep={data} mobile={mobile} />;
}
