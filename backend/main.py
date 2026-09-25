"""
Fraoula AI — Python FastAPI Backend
====================================
Provides supplementary API endpoints that complement the TanStack Start
frontend. All AI model calls, billing and auth are still handled by the
TypeScript server layer (Supabase + Lovable cloud functions). This Python
service adds:

  • /api/py/health          — liveness probe for Cloudflare / uptime checks
  • /api/py/models          — returns the canonical model catalogue (mirrors
                               pricing.ts so the frontend has a single source
                               of truth at runtime)
  • /api/py/usage/summary   — aggregates usage rows fetched from Supabase
                               and returns rolling stats (24 h / 7 d / 30 d)
  • /api/py/admin/metrics   — internal dashboard metrics (admin-only via
                               service-role key)

Run locally:
    uvicorn backend.main:app --reload --port 8000

Deploy on Cloudflare Workers (Python workers beta) or any WSGI/ASGI host.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Security
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Fraoula AI — Python API",
    description="Supplementary Python backend for Fraoula AI.",
    version="1.0.0",
)

ALLOWED_ORIGINS = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:3000,https://fraoula.ai,https://fraoula.pages.dev",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

bearer_scheme = HTTPBearer(auto_error=False)

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
INTERNAL_API_SECRET = os.getenv("INTERNAL_API_SECRET", "")


# ---------------------------------------------------------------------------
# Models (mirrors src/lib/pricing.ts)
# ---------------------------------------------------------------------------

MODELS: list[dict[str, Any]] = [
    {
        "id": "gemini-2-5-flash-lite",
        "label": "Gemini 2.5 Flash Lite",
        "provider": "google",
        "free": True,
        "enabled": True,
        "rates": {"input": 0, "output": 0},
    },
    {
        "id": "gemini-2-5-flash",
        "label": "Gemini 2.5 Flash",
        "provider": "google",
        "free": False,
        "enabled": True,
        "rates": {"input": 0.3, "output": 2.5},
    },
    {
        "id": "gemini-2-5-pro",
        "label": "Gemini 2.5 Pro",
        "provider": "google",
        "free": False,
        "enabled": True,
        "rates": {"input": 2.5, "output": 15.0},
    },
    {
        "id": "gpt-5-6-terra",
        "label": "GPT-5.6 Terra",
        "provider": "openai",
        "free": False,
        "enabled": True,
        "rates": {"input": 5.0, "output": 20.0},
        "minTier": 1,
    },
    {
        "id": "claude-sonnet-4-6",
        "label": "Claude Sonnet 4.6",
        "provider": "anthropic",
        "free": False,
        "enabled": True,
        "rates": {"input": 3.0, "output": 15.0},
    },
    {
        "id": "opus-5",
        "label": "Opus 5",
        "provider": "anthropic",
        "free": False,
        "enabled": True,
        "rates": {"input": 15.0, "output": 75.0},
        "minTier": 2,
    },
]


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    version: str


class UsageSummaryResponse(BaseModel):
    messages_24h: int
    messages_7d: int
    messages_30d: int
    cost_24h_usd: float
    cost_7d_usd: float
    cost_30d_usd: float


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _supabase_headers(use_service_key: bool = False) -> dict[str, str]:
    key = SUPABASE_SERVICE_KEY if use_service_key else ""
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _require_internal_token(
    creds: HTTPAuthorizationCredentials | None,
) -> None:
    """Validates the shared internal API secret for admin endpoints."""
    if not INTERNAL_API_SECRET:
        raise HTTPException(503, "Admin endpoints are not configured.")
    if creds is None or creds.credentials != INTERNAL_API_SECRET:
        raise HTTPException(401, "Unauthorized.")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/api/py/health", response_model=HealthResponse, tags=["infra"])
async def health() -> HealthResponse:
    """Liveness probe — always returns 200 when the service is up."""
    return HealthResponse(
        status="ok",
        timestamp=datetime.now(timezone.utc).isoformat(),
        version="1.0.0",
    )


@app.get("/api/py/models", tags=["catalogue"])
async def list_models() -> dict[str, Any]:
    """Returns the full model catalogue with client-safe pricing."""
    return {"models": MODELS, "count": len(MODELS)}


@app.get("/api/py/usage/summary", response_model=UsageSummaryResponse, tags=["usage"])
async def usage_summary(request: Request) -> UsageSummaryResponse:
    """
    Returns rolling usage stats for the authenticated user.

    Expects a valid Supabase JWT in the Authorization header. The stats are
    computed client-side from the usage_records table via the Supabase REST
    API (no direct DB connection required in the Python layer).
    """
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Missing or invalid authorization header.")

    user_jwt = auth.split(" ", 1)[1]

    if not SUPABASE_URL:
        # Dev fallback — return zeroes when Supabase isn't configured.
        return UsageSummaryResponse(
            messages_24h=0,
            messages_7d=0,
            messages_30d=0,
            cost_24h_usd=0.0,
            cost_7d_usd=0.0,
            cost_30d_usd=0.0,
        )

    import httpx

    now = datetime.now(timezone.utc)
    cutoff_30d = (now - timedelta(days=30)).isoformat()

    url = (
        f"{SUPABASE_URL}/rest/v1/usage_records"
        f"?select=created_at,final_cost"
        f"&created_at=gte.{cutoff_30d}"
        f"&order=created_at.desc"
    )

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url,
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {user_jwt}",
            },
        )

    if resp.status_code != 200:
        raise HTTPException(502, "Could not fetch usage data.")

    rows: list[dict[str, Any]] = resp.json()

    def _agg(days: int) -> tuple[int, float]:
        cutoff = now - timedelta(days=days)
        filtered = [
            r
            for r in rows
            if datetime.fromisoformat(r["created_at"].replace("Z", "+00:00")) >= cutoff
        ]
        cost = sum(float(r.get("final_cost") or 0) for r in filtered)
        return len(filtered), round(cost, 6)

    m24, c24 = _agg(1)
    m7, c7 = _agg(7)
    m30, c30 = _agg(30)

    return UsageSummaryResponse(
        messages_24h=m24,
        messages_7d=m7,
        messages_30d=m30,
        cost_24h_usd=c24,
        cost_7d_usd=c7,
        cost_30d_usd=c30,
    )


@app.get("/api/py/admin/metrics", tags=["admin"])
async def admin_metrics(
    creds: HTTPAuthorizationCredentials | None = Security(bearer_scheme),
) -> dict[str, Any]:
    """
    Internal admin metrics endpoint.
    Requires the INTERNAL_API_SECRET bearer token.
    """
    _require_internal_token(creds)

    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        return {"error": "Supabase not configured", "metrics": {}}

    import httpx

    now = datetime.now(timezone.utc)
    cutoff_24h = (now - timedelta(hours=24)).isoformat()

    async with httpx.AsyncClient() as client:
        # Total users
        users_resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/profiles?select=id",
            headers=_supabase_headers(use_service_key=True),
        )
        # 24h revenue
        revenue_resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/usage_records"
            f"?select=final_cost&created_at=gte.{cutoff_24h}",
            headers=_supabase_headers(use_service_key=True),
        )

    users = users_resp.json() if users_resp.status_code == 200 else []
    revenue_rows = revenue_resp.json() if revenue_resp.status_code == 200 else []
    revenue_24h = sum(float(r.get("final_cost") or 0) for r in revenue_rows)

    return {
        "total_users": len(users),
        "revenue_24h_usd": round(revenue_24h, 4),
        "timestamp": now.isoformat(),
    }
