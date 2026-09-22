/**
 * Boot and wiring.
 *
 * Nothing loads until a bridge is chosen: every visit starts at the picker.
 * A link can still carry a view - ?site=BKT&type=axle,weight&unit=axle-2 - and
 * the bridge it names is pre-selected in the picker, one tap away.
 */
/**
 * js/sites.js is the one file that gets edited between reloads, so it is
 * imported with a cache-busting query instead of being left to the browser's
 * module cache. An ordinary reload happily serves a stale copy of it - and on
 * iOS Safari there is no hard reload at all - which looks exactly like the
 * setting being ignored. It is 4 KB next to a 10 MB model, so this is free.
 */
const { SITES, getSite } = await import(`./sites.js?t=${Date.now()}`);
import { createViewer } from './viewer.js';
import { detectSensors, detectGround, createHighlighter, SENSOR_TYPES, CAMERA } from './sensors.js';
import { createUI } from './ui.js';

const LAST_SITE_KEY = 'bwim.lastSite';
const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const viewer = createViewer({ canvas: document.getElementById('scene') });

let site = null;          // current site record
let groups = null;        // { axle, camera, weight, cabinet } from detectSensors
let highlighter = null;
let selection = { types: [], unitId: null };
let floorOverride = null; // null = follow the selection; see floorWanted()
let loading = false;

const typeDef = k => SENSOR_TYPES.find(t => t.key === k) || null;
/** Panel order, so a selection reads the same however it was assembled. */
const ORDER = SENSOR_TYPES.map(t => t.key);

/* ------------------------------------------------------------------ *
 * Selection                                                           *
 * ------------------------------------------------------------------ */

/**
 * Light a set of types. Several at once is the normal case - every chip is a
 * toggle, because a touch screen has no modifier to hold - and `unitId` only
 * means anything when exactly one of them is lit.
 */
function select(types, unitId = null) {
    if (!groups) return;
    const keys = ORDER.filter(k => types.includes(k) && groups[k]);
    selection = { types: keys, unitId: keys.length === 1 ? (unitId || null) : null };

    // Any change of view hands the floor back to the automatic rule.
    floorOverride = null;
    applyFloor();

    highlighter.set(keys, selection.unitId);
    ui.setActive(selection.types, selection.unitId);
    frameSelection();
    syncUrl();
}

const toggleType = key => select(selection.types.includes(key)
    ? selection.types.filter(k => k !== key)
    : [...selection.types, key]);

/** Select-all, and off again once everything is on. */
function toggleAll() {
    const lit = ORDER.filter(k => groups?.[k]?.count);
    select(selection.types.length === lit.length ? [] : lit);
}

function frameSelection() {
    const keys = selection.types;
    if (!keys.length) { viewer.frameModel(); return; }

    if (keys.length === 1) {
        const type = typeDef(keys[0]);
        const unit = selection.unitId && groups[type.key].units.find(u => u.id === selection.unitId);
        viewer.frameBox(unit ? unit.box : groups[type.key].focus,
                        unit ? (type.unitFraming ?? type.framing) : type.framing,
                        {
                            // The group's own meshes are not obstructions.
                            ignore: new Set(unit ? unit.meshes : groups[type.key].meshes),
                            view: viewFor(type, unit),
                            label: unit ? `${type.key} / ${unit.label}` : type.key,
                        });
        // An export can ship its camera nodes as empty placeholders, leaving a
        // position to fly to but nothing to light up. Say so rather than
        // leaving someone staring at an unchanged model.
        if (type.key === CAMERA && !groups[CAMERA].meshes.length) {
            ui.toast('This model has no camera geometry — showing the mounting position only.', 4200);
        }
        return;
    }

    // Two or more: the union of what is lit, taken from off the side of the
    // deck. `outside` works out at about 12 degrees above level, which is
    // where the show screen's own fit settled for exactly this content - the
    // roadside cameras 5 m up and the strain plates below the deck. A higher
    // angle flattens that spread. Per-site `views` are keyed on one type or
    // one unit, so a mixed shot takes none of them.
    const box = new viewer.THREE.Box3();
    const ignore = new Set();
    for (const k of keys) {
        const g = groups[k];
        if (g.focus && !g.focus.isEmpty()) box.union(g.focus);
        for (const m of g.meshes) ignore.add(m);
    }
    viewer.frameBox(box, 'outside', { ignore, label: keys.join(' + ') });
}

