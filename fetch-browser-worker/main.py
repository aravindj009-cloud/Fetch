import asyncio
import os
import time
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_LOGGING_LEVEL", "info")
os.environ.setdefault("IN_DOCKER", "True")

from browser_use import Agent, ChatOpenAI
from browser_use.browser import BrowserProfile, BrowserSession
from browser_use.browser.profile import ViewportSize


app = FastAPI(
    title="Fetch Browser Worker",
    version="1.0.0",
)


# ============================================================
# ENVIRONMENT
# ============================================================

HF_TOKEN = os.getenv("HF_TOKEN", "").strip()

WORKER_TOKEN = os.getenv("WORKER_TOKEN", "").strip()

BROWSER_MODEL = os.getenv(
    "BROWSER_MODEL",
    "openai/gpt-oss-120b:fastest",
).strip()

HF_BASE_URL = os.getenv(
    "HF_BASE_URL",
    "https://router.huggingface.co/v1",
).strip()

MAX_STEPS = int(
    os.getenv("BROWSER_MAX_STEPS", "30")
)

TASK_TIMEOUT_SECONDS = int(
    os.getenv("BROWSER_TASK_TIMEOUT_SECONDS", "240")
)


# ============================================================
# PROTECTED WEBSITES
# ============================================================

BLOCKED_HOSTS = {
    "accounts.google.com",
    "login.microsoftonline.com",
    "paypal.com",
    "www.paypal.com",
}


# ============================================================
# REQUEST MODEL
# ============================================================

class ExecuteRequest(BaseModel):

    task: str = Field(
        min_length=1,
        max_length=12000,
    )

    url: str | None = None

    conversation_id: str | None = None

    workflow_id: str | None = None


# ============================================================
# SECURITY
# ============================================================

def check_worker_token(
    authorization: str | None,
) -> None:

    if not WORKER_TOKEN:

        raise HTTPException(
            status_code=503,
            detail="WORKER_TOKEN is not configured",
        )

    expected = f"Bearer {WORKER_TOKEN}"

    if authorization != expected:

        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
        )


def validate_url(
    url: str | None,
) -> None:

    if not url:
        return

    parsed = urlparse(url)

    if parsed.scheme not in {
        "http",
        "https",
    }:

        raise HTTPException(
            status_code=400,
            detail="Invalid URL",
        )

    if not parsed.netloc:

        raise HTTPException(
            status_code=400,
            detail="Invalid URL",
        )

    host = (
        parsed.hostname or ""
    ).lower()

    for blocked in BLOCKED_HOSTS:

        if (
            host == blocked
            or host.endswith("." + blocked)
        ):

            raise HTTPException(
                status_code=403,
                detail=(
                    "This website requires "
                    "a dedicated secure executor"
                ),
            )


# ============================================================
# BUILD BROWSER TASK
# ============================================================

def build_task(
    request: ExecuteRequest,
) -> str:

    task = request.task.strip()

    if request.url:

        validate_url(request.url)

        task = (
            f"Start at this URL: {request.url}\n\n"
            f"User's browser task:\n{task}"
        )

    return f"""
You are the Browser Agent for Fetch.

Fetch is a general-purpose personal AI assistant.

Your job is to use a real web browser to complete
the user's requested web task.

IMPORTANT RULES:

1. Navigate normal public websites.

2. Read pages carefully.

3. Click, type, search, scroll and navigate when
   required to complete the task.

4. If a website asks for a password, OTP,
   banking PIN, card CVV, authentication secret,
   or other private credential, STOP and report
   that Fetch needs the user to complete that
   secure step.

5. Do NOT make purchases.

6. Do NOT submit payments.

7. Do NOT place financial orders.

8. Do NOT send irreversible messages.

9. These actions require an explicit confirmation
   flow from Fetch.

10. Never claim an action succeeded unless the
    website clearly confirms success.

11. If a CAPTCHA, login wall, anti-bot system,
    or other blocker prevents completion, report
    the blocker honestly.

12. Do not invent information.

13. Prefer completing the task over explaining
    how the user could do it themselves.

14. When finished, return a concise factual result.

USER TASK:

{task}
""".strip()


