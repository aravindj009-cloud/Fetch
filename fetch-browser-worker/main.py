import os
import asyncio
import logging
from typing import Any, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from browser_use import Agent
from browser_use.browser import BrowserProfile, BrowserSession
from browser_use.browser.profile import ViewportSize
from langchain_openai import ChatOpenAI


# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------

PORT = int(os.getenv("PORT", "8080"))

HF_TOKEN = os.getenv("HF_TOKEN", "").strip()
HF_BASE_URL = os.getenv(
    "HF_BASE_URL",
    "https://router.huggingface.co/v1",
).strip()

BROWSER_MODEL = os.getenv(
    "BROWSER_MODEL",
    "openai/gpt-oss-120b:fastest",
).strip()

WORKER_TOKEN = os.getenv("WORKER_TOKEN", "").strip()

MAX_STEPS = int(
    os.getenv(
        "BROWSER_MAX_STEPS",
        os.getenv("MAX_STEPS", "30"),
    )
)

TASK_TIMEOUT_SECONDS = int(
    os.getenv(
        "BROWSER_TASK_TIMEOUT_SECONDS",
        os.getenv("TASK_TIMEOUT_SECONDS", "240"),
    )
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

logger = logging.getLogger("fetch-browser-worker")


# ---------------------------------------------------------
# FastAPI
# ---------------------------------------------------------

app = FastAPI(
    title="Fetch Browser Worker",
    version="1.0.1",
)


# ---------------------------------------------------------
# Request models
# ---------------------------------------------------------

class ExecuteRequest(BaseModel):
    task: str = Field(..., min_length=1, max_length=12000)
    url: Optional[str] = None
    conversation_id: Optional[str] = None
    workflow_id: Optional[str] = None


# ---------------------------------------------------------
# Security
# ---------------------------------------------------------

BLOCKED_HOSTS = {
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "paypal.com",
    "www.paypal.com",
}


def require_worker_token(authorization: Optional[str]) -> None:
    """
    Protect /execute with the same WORKER_TOKEN configured in Railway
    and BROWSER_WORKER_TOKEN configured in Vercel.
    """

    if not WORKER_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="WORKER_TOKEN is not configured on the browser worker.",
        )

    expected = f"Bearer {WORKER_TOKEN}"

    if authorization != expected:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized.",
        )


def host_is_blocked(url: str) -> bool:
    try:
        from urllib.parse import urlparse

        host = (urlparse(url).hostname or "").lower()

        if host in BLOCKED_HOSTS:
            return True

        return any(
            host.endswith("." + blocked)
            for blocked in BLOCKED_HOSTS
        )

    except Exception:
        return False


# ---------------------------------------------------------
# Safety instructions for the browser agent
# ---------------------------------------------------------

SAFETY_INSTRUCTIONS = """
You are Fetch's browser execution worker.

You operate a real web browser to complete the user's requested task.

Rules:

1. Never ask for, enter, expose, or retrieve passwords, OTPs, authentication
   codes, private keys, API secrets, or other sensitive credentials.

2. Never complete a payment, purchase, money transfer, financial transaction,
   subscription purchase, donation, or other irreversible financial action.

3. Never submit an irreversible action such as deleting an account, deleting
   important data, permanently closing an account, or accepting a legal
   agreement on behalf of the user.

4. If the task reaches a login page, OTP prompt, payment page, CAPTCHA,
   security challenge, or other sensitive checkpoint, stop and report that
   human interaction is required.

5. Do not claim an action succeeded unless the browser provides clear evidence
   that it actually succeeded.

6. Read public web pages, search public websites, navigate pages, compare
   information, and extract publicly available information when requested.

7. Return a concise factual result describing what you actually found or did.

8. If the requested task cannot be completed, explain the exact blocker.

9. Do not invent URLs, prices, availability, confirmations, reservations,
   purchases, or successful actions.

10. The user request is the source of truth for the task. Do not perform
    unrelated actions.
"""


# ---------------------------------------------------------
# Health / root endpoints
# ---------------------------------------------------------

@app.get("/")
async def root():
    return {
        "ok": True,
        "service": "fetch-browser-worker",
        "status": "online",
        "health": "/health",
        "execute": "/execute",
    }


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "fetch-browser-worker",
        "browser_model": BROWSER_MODEL,
        "hf_configured": bool(HF_TOKEN),
        "worker_token_configured": bool(WORKER_TOKEN),
    }


