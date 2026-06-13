/**
 * ORBITAL RELAY
 * CesiumJS 3D globe with real satellite orbits + live tracking.
 * Data: Celestrak TLE (STATIONS + STARLINK + constellation groups).
 *
 * Architecture:
 *  - Each satellite's position is a Cesium CallbackProperty that propagates the
 *    TLE off the *Cesium clock* time. This means a single clock multiplier
 *    drives every satellite — enabling time-warp (pause / 60× / 600×) and
 *    smooth motion at any speed with no per-satellite timers.
 *  - Satellites carry metadata (name, group, satrec) for click-to-inspect.
 *  - Inspector draws full orbit + ground track + coverage footprint on demand.
 *  - Day/night terminator via Cesium dynamic lighting + sun position.
 *
 * Features: time-warp, click-to-inspect, ground tracks, coverage footprints,
 * animated orbit trails, constellation pulse FX, fly-to cinematics,
 * Starlink fetch-full-constellation.
 */

/* ── Token + constants ─────────────────────────────────────────────────── */
Cesium.Ion.defaultAccessToken =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJqdGkiOiI2MjFjZDg5My0zMTRiLTQ3ZjMtOTNlNi1iM2E3ZGNjYWE5ZTQiLCJpZCI6MzkzOTM1LCJpYXQiOjE3NzE5Nzk4NTd9.' +
    'eAH51ApKzzuBIkgwf-rqo4G2U6cSBOQMTPFAALBb2Hg';

const TLE_ENDPOINT    = '/api/tle';            // Pages Function: live proxy + edge cache
const TLE_FILE_BASE   = '/data/tle';           // shipped baseline snapshots
const SAT_CAP_DEFAULT = 40;                     // Starlink shown on load
const SAT_CAP_MAX     = 600;                    // baseline slider maximum
const SAT_CAP_FULL    = 8000;                   // hard ceiling for "fetch all"
const EARTH_R_KM      = 6371;
const GM_EARTH        = 398600.4418;            // km^3/s^2

// Starlink state — all parsed records + spawned Cesium entities
const slAllRecords  = [];
const slEntities    = [];
let   slActiveCount = SAT_CAP_DEFAULT;
let   slFullLoaded  = false;

const _intervals = [];

let activeSource = localStorage.getItem('orbit-source') || 'celestrak';

/* ── HUD toggle helper ─────────────────────────────────────────────────── */
const _hudPanels = [];

function wireHudToggle(hudId, toggleId, bodyId) {
    const hud    = document.getElementById(hudId);
    const toggle = document.getElementById(toggleId);
    const body   = document.getElementById(bodyId);
    if (!hud || !toggle || !body) return;
    _hudPanels.push(hud);
    toggle.addEventListener('click', () => {
        const willExpand = hud.classList.contains('key-hud--collapsed');
        const isMobile   = window.matchMedia('(max-width: 600px)').matches;
        // On narrow screens keep only one panel expanded so cards don't overlap.
        if (willExpand && isMobile) {
            _hudPanels.forEach(p => {
                if (p !== hud) {
                    p.classList.add('key-hud--collapsed');
                    const b = p.querySelector('.key-hud-body');
                    const t = p.querySelector('.key-hud-toggle');
                    if (b) b.hidden = true;
                    if (t) t.setAttribute('aria-expanded', 'false');
                }
            });
        }
        const collapsed = hud.classList.toggle('key-hud--collapsed');
        body.hidden     = collapsed;
        toggle.setAttribute('aria-expanded', String(!collapsed));
        // Mobile: while one panel is open, hide the OTHER collapsed chips so an
        // expanded panel can never cover (and block taps on) another chip.
        document.body.classList.toggle('hud-panel-open', !collapsed && isMobile);
    });
}

wireHudToggle('iss-hud',      'iss-hud-toggle',      'iss-hud-body');
wireHudToggle('starlink-hud', 'starlink-hud-toggle', 'starlink-hud-body');
wireHudToggle('layers-hud',   'layers-hud-toggle',   'layers-hud-body');

