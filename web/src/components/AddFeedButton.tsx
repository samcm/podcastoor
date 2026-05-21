import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { S, sMono } from "../tokens";
import { SBtn } from "./ui";
import { api, ensureAdminToken } from "../api";
import { useAdminSession } from "../hooks";

export function AddFeedButton({ variant = "ghost" }: { variant?: "ghost" | "soft" | "primary" }) {
  const { isAdmin } = useAdminSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const close = () => {
    setOpen(false);
    setName("");
    setFeedUrl("");
    setError(undefined);
  };

  const submit = async () => {
    setError(undefined);
    if (!name.trim() || !feedUrl.trim()) {
      setError("Name and feed URL are required.");
      return;
    }
    if (!ensureAdminToken()) return;
    setBusy(true);
    try {
      const { slug } = await api.addFeed({ name: name.trim(), feedUrl: feedUrl.trim() });
      close();
      navigate(`/podcasts/${slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    background: S.bg,
    border: `1px solid ${S.border}`,
    color: S.text,
    padding: "8px 10px",
    ...sMono,
    fontSize: 12,
    outline: "none",
    width: "100%",
  } as const;

  if (!isAdmin) return null;

  return (
    <>
      <SBtn variant={variant} onClick={() => setOpen(true)}>
        + Add feed
      </SBtn>
      {open && (
        <div
          onClick={close}
          style={{ position: "fixed", inset: 0, background: "#00000099", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "100%", background: S.panel, border: `1px solid ${S.borderHi}` }}>
            <div style={{ height: 36, borderBottom: `1px solid ${S.border}`, display: "flex", alignItems: "center", padding: "0 14px" }}>
              <span style={{ ...sMono, fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: S.textDim }}>Add feed</span>
              <div style={{ flex: 1 }} />
              <span onClick={close} style={{ ...sMono, fontSize: 14, color: S.textMute, cursor: "pointer" }}>✕</span>
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ ...sMono, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: S.textMute }}>Name</span>
                <input style={inputStyle} value={name} placeholder="Example Show" onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ ...sMono, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: S.textMute }}>Feed URL</span>
                <input style={inputStyle} value={feedUrl} placeholder="https://feeds.example.com/show.xml" onChange={(e) => setFeedUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
              </label>
              <div style={{ ...sMono, fontSize: 10, color: S.textMute, lineHeight: 1.5 }}>The feed is added to this host and persists across restarts. Mutating actions require an admin token.</div>
              {error && <div style={{ ...sMono, fontSize: 11, color: S.red }}>{error}</div>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                <SBtn variant="ghost" onClick={close}>Cancel</SBtn>
                <SBtn variant="primary" onClick={submit} disabled={busy}>{busy ? "Adding…" : "Add feed"}</SBtn>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
