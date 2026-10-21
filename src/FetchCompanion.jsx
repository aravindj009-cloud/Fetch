import React, { useEffect, useMemo, useRef, useState } from "react";
import "./FetchCompanion.css";

const STORAGE_KEY = "fetch_companion_entries_v1";
const CAPTURE_TYPES = [
  { id: "note", label: "Quick note", icon: "✎" },
  { id: "commitment", label: "Commitment", icon: "✓" },
  { id: "decision", label: "Decision", icon: "◆" },
  { id: "idea", label: "Idea", icon: "✦" },
];

function dayKey(value = new Date()) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function readEntries() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.text === "string" && item.id)
      .slice(0, 500)
      .map((item) => ({
        id: String(item.id),
        text: String(item.text).slice(0, 5000),
        kind: CAPTURE_TYPES.some((type) => type.id === item.kind) ? item.kind : "note",
        createdAt: item.createdAt || new Date().toISOString(),
        day: item.day || dayKey(item.createdAt),
        done: item.done === true,
      }));
  } catch {
    return [];
  }
}

function formattedDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(value);
}

function formattedTime(value) {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function friendlyId() {
  return globalThis.crypto?.randomUUID?.() || "capture-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

function DogCompanion({ mood = "happy", small = false }) {
  return (
    <svg
      className={`fc-dog ${small ? "fc-dog-small" : ""} fc-dog-${mood}`}
      viewBox="0 0 260 250"
      role="img"
      aria-label="Fetch, your friendly dog companion"
    >
      <ellipse cx="132" cy="226" rx="76" ry="12" fill="#273c35" opacity=".1" />
      <path d="M78 73 C48 44 27 63 30 103 C32 130 52 151 78 143 Z" fill="#a96c42" />
      <path d="M181 73 C210 43 235 63 230 103 C227 132 208 151 181 143 Z" fill="#a96c42" />
      <path d="M82 74 C56 54 44 75 48 101 C52 120 64 131 81 126 Z" fill="#d7a16b" />
      <path d="M177 74 C202 54 216 76 211 102 C207 120 195 131 179 126 Z" fill="#d7a16b" />
      <path d="M81 145 C71 164 75 201 91 217 C105 232 160 232 175 216 C191 198 194 164 180 143 Z" fill="#edc58d" />
      <path d="M98 180 C92 196 92 215 99 222 C106 230 118 225 119 215 L121 185 Z" fill="#edc58d" />
      <path d="M151 180 L153 215 C154 227 167 230 175 220 C182 211 178 193 171 180 Z" fill="#edc58d" />
      <path d="M72 81 C72 42 94 22 130 22 C169 22 192 46 190 85 L184 128 C180 160 157 177 131 177 C103 177 79 158 76 129 Z" fill="#f2d09a" />
      <path d="M77 65 C84 37 105 27 131 27 C151 27 171 36 182 57 C164 52 148 43 136 34 C124 48 101 59 77 65 Z" fill="#f8dcae" />
      <ellipse cx="105" cy="94" rx="8" ry="11" fill="#29372f" />
      <ellipse cx="156" cy="94" rx="8" ry="11" fill="#29372f" />
      <circle cx="107" cy="91" r="2.4" fill="#fff" />
      <circle cx="158" cy="91" r="2.4" fill="#fff" />
      <ellipse cx="131" cy="120" rx="32" ry="25" fill="#fff0d8" />
      <ellipse cx="131" cy="111" rx="10" ry="7" fill="#26352f" />
      <path d="M119 128 Q131 139 143 128" fill="none" stroke="#7c4e38" strokeWidth="3.5" strokeLinecap="round" />
      <ellipse cx="91" cy="117" rx="9" ry="5" fill="#ec9a85" opacity=".55" />
      <ellipse cx="172" cy="117" rx="9" ry="5" fill="#ec9a85" opacity=".55" />
      <path d="M82 153 Q131 176 180 153 L176 170 Q131 190 86 170 Z" fill="#2d8472" />
      <path d="M131 175 L141 190 L131 207 L121 190 Z" fill="#ffbf82" stroke="#2d8472" strokeWidth="3" />
      <circle cx="131" cy="190" r="4" fill="#fff0d8" />
      {mood === "listening" && (
        <>
          <path d="M59 39 Q43 54 49 70" fill="none" stroke="#2d8472" strokeWidth="4" strokeLinecap="round" />
          <path d="M201 39 Q217 54 211 70" fill="none" stroke="#2d8472" strokeWidth="4" strokeLinecap="round" />
          <circle cx="47" cy="31" r="4" fill="#e79a74" />
          <circle cx="214" cy="31" r="4" fill="#e79a74" />
        </>
      )}
      {mood === "thinking" && <circle cx="183" cy="35" r="9" fill="#edb56f" opacity=".95" />}
    </svg>
  );
}

function EmptyState({ onStarter }) {
  return (
    <div className="fc-empty">
      <div className="fc-empty-art"><DogCompanion small /></div>
      <strong>Your day starts here.</strong>
      <p>Capture a thought, a decision or something you promised to do. Fetch will keep it organised.</p>
      <div className="fc-starters">
        <button type="button" onClick={() => onStarter("I need to follow up on ")}>＋ Follow-up</button>
        <button type="button" onClick={() => onStarter("A decision we made: ")}>＋ Decision</button>
        <button type="button" onClick={() => onStarter("An idea: ")}>＋ Idea</button>
      </div>
    </div>
  );
}

function CaptureCard({ draft, setDraft, kind, setKind, onSave }) {
  const [listening, setListening] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState("");
  const recognitionRef = useRef(null);

  useEffect(() => () => {
    try { recognitionRef.current?.stop(); } catch {}
  }, []);

  function startVoiceCapture() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceMessage("Voice capture isn't supported in this browser yet. You can type your note instead.");
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    setVoiceMessage("Listening on this device. Your speech will be added as text for you to review.");
    const recognition = new SpeechRecognition();
    recognition.lang = "en-IN";
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      const phrase = Array.from(event.results)
        .slice(event.resultIndex)
        .map((result) => result[0]?.transcript || "")
        .join(" ")
        .trim();
      if (phrase) setDraft((current) => (current.trim() ? current.trim() + " " : "") + phrase);
    };
    recognition.onerror = (event) => {
      setListening(false);
      setVoiceMessage(event.error === "not-allowed"
        ? "Microphone permission was denied. You can still type your capture."
        : "Voice capture stopped. Your written draft is still available.");
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
      setVoiceMessage("Couldn't start the microphone. Please type your capture.");
    }
  }

  return (
    <section className="fc-card fc-capture-card">
      <div className="fc-card-heading">
        <div>
          <span className="fc-eyebrow">CAPTURE IN THE MOMENT</span>
          <h2>What's on your mind?</h2>
        </div>
        <span className="fc-private-pill"><span /> Saved privately</span>
      </div>
      <div className="fc-kind-picker" role="group" aria-label="Capture type">
        {CAPTURE_TYPES.map((type) => (
          <button
            type="button"
            key={type.id}
            className={kind === type.id ? "active" : ""}
            onClick={() => setKind(type.id)}
          >
            <span>{type.icon}</span>{type.label}
          </button>
        ))}
      </div>
      <form onSubmit={onSave}>
        <label className="fc-sr-only" htmlFor="fc-capture-text">Your note or commitment</label>
        <textarea
          id="fc-capture-text"
          rows={3}
          maxLength={5000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            kind === "commitment" ? "What do you need to follow up on?" :
            kind === "decision" ? "What did you decide?" :
            kind === "idea" ? "Capture that idea before it disappears…" :
            "A meeting note, something to remember, or a thought…"
          }
        />
        {voiceMessage && <p className={`fc-voice-message ${listening ? "is-live" : ""}`}>{voiceMessage}</p>}
        <div className="fc-compose-footer">
          <button className={`fc-voice-button ${listening ? "is-live" : ""}`} type="button" onClick={startVoiceCapture} aria-pressed={listening}>
            <span className="fc-mic-dot">{listening ? "■" : "●"}</span>
            {listening ? "Stop listening" : "Capture by voice"}
          </button>
          <span className="fc-character-count">{draft.length}/5000</span>
          <button className="fc-primary-button" type="submit" disabled={!draft.trim()}>
            Save capture <span>↗</span>
          </button>
        </div>
      </form>
      <p className="fc-privacy-note"><span>✦</span> This prototype stores captures in this browser only. Voice is transcribed into text; no audio recording is saved.</p>
    </section>
  );
}