@app.get("/favicon.ico")
async def favicon():
    # Railway/browser requests this automatically. Returning 204 avoids
    # unnecessary 404 noise in the logs.
    return JSONResponse(
        content=None,
        status_code=204,
    )


# ---------------------------------------------------------
# Browser execution
# ---------------------------------------------------------

async def run_browser_task(
    task: str,
    url: Optional[str] = None,
) -> Any:

    if not HF_TOKEN:
        raise RuntimeError(
            "HF_TOKEN is not configured on the browser worker."
        )

    final_task = task.strip()

    if url:
        url = url.strip()

        if host_is_blocked(url):
            raise RuntimeError(
                "This destination requires sensitive authentication or "
                "financial interaction and is blocked by Fetch."
            )

        final_task = (
            f"Open this URL first: {url}\n\n"
            f"Then complete this task:\n{task.strip()}"
        )

    final_task = (
        f"{SAFETY_INSTRUCTIONS}\n\n"
        "USER TASK:\n"
        f"{final_task}"
    )

    logger.info(
        "Starting browser task. model=%s max_steps=%s timeout=%ss",
        BROWSER_MODEL,
        MAX_STEPS,
        TASK_TIMEOUT_SECONDS,
    )

    # Hugging Face exposes an OpenAI-compatible endpoint.
    # This keeps the worker independent of the OpenAI API.
    llm = ChatOpenAI(
        model=BROWSER_MODEL,
        api_key=HF_TOKEN,
        base_url=HF_BASE_URL,
        temperature=0,
    )

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

        agent = Agent(
            task=final_task,
            llm=llm,
            browser=browser_session,
            use_vision=True,
            max_actions_per_step=5,
        )

        history = await asyncio.wait_for(
            agent.run(max_steps=MAX_STEPS),
            timeout=TASK_TIMEOUT_SECONDS,
        )

        result = None

        try:
            result = history.final_result()
        except Exception:
            result = None

        if result is None:
            result = str(history)

        logger.info("Browser task completed.")

        return result

    finally:
        try:
            await browser_session.stop()
        except Exception as exc:
            logger.warning(
                "Browser session cleanup warning: %s",
                exc,
            )


# ---------------------------------------------------------
# Execute endpoint
# ---------------------------------------------------------

@app.post("/execute")
async def execute(
    request: ExecuteRequest,
    authorization: Optional[str] = Header(default=None),
):
    require_worker_token(authorization)

    task = request.task.strip()

    if not task:
        raise HTTPException(
            status_code=400,
            detail="Task is required.",
        )

    logger.info(
        "Received browser execution request. conversation_id=%s workflow_id=%s",
        request.conversation_id,
        request.workflow_id,
    )

    try:
        result = await run_browser_task(
            task=task,
            url=request.url,
        )

        return {
            "ok": True,
            "status": "completed",
            "result": result,
            "conversation_id": request.conversation_id,
            "workflow_id": request.workflow_id,
        }

    except asyncio.TimeoutError:
        logger.exception("Browser task timed out.")

        return JSONResponse(
            status_code=504,
            content={
                "ok": False,
                "status": "timeout",
                "error": (
                    f"Browser task exceeded the "
                    f"{TASK_TIMEOUT_SECONDS}-second timeout."
                ),
                "conversation_id": request.conversation_id,
                "workflow_id": request.workflow_id,
            },
        )

    except HTTPException:
        raise

    except Exception as exc:
        logger.exception("Browser task failed.")

        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "status": "failed",
                "error": str(exc),
                "conversation_id": request.conversation_id,
                "workflow_id": request.workflow_id,
            },
        )


# ---------------------------------------------------------
# Startup
# ---------------------------------------------------------

@app.on_event("startup")
async def startup_event():
    logger.info("==========================================")
    logger.info("Fetch Browser Worker starting")
    logger.info("PORT=%s", PORT)
    logger.info("BROWSER_MODEL=%s", BROWSER_MODEL)
    logger.info("HF_BASE_URL=%s", HF_BASE_URL)
    logger.info("HF_TOKEN configured=%s", bool(HF_TOKEN))
    logger.info("WORKER_TOKEN configured=%s", bool(WORKER_TOKEN))
    logger.info("MAX_STEPS=%s", MAX_STEPS)
    logger.info("TASK_TIMEOUT_SECONDS=%s", TASK_TIMEOUT_SECONDS)
    logger.info("==========================================")


# ---------------------------------------------------------
# Main
# ---------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
    )