/* ── Cesium Viewer ─────────────────────────────────────────────────────── */
const viewer = new Cesium.Viewer('cesium-container', {
    animation:             false,
    baseLayerPicker:       false,
    fullscreenButton:      false,
    geocoder:              false,
    homeButton:            false,
    infoBox:               false,
    sceneModePicker:       false,
    selectionIndicator:    false,
    timeline:              false,
    navigationHelpButton:  false,
    shouldAnimate:         true,
});

// Expose the viewer for console debugging / inspection.
window.viewer = viewer;

// Space atmosphere + day/night terminator (dynamic lighting follows the sun)
viewer.scene.globe.enableLighting          = true;
viewer.scene.globe.dynamicAtmosphereLighting = true;
viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;
viewer.scene.skyAtmosphere.show            = true;
viewer.scene.skyAtmosphere.hueShift        = 0.0;
viewer.scene.skyAtmosphere.saturationShift = -0.1;
viewer.scene.skyAtmosphere.brightnessShift = -0.1;
// Slight night-side dimming so the terminator reads clearly
viewer.scene.globe.nightFadeOutDistance = 1.0e7;
viewer.scene.globe.nightFadeInDistance  = 5.0e7;

viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
    Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
);

// Initial camera (a cinematic fly-in animates from here on boot)
viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(20, 25, 40000000),
});

/* ── Cesium clock helpers (the single time source for all sats) ─────────── */
const clock = viewer.clock;
clock.shouldAnimate = true;
clock.multiplier    = 1;

function clockDate() {
    return Cesium.JulianDate.toDate(clock.currentTime);
}

/* ── Propagation helpers ───────────────────────────────────────────────── */
function getSatGeo(satrec, date) {
    const t  = date || clockDate();
    const pv = satellite.propagate(satrec, t);
    if (!pv || !pv.position) return null;
    const gmst = satellite.gstime(t);
    const geo  = satellite.eciToGeodetic(pv.position, gmst);
    return {
        lat: satellite.degreesLat(geo.latitude),
        lon: satellite.degreesLong(geo.longitude),
        alt: geo.height, // km
    };
}

function orbitalPeriodMin(satrec) {
    return (2 * Math.PI) / satrec.no;
}

function orbitRegime(altKm) {
    if (altKm < 2000)   return 'LEO';
    if (altKm < 35000)  return 'MEO';
    if (altKm < 37000)  return 'GEO';
    return 'HEO';
}

function computeOrbitPath(satrec, steps) {
    const period = orbitalPeriodMin(satrec);
    steps = steps || 90;
    const now = clockDate();
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t  = new Date(now.getTime() + (i / steps) * period * 60000);
        const pv = satellite.propagate(satrec, t);
        if (!pv || !pv.position) continue;
        const gmst = satellite.gstime(t);
        const geo  = satellite.eciToGeodetic(pv.position, gmst);
        pts.push(Cesium.Cartesian3.fromDegrees(
            satellite.degreesLong(geo.longitude),
            satellite.degreesLat(geo.latitude),
            geo.height * 1000
        ));
    }
    return pts;
}

// Ground track: subsatellite path clamped to the surface (one full period).
function computeGroundTrack(satrec, steps) {
    const period = orbitalPeriodMin(satrec);
    steps = steps || 120;
    const now = clockDate();
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t  = new Date(now.getTime() + (i / steps) * period * 60000);
        const pv = satellite.propagate(satrec, t);
        if (!pv || !pv.position) continue;
        const gmst = satellite.gstime(t);
        const geo  = satellite.eciToGeodetic(pv.position, gmst);
        pts.push(Cesium.Cartesian3.fromDegrees(
            satellite.degreesLong(geo.longitude),
            satellite.degreesLat(geo.latitude),
            0
        ));
    }
    return pts;
}

