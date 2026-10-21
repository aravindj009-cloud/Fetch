import React, { useEffect, useMemo, useState } from "react";
import "./FetchCompanionLayer.css";

const STORAGE_KEY = "fetch_daily_minutes_layer_v1";
const MAX_MINUTES = 300;

function localDayKey(date = new Date()) {
  const d = new Date(date);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

function readMinutes() {
  try {
    const items = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item.text === "string" && item.id)
      .slice(0, MAX_MINUTES)
      .map((item) => ({
        id: String(item.id),
        text: String(item.text).slice(0, 4000),
        createdAt: item.createdAt || new Date().toISOString(),
        day: item.day || localDayKey(item.createdAt),
      }));
  } catch {
    return [];
  }
}

function shortTime(value) {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function DogMark({ size = 34 }) {
  return (
    <svg className="fcl-dog" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Fetch dog companion">
      <path d="M29 28 C13 7 5 22 10 43 C13 56 21 61 31 56 Z" fill="#a66b43"/>
      <path d="M71 28 C87 7 95 22 90 43 C87 56 79 61 69 56 Z" fill="#a66b43"/>
      <ellipse cx="50" cy="53" rx="31" ry="34" fill="#edc68e"/>
      <ellipse cx="39" cy="47" rx="3.5" ry="5" fill="#26362f"/>
      <ellipse cx="61" cy="47" rx="3.5" ry="5" fill="#26362f"/>
      <ellipse cx="50" cy="60" rx="14" ry="11" fill="#fff0d9"/>
      <ellipse cx="50" cy="57" rx="5.5" ry="4" fill="#26362f"/>
      <path d="M44 64 Q50 70 56 64" fill="none" stroke="#805038" strokeWidth="2.5" strokeLinecap="round"/>
      <path d="M22 76 Q50 88 78 76 L75 84 Q50 97 25 84 Z" fill="#2d8472"/>
      <path d="M50 83 L57 90 L50 97 L43 90 Z" fill="#f3b26f"/>
    </svg>
  );
}

export default function FetchCompanionLayer({ open, onToggle, onClose, onRequest, isBusy = false }) {
  const [tab, setTab] = useState("ask");
  const [request, setRequest] = useState("");
  const [minuteDraft, setMinuteDraft] = useState("");
  const [minutes, setMinutes] = useState(readMinutes);
  const today = localDayKey();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(minutes.slice(0, MAX_MINUTES)));
    } catch {
      // The panel still works for the current session when browser storage is unavailable.
    }
  }, [minutes]);

  const todayMinutes = useMemo(
    () => minutes.filter((item) => item.day === today).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [minutes, today]
  );

  function sendRequest(event) {
    event?.preventDefault?.();
    const text = request.trim();
    if (!text || isBusy) return;
    setRequest("");
    onClose?.();
    // Reuse Fetch's existing universal request handler, ATC, connectors and approvals.
    onRequest?.(text);
  }

  function saveMinute(event) {
    event?.preventDefault?.();
    const text = minuteDraft.trim();
    if (!text) return;
    const now = new Date();
    setMinutes((current) => [
      { id: globalThis.crypto?.randomUUID?.() || String(Date.now()), text, createdAt: now.toISOString(), day: localDayKey(now) },
      ...current,
    ].slice(0, MAX_MINUTES));
    setMinuteDraft("");
  }

  function deleteMinute(id) {
    setMinutes((current) => current.filter((item) => item.id !== id));
  }

  function summariseMinutes() {
    if (!todayMinutes.length || isBusy) return;
    const source = todayMinutes.slice().reverse().map((item) =>
      "[" + shortTime(item.createdAt) + "] " + item.text
    ).join("\n");
    const prompt = [
      "Prepare my end-of-day brief from these daily minutes captured in Fetch.",
      "Organise it into: what happened, decisions, commitments and owners (only when explicitly stated), unresolved questions, and next actions.",
      "Do not invent facts, owners, decisions, or completed actions. Mark uncertainty and keep the source timestamps where useful.",
      "",
      "Captured notes:",
      source,
    ].join("\n");
    onClose?.();
    onRequest?.(prompt);
  }

  return (
    <div className="fcl-root">
      {open && (
        <section className="fcl-panel" role="dialog" aria-label="Fetch companion">
          <header className="fcl-panel-head">
            <div className="fcl-identity"><DogMark size={43}/><div><strong>Fetch</strong><span>Your companion. Same assistant.</span></div></div>
            <button type="button" className="fcl-close" onClick={onClose} aria-label="Close companion">×</button>
          </header>
          <div className="fcl-tabs" role="tablist" aria-label="Companion tools">
            <button type="button" role="tab" aria-selected={tab === "ask"} className={tab === "ask" ? "active" : ""} onClick={() => setTab("ask")}>Ask Fetch</button>
            <button type="button" role="tab" aria-selected={tab === "minutes"} className={tab === "minutes" ? "active" : ""} onClick={() => setTab("minutes")}>Daily minutes <span>{todayMinutes.length}</span></button>
          </div>

          {tab === "ask" ? (
            <div className="fcl-ask">
              <div className="fcl-greeting"><DogMark size={54}/><div><strong>What do you need done?</strong><p>Ask the way you always ask Fetch. I’ll use the same task flow and intelligence layer.</p></div></div>
              <form onSubmit={sendRequest}>
                <label className="fcl-sr-only" htmlFor="fcl-request">Ask Fetch to complete a request</label>
                <textarea id="fcl-request" value={request} onChange={(e) => setRequest(e.target.value)} rows={3} maxLength={4000} placeholder="Find an electrician, get groceries, research something…" disabled={isBusy}/>
                <div className="fcl-actions"><span>{isBusy ? "Fetch is working…" : "Uses your existing Fetch assistant"}</span><button type="submit" disabled={!request.trim() || isBusy}>Send to Fetch ↗</button></div>
              </form>
              <div className="fcl-examples">
                <span>TRY ASKING</span>
                <button type="button" disabled={isBusy} onClick={() => { setRequest("Find an electrician near me"); }}>Find an electrician</button>
                <button type="button" disabled={isBusy} onClick={() => { setRequest("Get me milk and bread"); }}>Get groceries</button>
                <button type="button" disabled={isBusy} onClick={() => { setRequest("Research the latest developments in AI agents"); }}>Research a topic</button>
              </div>
              <p className="fcl-footnote">Fetch's main chat remains the source of truth for progress, questions and approvals.</p>
            </div>
          ) : (
            <div className="fcl-minutes">
              <p className="fcl-minute-intro">Capture meeting minutes, decisions, quick updates or promises as they happen. They stay in this browser for now.</p>
              <form onSubmit={saveMinute}>
                <label className="fcl-sr-only" htmlFor="fcl-minute-draft">Capture daily minutes</label>
                <textarea id="fcl-minute-draft" rows={3} maxLength={4000} value={minuteDraft} onChange={(e) => setMinuteDraft(e.target.value)} placeholder="What happened? What was decided? What needs follow-up?"/>
                <div className="fcl-actions"><span>Private to this browser</span><button type="submit" disabled={!minuteDraft.trim()}>Save minute +</button></div>
              </form>
              <div className="fcl-minute-list">
                <div className="fcl-section-label">TODAY · {todayMinutes.length} CAPTURED</div>
                {todayMinutes.length ? todayMinutes.map((item) => (
                  <article className="fcl-minute" key={item.id}>
                    <time>{shortTime(item.createdAt)}</time><p>{item.text}</p>
                    <button type="button" onClick={() => deleteMinute(item.id)} aria-label="Delete minute">×</button>
                  </article>
                )) : <p className="fcl-empty">No minutes captured today yet.</p>}
              </div>
              <button type="button" className="fcl-summarise" disabled={!todayMinutes.length || isBusy} onClick={summariseMinutes}>Ask Fetch to prepare an EOD brief ↗</button>
              <p className="fcl-footnote">The summary is prepared by the existing Fetch assistant from the notes above. It will appear in the main Fetch conversation.</p>
            </div>
          )}
        </section>
      )}
      <button type="button" className={"fcl-launcher " + (open ? "is-open" : "")} onClick={onToggle} aria-expanded={open} aria-label={open ? "Close Fetch companion" : "Open Fetch companion"}>
        <DogMark size={46}/>
        {!open && <span className="fcl-launcher-dot"/>}
        <span className="fcl-launcher-label">{open ? "Close" : "Fetch companion"}</span>
      </button>
    </div>
  );
}
