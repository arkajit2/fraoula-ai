"""
Fraoula AI — Python backend tests
===================================
Run with:  pytest backend/tests/ -v
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from backend.main import app


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_health() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/py/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "timestamp" in body
    assert body["version"] == "1.0.0"


@pytest.mark.anyio
async def test_models() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/py/models")
    assert resp.status_code == 200
    body = resp.json()
    assert "models" in body
    assert isinstance(body["models"], list)
    assert body["count"] == len(body["models"])
    # Ensure the free model is present
    free_models = [m for m in body["models"] if m["free"]]
    assert len(free_models) >= 1


@pytest.mark.anyio
async def test_usage_summary_requires_auth() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/py/usage/summary")
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_admin_metrics_requires_token() -> None:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/py/admin/metrics")
    # 503 when INTERNAL_API_SECRET is unset, 401 with a bad token
    assert resp.status_code in (401, 503)
