# KMB Bus Arrival Times 九巴到站時間

A self-hosted, mobile-first web app that shows live bus arrival times for
KMB (Kowloon Motor Bus) stops in Hong Kong, backed by the official
[data.gov.hk](https://data.gov.hk/sc-data/dataset/hk-td-tis_21-etakmb) transit data service.

## Features

- **Nearby stops** — bus stops within 500 m of your location (browser
  geolocation, which requires opening the app over HTTPS).
- **Stop search** — fuzzy search over all ~6,700 stops by English,
  Traditional or Simplified Chinese name; no location required.
- **Subscribed stops** — tap ★ next to any stop to keep it in
  我的車站 / Subscribed stops. Stored in a browser cookie; no account.
- **Live arrivals** — per stop, every route with its next ETAs; the
  page re-polls every 60 s (upstream data updates every minute).
- **Duplicate stop codes** — some special routes registers an extra stop
  with the same code (e.g. 269D at TN507). Such stops appear as a single
  record bound to all of its ids; their arrival lists are merged,
  approaching buses are deduplicated by ETA timestamp, and cards without
  a live ETA (e.g. a service whose times are not yet published) sort to
  the bottom.
- **zh / en UI** — Traditional Chinese by default, one-tap switch.

## Quick start

```bash
pip install -r requirements.txt
python server.py
```

- **HTTP**: http://localhost:8000
- **HTTPS**: https://localhost:8443 — required for geolocation on phones.
  On first run the app generates a self-signed certificate in `certs/`.
  To get location on a phone, install `certs/root_ca.pem` on the device
  and trust it once, then open `https://<server-lan-ip>:8443`.

The first start downloads the full stop list from eTAPI. Afterwards the
cache in `data/stops.json` is loaded at startup and refreshed daily at
06:00 (server local time). Stop ETAs are proxied with a 60 s server-side
cache so repeated polls don't hammer the upstream API.

## API

| Endpoint | Description |
| --- | --- |
| `GET /` | The frontend. |
| `GET /api/stops?lat=…&lng=…` | Stops within 500 m of the given point, plus every stop in the `subscribed_stops` cookie. Stops that share a stop code are returned once (representative record) with all member ids in `ids`. |
| `GET /api/stops/search?q=…` | Fuzzy name search, top 25 matches (same stop-code grouping). `lat`/`lng` are optional and add distances. |
| `GET /api/stops/{stop_id}/eta` | Arrivals for all routes at a stop, merged across every id of its stop code; 60 s cache. |

## Project layout

```
server.py           FastAPI app: eTAPI proxy, stop cache, HTTPS server
static/             Frontend — vanilla HTML/CSS/JS, no build step
data/               stops.json cache (generated; gitignored)
certs/              Self-signed certificate (generated; gitignored)
requirements.txt    Python dependencies
```

Bus data is provided by the Hong Kong Government's
[data.gov.hk](https://data.gov.hk/sc-data/dataset/hk-td-tis_21-etakmb) (KMB specification and
data dictionary are available there).

## Disclaimer

This app is intended for **personal use only**. When location services
(LBS) are enabled, your device's GPS coordinates are sent to the server
so it can work out nearby stops; the server does not store them, but
please take care of your own privacy — host the app on a network you
trust, and use the search box instead of geolocation if you would
rather not share your position.