// Coverage footprint radius (metres) — horizon circle for a sat at altKm.
function footprintRadiusM(altKm) {
    // central angle of the visible horizon: acos(R / (R + h))
    const ratio = EARTH_R_KM / (EARTH_R_KM + altKm);
    const theta = Math.acos(Math.min(1, Math.max(-1, ratio)));
    return theta * EARTH_R_KM * 1000; // arc length on the surface, metres
}

// Wrap an expensive position-array producer so it only recomputes every
// `ms` of wall time. Orbit/ground-track polylines (esp. clamp-to-ground) are
// far too costly to rebuild every frame; the path barely moves between ticks.
function throttledPath(fn, ms) {
    let cache = null, last = 0;
    return () => {
        const now = performance.now();
        if (!cache || now - last > ms) { cache = fn(); last = now; }
        return cache;
    };
}

function parseTLE(text) {
    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const sats  = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i];
        const l1   = lines[i + 1];
        const l2   = lines[i + 2];
        if (l1.startsWith('1') && l2.startsWith('2')) {
            try { sats.push({ name, satrec: satellite.twoline2satrec(l1, l2) }); }
            catch (_) { /* skip malformed TLE */ }
        }
    }
    return sats;
}

function tleLooksValid(t) {
    return t && !t.includes('No GP data') && !t.includes('Invalid query') &&
           !t.startsWith('GP data has not updated') && t.trim().length >= 10;
}

async function fetchTLE(group, live) {
    const src     = activeSource;
    const slug    = group.toLowerCase();
    const fileUrl = `${TLE_FILE_BASE}/${src}/${slug}.txt`;
    const apiUrl  = `${TLE_ENDPOINT}?source=${encodeURIComponent(src)}&group=${encodeURIComponent(group)}`;
    const order   = live ? [apiUrl, fileUrl] : [fileUrl, apiUrl];

    for (const url of order) {
        try {
            const r = await fetch(url);
            if (!r.ok) continue;
            const t = await r.text();
            if (tleLooksValid(t)) return t;
        } catch (_) { /* try next */ }
    }
    return '';
}

/* ── Add a satellite to the scene ──────────────────────────────────────── */
// Registry mapping Cesium point entity → { satrec, name, group } for clicks.
const satMeta = new WeakMap();

function makeCallbackPosition(satrec) {
    // Position evaluated from the Cesium clock — drives time-warp + pause for free.
    return new Cesium.CallbackProperty(() => {
        const p = getSatGeo(satrec, clockDate());
        if (!p) return undefined;
        return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt * 1000);
    }, false);
}

function addSatellite(satrec, color, pointSize, orbitStyle, meta) {
    if (orbitStyle) {
        const pts = computeOrbitPath(satrec);
        if (pts.length > 1) {
            viewer.entities.add({
                polyline: {
                    positions: pts,
                    width:     orbitStyle === 'bright' ? 1.4 : 0.7,
                    material:  new Cesium.PolylineGlowMaterialProperty({
                        glowPower: orbitStyle === 'bright' ? 0.35 : 0.12,
                        color:     color.withAlpha(orbitStyle === 'bright' ? 0.6 : 0.2),
                    }),
                    arcType: Cesium.ArcType.NONE,
                },
            });
        }
    }

    const pointOpts = {
        pixelSize:                pointSize,
        color:                    color,
        outlineColor:             Cesium.Color.BLACK.withAlpha(0.4),
        outlineWidth:             pointSize > 7 ? 1.5 : 0,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance:          new Cesium.NearFarScalar(1e6, 1.2, 2e7, 0.6),
    };

    // Constellation pulse FX — animate point size/translucency on a sine wave.
    if (meta && meta.pulse) {
        const base  = pointSize;
        const phase = Math.random() * Math.PI * 2;
        pointOpts.pixelSize = new Cesium.CallbackProperty(() => {
            const t = Date.now() / 1000;
            return base + Math.sin(t * 2 + phase) * (base * 0.35);
        }, false);
    }

    const entity = viewer.entities.add({
        position: makeCallbackPosition(satrec),
        point:    pointOpts,
    });
    satMeta.set(entity, meta || { satrec, name: 'SAT', group: '' });
    return entity;
}