function CaptureItem({ entry, onToggle, onDelete }) {
  const type = CAPTURE_TYPES.find((item) => item.id === entry.kind) || CAPTURE_TYPES[0];
  return (
    <article className={`fc-capture-item ${entry.done ? "is-done" : ""}`}>
      <button
        className={`fc-check ${entry.done ? "checked" : ""}`}
        type="button"
        aria-label={entry.done ? "Mark commitment open" : "Mark commitment complete"}
        onClick={() => entry.kind === "commitment" ? onToggle(entry.id) : undefined}
        disabled={entry.kind !== "commitment"}
      >
        {entry.done ? "✓" : entry.kind === "commitment" ? "" : type.icon}
      </button>
      <div className="fc-capture-main">
        <div className="fc-item-topline">
          <span className={`fc-type fc-type-${entry.kind}`}>{type.label}</span>
          <time dateTime={entry.createdAt}>{formattedTime(entry.createdAt)}</time>
        </div>
        <p>{entry.text}</p>
        {entry.kind === "commitment" && <span className={`fc-task-state ${entry.done ? "complete" : ""}`}>{entry.done ? "Completed" : "Open commitment"}</span>}
      </div>
      <button className="fc-delete" type="button" aria-label="Delete capture" title="Delete capture" onClick={() => onDelete(entry.id)}>×</button>
    </article>
  );
}

