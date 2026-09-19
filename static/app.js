// KMB bus arrival times — frontend logic.
// Subscribed stops are stored in the "subscribed_stops" cookie.
// UI language ("zh" default / "en") is stored in localStorage.

const COOKIE_NAME = "subscribed_stops";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const ETA_POLL_MS = 60 * 1000;             // upstream updates every minute
const LOCATION_REFRESH_MS = 60 * 1000;     // re-fetch GPS + nearby stops every minute
const LANG_KEY = "ui_lang";

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// i18n — Traditional Chinese by default, English selectable
// ---------------------------------------------------------------------------

const I18N = {
  zh: {
    appTitle: "九巴到站時間",
    langToggle: "EN",
    searchPlaceholder: "搜尋車站… 例如 尖沙咀碼頭 / Star Ferry",
    nearbyTitle: "附近車站",
    radius: "500 米內",
    subscribedTitle: "我的車站",
    noSubscribed: "暫無訂閱車站。點選車站旁的 ★ 即可加入。（即使該車站同時是附近車站，也會顯示在「我的車站」中。）",
    locating: "正在定位…",
    geoInsecure: "此瀏覽器在非 HTTPS 頁面上禁用位置功能。請改用 HTTPS（8443 端口）開啟本應用並信任一次證書，或使用上方的搜尋框。",
    geoDenied: "位置權限被拒絕。請在瀏覽器設定中允許此網站取得位置（Safari：設定 → 隱私與安全性 → 定位服務），然後按重試——或改用搜尋框。",
    geoUnavailable: "現時無法取得位置。請重試或使用搜尋框。",
    geoTimeout: "定位逾時。請重試或使用搜尋框。",
    retry: "重試",
    loadFailed: "載入車站失敗：{msg}",
    noNearby: "500 米內沒有巴士站。",
    searchNoMatch: "沒有與「{q}」相符的車站。",
    searchFailed: "搜尋失敗：{msg}",
    back: "← 返回",
    updated: "更新於 {time}",
    cache: "（快取）",
    loadingEta: "載入到站時間…",
    etaFailed: "載入到站時間失敗：{msg}",
    noEta: "此車站沒有到站時間資料。",
    due: "即達",
    minutes: "{n} 分鐘",
    etaAt: "預計到達 {time}",
    noService: "未有班次資料",
  },
  en: {
    appTitle: "KMB Bus Arrival Times",
    langToggle: "中文",
    searchPlaceholder: "Search stops… e.g. Star Ferry / 尖沙咀碼頭",
    nearbyTitle: "Nearby stops",
    radius: "within 500 m",
    subscribedTitle: "Subscribed stops",
    noSubscribed: "No subscribed stops yet. Tap ★ next to a stop to add it here — it will show up here even if it is also listed as nearby.",
    locating: "Locating you…",
    geoInsecure: "This browser blocks location access on non-HTTPS pages. Open the app via HTTPS (port 8443) and trust the certificate once, or use the search box above.",
    geoDenied: "Location permission denied. Allow location for this site in your browser settings (Safari: Settings → Privacy & Security → Location Services), then tap Retry — or use the search box.",
    geoUnavailable: "Location unavailable right now. Tap Retry or use the search box.",
    geoTimeout: "Could not get your location (timed out). Tap Retry or use the search box.",
    retry: "Retry",
    loadFailed: "Failed to load stops: {msg}",
    noNearby: "No bus stops within 500 m.",
    searchNoMatch: "No stops match “{q}”.",
    searchFailed: "Search failed: {msg}",
    back: "← Back",
    updated: "Updated {time}",
    cache: " (cache)",
    loadingEta: "Loading arrival times…",
    etaFailed: "Failed to load arrival times: {msg}",
    noEta: "No arrival times available for this stop.",
    due: "Due",
    minutes: "{n} min",
    etaAt: "ETA {time}",
    noService: "Information unavailable",
  },
};

let uiLang = localStorage.getItem(LANG_KEY) === "en" ? "en" : "zh";

function t(key, params) {
  let s = (I18N[uiLang] && I18N[uiLang][key]) || I18N.en[key] || key;
  for (const [k, v] of Object.entries(params || {})) {
    s = s.split(`{${k}}`).join(v);
  }
  return s;
}

// [primary, secondary] stop/destination name pair — Chinese by default.
function pickName(en, tc) {
  const primary = uiLang === "zh" ? tc : en;
  const secondary = uiLang === "zh" ? en : tc;
  if (!primary) return [secondary, ""];
  return [primary, secondary];
}