/* ── HUD update ────────────────────────────────────────────────────────── */
const elLat   = document.getElementById('hud-iss-lat');
const elLon   = document.getElementById('hud-iss-lon');
const elAlt   = document.getElementById('hud-iss-alt');
const elVel   = document.getElementById('hud-iss-vel');
const elCount = document.getElementById('hud-sat-count');
const elDate  = document.getElementById('hud-date');
const elTime  = document.getElementById('hud-time');

let issRec = null;

function fmtLat(lat) { return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`; }
function fmtLon(lon) { return `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`; }
function orbVel(altKm) { return Math.sqrt(GM_EARTH / (EARTH_R_KM + altKm)); }

function updateISSHud() {
    if (!issRec) return;
    const p = getSatGeo(issRec);
    if (!p) return;
    if (elLat) elLat.textContent = fmtLat(p.lat);
    if (elLon) elLon.textContent = fmtLon(p.lon);
    if (elAlt) elAlt.textContent = `${Math.round(p.alt)} km`;
    if (elVel) elVel.textContent = `${orbVel(p.alt).toFixed(2)} km/s`;
}
_intervals.push(setInterval(updateISSHud, 1000));

/* ── UTC clock (shows the simulated time so time-warp is legible) ──────── */
function updateClock() {
    const now = clockDate();
    const pad = n => String(n).padStart(2, '0');
    const d = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    const t = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    if (elDate) elDate.textContent = d;
    if (elTime) elTime.textContent = t + ' UTC';
}
_intervals.push(setInterval(updateClock, 250));

window.addEventListener('beforeunload', () => {
    _intervals.forEach(id => clearInterval(id));
});

/* ── Loading state ─────────────────────────────────────────────────────── */
function setLoadingState(active) {
    if (elCount && active) elCount.textContent = 'INITIALIZING RELAY…';
}

/* ── Layer registries + sat count bar ──────────────────────────────────── */
const stationEntities = [];
let layerCount = 0;

function updateSatBar() {
    const stVis = stationEntities.filter(e => e.show).length;
    const slVis = slEntities.filter(e => e.show).length;
    if (elCount) elCount.textContent = 1 + stVis + slVis + layerCount;
}

/* ── Starlink panel: slider + fetch-all ────────────────────────────────── */
const slSlider       = document.getElementById('sl-slider');
const slCountDisplay = document.getElementById('sl-count-display');
const slTotalDisplay = document.getElementById('sl-total-display');
const slLabelMax     = document.getElementById('sl-label-max');
const slControls     = document.getElementById('starlink-controls');
const slStatusEl     = document.getElementById('layer-status-starlink');
const stStatusEl     = document.getElementById('layer-status-stations-other');
const slFetchAllBtn  = document.getElementById('sl-fetch-all');
const slFetchHint    = document.getElementById('sl-fetch-hint');

const slColor = Cesium.Color.fromCssColorString('#00ccff');

function spawnStarlink(i) {
    const rec = slAllRecords[i];
    return addSatellite(rec.satrec, slColor, 4, false,
        { satrec: rec.satrec, name: rec.name, group: 'STARLINK', pulse: false });
}

function updateStarlinkCount(n) {
    slActiveCount = Math.max(SAT_CAP_DEFAULT, Math.min(n, slAllRecords.length));

    for (let i = slEntities.length; i < slActiveCount; i++) {
        slEntities.push(spawnStarlink(i));
    }
    for (let i = 0; i < slEntities.length; i++) {
        slEntities[i].show = i < slActiveCount;
    }

    if (slCountDisplay) slCountDisplay.textContent = slActiveCount;
    if (slStatusEl)     slStatusEl.textContent     = slActiveCount;
    updateSatBar();
}

if (slSlider) {
    slSlider.addEventListener('input', () => {
        updateStarlinkCount(parseInt(slSlider.value, 10));
    });
}

// Fetch the full live constellation from the proxy, then open up the slider.
if (slFetchAllBtn) {
    slFetchAllBtn.addEventListener('click', async () => {
        if (slFullLoaded || slFetchAllBtn.disabled) return;
        slFetchAllBtn.disabled = true;
        slFetchAllBtn.textContent = '… FETCHING LIVE …';
        try {
            const text   = await fetchTLE('STARLINK', true); // live=true → proxy first
            const parsed = parseTLE(text).slice(0, SAT_CAP_FULL);
            if (parsed.length > slAllRecords.length) {
                // Append only the new records beyond the baseline batch.
                for (let i = slAllRecords.length; i < parsed.length; i++) {
                    slAllRecords.push(parsed[i]);
                }
            }
            slFullLoaded = true;
            if (slSlider)       slSlider.max = slAllRecords.length;
            if (slLabelMax)     slLabelMax.textContent = slAllRecords.length;
            if (slTotalDisplay) slTotalDisplay.textContent = slAllRecords.length;
            slFetchAllBtn.textContent = `✓ ${slAllRecords.length} LOADED`;
            slFetchAllBtn.classList.add('is-loaded');
            if (slFetchHint) slFetchHint.textContent = 'slide right to render more';
        } catch (err) {
            console.warn('[orbital-relay] fetch-all failed:', err);
            slFetchAllBtn.disabled = false;
            slFetchAllBtn.textContent = '⬇ RETRY FETCH';
            if (slFetchHint) slFetchHint.textContent = 'fetch failed — try again';
        }
    });
}

/* ── Load TLE data ─────────────────────────────────────────────────────── */
async function loadSatellites() {
    setLoadingState(true);

    const [stResult, slResult] = await Promise.allSettled([
        fetchTLE('STATIONS'),
        fetchTLE('STARLINK'),
    ]);

    if (stResult.status === 'fulfilled') {
        const stations = parseTLE(stResult.value);
        const issEntry = stations.find(s =>
            s.name.toUpperCase().includes('ISS') || s.name.toUpperCase().includes('ZARYA')
        );
        if (issEntry) {
            issRec = issEntry.satrec;
            issEntity = addSatellite(issRec, Cesium.Color.fromCssColorString('#f5a623'), 11, 'bright',
                { satrec: issRec, name: issEntry.name, group: 'ISS', pulse: true });
            // ISS gets a persistent ground track + coverage footprint
            addGroundTrack(issRec, '#f5a623');
            addFootprint(issRec, '#f5a623');
        }
        stations
            .filter(s => s !== issEntry)
            .forEach(s => {
                const e = addSatellite(s.satrec, Cesium.Color.fromCssColorString('#ff8c69'), 7, true,
                    { satrec: s.satrec, name: s.name, group: 'STATIONS' });
                e.show = false;
                stationEntities.push(e);
            });
        if (stStatusEl) stStatusEl.textContent = '';
    } else {
        console.warn('[orbital-relay] STATIONS fetch failed:', stResult.reason);
    }

    if (slResult.status === 'fulfilled') {
        const parsed = parseTLE(slResult.value).slice(0, SAT_CAP_MAX);
        slAllRecords.push(...parsed);
        if (slSlider)       slSlider.max = slAllRecords.length;
        if (slLabelMax)     slLabelMax.textContent = slAllRecords.length;
        if (slTotalDisplay) slTotalDisplay.textContent = slAllRecords.length;
        for (let i = 0; i < SAT_CAP_DEFAULT && i < slAllRecords.length; i++) {
            const e = spawnStarlink(i);
            e.show = false;
            slEntities.push(e);
        }
        slActiveCount = SAT_CAP_DEFAULT;
    } else {
        console.warn('[orbital-relay] STARLINK fetch failed:', slResult.reason);
    }

    updateSatBar();
    introFlyIn();
}

/* ── ISS persistent visuals: ground track + coverage footprint ─────────── */
let issEntity = null;

function addGroundTrack(satrec, cssColor) {
    const color = Cesium.Color.fromCssColorString(cssColor);
    viewer.entities.add({
        polyline: {
            positions: new Cesium.CallbackProperty(
                throttledPath(() => computeGroundTrack(satrec), 2000), false),
            width:     1.6,
            material:  new Cesium.PolylineDashMaterialProperty({
                color: color.withAlpha(0.55),
                dashLength: 12,
            }),
            clampToGround: true,
        },
    });
}

function addFootprint(satrec, cssColor) {
    const color = Cesium.Color.fromCssColorString(cssColor);
    viewer.entities.add({
        position: new Cesium.CallbackProperty(() => {
            const p = getSatGeo(satrec);
            if (!p) return undefined;
            return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0);
        }, false),
        ellipse: {
            semiMajorAxis: new Cesium.CallbackProperty(() => {
                const p = getSatGeo(satrec);
                return p ? footprintRadiusM(p.alt) : 0;
            }, false),
            semiMinorAxis: new Cesium.CallbackProperty(() => {
                const p = getSatGeo(satrec);
                return p ? footprintRadiusM(p.alt) : 0;
            }, false),
            material: color.withAlpha(0.07),
            outline: true,
            outlineColor: color.withAlpha(0.45),
            outlineWidth: 1.2,
            height: 0,
        },
    });
}

/* ── Click-to-inspect ──────────────────────────────────────────────────── */
const detailCard   = document.getElementById('sat-detail');
const dName        = document.getElementById('sat-detail-name');
const dGroup       = document.getElementById('sat-detail-group');
const dLat         = document.getElementById('sat-detail-lat');
const dLon         = document.getElementById('sat-detail-lon');
const dAlt         = document.getElementById('sat-detail-alt');
const dVel         = document.getElementById('sat-detail-vel');
const dPeriod      = document.getElementById('sat-detail-period');
const dRegime      = document.getElementById('sat-detail-regime');
const detailClose  = document.getElementById('sat-detail-close');

let inspectedSatrec   = null;
let inspectOrbitEnt   = null;
let inspectTrackEnt   = null;
let inspectFootEnt    = null;
let inspectUpdateTimer = null;

function clearInspectVisuals() {
    [inspectOrbitEnt, inspectTrackEnt, inspectFootEnt].forEach(e => {
        if (e) viewer.entities.remove(e);
    });
    inspectOrbitEnt = inspectTrackEnt = inspectFootEnt = null;
}

function closeInspector() {
    inspectedSatrec = null;
    clearInspectVisuals();
    if (inspectUpdateTimer) { clearInterval(inspectUpdateTimer); inspectUpdateTimer = null; }
    if (detailCard) detailCard.hidden = true;
}

function inspectSatellite(meta) {
    if (!meta || !meta.satrec) return;
    inspectedSatrec = meta.satrec;
    clearInspectVisuals();

    const accent = Cesium.Color.fromCssColorString('#ffffff');

    // Full orbit (static positions, refreshed periodically)
    inspectOrbitEnt = viewer.entities.add({
        polyline: {
            positions: new Cesium.CallbackProperty(
                throttledPath(() => computeOrbitPath(meta.satrec, 120), 2000), false),
            width: 1.6,
            material: new Cesium.PolylineGlowMaterialProperty({
                glowPower: 0.25, color: accent.withAlpha(0.55),
            }),
            arcType: Cesium.ArcType.NONE,
        },
    });
    inspectTrackEnt = viewer.entities.add({
        polyline: {
            positions: new Cesium.CallbackProperty(
                throttledPath(() => computeGroundTrack(meta.satrec), 2000), false),
            width: 1.4,
            material: new Cesium.PolylineDashMaterialProperty({ color: accent.withAlpha(0.4) }),
            clampToGround: true,
        },
    });
    inspectFootEnt = viewer.entities.add({
        position: new Cesium.CallbackProperty(() => {
            const p = getSatGeo(meta.satrec);
            return p ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0) : undefined;
        }, false),
        ellipse: {
            semiMajorAxis: new Cesium.CallbackProperty(() => {
                const p = getSatGeo(meta.satrec); return p ? footprintRadiusM(p.alt) : 0;
            }, false),
            semiMinorAxis: new Cesium.CallbackProperty(() => {
                const p = getSatGeo(meta.satrec); return p ? footprintRadiusM(p.alt) : 0;
            }, false),
            material: accent.withAlpha(0.06),
            outline: true, outlineColor: accent.withAlpha(0.4), outlineWidth: 1, height: 0,
        },
    });

    // Populate + live-update the card
    if (dName)  dName.textContent  = `// ${meta.name}`;
    if (dGroup) dGroup.textContent = meta.group || '—';
    function refresh() {
        const p = getSatGeo(meta.satrec);
        if (!p) return;
        if (dLat)    dLat.textContent    = fmtLat(p.lat);
        if (dLon)    dLon.textContent    = fmtLon(p.lon);
        if (dAlt)    dAlt.textContent    = `${Math.round(p.alt)} km`;
        if (dVel)    dVel.textContent    = `${orbVel(p.alt).toFixed(2)} km/s`;
        if (dPeriod) dPeriod.textContent = `${orbitalPeriodMin(meta.satrec).toFixed(1)} min`;
        if (dRegime) dRegime.textContent = orbitRegime(p.alt);
    }
    refresh();
    if (inspectUpdateTimer) clearInterval(inspectUpdateTimer);
    inspectUpdateTimer = setInterval(refresh, 1000);
    _intervals.push(inspectUpdateTimer);
    if (detailCard) detailCard.hidden = false;
}

