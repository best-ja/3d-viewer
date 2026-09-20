/**
 * Boot and wiring.
 *
 * Deep links: ?site=BKT and optionally &sensor=LDR-03 so a location can be
 * sent to another inspector as a plain URL.
 */
import { SITES, getSite } from './sites.js';
import { createViewer } from './viewer.js';
import { detectSensors, createMarkers, countByType } from './sensors.js';
import { createCompass } from './compass.js';
import { createUI } from './ui.js';

const LAST_SITE_KEY = 'bsi.lastSite';
const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const viewer = createViewer({
    canvas: document.getElementById('scene'),
    labelsEl: document.getElementById('labels'),
});

let site = null;        // current site record
let sensors = [];       // detected sensors for that site
let markers = null;     // marker layer
let filter = null;
let selectedId = null;
let loading = false;

/* ------------------------------------------------------------------ *
 * Selection / filtering                                               *
 * ------------------------------------------------------------------ */
function select(id, { fly = false } = {}) {
    const s = id ? sensors.find(x => x.id === id) : null;
    selectedId = s ? s.id : null;
    markers?.setSelected(selectedId);
    ui.setSelected(selectedId);
    if (s && fly) flyToSensor(s);
    syncUrl();
}

function flyToSensor(s) {
    // Far enough out to see the unit against the structure it is mounted on -
    // closer than this and the girder fills the screen with flat concrete.
    viewer.focusOn(s.position, s.type === 'camera' ? 17 : 13);
}

function setFilter(type) {
    filter = type || null;
    markers?.setTypeFilter(filter);
    ui.setFilter(filter);
    if (filter && selectedId) {
        const s = sensors.find(x => x.id === selectedId);
        if (s && s.type !== filter) select(null);
    }
}

function syncUrl() {
    if (!site) return;
    const p = new URLSearchParams();
    p.set('site', site.code);
    if (selectedId) p.set('sensor', selectedId);
    history.replaceState(null, '', `${location.pathname}?${p}`);
}

/* ------------------------------------------------------------------ *
 * UI                                                                  *
 * ------------------------------------------------------------------ */
const ui = createUI({
    onOpenPicker: () => { ui.buildPicker(SITES, site?.code); ui.openPicker(); },
    onChooseSite: s => loadSite(s),
    onFilter: setFilter,
    onSelectSensor: id => select(id, { fly: !!id }),
    onLocate: id => { const s = sensors.find(x => x.id === id); if (s) flyToSensor(s); },
    onView: name => { viewer.cancelFly(); viewer.applyView(name); if (name === 'iso') select(null); },
    onInvalidate: () => viewer.invalidate(),
    onFocusDim: on => viewer.setFocusDim(on),
    onCompassToggle: () => (compass.active ? stopCompass() : startCompass()),
    onCalibrate: (what, arg) => {
        if (what === 'align') {
            ui.toast(compass.alignToCurrentView()
                ? 'Aligned. Saved for this site.'
                : 'No heading yet — wait for the compass to settle.');
        } else if (what === 'nudge') {
            compass.nudge(arg);
        } else if (what === 'reset') {
            compass.resetOffset();
            ui.toast('Alignment reset.');
        } else if (what === 'tilt') {
            const on = !compass.tiltEnabled;
            compass.setTiltEnabled(on);
            ui.setTiltState(on);
        }
    },
});

/* ------------------------------------------------------------------ *
 * Compass                                                             *
 * ------------------------------------------------------------------ */
const compass = createCompass(viewer, {
    onStatus: state => ui.setCompassState(state),
    onReading: r => ui.setCompassReading(r),
});

async function startCompass() {
    if (!site) { ui.toast('Load a site first.'); return; }
    ui.setCompassState('waiting');
    const ok = await compass.start();
    if (!ok) ui.setCompassState('off');
}
function stopCompass() {
    compass.stop();
    ui.setCompassState('off');
}

/* ------------------------------------------------------------------ *
 * Tap to select                                                       *
 * ------------------------------------------------------------------ */
const canvas = viewer.canvas;
let down = null;
canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
    if (!down || !markers) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 8) return;                       // that was an orbit drag

    const visible = markers.pickables.filter(p => p.material.opacity > 0.5);
    const hit = viewer.pick(e.clientX, e.clientY, visible)[0]
             || viewer.pick(e.clientX, e.clientY, markers.bodyMeshes)[0];
    select(hit ? (hit.object.userData.sensorId ?? null) : null, { fly: !!hit });
});

/* ------------------------------------------------------------------ *
 * Site loading                                                        *
 * ------------------------------------------------------------------ */
async function loadSite(next, wantSensor = null) {
    if (loading || !next) return;
    loading = true;

    markers?.dispose();
    markers = null;
    sensors = [];
    selectedId = null;
    filter = null;
    if (compass.active) stopCompass();

    ui.loader.show(next.name, `${next.code} · ${next.sizeMB} MB`);

    try {
        const model = await viewer.loadModel(next.file, xhr => {
            if (xhr.total) ui.loader.progress(Math.round((xhr.loaded / xhr.total) * 100));
        });

        site = next;
        store.set(LAST_SITE_KEY, site.code);
        compass.setSite(site.code, site.northOffsetDeg);

        sensors = detectSensors(model);
        markers = createMarkers(viewer, sensors, { onSelect: id => select(id, { fly: true }) });

        ui.setSite(site, countByType(sensors));
        ui.setSensors(sensors, model.center);
        ui.setFilter(null);
        ui.setTiltState(compass.tiltEnabled);
        ui.setSheet('peek');

        viewer.applyView('iso');
        ui.loader.hide();

        if (!sensors.length) {
            ui.toast('No sensor nodes found in this model — check the export.', 6000);
        }
        if (wantSensor) select(wantSensor, { fly: true });
        else syncUrl();
    } catch (err) {
        console.error('[main] model load failed', err);
        ui.loader.error('Could not load the model',
            `${next.file} — check the file exists and the path case matches exactly.`);
    } finally {
        loading = false;
    }
}

/* ------------------------------------------------------------------ *
 * Boot                                                                *
 * ------------------------------------------------------------------ */
viewer.start();

const params = new URLSearchParams(location.search);
const initial = getSite(params.get('site')) || getSite(store.get(LAST_SITE_KEY));

ui.buildPicker(SITES, initial?.code);
if (initial) {
    loadSite(initial, params.get('sensor'));
} else {
    ui.loader.hide();
    ui.openPicker();
}
