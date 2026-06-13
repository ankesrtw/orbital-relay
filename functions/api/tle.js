// Cloudflare Pages Function — Orbital Relay TLE proxy.
//
//   GET /api/tle?source=celestrak&group=<group>
//
// Celestrak sends no CORS header, so the browser can't fetch it directly; this
// runs server-side (no CORS) and caches each group via the Cloudflare Cache API
// (~6h). On a throttle/empty upstream it falls back to the shipped baseline file
// under /data/tle/<source>/<group>.txt, so the page never goes blank.
//
// source=spacetrack is Phase 2 (scheduled R2 snapshot) — returns 501 for now.

const ALLOWED_GROUPS = new Set([
  'stations', 'starlink', 'gps-ops', 'glo-ops', 'galileo', 'beidou',
  'qianfan', 'hulianwang', 'irnss', 'iridium-next', 'weather', 'geo',
  'resource', 'last-30-days', 'oneweb', 'sbas',
  'cosmos-2251-debris', 'cosmos-1408-debris', 'fengyun-1c-debris',
  'iridium-33-debris',
]);

const CACHE_TTL = 21600; // 6h

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function text(status, body, cache) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    ...CORS,
  };
  if (cache) headers['Cache-Control'] = `public, max-age=${CACHE_TTL}`;
  return new Response(body, { status, headers });
}

function looksInvalid(t) {
  return !t || t.startsWith('GP data has not updated') ||
         t.includes('Invalid query') || t.trim().length < 10;
}

export async function onRequest(context) {
  const { request, next } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || 'celestrak').toLowerCase();
  const group = (url.searchParams.get('group') || '').trim();

  if (!ALLOWED_GROUPS.has(group.toLowerCase())) {
    return text(400, 'Unknown or unsupported group.');
  }

  if (source === 'spacetrack') {
    // Phase 2: read from R2 snapshot. Not yet wired.
    return text(501, 'Space-Track source not yet available.');
  }
  if (source !== 'celestrak') {
    return text(400, 'Unknown source.');
  }

  // Serve from edge cache when warm.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Live fetch from Celestrak (server-side, no CORS).
  let body = '';
  try {
    const upstream = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=TLE`;
    const r = await fetch(upstream, {
      headers: { 'User-Agent': 'orbital-relay-tracker/1.0' },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
    body = await r.text();
  } catch (_) {
    body = '';
  }

  // Fall back to the shipped baseline file if upstream throttled/empty.
  if (looksInvalid(body)) {
    try {
      const assetUrl = new URL(`/data/tle/celestrak/${group}.txt`, url.origin);
      const assetResp = await next(new Request(assetUrl));
      if (assetResp.ok) {
        const baseline = await assetResp.text();
        if (!looksInvalid(baseline)) return text(200, baseline, false);
      }
    } catch (_) { /* ignore */ }
    return text(502, 'Upstream returned no TLE data and no baseline available.');
  }

  const resp = text(200, body, true);
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}
