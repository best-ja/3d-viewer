/**
 * Boot and wiring.
 *
 * Deep links: ?site=BKT, optionally &type=axle and &unit=axle-2, so a view can
 * be sent to someone else as a plain URL.
 */
import { SITES, getSite } from './sites.js';
import { createViewer } from './viewer.js';
import { detectSensors, detectPiers, detectNorth, createHighlighter, SENSOR_TYPES, CAMERA } from './sensors.js';
import { createCompass } from './compass.js';
import { createUI } from './ui.js';

const LAST_SITE_KEY = 'bwim.lastSite';
const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const viewer = createViewer({
    canvas: document.getElementById('scene'),
    labelsEl: document.getElementById('pierLabels'),
});

let site = null;          // current site record
let groups = null;        // { axle, camera, weight, cabinet } from detectSensors
let highlighter = null;
let selection = { type: null, unitId: null };
let piersOn = false;
let piers = [];           // resolved [{ label, position }]
let loading = false;

const typeDef = k => SENSOR_TYPES.find(t => t.key === k) || null;

/* ------------------------------------------------------------------ *
 * Selection                                                           *
 * ------------------------------------------------------------------ */
function select(typeKey, unitId = null) {
    if (!groups) return;
    const type = typeDef(typeKey);
    selection = { type: type ? type.key : null, unitId: type ? unitId : null };

    highlighter.set(selection.type, selection.unitId);
    ui.setActive(selection.type, selection.unitId);

    if (type) {
        const unit = selection.unitId && groups[type.key].units.find(u => u.id === selection.unitId);
        viewer.frameBox(unit ? unit.box : groups[type.key].focus,
                        unit ? (type.unitFraming ?? type.framing) : type.framing);
        // An export can ship its camera nodes as empty placeholders, leaving a
        // position to fly to but nothing to light up. Say so rather than
        // leaving someone staring at an unchanged model.
        if (type.key === CAMERA && !groups[CAMERA].meshes.length) {
            ui.toast('This model has no camera geometry — showing the mounting position only.', 4200);
        }
    } else {
        viewer.frameModel();
    }
    syncUrl();
}

function syncUrl() {
    if (!site) return;
    const p = new URLSearchParams();
    p.set('site', site.code);
    if (selection.type) p.set('type', selection.type);
    if (selection.unitId) p.set('unit', selection.unitId);
    history.replaceState(null, '', `${location.pathname}?${p}`);
}

/* ------------------------------------------------------------------ *
 * Pier tags                                                           *
 * ------------------------------------------------------------------ */
function applyPiers() {
    viewer.setPierLabels(piersOn ? piers : []);
    ui.setPiersState(piersOn, piers.length > 0);
}

/**
 * Pier tags come from the model when the designer named the pier groups, and
 * from the `piers` list in js/sites.js when they did not. glTF has no text
 * primitive, so SketchUp Text entities do not survive export - only names do.
 */
function resolvePiers(model) {
    const detected = detectPiers(model);
    if (detected.length) return detected;
    return (site.piers || [])
        .map(p => ({ label: p.label, position: viewer.pointAtChainage(p.at) }))
        .filter(p => p.position);
}

/* ------------------------------------------------------------------ *
 * UI                                                                  *
 * ------------------------------------------------------------------ */
const ui = createUI({
    onOpenPicker: () => { ui.buildPicker(SITES, site?.code); ui.openPicker(); },
    onChooseSite: s => loadSite(s),
    onSelectType: k => select(k),
    onSelectUnit: (k, unitId) => select(k, unitId),
    onOverview: () => select(null),
    onTogglePiers: () => { piersOn = !piersOn; applyPiers(); },
    onCompassToggle: () => (compass.active ? stopCompass() : startCompass()),
    onCalibrate: (what, arg) => {
        if (what === 'align') {
            ui.toast(compass.alignToCurrentView()
                ? 'Aligned. Saved for this bridge.'
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
    if (!site) { ui.toast('Load a bridge first.'); return; }
    ui.setCompassState('waiting');
    const ok = await compass.start();
    if (!ok) ui.setCompassState('off');
}
function stopCompass() {
    compass.stop();
    ui.setCompassState('off');
}

/* ------------------------------------------------------------------ *
 * Site loading                                                        *
 * ------------------------------------------------------------------ */
async function loadSite(next, want = {}) {
    if (loading || !next) return;
    loading = true;

    highlighter?.dispose();
    highlighter = null;
    groups = null;
    piers = [];
    selection = { type: null, unitId: null };
    ui.setActive(null);
    if (compass.active) stopCompass();

    ui.loader.show(next.name, `${next.code} · ${next.sizeMB} MB`);

    try {
        const model = await viewer.loadModel(next.file, xhr => {
            if (xhr.total) ui.loader.progress(Math.round((xhr.loaded / xhr.total) * 100));
        });

        site = next;
        store.set(LAST_SITE_KEY, site.code);

        // A model that carries an N/E/S/W compass rose already knows which way
        // it faces, so there is nothing for the inspector to calibrate.
        const north = detectNorth(model);
        compass.setSite(site.code, north ?? site.northOffsetDeg,
                        north != null || site.northOffsetDeg != null);
        piers = resolvePiers(model);

        groups = detectSensors(model);
        highlighter = createHighlighter(viewer, groups);

        ui.setSite(site);
        ui.setTypes(SENSOR_TYPES.map(t => ({
            key: t.key, label: t.label, css: t.css,
            count: groups[t.key].count,
            units: groups[t.key].units.map(u => ({ id: u.id, label: u.label })),
        })));
        ui.setTiltState(compass.tiltEnabled);
        applyPiers();

        viewer.frameModel();
        ui.loader.hide();

        if (want.type) select(want.type, want.unit);
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

// Debug seam, off unless ?debug=1 is in the URL. Lets the test harness assert
// on materials and layers, and is handy from the console in the field.
if (params.has('debug')) {
    window.__bwim = {
        viewer,
        get site() { return site; },
        get groups() { return groups; },
        get selection() { return selection; },
        get piers() { return piers; },
        compass,
    };
}

ui.buildPicker(SITES, initial?.code);
if (initial) {
    loadSite(initial, { type: params.get('type'), unit: params.get('unit') });
} else {
    ui.loader.hide();
    ui.openPicker();
}
