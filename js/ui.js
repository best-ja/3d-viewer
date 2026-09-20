/**
 * All DOM wiring. The markup lives in index.html; this module fills it in and
 * turns interactions into callbacks for main.js.
 *
 * Every piece of site- or sensor-supplied text goes in through textContent, so
 * Thai site names (or anything else) render as written and can never be parsed
 * as markup.
 */
import { SENSOR_TYPES, cardinal, bearingOfModelDir } from './sensors.js';

const $ = id => document.getElementById(id);

function el(tag, props = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('data-') || k.startsWith('aria-')) n.setAttribute(k, v);
        else n[k] = v;
    }
    for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
    return n;
}

export function createUI(handlers) {
    const dom = {
        siteBtn: $('siteBtn'), siteName: $('siteName'), siteSub: $('siteSub'),
        compassBtn: $('compassBtn'),
        chips: $('chips'),
        viewTools: $('viewTools'), toggleLabels: $('toggleLabels'), toggleFocus: $('toggleFocus'),
        calib: $('calib'), calHeading: $('calHeading'), calNote: $('calNote'),
        calAlign: $('calAlign'), calTilt: $('calTilt'), calReset: $('calReset'), calOffset: $('calOffset'),
        sheet: $('sheet'), sheetGrip: $('sheetGrip'), sheetTitle: $('sheetTitle'), sheetSub: $('sheetSub'),
        sheetBody: $('sheetBody'), sensorList: $('sensorList'), detail: $('detail'),
        picker: $('picker'), siteList: $('siteList'), pickerClose: $('pickerClose'),
        loader: $('loader'), loadTitle: $('loadTitle'), loadSub: $('loadSub'),
        loadFill: $('loadFill'), loadPct: $('loadPct'), loadRetry: $('loadRetry'),
        toast: $('toast'),
    };

    let sensors = [];
    let filter = null;
    let selectedId = null;
    let northCtx = { northOffset: 0, northKnown: false, centre: null };

    /* ------------------------------------------------------------------ *
     * Site picker                                                         *
     * ------------------------------------------------------------------ */
    function buildPicker(sites, currentCode) {
        dom.siteList.replaceChildren(...sites.map(site => {
            const row = el('button', {
                class: 'site-row' + (site.code === currentCode ? ' current' : ''),
                type: 'button',
            }, [
                el('span', { class: 'code', text: site.code }),
                el('span', { class: 'meta' }, [
                    el('span', { class: 'n wrap-any', text: site.name }),
                    el('span', { class: 'd', text: `${site.captured} · ${site.sizeMB} MB` }),
                ]),
            ]);
            row.addEventListener('click', () => {
                closePicker();
                handlers.onChooseSite(site);
            });
            return row;
        }));
    }

    const openPicker = () => dom.picker.classList.add('show');
    const closePicker = () => dom.picker.classList.remove('show');

    dom.siteBtn.addEventListener('click', () => handlers.onOpenPicker());
    dom.pickerClose.addEventListener('click', closePicker);

    /* ------------------------------------------------------------------ *
     * Type chips                                                          *
     * ------------------------------------------------------------------ */
    function buildChips(counts) {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const defs = [
            { key: null, label: 'All', sw: 'sw-all', n: total },
            ...Object.values(SENSOR_TYPES)
                .filter(t => counts[t.key] > 0)
                .map(t => ({ key: t.key, label: t.label, sw: `sw-${t.key}`, n: counts[t.key] })),
        ];
        dom.chips.replaceChildren(...defs.map(d => {
            const c = el('button', { class: 'chip', type: 'button' }, [
                el('i', { class: `swatch ${d.sw}` }),
                el('span', { text: d.label }),
                el('span', { class: 'n', text: String(d.n) }),
            ]);
            c.setAttribute('aria-pressed', String(filter === d.key));
            c.dataset.type = d.key ?? '';
            c.addEventListener('click', () => handlers.onFilter(d.key));
            return c;
        }));
    }

    function setFilter(type) {
        filter = type || null;
        for (const c of dom.chips.children) {
            c.setAttribute('aria-pressed', String((c.dataset.type || null) === filter));
        }
        renderList();
    }

    /* ------------------------------------------------------------------ *
     * Sensor list + detail                                                *
     * ------------------------------------------------------------------ */
    function renderList() {
        const shown = sensors.filter(s => !filter || s.type === filter);
        dom.sheetSub.textContent = shown.length === sensors.length
            ? `${sensors.length} installed`
            : `${shown.length} of ${sensors.length}`;

        const frag = document.createDocumentFragment();
        for (const type of Object.values(SENSOR_TYPES)) {
            const group = shown.filter(s => s.type === type.key);
            if (!group.length) continue;
            frag.appendChild(el('div', { class: 'group-label', text: `${type.plural} (${group.length})` }));
            for (const s of group) {
                const row = el('div', { class: 'srow' + (s.id === selectedId ? ' selected' : '') }, [
                    el('i', { class: 'pip' }),
                    el('span', { class: 'txt' }, [
                        el('span', { class: 'id', text: s.id }),
                        el('span', { class: 'loc', text: s.location }),
                    ]),
                    el('span', { class: 'go', text: '›' }),
                ]);
                row.firstChild.style.background = type.css;
                row.addEventListener('click', () => handlers.onSelectSensor(s.id));
                frag.appendChild(row);
            }
        }
        dom.sensorList.replaceChildren(frag);
    }

    function renderDetail(s) {
        if (!s) { dom.detail.classList.remove('show'); dom.detail.replaceChildren(); return; }
        const t = s.typeDef;

        const rows = [
            ['Model', t.model],
            ['Position (x, y, z)', s.position.toArray().map(n => n.toFixed(2)).join(', ')],
            ['Chainage', `${s.chainage.toFixed(1)} m`],
            ['Side', s.side],
            ['Height above base', `${s.height.toFixed(2)} m`],
            ...t.spec,
        ];

        // Direction to walk from the middle of the structure - only meaningful
        // once the compass has been aligned for this site.
        if (northCtx.northKnown && northCtx.centre) {
            const dx = s.position.x - northCtx.centre.x;
            const dz = s.position.z - northCtx.centre.z;
            if (Math.hypot(dx, dz) > 0.5) {
                const b = bearingOfModelDir(dx, dz, northCtx.northOffset);
                rows.push(['From site centre', `${cardinal(b)} · ${b.toFixed(0)}°`]);
            }
        }

        const dl = el('dl', { class: 'dgrid' });
        for (const [k, v] of rows) {
            dl.appendChild(el('dt', { text: k }));
            dl.appendChild(el('dd', { text: v }));
        }

        const close = el('button', { class: 'x', type: 'button', 'aria-label': 'Close', text: '×' });
        close.addEventListener('click', () => handlers.onSelectSensor(null));

        const locate = el('button', { class: 'btn small', type: 'button', text: 'Fly to' });
        locate.addEventListener('click', () => handlers.onLocate(s.id));

        const card = el('div', { class: 'dcard' }, [
            el('div', { class: 'dhead' }, [
                el('div', {}, [
                    el('div', { class: 'dtitle', text: s.id }),
                    el('div', { class: 'dsub wrap-any', text: s.location }),
                ]),
                close,
            ]),
            el('span', { class: `tag ${s.type}`, text: t.label }),
            dl,
            el('div', { class: 'dactions' }, [locate]),
        ]);

        if (!s.hasGeometry) {
            card.appendChild(el('div', {
                class: 'note warn',
                text: 'This unit has no 3D geometry in the model file — the marker shows its '
                    + 'designed position, but there is nothing to see here in the model.',
            }));
        }

        dom.detail.replaceChildren(card);
        dom.detail.classList.add('show');
    }

    function setSelected(id) {
        selectedId = id || null;
        renderList();
        renderDetail(sensors.find(s => s.id === selectedId) || null);
        if (selectedId) {
            setSheet('half');
            dom.sheetBody.scrollTop = 0;
        }
    }

    /* ------------------------------------------------------------------ *
     * Bottom sheet                                                        *
     * ------------------------------------------------------------------ */
    const SHEET_STATES = ['peek', 'half', 'full'];
    let sheetState = 'peek';

    function sheetY(state) {
        const h = dom.sheet.offsetHeight;
        if (state === 'full') return 0;
        if (state === 'half') return Math.round(innerHeight * 0.37);
        return Math.max(0, h - 168);
    }

    function setSheet(state) {
        sheetState = state;
        dom.sheet.style.transform = '';
        dom.sheet.classList.remove('half', 'full', 'dragging');
        if (state !== 'peek') dom.sheet.classList.add(state);
    }

    // Drag the grip / header to move between the three stops. Move and release
    // are tracked on the document so a fast drag that leaves the grip still ends
    // cleanly.
    let drag = null;
    function dragStart(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        drag = { y0: e.clientY, base: sheetY(sheetState), moved: false };
        dom.sheet.classList.add('dragging');
    }
    function dragMove(e) {
        if (!drag) return;
        const dy = e.clientY - drag.y0;
        if (Math.abs(dy) > 4) drag.moved = true;
        const y = Math.min(sheetY('peek'), Math.max(0, drag.base + dy));
        dom.sheet.style.transform = `translateY(${y}px)`;
    }
    function dragEnd(e) {
        if (!drag) return;
        const wasDrag = drag.moved;
        const y = Math.min(sheetY('peek'), Math.max(0, drag.base + (e.clientY - drag.y0)));
        drag = null;
        dom.sheet.classList.remove('dragging');
        dom.sheet.style.transform = '';
        if (!wasDrag) {
            // A tap cycles peek -> half -> full -> peek.
            setSheet(SHEET_STATES[(SHEET_STATES.indexOf(sheetState) + 1) % SHEET_STATES.length]);
            return;
        }
        let best = 'peek', bestD = Infinity;
        for (const s of SHEET_STATES) {
            const d = Math.abs(sheetY(s) - y);
            if (d < bestD) { bestD = d; best = s; }
        }
        setSheet(best);
    }
    for (const node of [dom.sheetGrip, $('sheetHead')]) {
        node.addEventListener('pointerdown', dragStart);
    }
    document.addEventListener('pointermove', dragMove);
    document.addEventListener('pointerup', dragEnd);
    document.addEventListener('pointercancel', dragEnd);

    /* ------------------------------------------------------------------ *
     * View tools                                                          *
     * ------------------------------------------------------------------ */
    dom.viewTools.querySelectorAll('[data-view]').forEach(b => {
        b.addEventListener('click', () => handlers.onView(b.dataset.view));
    });
    dom.toggleLabels.addEventListener('click', () => {
        const hidden = document.body.classList.toggle('no-labels');
        dom.toggleLabels.classList.toggle('active', !hidden);
        dom.toggleLabels.setAttribute('aria-pressed', String(!hidden));
        handlers.onInvalidate();
    });
    dom.toggleFocus.addEventListener('click', () => {
        const on = !dom.toggleFocus.classList.contains('active');
        dom.toggleFocus.classList.toggle('active', on);
        dom.toggleFocus.setAttribute('aria-pressed', String(on));
        handlers.onFocusDim(on);
    });

    /* ------------------------------------------------------------------ *
     * Compass                                                             *
     * ------------------------------------------------------------------ */
    dom.compassBtn.addEventListener('click', () => handlers.onCompassToggle());
    dom.calAlign.addEventListener('click', () => handlers.onCalibrate('align'));
    dom.calReset.addEventListener('click', () => handlers.onCalibrate('reset'));
    dom.calTilt.addEventListener('click', () => handlers.onCalibrate('tilt'));
    dom.calib.querySelectorAll('[data-nudge]').forEach(b => {
        b.addEventListener('click', () => handlers.onCalibrate('nudge', Number(b.dataset.nudge)));
    });

    const COMPASS_MESSAGES = {
        insecure: 'Compass needs an https:// page. Over plain http it is blocked by the browser, '
                + 'so use the deployed site rather than the local server.',
        unsupported: 'This browser does not report device orientation.',
        denied: 'Motion and orientation access was declined. Allow it in the browser settings to use compass mode.',
        relative: 'This phone reports no true heading (no magnetometer). Using touch control instead.',
        'no-data': 'No orientation data arrived from the phone. Using touch control instead.',
    };

    function setCompassState(state, reading) {
        const on = state === 'ok' || state === 'waiting';
        dom.compassBtn.classList.toggle('active', on);
        dom.compassBtn.setAttribute('aria-pressed', String(on));
        dom.compassBtn.textContent = state === 'waiting' ? 'Locating…' : 'Compass';
        dom.calib.classList.toggle('show', on);
        if (COMPASS_MESSAGES[state]) toast(COMPASS_MESSAGES[state], 5200);
        if (reading) setCompassReading(reading);
    }

    function setCompassReading({ heading, northOffset, active }) {
        northCtx.northOffset = northOffset;
        northCtx.northKnown = active && heading != null;
        dom.calHeading.textContent = heading == null ? '–' : `${cardinal(heading)} ${heading.toFixed(0)}°`;
        dom.calOffset.textContent = `Model north offset ${northOffset.toFixed(0)}° · saved for this site`;
    }

    function setTiltState(on) {
        dom.calTilt.textContent = `Follow tilt: ${on ? 'On' : 'Off'}`;
        dom.calTilt.classList.toggle('active', on);
        dom.calTilt.setAttribute('aria-pressed', String(on));
    }

    /* ------------------------------------------------------------------ *
     * Loader + toast                                                      *
     * ------------------------------------------------------------------ */
    const loader = {
        show(title, sub) {
            dom.loader.classList.remove('hide', 'error');
            dom.loader.style.display = '';
            dom.loadRetry.hidden = true;
            dom.loadTitle.textContent = title;
            dom.loadSub.textContent = sub || '';
            dom.loadFill.style.width = '0%';
            dom.loadPct.textContent = '0%';
        },
        progress(pct) {
            dom.loadFill.style.width = `${pct}%`;
            dom.loadPct.textContent = `${pct}%`;
        },
        hide() {
            dom.loader.classList.add('hide');
            setTimeout(() => { if (dom.loader.classList.contains('hide')) dom.loader.style.display = 'none'; }, 500);
        },
        error(title, sub) {
            dom.loader.classList.remove('hide');
            dom.loader.style.display = '';
            dom.loader.classList.add('error');
            dom.loadTitle.textContent = title;
            dom.loadSub.textContent = sub || '';
            dom.loadRetry.hidden = false;
        },
    };
    dom.loadRetry.addEventListener('click', () => { loader.hide(); handlers.onOpenPicker(); });

    let toastTimer = null;
    function toast(msg, ms = 2600) {
        dom.toast.textContent = msg;
        dom.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => dom.toast.classList.remove('show'), ms);
    }

    /* ------------------------------------------------------------------ */
    return {
        buildPicker, openPicker, closePicker,
        setSite(site, counts) {
            dom.siteName.textContent = site.name;
            dom.siteSub.textContent = `${site.code} · captured ${site.captured}`;
            dom.sheetTitle.textContent = 'Sensors';
            buildChips(counts);
        },
        setSensors(list, centre) {
            sensors = list;
            northCtx.centre = centre;
            selectedId = null;
            renderDetail(null);
            renderList();
        },
        setFilter, setSelected, setSheet,
        setCompassState, setCompassReading, setTiltState,
        loader, toast,
    };
}