function pickRemark(rmkEn, rmkTc) {
  return uiLang === "zh" ? (rmkTc || rmkEn) : (rmkEn || rmkTc);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let subscribed = readSubscribedCookie();
let currentEtaStopId = null;
let currentEtaGroupIds = null;
let etaPollTimer = null;
let lastLocation = null;   // [lat, lng] once known
let locationRefreshTimer = null;  // periodic GPS + nearby-stop refresh
let searchTimer = null;
let lastSearchQuery = "";
let lastStopsPayload = null;
let lastEtaBody = null;

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

function readSubscribedCookie() {
  const raw = document.cookie
    .split("; ")
    .find((row) => row.startsWith(COOKIE_NAME + "="));
  if (!raw) return new Set();
  const value = decodeURIComponent(raw.slice(COOKIE_NAME.length + 1));
  return new Set(value.split(",").filter(Boolean));
}

function saveSubscribedCookie() {
  const value = [...subscribed].map(encodeURIComponent).join(",");
  document.cookie = `${COOKIE_NAME}=${value}; max-age=${COOKIE_MAX_AGE}; path=/`;
}

// groupIds: all stop ids bound to this physical stop (stop-list results
// carry "ids"). The subscription is stored under the representative id and
// any legacy non-representative ids of the group are dropped, so a duplicate
// stop that is also nearby still appears in Subscribed stops.
function toggleSubscribed(stopId, groupIds) {
  const rep = (groupIds && groupIds.length) ? groupIds[0] : stopId;
  const ids = groupIds || [stopId];
  const wasActive = ids.some((id) => subscribed.has(id));
  for (const id of ids) subscribed.delete(id);
  if (!wasActive) subscribed.add(rep);
  saveSubscribedCookie();
}

// Immediate visual feedback after a star tap: the list re-render only
// happens after a network refetch, so update every star showing this stop
// (it may appear in search results and the nearby/subscribed lists at once)
// right away — otherwise users double-tap and silently cancel their toggle.
function syncStarButtons(stopId) {
  const active = subscribed.has(stopId);
  for (const s of document.querySelectorAll(`.star-btn[data-stop-id="${stopId}"]`)) {
    s.textContent = active ? "★" : "☆";
    s.classList.toggle("active", active);
    s.title = active ? "Unsubscribe 取消訂閱" : "Subscribe 訂閱";
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtDistance(m) {
  if (m == null) return "";
  if (m < 1000) return `${m} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function fmtEtaMinutes(etaIso) {
  if (!etaIso) return null;
  const eta = new Date(etaIso).getTime();
  const diffMin = Math.ceil((eta - Date.now()) / 60000);
  if (diffMin <= 0) return 0; // "due"
  return diffMin;
}

function fmtClock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

function applyI18n() {
  document.getElementById("app-title").textContent = "🚌 " + t("appTitle");
  document.getElementById("lang-toggle").textContent = t("langToggle");
  document.getElementById("stop-search").placeholder = t("searchPlaceholder");
  document.getElementById("nearby-title").textContent = t("nearbyTitle");
  document.getElementById("radius-label").textContent = t("radius");
  document.getElementById("subscribed-title").textContent = t("subscribedTitle");
  document.getElementById("no-subscribed").textContent = t("noSubscribed");
  document.getElementById("back-btn").textContent = t("back");
}

function toggleLang() {
  uiLang = uiLang === "zh" ? "en" : "zh";
  localStorage.setItem(LANG_KEY, uiLang);
  applyI18n();
  renderStopLists(lastStopsPayload);
  if (lastSearchQuery.length >= 2) runStopSearch(lastSearchQuery);
  if (currentEtaStopId && lastEtaBody) renderEtaList(lastEtaBody);
}

// ---------------------------------------------------------------------------
// Stop list rendering
// ---------------------------------------------------------------------------

function stopRow(stop) {
  const li = document.createElement("li");
  li.className = "stop-row";

  const [primary, secondary] = pickName(stop.name_en, stop.name_tc);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "stop-btn";
  btn.innerHTML = `
    <span class="stop-names">
      <span class="name-primary">${escapeHtml(primary)}</span>
      ${secondary ? `<span class="name-secondary">${escapeHtml(secondary)}</span>` : ""}
    </span>
    <span class="stop-meta">
      ${stop.distance_m != null ? `<span class="distance">${fmtDistance(stop.distance_m)}</span>` : ""}
    </span>`;
  btn.addEventListener("click", () => openStopDetail(stop));
  li.appendChild(btn);

  const star = document.createElement("button");
  star.type = "button";
  star.className = "star-btn" + (subscribed.has(stop.id) ? " active" : "");
  star.textContent = subscribed.has(stop.id) ? "★" : "☆";
  star.title = subscribed.has(stop.id) ? "Unsubscribe 取消訂閱" : "Subscribe 訂閱";
  star.dataset.stopId = stop.id;
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSubscribed(stop.id, stop.ids);
    syncStarButtons(stop.id);
    refreshListsAfterToggle();
  });
  li.appendChild(star);

  return li;
}

function renderStopLists(payload) {
  lastStopsPayload = payload;
  const nearbyUl = $("#nearby-list");
  const subUl = $("#subscribed-list");
  nearbyUl.innerHTML = "";
  subUl.innerHTML = "";

  const stops = (payload && payload.stops) || [];
  let nearbyCount = 0;

  for (const stop of stops) {
    if (stop.nearby) {
      nearbyUl.appendChild(stopRow(stop));
      nearbyCount++;
    }
    // A subscribed stop always appears in "Subscribed stops", even when it is
    // also listed as a nearby stop (e.g. a duplicate/merged physical stop).
    if (stop.subscribed) {
      subUl.appendChild(stopRow(stop));
    }
  }

  $("#no-subscribed").classList.toggle("hidden", subscribed.size > 0);
  if (nearbyCount === 0 && payload && payload.location) {
    nearbyUl.innerHTML = `<li class="empty">${escapeHtml(t("noNearby"))}</li>`;
  }
}

// ---------------------------------------------------------------------------
// Location + initial load
// ---------------------------------------------------------------------------

async function fetchStops(lat, lng) {
  const url = `/api/stops${lat != null ? `?lat=${lat}&lng=${lng}` : ""}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function showNotice(text, kind) {
  const el = $("#location-notice");
  el.textContent = text;
  el.className = `notice ${kind}`;
}

function geoErrorKey(err) {
  if (!window.isSecureContext) return "geoInsecure";
  switch (err.code) {
    case err.PERMISSION_DENIED: return "geoDenied";
    case err.POSITION_UNAVAILABLE: return "geoUnavailable";
    default: return "geoTimeout";
  }
}

function showGeoError(key, withRetry) {
  const notice = $("#location-notice");
  notice.className = "notice error";
  notice.textContent = t(key);
  if (withRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-btn";
    retry.textContent = " " + t("retry");
    retry.addEventListener("click", loadStops);
    notice.appendChild(retry);
  }
}

async function loadStops() {
  const notice = $("#location-notice");
  if (!locationRefreshTimer) {
    notice.className = "notice loading";
    notice.textContent = t("locating");
  }

  if (!window.isSecureContext || !navigator.geolocation) {
    showGeoError(geoErrorKey(null), false);
    refreshStopList(null);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      lastLocation = [pos.coords.latitude, pos.coords.longitude];
      notice.classList.add("hidden");
      try {
        const payload = await fetchStops(lastLocation[0], lastLocation[1]);
        renderStopLists(payload);
      } catch (e) {
        showNotice(t("loadFailed", { msg: e.message }), "error");
      }
    },
    (err) => {
      // First attempt (or retry): show the error. A background refresh
      // failing is not critical — keep the previous list as is.
      if (!lastLocation) {
        showGeoError(geoErrorKey(err), true);
        refreshStopList(null);
      }
      return;
    },
    // 0 = always request a fresh fix, so the 60 s refresh actually
    // reflects movement instead of serving the browser's cached position.
    { timeout: 15000, maximumAge: 0 }
  );

  if (!locationRefreshTimer) {
    locationRefreshTimer = setTimeout(loadStops, LOCATION_REFRESH_MS);
  }
}

async function refreshStopList(latLng) {
  try {
    const payload = await fetchStops(latLng ? latLng[0] : null, latLng ? latLng[1] : null);
    renderStopLists(payload);
  } catch (e) {
    showNotice(t("loadFailed", { msg: e.message }), "error");
  }
}

// ---------------------------------------------------------------------------
// Stop search (no location required)
// ---------------------------------------------------------------------------

async function runStopSearch(query) {
  lastSearchQuery = query;
  const ul = $("#search-results");
  if (query.length < 2) {
    ul.classList.add("hidden");
    ul.innerHTML = "";
    return;
  }
  const params = new URLSearchParams({ q: query });
  if (lastLocation) {
    params.set("lat", lastLocation[0]);
    params.set("lng", lastLocation[1]);
  }
  try {
    const resp = await fetch(`/api/stops/search?${params}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    ul.innerHTML = "";
    if (!body.results.length) {
      ul.innerHTML = `<li class="empty">${escapeHtml(t("searchNoMatch", { q: query }))}</li>`;
    } else {
      for (const stop of body.results) ul.appendChild(stopRow(stop));
    }
    ul.classList.remove("hidden");
  } catch (e) {
    ul.classList.remove("hidden");
    ul.innerHTML = `<li class="empty">${escapeHtml(t("searchFailed", { msg: e.message }))}</li>`;
  }
}

function onSearchInput() {
  const query = $("#stop-search").value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runStopSearch(query), 300);
}

// Re-render all stop lists after a subscription change. The local payload
// may not contain the toggled stop (e.g. it was subscribed from search
// results), so re-fetch /api/stops, which always includes subscribed stops;
// re-run an active search so its rows' star icons refresh as well.
function refreshListsAfterToggle() {
  refreshStopList(lastLocation);
  if (lastSearchQuery.length >= 2) runStopSearch(lastSearchQuery);
}

// ---------------------------------------------------------------------------
// Stop detail (ETA) view
// ---------------------------------------------------------------------------

function showView(view) {
  $("#list-view").classList.toggle("hidden", view !== "list");
  $("#detail-view").classList.toggle("hidden", view !== "detail");
}

function updateDetailSubscribeBtn(stopId) {
  const btn = $("#detail-subscribe");
  const active = subscribed.has(stopId);
  btn.textContent = active ? "★" : "☆";
  btn.classList.toggle("active", active);
  btn.title = active ? "Unsubscribe 取消訂閱" : "Subscribe 訂閱";
}

function openStopDetail(stop) {
  showView("detail");
  const [primary, secondary] = pickName(stop.name_en, stop.name_tc);
  $("#detail-title").innerHTML =
    `<span class="name-primary">${escapeHtml(primary)}</span>` +
    (secondary ? `<span class="name-secondary">${escapeHtml(secondary)}</span>` : "");
  currentEtaStopId = stop.id;
  currentEtaGroupIds = stop.ids || [stop.id];
  updateDetailSubscribeBtn(stop.id);
  lastEtaBody = null;
  const status = $("#eta-status");
  status.className = "notice loading";
  status.textContent = t("loadingEta");
  $("#eta-list").innerHTML = "";
  $("#detail-updated").textContent = "";
  stopEtaPoll();
}

async function stopEtaPoll() {
  const status = $("#eta-status");
  try {
    const resp = await fetch(`/api/stops/${encodeURIComponent(currentEtaStopId)}/eta`);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.message || body.error || `HTTP ${resp.status}`);
    status.classList.add("hidden");
    lastEtaBody = body;
    renderEtaList(body);
  } catch (e) {
    status.className = "notice error";
    status.textContent = t("etaFailed", { msg: e.message });
  }
  etaPollTimer = setTimeout(stopEtaPoll, ETA_POLL_MS);
}

function renderEtaList(body) {
  $("#detail-updated").textContent =
    t("updated", { time: fmtClock(body.generated_timestamp) }) +
    (body.from_cache ? t("cache") : "");

  const list = $("#eta-list");
  list.innerHTML = "";

  const routes = body.routes || [];
  if (routes.length === 0) {
    list.innerHTML = `<p class="empty">${escapeHtml(t("noEta"))}</p>`;
    return;
  }

  for (const route of routes) {
    const card = document.createElement("div");
    card.className = "route-card";

    const [destPrimary, destSecondary] = pickName(route.dest_en, route.dest_tc);
    const head = document.createElement("div");
    head.className = "route-head";
    head.innerHTML = `
      <span class="route-badge">${escapeHtml(route.route)}</span>
      <span class="dest">
        <span class="name-primary">${escapeHtml(destPrimary)}</span>
        ${destSecondary ? `<span class="name-secondary">${escapeHtml(destSecondary)}</span>` : ""}
      </span>`;
    card.appendChild(head);

    const chips = document.createElement("div");
    chips.className = "eta-chips";
    for (const eta of route.etas) {
      const chip = document.createElement("span");
      const min = fmtEtaMinutes(eta.eta);
      if (min == null) {
        chip.className = "eta-chip remark";
        chip.textContent = pickRemark(eta.rmk_en, eta.rmk_tc) || t("noService");
      } else if (min === 0) {
        chip.className = "eta-chip due";
        chip.textContent = t("due");
      } else {
        chip.className = "eta-chip";
        chip.textContent = t("minutes", { n: min });
      }
      chip.title = eta.eta ? t("etaAt", { time: fmtClock(eta.eta) }) : "";
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    list.appendChild(card);
  }
}

function closeStopDetail() {
  if (etaPollTimer) {
    clearTimeout(etaPollTimer);
    etaPollTimer = null;
  }
  currentEtaStopId = null;
  showView("list");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  // Attach handlers before applyI18n(): an i18n/DOM error there must not
  // leave the app without its event listeners.
  $("#back-btn").addEventListener("click", closeStopDetail);
  $("#lang-toggle").addEventListener("click", toggleLang);
  $("#stop-search").addEventListener("input", onSearchInput);
  $("#detail-subscribe").addEventListener("click", () => {
    if (!currentEtaStopId) return;
    toggleSubscribed(currentEtaStopId, currentEtaGroupIds);
    updateDetailSubscribeBtn(currentEtaStopId);
    refreshListsAfterToggle();
  });
  applyI18n();
  loadStops();
});
