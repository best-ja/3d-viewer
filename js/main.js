/**
 * Boot and wiring.
 *
 * Deep links: ?site=BKT, optionally &type=weight, so a view can be sent to
 * someone else as a plain URL.
 */
import { SITES, getSite } from './sites.js';
import { createViewer } from './viewer.js';
import { detectSensors, createHighlighter, SENSOR_TYPES, CAMERA } from './sensors.js';
import { createCompass } from './compass.js';
import { createUI } from './ui.js';

const LAST_SITE_KEY = 'bwim.lastSite';
const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const viewer = createViewer({ canvas: document.getElementById('scene') });

let site = null;          // current site record
let groups = null;        // { axle, camera, weight } from detectSensors
let highlighter = null;
let activeType = null;
let loading = false;

/* ------------------------------------------------------------------ *
 * Type selection                                                      *
 * ------------------------------------------------------------------ */
function selectType(k) {
    if (!groups) return;
    const type = SENSOR_TYPES.find(t => t.key === k) || null;
    activeType = type ? type.key : null;

    highlighter.set(activeType);
    ui.setActiveType(activeType);

    if (type) {
        viewer.frameBox(groups[type.key].focus, type.framing);
        // BKT ships its camera nodes as empty placeholders, so there is a
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
    if (activeType) p.set('type', activeType);
    history.replaceState(null, '', `${location.pathname}?${p}`);
}

/* ------------------------------------------------------------------ *
 * UI                                                                  *
 * ------------------------------------------------------------------ */
const ui = createUI({
    onOpenPicker: () => { ui.buildPicker(SITES, site?.code); ui.openPicker(); },
    onChooseSite: s => loadSite(s),
    onSelectType: selectType,
    onOverview: () => selectType(null),
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
async function loadSite(next, wantType = null) {
    if (loading || !next) return;
    loading = true;

    highlighter?.dispose();
    highlighter = null;
    groups = null;
    activeType = null;
    ui.setActiveType(null);
    if (compass.active) stopCompass();

    ui.loader.show(next.name, `${next.code} · ${next.sizeMB} MB`);

    try {
        const model = await viewer.loadModel(next.file, xhr => {
            if (xhr.total) ui.loader.progress(Math.round((xhr.loaded / xhr.total) * 100));
        });

        site = next;
        store.set(LAST_SITE_KEY, site.code);
        compass.setSite(site.code, site.northOffsetDeg);

        groups = detectSensors(model);
        highlighter = createHighlighter(viewer, groups);

        ui.setSite(site);
        ui.setTypes(SENSOR_TYPES.map(t => ({
            key: t.key, label: t.label, css: t.css, count: groups[t.key].points.length,
        })));
        ui.setTiltState(compass.tiltEnabled);

        viewer.frameModel();
        ui.loader.hide();

        if (wantType) selectType(wantType);
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
        get activeType() { return activeType; },
    };
}

ui.buildPicker(SITES, initial?.code);
if (initial) {
    loadSite(initial, params.get('type'));
} else {
    ui.loader.hide();
    ui.openPicker();
}
