import { useState } from "react";
import { S, sMono } from "../tokens";
import { SPanel, SBtn, SDot, Loading, ErrorNote } from "../components/ui";
import { api, runAdminAction, type TuningView } from "../api";
import { useApi, useIsMobile } from "../hooks";

interface Form {
  confidence: number;
  prePad: number;
  postPad: number;
  minCut: number;
  maxCut: number;
  markerTone: boolean;
}

function TuneRow({ label, note, display, min, max, step, marks, value, onChange }: { label: string; note: string; display: string; min: number; max: number; step: number; marks: number[]; value: number; onChange: (v: number) => void }) {
  const frac = (value - min) / (max - min);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(120px,180px) 1fr 80px", gap: 14, padding: "12px 0", borderBottom: `1px solid ${S.border}`, alignItems: "center" }}>
      <div>
        <div style={{ fontSize: 12, color: S.text }}>{label}</div>
        <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 2 }}>{note}</div>
      </div>
      <div style={{ position: "relative", height: 30 }}>
        <div style={{ position: "absolute", top: 14, left: 0, right: 0, height: 2, background: S.panelHi }} />
        <div style={{ position: "absolute", top: 14, left: 0, height: 2, width: `${frac * 100}%`, background: S.accent }} />
        {marks.map((m, i) => (
          <div key={i} style={{ position: "absolute", top: 8, left: `${((m - min) / (max - min)) * 100}%`, width: 1, height: 14, background: S.textMute }} />
        ))}
        <div style={{ position: "absolute", top: 9, left: `${frac * 100}%`, width: 12, height: 12, transform: "translateX(-6px)", background: S.accent, border: `2px solid ${S.bg}` }} />
        <div style={{ position: "absolute", top: 0, left: 0, ...sMono, fontSize: 9, color: S.textMute }}>{min}</div>
        <div style={{ position: "absolute", top: 0, right: 0, ...sMono, fontSize: 9, color: S.textMute }}>{max}</div>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "pointer" }} aria-label={label} />
      </div>
      <div style={{ ...sMono, fontSize: 16, color: S.accent, textAlign: "right" }}>{display}</div>
    </div>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <div style={{ width: 42, height: 22, background: on ? S.accent : S.panelHi, position: "relative", cursor: "pointer" }}>
      <div style={{ position: "absolute", top: 2, bottom: 2, width: 18, background: S.bg, left: on ? "auto" : 2, right: on ? 2 : "auto" }} />
    </div>
  );
}

