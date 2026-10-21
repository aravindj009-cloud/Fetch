import React, { useEffect, useMemo, useState } from "react";
import "./FetchCompanionLayer.css";
import { FETCH_AGENT_DOGS } from "../lib/fetch-agent-dog-registry.mjs";
import mascotPart1 from "./assets/team-fetch-mascot-part-1.js";
import mascotPart2 from "./assets/team-fetch-mascot-part-2.js";
import mascotPart3 from "./assets/team-fetch-mascot-part-3.js";
import mascotPart4 from "./assets/team-fetch-mascot-part-4.js";
import mascotPart5 from "./assets/team-fetch-mascot-part-5.js";
import mascotPart6 from "./assets/team-fetch-mascot-part-6.js";
import mascotPart7 from "./assets/team-fetch-mascot-part-7.js";

const TEAM_FETCH_MASCOT_SPRITE = "data:image/webp;base64," + [
  mascotPart1, mascotPart2, mascotPart3, mascotPart4, mascotPart5, mascotPart6, mascotPart7,
].join("");

const TEAM_FETCH_MASCOT_POSITIONS = Object.freeze({
  fetch: "0% 0%",
  scout: "50% 0%",
  shopper: "100% 0%",
  local_helper: "0% 100%",
  scribe: "50% 100%",
  journey: "100% 100%",
});

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

function DogMark({ size = 34, accent = "#2d8472", label = "Fetch dog companion" }) {
  return (
    <svg className="fcl-dog" width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={label}>
      <path d="M29 28 C13 7 5 22 10 43 C13 56 21 61 31 56 Z" fill="#a66b43"/>
      <path d="M71 28 C87 7 95 22 90 43 C87 56 79 61 69 56 Z" fill="#a66b43"/>
      <ellipse cx="50" cy="53" rx="31" ry="34" fill="#edc68e"/>
      <ellipse cx="39" cy="47" rx="3.5" ry="5" fill="#26362f"/>
      <ellipse cx="61" cy="47" rx="3.5" ry="5" fill="#26362f"/>
      <ellipse cx="50" cy="60" rx="14" ry="11" fill="#fff0d9"/>
      <ellipse cx="50" cy="57" rx="5.5" ry="4" fill="#26362f"/>
      <path d="M44 64 Q50 70 56 64" fill="none" stroke="#805038" strokeWidth="2.5" strokeLinecap="round"/>
      <path d="M22 76 Q50 88 78 76 L75 84 Q50 97 25 84 Z" fill={accent}/>
      <path d="M50 83 L57 90 L50 97 L43 90 Z" fill="#f3b26f"/>
    </svg>
  );
}

export default function FetchCompanionLayer({ open, onToggle, onClose, onRequest, isBusy = false }) {
  const [tab, setTab] = useState("team");
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
        <section className="fcl-panel" role="dialog" aria-label="Team Fetch">
          <header className="fcl-panel-head">
            <div className="fcl-identity"><DogMark size={43}/><div><strong>Team Fetch</strong><span>One assistant. A team of specialists.</span></div></div>
            <button type="button" className="fcl-close" onClick={onClose} aria-label="Close companion">×</button>
          </header>
          <div className="fcl-tabs" role="tablist" aria-label="Team Fetch tools">
            <button type="button" role="tab" aria-selected={tab === "team"} className={tab === "team" ? "active" : ""} onClick={() => setTab("team")}>Team Fetch</button>
            <button type="button" role="tab" aria-selected={tab === "minutes"} className={tab === "minutes" ? "active" : ""} onClick={() => setTab("minutes")}>Daily minutes <span>{todayMinutes.length}</span></button>
          </div>

          {tab === "minutes" ? (
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
          ) : (
            <div className="fcl-agent-team">
              <div className="fcl-team-intro">
                <strong>One chat. A whole team working behind Fetch.</strong>
                <p>Tell Fetch what you need in the main chat. The right specialist supports the task behind the scenes; ATC/IoI selects the actual provider, checks permissions and coordinates execution.</p>
              </div>
              {FETCH_AGENT_DOGS.map((agent) => {
                const example = agent.examples?.[0] || "Help me with this task";
                return (
                  <article className="fcl-agent-card" key={agent.id} style={{ "--fcl-agent-accent": agent.accent }}>
                    <div
                      className="fcl-agent-avatar"
                      role="img"
                      aria-label={agent.name + " — " + agent.title}
                      title={agent.name}
                      style={{
                        backgroundImage: "url(" + TEAM_FETCH_MASCOT_SPRITE + ")",
                        backgroundPosition: TEAM_FETCH_MASCOT_POSITIONS[agent.id] || "0% 0%",
                      }}
                    />
                    <div className="fcl-agent-card-copy">
                      <div className="fcl-agent-title"><strong>{agent.name}</strong>{agent.id === "fetch" && <span>COORDINATOR</span>}</div>
                      <small>{agent.title}</small>
                      <p>{agent.mission}</p>
                      <div className={"fcl-agent-status fcl-agent-status-" + agent.status}>{agent.status_label}</div>
                      <button type="button" disabled={isBusy} onClick={() => { onClose?.(); onRequest?.(example); }}>Try with Fetch ↗</button>
                    </div>
                  </article>
                );
              })}
              <p className="fcl-footnote">One shared conversation and task flow. Specialist roles are coordinated through Fetch/ATC/IoI; availability labels show what is connected today.</p>
            </div>
          )}
        </section>
      )}
      <button type="button" className={"fcl-launcher " + (open ? "is-open" : "")} onClick={onToggle} aria-expanded={open} aria-label={open ? "Close Team Fetch" : "Open Team Fetch"}>
        <DogMark size={46}/>
        {!open && <span className="fcl-launcher-dot"/>}
        <span className="fcl-launcher-label">{open ? "Close" : "Team Fetch"}</span>
      </button>
    </div>
  );
}
