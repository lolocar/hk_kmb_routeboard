"""KMB bus arrival time web app server.

Serves the static frontend and a small JSON API backed by the
official eTAPI (https://data.etabus.gov.hk), per the KMB API
Specification v1.05 and Data Dictionary v1.02 published with the
eTAPI service.

- Stop list is cached in memory + data/stops.json and refreshed
  daily at 06:00 (server local time).
- Stop ETA is proxied with a 60 s server-side cache (upstream
  updates every minute).
"""

import asyncio
import json
import logging
import math
import os
import re
import socket
import tempfile
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
CERTS_DIR = os.path.join(BASE_DIR, "certs")
STOPS_CACHE_FILE = os.path.join(DATA_DIR, "stops.json")

HTTP_PORT = 8000
HTTPS_PORT = 8443

ETAPI_BASE = "https://data.etabus.gov.hk/v1/transport/kmb"
STOP_LIST_URL = f"{ETAPI_BASE}/stop"

NEARBY_RADIUS_M = 500
ETA_CACHE_TTL_S = 60
STOP_LIST_REFRESH_HOUR = 6  # 06:00 daily

COOKIE_SUBSCRIBED = "subscribed_stops"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kmb_routeboard")

# ---------------------------------------------------------------------------
# Self-signed certificate for HTTPS (required for browser Geolocation on
# non-localhost origins)
# ---------------------------------------------------------------------------

def lan_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packets sent; selects the local interface
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def ensure_certs():
    """Return (cert_path, key_path) for HTTPS, generating a self-signed
    certificate on first run. Returns None if trustme is unavailable."""
    cert_path = os.path.join(CERTS_DIR, "cert.pem")
    key_path = os.path.join(CERTS_DIR, "key.pem")
    if os.path.exists(cert_path) and os.path.exists(key_path):
        return cert_path, key_path
    try:
        import trustme
    except ImportError:
        log.warning("trustme is not installed (pip install trustme); HTTPS disabled")
        return None
    try:
        os.makedirs(CERTS_DIR, exist_ok=True)
        ca = trustme.CA()
        names = ["localhost", "127.0.0.1"]
        ip = lan_ip()
        if ip:
            names.append(ip)
        server_cert = ca.issue_cert(*names)
        ca.cert_pem.write_to_path(os.path.join(CERTS_DIR, "root_ca.pem"))
        server_cert.cert_chain_pems[0].write_to_path(cert_path)
        server_cert.private_key_pem.write_to_path(key_path)
        log.info("Generated self-signed certificate for: %s", ", ".join(names))
        log.info("Install certs/root_ca.pem on client devices and trust it, "
                 "then open the app via https://<this-host>:%d", HTTPS_PORT)
    except Exception as e:
        log.error("Certificate generation failed: %s", e)
        return None
    return cert_path, key_path


# ---------------------------------------------------------------------------
# Stop list cache
# ---------------------------------------------------------------------------

STOP_CODE_RE = re.compile(r"\(([^()]+)\)\s*$")
STOP_CODE_PAT = re.compile(r"^[A-Za-z]{1,3}\d{2,4}[A-Za-z]?$")


def extract_stop_code(name_en: str) -> str | None:
    """Trailing parenthesized stop code of an English stop name
    (e.g. "TIN SHUI ESTATE (TN507)" -> "TN507"). Names whose suffix is not a
    code ("... (ALIGHTING STOP)", "... (MACAO FERRY)") return None."""
    m = STOP_CODE_RE.search(name_en or "")
    if m and STOP_CODE_PAT.match(m.group(1)):
        return m.group(1).upper()
    return None