if (detailClose) detailClose.addEventListener('click', closeInspector);

// Pick handler — click a satellite dot to inspect it.
const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (picked && picked.id && satMeta.has(picked.id)) {
        inspectSatellite(satMeta.get(picked.id));
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

/* ── Time-warp controls ────────────────────────────────────────────────── */
document.querySelectorAll('.tw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const rate = parseInt(btn.dataset.rate, 10);
        if (rate === 0) {
            clock.shouldAnimate = false;
        } else {
            clock.shouldAnimate = true;
            clock.multiplier    = rate;
        }
        document.querySelectorAll('.tw-btn').forEach(b =>
            b.classList.toggle('tw-btn--active', b === btn));
    });
});

/* ── Fly-to cinematics ─────────────────────────────────────────────────── */
function introFlyIn() {
    // Smooth descent from the wide boot view to the working altitude.
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(20, 25, 22000000),
        duration: 2.6,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
}

// Fly the camera to frame a constellation's spawned entities.
function flyToEntities(entities) {
    const visible = entities.filter(e => e.show !== false);
    if (!visible.length) return;
    viewer.flyTo(visible, {
        duration: 1.8,
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), 0),
    }).catch(() => { /* fly interrupted — ignore */ });
}

/* ── Constellation Layers ──────────────────────────────────────────────── */
const layerState = {};

