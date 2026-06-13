# 🛰️ Orbital Relay

A live, cinematic **3D satellite tracker** in the browser. Real orbital mechanics,
real TLE data, a spinning Earth — no account, no build step, no backend of your own.

Track the **ISS**, **Starlink**, **GPS / GLONASS / Galileo / BeiDou / NavIC**,
geostationary belts, weather sats, debris fields and more — propagated from live
[Celestrak](https://celestrak.org) two-line element sets and rendered on a
[CesiumJS](https://cesium.com/platform/cesiumjs/) globe.

> Clone it, open it, tinker. It's plain HTML + JavaScript.

---

## ✨ Features

- **Live orbit propagation** — every satellite's position is computed in-browser
  from its TLE using [satellite.js](https://github.com/shashwatak/satellite-js).
- **ISS telemetry HUD** — live lat/lon, altitude, velocity, UTC clock.
- **Constellation layers** — toggle USA / Russia / EU / China / India / international
  groups on and off, grouped by operator.
- **Starlink density control** — start with 40 sats, slide up, or **fetch the full
  live constellation** (thousands) on demand.
- **Click-to-inspect** — click any satellite to pin a detail card (group, position,
  velocity, orbital period, LEO/MEO/GEO regime) and draw its full orbit.
- **Ground tracks & coverage footprints** — subsatellite path + horizon circle.
- **Day/night terminator** — real-time sun lighting on the globe.
- **Time-warp** — pause, 1×, 60×, 600× to watch orbits evolve.
- **Fly-to cinematics** — camera frames a constellation when you enable it.
- **Mobile-friendly** — collapsible HUD panels that never cover the globe.

---

## 🗂️ Project structure

```
public/                     ← static site (served as the web root)
  index.html                  the page
  orbital-relay.js            all the logic (orbit math, rendering, UI)
  orbit.css                   styling
  vendor/satellite.min.js     TLE propagation library (self-hosted)
  data/tle/celestrak/*.txt    baseline TLE snapshots (offline fallback)
  icon.svg, _headers          favicon + cache headers
functions/
  api/tle.js                  Cloudflare Pages Function: live TLE proxy + cache
```

### How the data flows

1. The page asks for a satellite group (e.g. `starlink`).
2. It first loads a **baseline snapshot** from `public/data/tle/` so something
   shows instantly even offline.
3. For live/fresh data it calls **`/api/tle`**, a tiny serverless function that
   proxies [Celestrak](https://celestrak.org) (which sends no CORS headers, so the
   browser can't fetch it directly) and edge-caches the result for ~6 hours.
4. satellite.js propagates each TLE; CesiumJS renders the dots and orbits.

**There is no database and no private backend.** The only "server" is the small
read-only TLE proxy, and even that is optional — without it the app falls back to
the shipped baseline snapshots.

---

## 🚀 Run it locally

You need [Node.js](https://nodejs.org) (18+). Then, from the repo root:

```bash
# Serves public/ AND wires up the /api/tle function locally
npx wrangler pages dev public
```

Open the URL it prints (usually <http://localhost:8788>).

> `npx` downloads Wrangler on demand — nothing to install globally.

### Even simpler (no live proxy)

If you just want to poke at the front-end and don't care about live refresh, any
static server works — the app falls back to the baseline TLE files:

```bash
npx serve public        # or: python3 -m http.server -d public 8000
```

The "FETCH FULL CONSTELLATION" / live-refresh buttons won't work without the
`/api/tle` function, but everything else does.

---

## ☁️ Deploy to Cloudflare Pages (recommended)

The `/api/tle` function is written for **Cloudflare Pages Functions**, so Cloudflare
is the zero-config home for this project.

**Option A — Git integration (auto-deploy on push):**

1. Push this repo to any Git host (GitHub, Codeberg, GitLab, etc.).
2. In the [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages**
   → **Create** → **Pages** → **Connect to Git**, pick this repo.
3. Build settings:
   - **Framework preset:** `None`
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
4. Deploy. Every push redeploys; the `functions/` folder is picked up automatically.

**Option B — Direct upload from the CLI:**

```bash
npx wrangler pages deploy public
```

> No Cloudflare-specific secrets are required. The CesiumJS globe imagery uses a
> public [Cesium Ion](https://cesium.com/ion/) token already embedded in the code;
> swap in your own free token in `public/orbital-relay.js` if you prefer.

### Other hosts

The static site runs anywhere (GitHub Pages, Netlify, Vercel, any static host).
Only the live `/api/tle` proxy is Cloudflare-specific — on other platforms either
port that one function to their format, or rely on the baseline snapshots.

---

## 🛠️ Tinkering ideas

- Add a constellation: drop a baseline `.txt` in `data/tle/celestrak/`, add the
  group to `ALLOWED_GROUPS` in `functions/api/tle.js`, and add a layer row in
  `index.html`. Celestrak group names are listed at
  <https://celestrak.org/NORAD/elements/>.
- Refresh the baseline snapshots: `curl` a Celestrak `GROUP=...&FORMAT=TLE` URL
  into the matching file.
- Tweak colors, point sizes, pulse FX, and camera moves in `orbital-relay.js`.

---

## 📜 Credits & data

- Orbital data © [Celestrak](https://celestrak.org) (Dr. T.S. Kelso).
- Propagation: [satellite.js](https://github.com/shashwatak/satellite-js) (MIT).
- Globe: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache-2.0).

## License

MIT — see [LICENSE](LICENSE). Do whatever you like; attribution appreciated.