function TuningBody({ data, mobile, reload }: { data: TuningView; mobile: boolean; reload: () => void }) {
  const initial: Form = { confidence: data.global.confidence, prePad: data.global.prePad, postPad: data.global.postPad, minCut: data.global.minCut, maxCut: data.global.maxCut, markerTone: data.global.markerTone };
  const [form, setForm] = useState<Form>(initial);
  const set = <K extends keyof Form>(key: K, v: Form[K]) => setForm((f) => ({ ...f, [key]: v }));
  const changed = (Object.keys(initial) as Array<keyof Form>).filter((k) => form[k] !== initial[k]).length;

  const save = () =>
    runAdminAction(
      () =>
        api.saveTuning({
          scope: "global",
          confidenceThreshold: form.confidence,
          prePaddingSeconds: form.prePad,
          postPaddingSeconds: form.postPad,
          minSegmentSeconds: form.minCut,
          maxSegmentSeconds: form.maxCut,
          markerToneEnabled: form.markerTone,
        }),
      reload
    );

  return (
    <div style={{ padding: mobile ? 10 : 14, gap: 12, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Runtime tuning</h1>
        <span style={{ ...sMono, fontSize: 10, color: S.textMute, marginLeft: 6 }}>changes apply to future runs and forced reprocesses</span>
        <div style={{ flex: 1 }} />
        <span style={{ ...sMono, fontSize: 10, color: S.amber, display: "flex", alignItems: "center", gap: 6 }}>
          <SDot color={S.amber} /> admin token {data.adminConfigured ? "required to save" : "not configured"}
        </span>
      </div>

      <div style={{ border: `1px solid ${S.border}`, background: `${S.amber}08`, padding: "10px 14px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ ...sMono, fontSize: 9, letterSpacing: 1, color: S.amber, textTransform: "uppercase", flex: "0 0 auto" }}>Heads-up</div>
        <div style={{ fontSize: 12, color: S.textDim }}>
          Lowering confidence below <span style={{ color: S.text }}>0.55</span> causes more partial cuts; raising it above <span style={{ color: S.text }}>0.75</span> tends to leave host-reads in. The marker tone setting is per-podcast — disable it for daily news.
        </div>
        <div style={{ flex: 1 }} />
        <SBtn variant="ghost">Read tuning guide ↗</SBtn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1.4fr 1fr", gap: 12 }}>
        <SPanel title="Global defaults" subtitle="apply to every podcast unless overridden">
          <div style={{ padding: "4px 16px" }}>
            <TuneRow label="Confidence threshold" note="cuts only fire above this score" min={0.3} max={0.95} step={0.01} marks={[0.5, 0.65, 0.8]} value={form.confidence} display={form.confidence.toFixed(2)} onChange={(v) => set("confidence", v)} />
            <TuneRow label="Pre-cut padding" note="silence kept before each cut start" min={0} max={1.5} step={0.05} marks={[0.2, 0.5, 1.0]} value={form.prePad} display={`${form.prePad}s`} onChange={(v) => set("prePad", Number(v.toFixed(2)))} />
            <TuneRow label="Post-cut padding" note="silence kept after each cut end" min={0} max={1.5} step={0.05} marks={[0.2, 0.5, 1.0]} value={form.postPad} display={`${form.postPad}s`} onChange={(v) => set("postPad", Number(v.toFixed(2)))} />
            <TuneRow label="Minimum cut duration" note="shorter detections are dropped" min={2} max={30} step={1} marks={[5, 15, 25]} value={form.minCut} display={`${form.minCut}s`} onChange={(v) => set("minCut", v)} />
            <TuneRow label="Maximum cut duration" note="longer detections are quarantined for review" min={30} max={600} step={5} marks={[60, 180, 300]} value={form.maxCut} display={`${form.maxCut}s`} onChange={(v) => set("maxCut", v)} />

            <div style={{ display: "grid", gridTemplateColumns: "minmax(120px,180px) 1fr 80px", gap: 14, padding: "12px 0", borderBottom: `1px solid ${S.border}`, alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 12, color: S.text }}>Marker tone</div>
                <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 2 }}>short bleep inserted at each splice point</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }} onClick={() => set("markerTone", !form.markerTone)}>
                <Toggle on={form.markerTone} />
                <span style={{ ...sMono, fontSize: 10, color: S.textDim }}>{form.markerTone ? "ON" : "OFF"}</span>
              </div>
              <div style={{ ...sMono, fontSize: 16, color: S.accent, textAlign: "right" }}>1k Hz</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(120px,180px) 1fr 80px", gap: 14, padding: "12px 0", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 12, color: S.text }}>Reuse transcript</div>
                <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 2 }}>skip STT if a fresh transcript is on disk</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Toggle on={data.global.reuseTranscript} />
                <span style={{ ...sMono, fontSize: 10, color: S.textDim }}>{data.global.reuseTranscript ? "ON" : "OFF"}</span>
              </div>
              <div style={{ ...sMono, fontSize: 10, color: S.textMute, textAlign: "right" }}>fallback: re-STT</div>
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${S.border}`, padding: "10px 16px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ ...sMono, fontSize: 10, color: S.textMute }}>{changed} fields changed since last save</span>
            <div style={{ flex: 1 }} />
            <SBtn variant="ghost" onClick={() => setForm(initial)} disabled={changed === 0}>Revert</SBtn>
            <SBtn variant="ghost">Diff</SBtn>
            <SBtn variant="primary" onClick={save} disabled={changed === 0}>Save · admin token required</SBtn>
          </div>
        </SPanel>

        <SPanel title="Per-podcast overrides" subtitle={`${data.perPodcast.length} podcasts with overrides`} right={<SBtn variant="ghost">+ Add</SBtn>}>
          <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
            {data.perPodcast.map((o) => (
              <div key={o.slug} style={{ border: `1px solid ${S.border}`, background: S.panelHi, padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 3, height: 16, background: o.color }} />
                  <span style={{ fontSize: 12, color: S.text, fontWeight: 600 }}>{o.title}</span>
                  <span style={{ ...sMono, fontSize: 9.5, color: S.textMute, letterSpacing: 0.6, textTransform: "uppercase" }}>· {o.slug}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ ...sMono, fontSize: 10, color: S.textMute, cursor: "pointer" }}>edit</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginTop: 8, ...sMono, fontSize: 10.5 }}>
                  <div><span style={{ color: S.textMute }}>conf </span><span style={{ color: S.accent }}>{o.confidence}</span></div>
                  <div><span style={{ color: S.textMute }}>pre </span><span style={{ color: S.accent }}>{o.prePad}s</span></div>
                  <div><span style={{ color: S.textMute }}>post </span><span style={{ color: S.accent }}>{o.postPad}s</span></div>
                  <div><span style={{ color: S.textMute }}>tone </span><span style={{ color: S.accent }}>{o.markerTone ? "on" : "off"}</span></div>
                </div>
                {o.notes && <div style={{ ...sMono, fontSize: 10, color: S.textMute, marginTop: 6, fontStyle: "italic" }}>// {o.notes}</div>}
              </div>
            ))}
            <div style={{ ...sMono, fontSize: 10, color: S.textMute, padding: "10px 0", textAlign: "center", borderTop: `1px dashed ${S.border}` }}>+ {data.defaultsCount} podcasts using global defaults</div>
          </div>
        </SPanel>
      </div>
    </div>
  );
}

export function Tuning() {
  const mobile = useIsMobile();
  const { data, error, loading, reload } = useApi(() => api.tuning());
  if (loading) return <Loading label="loading tuning" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  return <TuningBody data={data} mobile={mobile} reload={reload} />;
}
