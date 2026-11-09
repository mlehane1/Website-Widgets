// F3 Locations Proxy — Netlify Serverless Function
// Works with Netlify Drop (no CLI or GitHub required)
//
// Returns a region's workout locations from the F3 Nation Map: name,
// address, latitude / longitude, the AOs and workouts that meet there, and
// ready-made links (F3 Map, Google Maps, Apple Maps, Waze, directions).
//
// A location on its own has no AO name — the F3 Nation /location list only
// knows the place. The /event list carries locationId + the AO (parentName),
// so we join the two by locationId.
//
// Query params:
//   regionOrgId  (required unless locationId) — the F3 Nation region ID
//   locationId   (optional) — return just this one location
//   ao           (optional) — case-insensitive filter on AO / workout /
//                             location name, e.g. ao=stampede
//   all          (optional) — 1 = include locations with no active workout
//                             (by default those are dropped: they are usually
//                             stale pins nobody cleaned up)
//   format       (optional) — 'geojson' returns a GeoJSON FeatureCollection
//                             for dropping straight into Leaflet / Mapbox
//   go           (optional) — map | google | apple | directions | waze.
//                             Instead of JSON, 302-redirects to that link for
//                             the FIRST matching location. Lets a region
//                             website link one AO straight to a map, e.g.
//                             ?regionOrgId=25250&ao=stampede&go=directions
//
// The token is optional for these endpoints today (the location and event
// lists answer without one), but if F3_BEARER_TOKEN is set we send it, so
// this keeps working if F3 Nation starts requiring auth.

const API = 'https://api.f3nation.com/v1';
const PAGE_SIZE = 100; // F3 Nation caps pageSize at 100 — larger is a 400
const MAX_ROWS = 2000;
const GO_TARGETS = ['map', 'google', 'apple', 'directions', 'waze'];

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const regionParam = (q.regionOrgId || '').trim();
  const locationParam = (q.locationId || '').trim();

  if (!regionParam && !locationParam) {
    return json(400, { error: 'regionOrgId (or locationId) parameter is required' });
  }
  if ((regionParam && !/^\d+$/.test(regionParam)) || (locationParam && !/^\d+$/.test(locationParam))) {
    return json(400, { error: 'regionOrgId and locationId must be numbers' });
  }

  const go = (q.go || '').trim().toLowerCase();
  if (go && !GO_TARGETS.includes(go)) {
    return json(400, { error: `go must be one of: ${GO_TARGETS.join(', ')}` });
  }

  const headers = { client: 'f3-locations-proxy' };
  if (process.env.F3_BEARER_TOKEN) headers.Authorization = `Bearer ${process.env.F3_BEARER_TOKEN}`;

  // --- pull data ----------------------------------------------------------
  let regionId = regionParam;
  let locations, events;
  try {
    // A bare locationId: find its region via the public map endpoint
    // (/location/id/{id} needs a token, /map/location/location-workout does
    // not), then take the same region-list path so the shape is identical.
    if (locationParam && !regionId) {
      const one = await fetchJson(`${API}/map/location/location-workout?locationId=${locationParam}`, headers);
      const rid = one && one.location && one.location.regionId;
      if (rid == null) return json(404, { error: `location ${locationParam} not found` });
      regionId = String(rid);
    }
    [locations, events] = await Promise.all([
      fetchAllPages(`${API}/location?regionIds=${regionId}`, headers, 'locations'),
      fetchAllPages(`${API}/event?regionIds=${regionId}`, headers, 'events'),
    ]);
    if (locationParam) {
      locations = locations.filter((l) => String(l.id) === locationParam);
      if (!locations.length) return json(404, { error: `location ${locationParam} not found in region ${regionId}` });
    }
  } catch (err) {
    return json(502, { error: 'Could not reach F3 Nation API: ' + err.message });
  }

  // --- join events onto their location ------------------------------------
  const byLocation = {};
  for (const e of events) {
    if (!e || !e.isActive || e.isPrivate || e.locationId == null) continue;
    (byLocation[e.locationId] = byLocation[e.locationId] || []).push(e);
  }

  const includeAll = q.all === '1' || q.all === 'true' || !!locationParam;
  const aoFilter = (q.ao || '').trim().toLowerCase();

  let rows = locations
    .filter((l) => l && l.isActive !== false)
    .map((l) => shapeLocation(l, byLocation[l.id] || []))
    .filter((r) => includeAll || r.workouts.length > 0)
    .filter((r) => includeAll || (r.latitude != null && r.longitude != null));

  if (aoFilter) {
    rows = rows.filter((r) =>
      [r.name, ...r.aos.map((a) => a.name), ...r.workouts.map((w) => w.name)]
        .some((s) => s && s.toLowerCase().includes(aoFilter))
    );
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  // --- output -------------------------------------------------------------
  if (go) {
    const hit = rows.find((r) => r.links[go]);
    if (!hit) return json(404, { error: 'No location matched', regionOrgId: regionId, ao: q.ao || null });
    return {
      statusCode: 302,
      headers: { Location: hit.links[go], 'Cache-Control': 'public, max-age=3600' },
      body: '',
    };
  }

  if ((q.format || '').toLowerCase() === 'geojson') {
    return json(200, {
      type: 'FeatureCollection',
      features: rows
        .filter((r) => r.latitude != null && r.longitude != null)
        .map((r) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.longitude, r.latitude] },
          properties: { ...r, latitude: undefined, longitude: undefined },
        })),
    }, 3600, 'application/geo+json');
  }

  return json(200, {
    regionOrgId: regionId || null,
    regionName: rows[0]?.regionName || locations[0]?.regionName || null,
    count: rows.length,
    locations: rows,
  }, 3600);
};