function syncUrl() {
    if (!site) return;
    const p = new URLSearchParams();
    p.set('site', site.code);
    if (selection.types.length) p.set('type', selection.types.join(','));
    if (selection.unitId) p.set('unit', selection.unitId);
    // URLSearchParams escapes the separator to %2C. A comma is legal in a query
    // string and nothing else here can contain one - site codes, type keys and
    // unit ids are all plain ASCII - so put it back, for a link people read.
    history.replaceState(null, '', `${location.pathname}?${p}`.replace(/%2C/g, ','));
}

/* ------------------------------------------------------------------ *
 * The floor                                                           *
 * ------------------------------------------------------------------ */

/**
 * WEIGHT SENSOR and CAS / BTS are the two types framed from under the deck,
 * and the ground is in the way of both - it fills the lower half of the shot
 * and pins the camera above it. `framing` already records which those are, so
 * the rule reads off that rather than naming the types again here.
 *
 * The button overrules it for the view you are in; changing the selection
 * hands control back.
 */
const goesUnder = keys => keys.some(k => typeDef(k)?.framing === 'under');
const floorWanted = () => floorOverride ?? !goesUnder(selection.types);

function applyFloor() {
    const shown = floorWanted();
    viewer.setGroundVisible(shown);
    ui.setFloorState(shown, viewer.hasGround);
}

/** No re-framing: dropping the floor mid-orbit should not fly the camera. */
function toggleFloor() {
    floorOverride = !floorWanted();
    applyFloor();
}

/**
 * Rename the detected units from the bridge's `unitLabels` - the nth name goes
 * to the nth unit along the deck - then order the panel by those names, since
 * the name is what you read. Numeric collation keeps A-10 after A-9.
 *
 * Kept here rather than in js/sensors.js so detection stays free of per-bridge
 * knowledge. Unit ids stay bound to their physical unit, so ?unit= deep links
 * keep resolving whatever the display order.
 */
