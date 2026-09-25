import asyncio
import os
import re
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from browser_use import Agent, ChatOpenAI
from browser_use.browser import BrowserProfile, BrowserSession
from browser_use.browser.profile import ViewportSize


app = FastAPI(title="Fetch Browser Worker", version="1.0.0")


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

MAX_STEPS = int(os.getenv("BROWSER_MAX_STEPS", "12"))
TASK_TIMEOUT_SECONDS = int(os.getenv("BROWSER_TASK_TIMEOUT_SECONDS", "180"))

# Browser-use itself has internal watchdogs. We deliberately disable vision for
# the first production browser worker because normal web tasks do not require
# screenshots, and screenshot watchdogs can add unnecessary latency/timeouts.
LLM_TIMEOUT_SECONDS = int(os.getenv("BROWSER_LLM_TIMEOUT_SECONDS", "60"))
STEP_TIMEOUT_SECONDS = int(os.getenv("BROWSER_STEP_TIMEOUT_SECONDS", "90"))


BLOCKED_HOSTS = (
    "accounts.google.com",
    "login.microsoftonline.com",
    "paypal.com",
    "www.paypal.com",
)


class ExecuteRequest(BaseModel):
    task: str
    url: str | None = None
    conversation_id: str | None = None
    workflow_id: str | None = None


def require_worker_auth(authorization: str | None) -> None:
    if not WORKER_TOKEN:
        raise HTTPException(status_code=503, detail="WORKER_TOKEN is not configured")

    expected = f"Bearer {WORKER_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def validate_task(task: str) -> str:
    value = re.sub(r"\s+", " ", (task or "").strip())
    if not value:
        raise HTTPException(status_code=400, detail="task is required")

    if len(value) > 4000:
        raise HTTPException(status_code=400, detail="task is too long")

    lowered = value.lower()

    # Browser Agent may navigate and read public pages, but it must not be used
    # as a password/payment/OTP execution worker.
    blocked_phrases = (
        "enter my password",
        "enter password",
        "type my password",
        "enter otp",
        "enter the otp",
        "enter verification code",
        "enter 2fa",
        "credit card number",
        "card number",
        "cvv",
        "bank password",
        "banking password",
        "make a payment",
        "pay for",
        "send money",
        "transfer money",
    )

    if any(phrase in lowered for phrase in blocked_phrases):
        raise HTTPException(
            status_code=400,
            detail="This browser worker cannot handle passwords, OTPs, payment credentials, or money transfers.",
        )

    return value


def validate_url(url: str | None) -> str | None:
    if not url:
        return None

    value = url.strip()
    if not re.match(r"^https?://", value, flags=re.I):
        raise HTTPException(status_code=400, detail="url must start with http:// or https://")

    lowered = value.lower()
    if any(host in lowered for host in BLOCKED_HOSTS):
        raise HTTPException(status_code=400, detail="This destination is blocked by the browser worker.")

    return value


def build_llm() -> ChatOpenAI:
    if not HF_TOKEN:
        raise HTTPException(status_code=503, detail="HF_TOKEN is not configured")

    return ChatOpenAI(
        model=BROWSER_MODEL,
        api_key=HF_TOKEN,
        base_url=HF_BASE_URL,
        temperature=0,
    )


def build_browser() -> BrowserSession:
    profile = BrowserProfile(
        headless=True,
        chromium_sandbox=False,
        viewport=ViewportSize(width=1440, height=900),
    )

    return BrowserSession(browser_profile=profile)


def build_agent_task(task: str, url: str | None) -> str:
    destination = f"\nStart at this URL: {url}" if url else ""

    return f"""
You are Fetch's browser execution worker.

Complete the user's browser task using public web pages.

User task:
{task}
{destination}

Rules:
- Navigate and read public webpages.
- Return the factual result of the task.
- Do not ask the user for a password, OTP, verification code, card number, CVV, or banking credentials.
- Do not make payments, transfer money, or perform irreversible financial actions.
- Do not claim success unless you actually completed the requested browser task.
- Keep the final answer concise and directly answer the user's request.
""".strip()


async def execute_browser_task(task: str, url: str | None) -> dict[str, Any]:
    llm = build_llm()
    browser_session = build_browser()

    final_task = build_agent_task(task, url)

    try:
        agent = Agent(
            task=final_task,
            llm=llm,
            browser_session=browser_session,
            # IMPORTANT: disable screenshots for this worker version.
            use_vision=False,
            max_actions_per_step=3,
            max_failures=2,
            use_thinking=False,
            flash_mode=True,
            enable_planning=False,
            llm_timeout=LLM_TIMEOUT_SECONDS,
            step_timeout=STEP_TIMEOUT_SECONDS,
            directly_open_url=True,
        )

        history = await asyncio.wait_for(
            agent.run(max_steps=MAX_STEPS),
            timeout=TASK_TIMEOUT_SECONDS,
        )

        final_result = None
        try:
            final_result = history.final_result()
        except Exception:
            final_result = None

        if final_result:
            return {
                "ok": True,
                "status": "completed",
                "result": str(final_result),
                "model": BROWSER_MODEL,
            }

        # Some browser-use versions expose the final answer through the last
        # history item rather than final_result(). Preserve useful output.
        try:
            items = history.model_dump() if hasattr(history, "model_dump") else {}
            if items:
                return {
                    "ok": True,
                    "status": "completed",
                    "result": str(items),
                    "model": BROWSER_MODEL,
                }
        except Exception:
            pass

        return {
            "ok": False,
            "status": "no_result",
            "result": "The browser completed without returning a final answer.",
            "model": BROWSER_MODEL,
        }

    except asyncio.TimeoutError:
        return {
            "ok": False,
            "status": "timeout",
            "result": "The browser task exceeded the worker timeout.",
            "model": BROWSER_MODEL,
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "failed",
            "result": f"{type(exc).__name__}: {str(exc)[:1000]}",
            "model": BROWSER_MODEL,
        }
    finally:
        try:
            await browser_session.kill()
        except Exception:
            pass


@app.get("/")
async def root():
    return {
        "ok": True,
        "service": "fetch-browser-worker",
        "status": "online",
    }


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "fetch-browser-worker",
        "browser_model": BROWSER_MODEL,
        "hf_configured": bool(HF_TOKEN),
        "worker_token_configured": bool(WORKER_TOKEN),
        "vision": False,
        "max_steps": MAX_STEPS,
        "task_timeout_seconds": TASK_TIMEOUT_SECONDS,
    }


@app.post("/execute")
async def execute(
    request: ExecuteRequest,
    authorization: str | None = Header(default=None),
):
    require_worker_auth(authorization)

    task = validate_task(request.task)
    url = validate_url(request.url)

    result = await execute_browser_task(task, url)

    if not result.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=result.get("result", "Browser execution failed"),
        )

    return {
        "ok": True,
        "status": result.get("status"),
        "result": result.get("result"),
        "model": result.get("model"),
        "conversation_id": request.conversation_id,
        "workflow_id": request.workflow_id,
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
