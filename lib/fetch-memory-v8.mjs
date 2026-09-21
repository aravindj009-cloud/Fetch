FETCH UNIVERSAL ARCHITECTURE V8

V8 extends V7 with Memory + Context Intelligence.

Flow:
USER -> CHANNEL -> FETCH AGENT -> MEMORY/CONTEXT -> INTENT -> PLAN -> DECISION -> ATC -> RESOURCE -> CONNECTOR -> EXECUTION -> RESULT

V8 does not remove or rewrite the V7 intelligence layer. It resolves durable memory, conversation context, recent decisions and active-task context, then passes the resulting memory into the existing V7 decision engine.

Durable memory rules:
- Explicit user facts and confirmed outcomes may be stored.
- Inferred facts should remain contextual unless confirmed.
- Secrets, passwords, API keys, tokens, payment credentials and similar sensitive credentials are blocked.

Deploy from docs/DEPLOY_V8.txt.