function recalcLayerCount() {
    layerCount = Object.values(layerState)
        .reduce((sum, s) => sum + s.entities.filter(e => e.show).length, 0);
}

async function toggleLayer(group, color, cap, checked, live) {
    const statusEl = document.getElementById(`layer-status-${group}`);

    if (!checked) {
        const state = layerState[group];
        if (state) {
            state.entities.forEach(e => { e.show = false; });
            recalcLayerCount();
            updateSatBar();
        }
        if (statusEl) statusEl.textContent = '';
        return;
    }

    const state = layerState[group];
    if (state && state.loaded) {
        state.entities.forEach(e => { e.show = true; });
        recalcLayerCount();
        updateSatBar();
        if (statusEl) statusEl.textContent = `${state.entities.length}`;
        flyToEntities(state.entities);
        return;
    }
    if (state && state.fetching) return;

    layerState[group] = { entities: [], loaded: false, fetching: true };
    if (statusEl) statusEl.textContent = '…';

    try {
        const text     = await fetchTLE(group, live);
        const records  = parseTLE(text).slice(0, cap);
        const cesColor = Cesium.Color.fromCssColorString(color);
        const entities = records.map(r =>
            addSatellite(r.satrec, cesColor, 5, false,
                { satrec: r.satrec, name: r.name, group: group.toUpperCase(), pulse: true })
        );
        layerState[group] = { entities, loaded: true, fetching: false };
        recalcLayerCount();
        updateSatBar();
        if (statusEl) statusEl.textContent = `${entities.length}`;
        flyToEntities(entities);
    } catch (err) {
        console.warn(`[orbital-relay] Layer "${group}" fetch failed:`, err);
        layerState[group] = { entities: [], loaded: false, fetching: false };
        if (statusEl) statusEl.textContent = 'ERR';
    }
}