function SummaryPanel({ entries, generatedAt, onGenerate }) {
  const commitments = entries.filter((entry) => entry.kind === "commitment");
  const openCommitments = commitments.filter((entry) => !entry.done);
  const decisions = entries.filter((entry) => entry.kind === "decision");
  const ideas = entries.filter((entry) => entry.kind === "idea");
  const notes = entries.filter((entry) => entry.kind === "note");
  return (
    <section className="fc-card fc-summary-card">
      <div className="fc-summary-top">
        <div className="fc-summary-icon"><span>✦</span></div>
        <div>
          <span className="fc-eyebrow">YOUR DAILY BRIEF</span>
          <h2>Close the day with clarity.</h2>
        </div>
      </div>
      <p className="fc-summary-intro">A clear view of what you captured, decided and still need to do.</p>
      <div className="fc-stats-grid">
        <div><strong>{entries.length}</strong><span>Captures</span></div>
        <div><strong>{openCommitments.length}</strong><span>Open items</span></div>
        <div><strong>{decisions.length}</strong><span>Decisions</span></div>
      </div>
      {generatedAt ? (
        <div className="fc-generated-brief">
          <div className="fc-generated-header"><strong>Today's recap</strong><span>Draft · {formattedTime(generatedAt)}</span></div>
          <p>You captured {entries.length} {entries.length === 1 ? "item" : "items"} today{decisions.length ? `, including ${decisions.length} ${decisions.length === 1 ? "decision" : "decisions"}` : ""}. {openCommitments.length ? `${openCommitments.length} commitment${openCommitments.length === 1 ? " remains" : "s remain"} open for follow-up.` : "There are no open commitments captured here."}</p>
          {openCommitments.length > 0 && (
            <div className="fc-brief-section">
              <span>FOLLOW UP</span>
              {openCommitments.slice(0, 4).map((entry) => <div key={entry.id}>↗ {entry.text}</div>)}
            </div>
          )}
          {decisions.length > 0 && (
            <div className="fc-brief-section">
              <span>DECISIONS RECORDED</span>
              {decisions.slice(0, 3).map((entry) => <div key={entry.id}>◆ {entry.text}</div>)}
            </div>
          )}
          {ideas.length > 0 && (
            <div className="fc-brief-section">
              <span>IDEAS TO REVISIT</span>
              {ideas.slice(0, 2).map((entry) => <div key={entry.id}>✦ {entry.text}</div>)}
            </div>
          )}
          {notes.length > 0 && (
            <div className="fc-brief-section">
              <span>NOTES CAPTURED</span>
              {notes.slice(0, 2).map((entry) => <div key={entry.id}>✎ {entry.text}</div>)}
            </div>
          )}
          <p className="fc-draft-disclaimer">Generated from your saved captures only. This isn't yet an AI-generated summary of connected meetings or email.</p>
        </div>
      ) : (
        <div className="fc-summary-empty">
          <div className="fc-summary-lines"><i /><i /><i /></div>
          <strong>Your daily brief, ready when you are.</strong>
          <p>Capture a few things today, then create a recap from your notes and commitments.</p>
        </div>
      )}
      <button className="fc-primary-button fc-full-button" type="button" onClick={onGenerate}>
        {generatedAt ? "Refresh daily brief" : "Generate daily brief"} <span>↗</span>
      </button>
    </section>
  );
}