class StopCache:
    """In-memory stop list with disk persistence."""

    def __init__(self):
        self.stops = {}          # id -> {id, name_en, name_tc, name_sc, lat, lng}
        self.fetched_at = None   # datetime (local)
        self.group_ids = {}      # id -> all ids sharing its stop code

    def load_disk(self) -> bool:
        """Load from data/stops.json. Returns True if loaded and fresh enough."""
        if not os.path.exists(STOPS_CACHE_FILE):
            return False
        try:
            with open(STOPS_CACHE_FILE, "r", encoding="utf-8") as f:
                payload = json.load(f)
            self.fetched_at = datetime.fromisoformat(payload["fetched_at"])
            self.stops = {s["id"]: s for s in payload["stops"]}
            self.build_group_index()
            log.info("Loaded %d stops from disk cache (fetched %s)",
                     len(self.stops), self.fetched_at.isoformat())
            return True
        except (ValueError, KeyError, OSError) as e:
            log.warning("Could not load stop cache from disk: %s", e)
            return False

    def is_stale(self) -> bool:
        """Stale if never fetched or last fetch was before today's 06:00."""
        now = datetime.now()
        cutoff = now.replace(hour=STOP_LIST_REFRESH_HOUR, minute=0,
                             second=0, microsecond=0)
        if self.fetched_at is None:
            return True
        if self.fetched_at < cutoff:
            return True
        return False

    @staticmethod
    def parse_stops(data) -> dict:
        """Parse the upstream StopList 'data' array into the internal format.

        Upstream fields: stop, name_en, name_tc, name_sc, lat, long
        (lat/long may be strings; names may carry stray whitespace).
        """
        stops = {}
        for item in data:
            sid = (item.get("stop") or "").strip()
            try:
                lat = float(item["lat"])
                lng = float(item["long"])
            except (KeyError, TypeError, ValueError):
                continue  # skip entries without usable coordinates
            if not sid:
                continue
            stops[sid] = {
                "id": sid,
                "name_en": (item.get("name_en") or "").strip(),
                "name_tc": (item.get("name_tc") or "").strip(),
                "name_sc": (item.get("name_sc") or "").strip(),
                "lat": lat,
                "lng": lng,
            }
        return stops

    def build_group_index(self):
        """Map every stop id to all ids sharing its stop code — the upstream
        list can register one physical stop twice (e.g. TN507). Stops without
        a code, or with a unique code, map to a single-element list. The
        first id (upstream order) is the representative record shown in the
        search and nearby lists."""
        by_code = {}
        for stop in self.stops.values():
            code = extract_stop_code(stop["name_en"])
            if code:
                by_code.setdefault(code, []).append(stop["id"])
        self.group_ids = {}
        for sid, stop in self.stops.items():
            code = extract_stop_code(stop["name_en"])
            self.group_ids[sid] = by_code[code] if code else [sid]
        for code, ids in by_code.items():
            if len(ids) > 2:
                log.info("Stop code %s has %d records: %s", code, len(ids), ids)
        dup_codes = [ids for ids in by_code.values() if len(ids) > 1]
        log.info("%d stops share a duplicated code (%d codes)",
                 sum(len(ids) for ids in dup_codes), len(dup_codes))

    async def fetch(self, client: httpx.AsyncClient) -> bool:
        try:
            resp = await client.get(STOP_LIST_URL, timeout=60)
            resp.raise_for_status()
            payload = resp.json()
        except (httpx.HTTPError, ValueError) as e:
            log.error("Failed to fetch stop list: %s", e)
            return False
        self.stops = self.parse_stops(payload.get("data", []))
        self.fetched_at = datetime.now()
        self.build_group_index()
        self.save_disk()
        log.info("Fetched %d stops from eTAPI", len(self.stops))
        return True

    def save_disk(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        payload = {
            "fetched_at": self.fetched_at.isoformat() if self.fetched_at else None,
            "stops": list(self.stops.values()),
        }
        fd, tmp_path = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
            os.replace(tmp_path, STOPS_CACHE_FILE)
        except OSError as e:
            log.error("Failed to save stop cache: %s", e)
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)


stop_cache = StopCache()

# ---------------------------------------------------------------------------
# Stop ETA cache (per stop, 60 s TTL)
# ---------------------------------------------------------------------------

eta_cache = {}  # stop_id -> (fetched_at_monotonic, payload_dict)