function shapeLocation(l, evs) {
  const lat = num(l.latitude);
  const lng = num(l.longitude);

  // AOs that meet here — de-duplicated by id
  const aoMap = {};
  for (const e of evs) {
    for (const p of e.parents || []) {
      if (p && p.parentId != null) aoMap[p.parentId] = { id: p.parentId, name: p.parentName || e.parent || '' };
    }
    if (!(e.parents || []).length && e.parent) aoMap['n:' + e.parent] = { id: null, name: e.parent };
  }
  const aos = Object.values(aoMap).sort((a, b) => a.name.localeCompare(b.name));

  const workouts = evs
    .map((e) => ({
      id: e.id,
      name: e.name,
      ao: (e.parents && e.parents[0] && e.parents[0].parentName) || e.parent || null,
      day: e.dayOfWeek || null,
      startTime: fmtTime(e.startTime),
      endTime: fmtTime(e.endTime),
      types: (e.eventTypes || []).map((t) => t.eventTypeName).filter(Boolean),
    }))
    .sort((a, b) => dayIdx(a.day) - dayIdx(b.day) || (a.startTime || '').localeCompare(b.startTime || ''));

  // Many locations have a blank locationName — the AO name is the useful label.
  const name = (l.locationName || '').trim() || aos.map((a) => a.name).join(' / ') || (l.description || '').trim() || `Location ${l.id}`;

  const address = [l.addressStreet, l.addressStreet2, l.addressCity, [l.addressState, l.addressZip].filter(Boolean).join(' ')]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(', ');

  return {
    id: l.id,
    name,
    description: l.description || null,
    regionId: l.regionId ?? null,
    regionName: l.regionName || null,
    latitude: lat,
    longitude: lng,
    address: address || null,
    aos,
    workouts,
    links: buildLinks(l.id, workouts[0]?.id, lat, lng, name),
  };
}

function buildLinks(locationId, eventId, lat, lng, name) {
  const f3 = `https://map.f3nation.com/?${eventId ? `eventId=${eventId}&` : ''}locationId=${locationId}`;
  if (lat == null || lng == null) return { map: f3 };
  const ll = `${lat},${lng}`;
  return {
    map: f3,
    google: `https://www.google.com/maps/search/?api=1&query=${ll}`,
    directions: `https://www.google.com/maps/dir/?api=1&destination=${ll}`,
    apple: `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent(name)}`,
    waze: `https://waze.com/ul?ll=${ll}&navigate=yes`,
  };
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
function dayIdx(d) {
  const i = DAYS.indexOf((d || '').toLowerCase());
  return i < 0 ? 99 : i;
}

// "0515" -> "05:15"
function fmtTime(t) {
  if (!t) return null;
  const s = String(t).replace(':', '');
  return /^\d{4}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2)}` : String(t);
}

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// pageIndex is zero-based. Pull pages until a short page, the reported
// totalCount, or MAX_ROWS — whichever is first.
async function fetchAllPages(url, headers, key) {
  const all = [];
  for (let pageIndex = 0; all.length < MAX_ROWS; pageIndex++) {
    const raw = await fetchJson(`${url}&pageSize=${PAGE_SIZE}&pageIndex=${pageIndex}`, headers);
    const page = (raw && raw[key]) || [];
    all.push(...page);
    const total = raw && Number.isFinite(raw.totalCount) ? raw.totalCount : null;
    if (page.length < PAGE_SIZE || (total != null && all.length >= total)) break;
  }
  return all;
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function json(statusCode, body, maxAge, contentType) {
  const headers = {
    'Content-Type': contentType || 'application/json',
    'Access-Control-Allow-Origin': '*',
  };
  if (maxAge) headers['Cache-Control'] = `public, max-age=${maxAge}`;
  return { statusCode, headers, body: JSON.stringify(body) };
}
