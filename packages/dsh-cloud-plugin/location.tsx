import React, { useEffect, useId, useRef, useState } from "react";

export function canChooseLocation(session: {
  blank?: boolean; running?: boolean; awaitingFirstTurn?: boolean;
  pendingSubmissions?: readonly unknown[];
} | undefined, entry: { draft?: boolean } | undefined, inputPhase: string | undefined) {
  return session?.blank === true && !session.running && !session.awaitingFirstTurn
    && !session.pendingSubmissions?.length && (!entry || entry.draft === true) && inputPhase === "plain";
}

export function CloudIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 18a4.5 4.5 0 0 1-.8-8.9A6.5 6.5 0 0 1 17.6 8a5 5 0 0 1 .4 10H6Z"/></svg>;
}
function LocalIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>;
}

export function LocationPicker({ available, cloud, onSelect, children }: {
  available: boolean;
  cloud: boolean;
  onSelect: (cloud: boolean) => Promise<boolean>;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panelId = useId();
  useEffect(() => { setOpen(false); setError(""); }, [available]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  // Unknown/loading sessions must never expose a location switch.
  if (!available) return null;
  const select = async (next: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try { if (await onSelect(next)) { setOpen(false); trigger.current?.focus(); } }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div ref={root} className="dsh-cloud-native cloud-location" onKeyDown={e => {
    if (e.key === "Escape") { e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }} onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" className="cloud-location-trigger" aria-label={`执行位置：${cloud ? "云端" : "本地"}`} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
      {cloud ? <CloudIcon/> : <LocalIcon/>}<span>{cloud ? "云端" : "本地"}</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <div id={panelId} className="cloud-popover" aria-label="执行位置">
      <div className="cloud-location-options" role="group" aria-label="选择执行位置">
        <button type="button" aria-pressed={!cloud} disabled={busy} onClick={() => void select(false)}><LocalIcon/><span>本地</span>{!cloud && <span className="cloud-location-check" aria-hidden="true">✓</span>}</button>
        <button type="button" aria-pressed={cloud} disabled={busy} onClick={() => void select(true)}><CloudIcon/><span>云端</span>{cloud && <span className="cloud-location-check" aria-hidden="true">✓</span>}</button>
      </div>
      {children && <div className="cloud-location-setup">{children}</div>}
      {error && <p className="cloud-error" role="alert">{error}</p>}
    </div>}
  </div>;
}