function applyUnitConfig() {
    for (const [key, labels] of Object.entries(site.unitLabels || {})) {
        const units = groups[key]?.units;
        if (!units || !Array.isArray(labels)) continue;
        if (labels.length !== units.length) {
            console.warn(`[labels] ${site.code}.unitLabels.${key} has ${labels.length} name(s) `
                + `but ${units.length} unit(s) were detected - ignoring it.`);
            continue;
        }
        units.forEach((u, i) => { u.label = String(labels[i]); });
    }
    for (const t of SENSOR_TYPES) {
        groups[t.key]?.units.sort((a, b) =>
            a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
    }
}

/**
 * The view override for a shot: a unit's own entry wins over its type's, and a
 * unit can be named either way round - by the label you gave it, or by its
 * stable id - so a rename does not silently drop the override.
 */
function viewFor(type, unit) {
    const v = site?.views || {};
    if (unit) return v[unit.label] ?? v[unit.id] ?? v[type.key];
    return v[type.key];
}

/* ------------------------------------------------------------------ *
 * UI                                                                  *
 * ------------------------------------------------------------------ */
const ui = createUI({
    onOpenPicker: () => { ui.buildPicker(SITES, site?.code); ui.openPicker(); },
    onChooseSite: s => choose(s),
    onToggleType: k => toggleType(k),
    onSelectUnit: (k, unitId) => select([k], unitId),
    onAll: () => toggleAll(),
    onToggleFloor: () => toggleFloor(),
});

/* ------------------------------------------------------------------ *
 * Site loading                                                        *
 * ------------------------------------------------------------------ */
async function loadSite(next, want = {}) {
    if (loading || !next) return;
    loading = true;

    highlighter?.dispose();
    highlighter = null;
    groups = null;
    selection = { types: [], unitId: null };
    floorOverride = null;
    ui.setActive([]);

    ui.loader.show(next.name, `${next.code} · ${next.sizeMB} MB`);

    try {
        const model = await viewer.loadModel(next.file, xhr => {
            if (xhr.total) ui.loader.progress(Math.round((xhr.loaded / xhr.total) * 100));
        });

        site = next;
        store.set(LAST_SITE_KEY, site.code);

        // Name the settings that were read, so a config that did not reach the
        // browser is visible at a glance rather than looking like the app
        // ignoring it.
        const cfg = [...Object.keys(site.unitLabels || {}).map(k => `unitLabels.${k}`),
                     ...Object.keys(site.views || {}).map(k => `views.${k}`)];
        console.log(`[config] ${site.code} from js/sites.js - `
            + (cfg.length ? cfg.join(', ') : 'nothing configured'));

        viewer.setGround(detectGround(model));

        groups = detectSensors(model);
        applyUnitConfig();
        highlighter = createHighlighter(viewer, groups);

        ui.setSite(site);
        ui.setTypes(SENSOR_TYPES.map(t => ({
            key: t.key, label: t.label, short: t.short, css: t.css,
            count: groups[t.key].count,
            units: groups[t.key].units.map(u => ({ id: u.id, label: u.label })),
        })));
        applyFloor();

        viewer.frameModel();
        ui.loader.hide();

        const wanted = (want.type || '').split(',').filter(Boolean);
        if (wanted.length) select(wanted, want.unit);
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
const linked = getSite(params.get('site'));

/**
 * What a shared link asked for, held until the bridge it names is picked. Pick
 * a different one and it is dropped: ?unit=axle-3 means nothing on another
 * model, and silently applying half of it would be worse than none.
 */
let pending = linked ? { type: params.get('type'), unit: params.get('unit') } : null;

function choose(s) {
    const want = (pending && s === linked) ? pending : {};
    pending = null;
    loadSite(s, want);
}

/**
 * Print where the camera is now, in the form js/sites.js wants. Light one
 * sensor type, orbit until it looks right, call this, paste the line into
 * `views`. See CONFIG.md.
 */
window.bwimView = () => {
    if (!site || !groups) { console.log('Load a bridge first.'); return null; }
    const a = viewer.currentAngles();
    if (selection.types.length !== 1) {
        console.log('Light exactly one sensor type, then orbit and call bwimView() again — '
            + '`views` is keyed on one type or one unit.');
        return { site: site.code, types: [...selection.types], ...a };
    }
    const type = typeDef(selection.types[0]);
    const unit = selection.unitId
        ? groups[type.key].units.find(u => u.id === selection.unitId) : null;
    const key = unit ? unit.label : type.key;
    console.log(`${site.code} · ${type.key}` + (unit ? ` · ${unit.label}` : ''));
    console.log(`views: { '${key}': { azimuth: ${Math.round(a.azimuth)}, `
        + `elevation: ${Math.round(a.elevation)}, distance: ${a.distance.toFixed(1)} } }`);
    return { site: site.code, type: type.key, unit: unit?.label ?? null, ...a };
};

// Debug seam, off unless ?debug=1 is in the URL. Lets the test harness assert
// on materials and layers, and is handy from the console in the field.
if (params.has('debug')) {
    window.__bwim = {
        viewer,
        // The app holds its own instance of js/sites.js (cache-busted above), so
        // the seam hands out that one - importing the module again would give a
        // second copy whose edits go nowhere.
        SITES,
        get site() { return site; },
        get groups() { return groups; },
        get selection() { return selection; },
        get floor() {
            return {
                shown: viewer.groundShown,
                available: viewer.hasGround,
                override: floorOverride,
            };
        },
        select, toggleType, toggleAll, toggleFloor, loadSite,
    };
}

ui.buildPicker(SITES, (linked || getSite(store.get(LAST_SITE_KEY)))?.code);
ui.openPicker();