export default function FetchCompanion({ navigateFetch }) {
  const [entries, setEntries] = useState(readEntries);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState("note");
  const [tab, setTab] = useState("today");
  const [search, setSearch] = useState("");
  const [generatedAt, setGeneratedAt] = useState(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 500))); } catch {}
  }, [entries]);

  const today = dayKey();
  const todayEntries = useMemo(
    () => entries.filter((entry) => entry.day === today).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [entries, today]
  );
  const memoryEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries
      .filter((entry) => !query || (entry.text + " " + entry.kind).toLowerCase().includes(query))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [entries, search]);

  function addCapture(event) {
    event?.preventDefault?.();
    const text = draft.trim();
    if (!text) return;
    const now = new Date();
    const entry = { id: friendlyId(), text, kind, createdAt: now.toISOString(), day: dayKey(now), done: false };
    setEntries((current) => [entry, ...current].slice(0, 500));
    setDraft("");
    setTab("today");
    setToast("Saved to your day");
    window.setTimeout(() => setToast(""), 2200);
  }

  function toggleCommitment(id) {
    setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, done: !entry.done } : entry));
  }

  function deleteCapture(id) {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    setToast("Capture deleted");
    window.setTimeout(() => setToast(""), 2200);
  }

  function startFromStarter(text) {
    if (/follow up/i.test(text)) setKind("commitment");
    else if (/decision/i.test(text)) setKind("decision");
    else if (/idea/i.test(text)) setKind("idea");
    else setKind("note");
    setDraft(text);
    document.getElementById("fc-capture-text")?.focus();
  }

  function generateBrief() {
    setGeneratedAt(new Date().toISOString());
    setTab("brief");
  }

  const openCommitments = todayEntries.filter((entry) => entry.kind === "commitment" && !entry.done).length;
  const decisions = todayEntries.filter((entry) => entry.kind === "decision").length;

  return (
    <div className="fc-app">
      <header className="fc-header">
        <button className="fc-wordmark" type="button" onClick={() => navigateFetch?.("/")}>fetch<span>.</span></button>
        <div className="fc-header-title"><DogCompanion small /><div><strong>Fetch Companion</strong><small>YOUR DAILY INTELLIGENCE</small></div></div>
        <nav className="fc-nav" aria-label="Companion navigation">
          <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}>Today</button>
          <button className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>Memory</button>
          <button className={tab === "brief" ? "active" : ""} onClick={() => setTab("brief")}>Daily brief</button>
        </nav>
        <button className="fc-back-button" type="button" onClick={() => navigateFetch?.("/")}>← Main Fetch</button>
      </header>

      <main className="fc-main">
        <section className="fc-hero">
          <div className="fc-hero-copy">
            <span className="fc-hero-pill"><span /> YOUR COMPANION IS HERE</span>
            <h1>A little more clarity,<br /><em>every day.</em></h1>
            <p>Your friendly Fetch dog keeps track of the thoughts, decisions and promises you don't want to lose.</p>
            <div className="fc-hero-actions">
              <button className="fc-primary-button" onClick={() => { setTab("today"); document.getElementById("fc-capture-text")?.focus(); }}>Capture something <span>↗</span></button>
              <span className="fc-hero-date">{formattedDate()}</span>
            </div>
          </div>
          <div className="fc-hero-mascot">
            <div className="fc-orbit fc-orbit-one" />
            <div className="fc-orbit fc-orbit-two" />
            <div className="fc-mascot-note note-a">I'll remember this ✦</div>
            <div className="fc-mascot-note note-b">Good ideas stay.</div>
            <DogCompanion mood={tab === "brief" ? "thinking" : "happy"} />
            <div className="fc-mascot-caption">Hi, I'm Fetch. <span>🐾</span></div>
          </div>
        </section>

        <div className="fc-workspace">
          <div className="fc-primary-column">
            {tab === "today" && (
              <>
                <CaptureCard draft={draft} setDraft={setDraft} kind={kind} setKind={setKind} onSave={addCapture} />
                <section className="fc-card fc-timeline-card">
                  <div className="fc-card-heading">
                    <div><span className="fc-eyebrow">YOUR DAY, IN CONTEXT</span><h2>Today's captures <span className="fc-count">{todayEntries.length}</span></h2></div>
                    <span className="fc-timeline-date">{new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short" }).format(new Date())}</span>
                  </div>
                  {todayEntries.length ? (
                    <div className="fc-timeline">
                      {todayEntries.map((entry) => <CaptureItem key={entry.id} entry={entry} onToggle={toggleCommitment} onDelete={deleteCapture} />)}
                    </div>
                  ) : <EmptyState onStarter={startFromStarter} />}
                </section>
              </>
            )}

            {tab === "memory" && (
              <section className="fc-card fc-memory-card">
                <div className="fc-card-heading">
                  <div><span className="fc-eyebrow">YOUR PERSONAL MEMORY</span><h2>Find what matters.</h2></div>
                  <span className="fc-count">{memoryEntries.length}</span>
                </div>
                <div className="fc-search">
                  <span>⌕</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes, decisions and commitments…" aria-label="Search saved captures" />
                </div>
                {memoryEntries.length ? (
                  <div className="fc-timeline">
                    {memoryEntries.map((entry) => (
                      <div key={entry.id} className="fc-memory-group">
                        <span className="fc-memory-day">{entry.day === today ? "TODAY" : formattedDate(new Date(entry.day + "T12:00:00"))}</span>
                        <CaptureItem entry={entry} onToggle={toggleCommitment} onDelete={deleteCapture} />
                      </div>
                    ))}
                  </div>
                ) : <EmptyState onStarter={startFromStarter} />}
              </section>
            )}

            {tab === "brief" && (
              <div className="fc-brief-view">
                <div className="fc-brief-hero">
                  <div><span className="fc-eyebrow">A MOMENT TO REFLECT</span><h2>Let’s close the loop.</h2><p>Review the important things you captured and carry a clear mind into tomorrow.</p></div>
                  <DogCompanion mood="thinking" small />
                </div>
                <SummaryPanel entries={todayEntries} generatedAt={generatedAt} onGenerate={generateBrief} />
              </div>
            )}
          </div>

          <aside className="fc-side-column">
            <section className="fc-card fc-side-welcome">
              <div className="fc-side-dog"><DogCompanion small /></div>
              <span className="fc-eyebrow">YOUR DAY AT A GLANCE</span>
              <h2>I've got the little things.</h2>
              <p>Capture now. Remember later. Finish the day knowing what matters.</p>
              <div className="fc-side-stat"><span>Today's captures</span><strong>{todayEntries.length}</strong></div>
              <div className="fc-side-stat"><span>Open commitments</span><strong>{openCommitments}</strong></div>
              <div className="fc-side-stat"><span>Decisions recorded</span><strong>{decisions}</strong></div>
              <button className="fc-text-button" onClick={() => setTab("memory")}>Explore your memory <span>→</span></button>
            </section>
            <SummaryPanel entries={todayEntries} generatedAt={generatedAt} onGenerate={generateBrief} />
            <div className="fc-iio-note"><span>✦</span><div><strong>Powered by Internet of Intelligence</strong><p>Today, your captures live on this device. Next, IoI will connect authorised sources and bring their evidence into your daily brief.</p></div></div>
          </aside>
        </div>

        <footer className="fc-footer">
          <DogCompanion small />
          <p><strong>Fetch Companion</strong> · A little more clarity, every day.</p>
          <span>Prototype · Local device storage</span>
        </footer>
      </main>
      {toast && <div className="fc-toast" role="status">{toast}</div>}
    </div>
  );
}