document.querySelectorAll('.layer-cb').forEach(cb => {
    cb.addEventListener('change', () => {
        const group   = cb.dataset.group;
        const builtin = cb.dataset.builtin === 'true';

        if (builtin) {
            if (group === 'stations-other') {
                stationEntities.forEach(e => { e.show = cb.checked; });
                if (stStatusEl) stStatusEl.textContent = cb.checked ? stationEntities.length : '';
                updateSatBar();
            } else if (group === 'starlink') {
                if (slControls) slControls.hidden = !cb.checked;
                if (cb.checked) {
                    for (let i = 0; i < slActiveCount; i++) {
                        if (slEntities[i]) slEntities[i].show = true;
                    }
                    if (slStatusEl) slStatusEl.textContent = slActiveCount;
                    flyToEntities(slEntities.slice(0, slActiveCount));
                } else {
                    slEntities.forEach(e => { e.show = false; });
                    if (slStatusEl) slStatusEl.textContent = '';
                }
                updateSatBar();
            }
        } else {
            const color = cb.dataset.color;
            const cap   = parseInt(cb.dataset.cap, 10);
            toggleLayer(group, color, cap, cb.checked);
        }
    });
});

/* ── Source toggle (Celestrak ⇄ Space-Track) ───────────────────────────── */
function reloadAllLayers(live) {
    document.querySelectorAll('.layer-cb').forEach(cb => {
        if (cb.dataset.builtin === 'true') return;
        const group = cb.dataset.group;
        const state = layerState[group];
        if (state) {
            state.entities.forEach(e => viewer.entities.remove(e));
            delete layerState[group];
        }
        if (cb.checked) {
            toggleLayer(group, cb.dataset.color, parseInt(cb.dataset.cap, 10), true, live);
        }
    });
}

document.querySelectorAll('.source-btn').forEach(btn => {
    btn.classList.toggle('source-btn--active', btn.dataset.source === activeSource);
    btn.addEventListener('click', () => {
        if (btn.disabled || btn.dataset.source === activeSource) return;
        activeSource = btn.dataset.source;
        localStorage.setItem('orbit-source', activeSource);
        document.querySelectorAll('.source-btn').forEach(b =>
            b.classList.toggle('source-btn--active', b.dataset.source === activeSource));
        reloadAllLayers(false);
    });
});

const refreshBtn = document.getElementById('refresh-data');
if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
        refreshBtn.classList.add('is-spinning');
        reloadAllLayers(true);
        setTimeout(() => refreshBtn.classList.remove('is-spinning'), 1200);
    });
}

/* ── Boot ──────────────────────────────────────────────────────────────── */
loadSatellites();