def seconds_until_next_6am() -> float:
    now = datetime.now()
    target = now.replace(hour=STOP_LIST_REFRESH_HOUR, minute=0,
                         second=0, microsecond=0)
    if now >= target:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def daily_stop_list_updater():
    """Re-fetch the stop list at 06:00 every day."""
    while True:
        delay = seconds_until_next_6am()
        log.info("Next stop-list refresh at 06:00 (in %.1f h)", delay / 3600)
        await asyncio.sleep(delay)
        async with httpx.AsyncClient() as client:
            await stop_cache.fetch(client)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load cache from disk; refresh if missing or stale (last fetch before
    # today's 06:00).
    if not stop_cache.load_disk() or stop_cache.is_stale():
        async with httpx.AsyncClient() as client:
            if not await stop_cache.fetch(client):
                # Keep whatever we had (possibly empty) so the app still runs.
                log.error("Starting with an incomplete stop list")
    updater = asyncio.create_task(daily_stop_list_updater())
    yield
    updater.cancel()


app = FastAPI(title="KMB Bus Arrival Times", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def haversine_m(lat1, lng1, lat2, lng2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def subscribed_ids_from_cookie(request: Request) -> set:
    raw = request.cookies.get(COOKIE_SUBSCRIBED, "")
    return {s.strip() for s in raw.split(",") if s.strip()}


def normalize_stop_eta(payload: dict) -> dict:
    """Collapse service_type duplicates and group by (route, dir).

    Per the spec, service types of the same route number share ETA data
    at a stop, so (route, dir, eta_seq) is the dedupe key.
    """
    seen = {}      # (route, dir, eta_seq) -> eta entry
    groups = {}    # (route, dir) -> group dict
    for item in payload.get("data", []):
        route = item.get("route") or ""
        direction = item.get("dir") or ""
        eta_seq = item.get("eta_seq")
        key = (route, direction, eta_seq)
        if key in seen:
            continue
        eta_entry = {
            "eta_seq": eta_seq,
            "eta": item.get("eta"),
            "rmk_en": item.get("rmk_en") or "",
            "rmk_tc": item.get("rmk_tc") or "",
            "data_timestamp": item.get("data_timestamp"),
        }
        seen[key] = eta_entry
        gkey = (route, direction)
        if gkey not in groups:
            groups[gkey] = {
                "route": route,
                "dir": direction,
                "dest_en": item.get("dest_en") or "",
                "dest_tc": item.get("dest_tc") or "",
                "dest_sc": item.get("dest_sc") or "",
                "etas": [],
            }
        groups[gkey]["etas"].append(eta_entry)

    routes = list(groups.values())
    for g in routes:
        g["etas"].sort(key=lambda e: (e["eta_seq"] is None, e["eta_seq"]))
    routes.sort(key=lambda g: (g["route"].upper(), g["dir"]))
    return {
        "generated_timestamp": payload.get("generated_timestamp"),
        "routes": routes,
    }


def merge_stop_eta(payloads: list) -> dict:
    """Combine the route lists of the records of one physical stop (e.g. two
    poles registered under the same code). The same (route, dir) at
    different poles becomes one card; approaching buses are deduped by ETA
    timestamp, no-eta remarks by their text. Cards with at least one live
    ETA sort above all-null ones; within a card, chips without an ETA come
    last."""
    groups = {}
    for p in payloads:
        for g in p["routes"]:
            key = (g["route"], g["dir"])
            if key not in groups:
                groups[key] = {
                    "route": g["route"],
                    "dir": g["dir"],
                    "dest_en": g["dest_en"],
                    "dest_tc": g["dest_tc"],
                    "dest_sc": g["dest_sc"],
                    "etas": [],
                }
            etas = groups[key]["etas"]
            for e in g["etas"]:
                if e["eta"] is not None:
                    if any(x["eta"] == e["eta"] for x in etas):
                        continue
                elif any(x["eta"] is None and x["rmk_en"] == e["rmk_en"]
                         and x["rmk_tc"] == e["rmk_tc"] for x in etas):
                    continue
                etas.append(e)

    routes = list(groups.values())
    for g in routes:
        g["etas"].sort(key=lambda e: (e["eta"] is None,
                                      e["eta_seq"] is None, e["eta_seq"]))
    routes.sort(key=lambda g: (all(e["eta"] is None for e in g["etas"]),
                               g["route"].upper(), g["dir"]))
    stamps = [p.get("generated_timestamp") for p in payloads
              if p.get("generated_timestamp")]
    return {
        "generated_timestamp": max(stamps) if stamps else None,
        "routes": routes,
    }


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@app.get("/api/stops")
async def list_stops(request: Request, lat: float = None, lng: float = None):
    """Stops within 500 m of (lat, lng) plus all subscribed stops.

    A physical stop registered under two ids (same stop code) is shown once
    as the representative record, with all member ids in "ids".
    """
    subscribed = subscribed_ids_from_cookie(request)
    has_location = lat is not None and lng is not None

    results = []
    for stop in stop_cache.stops.values():
        ids = stop_cache.group_ids[stop["id"]]
        if ids[0] != stop["id"]:
            continue  # non-representative record of a grouped stop
        is_subscribed = any(i in subscribed for i in ids)
        if has_location:
            dist = min(haversine_m(lat, lng, stop_cache.stops[i]["lat"],
                                   stop_cache.stops[i]["lng"]) for i in ids)
            is_nearby = dist <= NEARBY_RADIUS_M
        else:
            dist = None
            is_nearby = False
        if not is_nearby and not is_subscribed:
            continue
        results.append({
            **stop,
            "ids": ids,
            "distance_m": round(dist) if dist is not None else None,
            "nearby": is_nearby,
            "subscribed": is_subscribed,
        })
    results.sort(key=lambda s: (s["distance_m"] is None, s["distance_m"] or 0))
    return {"location": [lat, lng] if has_location else None, "stops": results}


@app.get("/api/stops/search")
async def search_stops(request: Request, q: str = "",
                       lat: float = None, lng: float = None):
    """Fuzzy search all stops by name (English or Chinese), top 25 matches.

    Works without a location; distances are included when lat/lng are given.
    A physical stop registered under two ids (same stop code) is shown once
    as the representative record, with all member ids in "ids".
    """
    subscribed = subscribed_ids_from_cookie(request)
    q = " ".join(q.lower().split())
    if len(q) < 2:
        return {"results": []}

    def matches(hay: str) -> bool:
        if q in hay:
            return True
        # Fallback: all words must appear (handles non-contiguous phrases)
        words = q.split()
        return len(words) > 1 and all(w in hay for w in words)

    has_location = lat is not None and lng is not None
    results = []
    for stop in stop_cache.stops.values():
        ids = stop_cache.group_ids[stop["id"]]
        if ids[0] != stop["id"]:
            continue  # non-representative record of a grouped stop
        # Match against every member so a query hitting a twin's name still
        # finds the stop.
        hay = " ".join(f"{stop_cache.stops[i]['name_en']} "
                       f"{stop_cache.stops[i]['name_tc']} "
                       f"{stop_cache.stops[i]['name_sc']}" for i in ids).lower()
        if not matches(hay):
            continue
        dist = (min(haversine_m(lat, lng, stop_cache.stops[i]["lat"],
                                stop_cache.stops[i]["lng"]) for i in ids)
                if has_location else None)
        results.append({
            **stop,
            "ids": ids,
            "distance_m": round(dist) if dist is not None else None,
            "nearby": dist is not None and dist <= NEARBY_RADIUS_M,
            "subscribed": any(i in subscribed for i in ids),
        })
    results.sort(key=lambda s: (s["distance_m"] is None,
                                s["distance_m"] or 0,
                                s["name_en"]))
    return {"results": results[:25]}


async def get_stop_eta_normalized(sid: str,
                                  client: httpx.AsyncClient):
    """Normalized stop-eta payload for one stop id (60 s cache), or
    (None, False) if it cannot be fetched."""
    cached = eta_cache.get(sid)
    now = time.monotonic()
    if cached and now - cached[0] < ETA_CACHE_TTL_S:
        return cached[1], True
    url = f"{ETAPI_BASE}/stop-eta/{sid}"
    try:
        resp = await client.get(url, timeout=30)
    except httpx.HTTPError as e:
        log.warning("stop-eta %s failed: %s", sid, e)
        return None, False
    if resp.status_code != 200:
        log.warning("stop-eta %s returned HTTP %d", sid, resp.status_code)
        return None, False
    try:
        payload = resp.json()
    except ValueError:
        log.warning("stop-eta %s returned invalid JSON", sid)
        return None, False
    normalized = normalize_stop_eta(payload)
    eta_cache[sid] = (now, normalized)
    return normalized, False


@app.get("/api/stops/{stop_id}/eta")
async def stop_eta(stop_id: str):
    """Arrival times for all routes at a stop, cached 60 s server-side.

    A physical stop registered under two ids (same stop code) is shown as
    one: the route lists of both records are merged, and cards without live
    ETAs sort to the bottom.
    """
    ids = stop_cache.group_ids.get(stop_id) or [stop_id]
    payloads, all_cached = [], True
    async with httpx.AsyncClient() as client:
        for sid in ids:
            normalized, cached = await get_stop_eta_normalized(sid, client)
            if normalized is None:
                continue
            payloads.append(normalized)
            all_cached = all_cached and cached
    if not payloads:
        return Response(status_code=502, content=json.dumps(
            {"error": "upstream request failed"}))
    merged = merge_stop_eta(payloads) if len(payloads) > 1 else payloads[0]
    return {"stop_id": stop_id, "from_cache": all_cached, **merged}


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    with open(os.path.join(STATIC_DIR, "index.html"), "r", encoding="utf-8") as f:
        return Response(content=f.read(), media_type="text/html; charset=utf-8")


if __name__ == "__main__":
    import threading

    import uvicorn

    ssl_files = ensure_certs()
    if ssl_files:
        cert_path, key_path = ssl_files
        https_config = uvicorn.Config(
            app, host="0.0.0.0", port=HTTPS_PORT,
            ssl_certfile=cert_path, ssl_keyfile=key_path, log_level="info")
        https_thread = threading.Thread(
            target=uvicorn.Server(https_config).run, daemon=True,
            name="https-server")
        https_thread.start()
        log.info("HTTPS available at https://localhost:%d (Geolocation "
                 "requires HTTPS on non-localhost origins)", HTTPS_PORT)
    uvicorn.run(app, host="0.0.0.0", port=HTTP_PORT, log_level="info")