# ============================================================
# EXECUTE BROWSER TASK
# ============================================================

async def execute_browser_task(
    request: ExecuteRequest,
) -> dict[str, Any]:

    if not HF_TOKEN:

        raise RuntimeError(
            "HF_TOKEN is not configured"
        )

    started = time.time()

    # --------------------------------------------------------
    # Hugging Face OpenAI-compatible model
    # --------------------------------------------------------

    llm = ChatOpenAI(
        model=BROWSER_MODEL,
        base_url=HF_BASE_URL,
        api_key=HF_TOKEN,
    )

    # --------------------------------------------------------
    # Browser configuration
    # --------------------------------------------------------

    browser_profile = BrowserProfile(

        headless=True,

        chromium_sandbox=False,

        viewport=ViewportSize(
            width=1920,
            height=1080,
        ),
    )

    browser_session = BrowserSession(
        browser_profile=browser_profile,
    )

    try:

        await browser_session.start()

        # ----------------------------------------------------
        # Browser Use Agent
        # ----------------------------------------------------

        agent = Agent(

            task=build_task(request),

            llm=llm,

            browser_session=browser_session,

            use_vision=True,

            max_failures=4,

            max_actions_per_step=5,

            use_thinking=True,
        )

        history = await asyncio.wait_for(

            agent.run(
                max_steps=MAX_STEPS
            ),

            timeout=TASK_TIMEOUT_SECONDS,
        )

        # ----------------------------------------------------
        # Extract final result
        # ----------------------------------------------------

        result = None

        final_result = getattr(
            history,
            "final_result",
            None,
        )

        if callable(final_result):

            result = final_result()

        if result is None:

            result = str(history)

        return {

            "ok": True,

            "status": "completed",

            "result": result,

            "model": BROWSER_MODEL,

            "duration_seconds": round(
                time.time() - started,
                2,
            ),

            "conversation_id":
                request.conversation_id,

            "workflow_id":
                request.workflow_id,
        }

    except asyncio.TimeoutError:

        return {

            "ok": False,

            "status": "timeout",

            "error": (
                "Browser task exceeded "
                f"{TASK_TIMEOUT_SECONDS} seconds"
            ),

            "duration_seconds": round(
                time.time() - started,
                2,
            ),
        }

    except Exception as exc:

        return {

            "ok": False,

            "status": "failed",

            "error": str(exc),

            "duration_seconds": round(
                time.time() - started,
                2,
            ),
        }

    finally:

        try:

            await browser_session.kill()

        except Exception:

            pass


# ============================================================
# HEALTH
# ============================================================

@app.get("/")
async def root():

    return {

        "service":
            "fetch-browser-worker",

        "status":
            "online",

        "version":
            "1.0.0",
    }


@app.get("/health")
async def health():

    return {

        "ok": True,

        "service":
            "fetch-browser-worker",

        "browser_model":
            BROWSER_MODEL,

        "hf_configured":
            bool(HF_TOKEN),

        "worker_token_configured":
            bool(WORKER_TOKEN),
    }


# ============================================================
# EXECUTE
# ============================================================

@app.post("/execute")
async def execute(

    request: ExecuteRequest,

    authorization: str | None =
        Header(default=None),
):

    check_worker_token(
        authorization
    )

    validate_url(
        request.url
    )

    return await execute_browser_task(
        request
    )


# ============================================================
# LOCAL ENTRYPOINT
# ============================================================

if __name__ == "__main__":

    import uvicorn

    port = int(
        os.getenv(
            "PORT",
            "8080",
        )
    )

    uvicorn.run(

        "main:app",

        host="0.0.0.0",

        port=port,
    )
