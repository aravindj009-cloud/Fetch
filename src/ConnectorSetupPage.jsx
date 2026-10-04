import React, { useEffect, useState } from "react";

export default function ConnectorSetupPage({ connector, getConversationId, navigateFetch }) {
  const [status, setStatus] = useState("loading");
  const [starting, setStarting] = useState(false);
  const conversationId = getConversationId();

  useEffect(() => {
    fetch("/api/fetch/context.mjs?status=1&conversation_id=" + encodeURIComponent(conversationId), { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setStatus(data?.connections?.[connector.id] ? "connected" : "available"))
      .catch(() => setStatus("available"));
  }, [connector.id, conversationId]);

  const connect = () => {
    setStarting(true);
    const param =
      connector.id === "email" ? "google_connect=1" :
      connector.id === "swiggy" ? "swiggy_connect=1" :
      "instamart_connect=1";
    window.location.assign("/api/fetch/context.mjs?" + param + "&conversation_id=" + encodeURIComponent(conversationId));
  };

  const description =
    connector.id === "email"
      ? "Connect Gmail securely so Fetch can read, search and manage email when you ask it to."
      : connector.id === "swiggy"
        ? "Connect your Swiggy account through Swiggy’s authorization flow. Fetch will only use the access you approve."
        : "Connect your Instamart account through Swiggy’s authorization flow. Fetch will use it as a grocery execution path when available.";

  return (
    <div className="fetchDirectory">
      <header className="directoryHeader">
        <button className="directoryBrand" onClick={() => navigateFetch("/connectors")}>fetch<span>.</span></button>
        <nav>
          <button onClick={() => navigateFetch("/connectors")}>Connectors</button>
          <button onClick={() => navigateFetch("/contact")}>Contact</button>
          <button className="directoryBack" onClick={() => navigateFetch("/")}>Open Fetch →</button>
        </nav>
      </header>
      <main className="directoryMain connectorSetup">
        <button className="setupBack" onClick={() => navigateFetch("/connectors")}>← All connectors</button>
        <div className="setupIcon">{connector.icon}</div>
        <small className="directoryEyebrow">CONNECT {connector.name.toUpperCase()}</small>
        <h1>Give Fetch access to <em>{connector.name}.</em></h1>
        <p className="directoryLead">{description}</p>
        <div className="setupCard">
          <div>
            <strong>{status === "connected" ? "Connected to Fetch" : "Ready to connect"}</strong>
            <span>{status === "connected" ? "This provider is available to your Fetch session." : "You’ll leave Fetch briefly to approve access, then return here."}</span>
          </div>
          {status === "connected"
            ? <span className="setupConnected">✓ Connected</span>
            : <button onClick={connect} disabled={starting}>{starting ? "Opening…" : "Connect securely →"}</button>}
        </div>
        <div className="setupNote">
          <strong>What happens next</strong>
          <p>Fetch stores provider tokens encrypted on the server — never in browser localStorage.</p>
        </div>
      </main>
    </div>
  );
}
