/**
 * All DOM wiring. The markup lives in index.html; this module fills it in and
 * turns interactions into callbacks for main.js.
 *
 * Every piece of site-supplied text goes in through textContent, so Thai bridge
 * and pier names render as written and can never be parsed as markup.
 */
const $ = id => document.getElementById(id);
const PANEL_KEY = 'bwim.panelCollapsed';

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

/** #rrggbb -> rgba(r,g,b,a), for the selected tint without needing color-mix(). */
function softColor(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function createUI(handlers) {
    const dom = {
        siteBtn: $('siteBtn'), siteName: $('siteName'), compassBtn: $('compassBtn'),
        typeList: $('typeList'), overviewBtn: $('overviewBtn'), pierBtn: $('pierBtn'),
        panelOpen: $('panelOpen'), panelClose: $('panelClose'),
        calib: $('calib'), calHeading: $('calHeading'), calAlign: $('calAlign'),
        calTilt: $('calTilt'), calReset: $('calReset'), calOffset: $('calOffset'),
        picker: $('picker'), siteList: $('siteList'), pickerClose: $('pickerClose'),
        loader: $('loader'), loadTitle: $('loadTitle'), loadSub: $('loadSub'),
        loadFill: $('loadFill'), loadPct: $('loadPct'), loadRetry: $('loadRetry'),
        toast: $('toast'),
    };

    /* ------------------------------------------------------------------ *
     * Bridge picker                                                       *
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
            row.addEventListener('click', () => { closePicker(); handlers.onChooseSite(site); });
            return row;
        }));
    }
    const openPicker = () => dom.picker.classList.add('show');
    const closePicker = () => dom.picker.classList.remove('show');

    dom.siteBtn.addEventListener('click', () => handlers.onOpenPicker());
    dom.pickerClose.addEventListener('click', closePicker);

    /* ------------------------------------------------------------------ *
     * Sensor types and their per-unit submenus                            *
     * ------------------------------------------------------------------ */
    let active = { type: null, unitId: null };

    function setTypes(entries) {
        dom.typeList.replaceChildren(...entries.map(e => {
            const hasUnits = e.units.length > 1;
            const head = el('button', {
                class: 'type', type: 'button', 'data-type': e.key,
                'aria-pressed': 'false', 'aria-expanded': 'false',
            }, [
                el('i', { class: 'bar' }),
                el('span', { class: 't' }, [
                    el('span', { class: 'tl', text: e.label }),
                    el('span', { class: 'tn', text: e.count === 1 ? '1 unit' : `${e.count} units` }),
                ]),
                hasUnits ? el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }) : null,
            ]);
            head.style.setProperty('--c', e.css);
            head.style.setProperty('--c-soft', softColor(e.css, 0.18));
            // Tapping the selected type again clears it.
            head.addEventListener('click', () =>
                handlers.onSelectType(active.type === e.key && !active.unitId ? null : e.key));

            const subs = el('div', { class: 'subs' }, e.units.map(u => {
                const b = el('button', {
                    class: 'sub', type: 'button', 'data-unit': u.id,
                    'aria-pressed': 'false', text: u.label,
                });
                b.style.setProperty('--c', e.css);
                b.style.setProperty('--c-soft', softColor(e.css, 0.18));
                b.addEventListener('click', () =>
                    handlers.onSelectUnit(e.key, active.unitId === u.id ? null : u.id));
                return b;
            }));
            return el('div', { class: 'type-row' }, hasUnits ? [head, subs] : [head]);
        }));
        setActive(active.type, active.unitId);
    }

    function setActive(type, unitId = null) {
        active = { type: type || null, unitId: unitId || null };
        for (const row of dom.typeList.children) {
            const head = row.querySelector('.type');
            const isType = head.dataset.type === active.type;
            head.setAttribute('aria-pressed', String(isType && !active.unitId));
            head.setAttribute('aria-expanded', String(isType));
            const subs = row.querySelector('.subs');
            if (subs) {
                subs.classList.toggle('show', isType);
                for (const b of subs.children) {
                    b.setAttribute('aria-pressed', String(isType && b.dataset.unit === active.unitId));
                }
            }
        }
    }

    dom.overviewBtn.addEventListener('click', () => handlers.onOverview());

    /* ------------------------------------------------------------------ *
     * Pier tags                                                           *
     * ------------------------------------------------------------------ */
    dom.pierBtn.addEventListener('click', () => handlers.onTogglePiers());

    function setPiersState(on, available) {
        dom.pierBtn.disabled = !available;
        dom.pierBtn.title = available
            ? 'Show pier name tags'
            : 'No piers listed for this bridge - add them to js/sites.js';
        dom.pierBtn.classList.toggle('active', !!on && available);
        dom.pierBtn.setAttribute('aria-pressed', String(!!on && available));
    }

    /* ------------------------------------------------------------------ *
     * Panel collapse                                                      *
     * ------------------------------------------------------------------ */
    let collapsed = false;
    function setCollapsed(on, remember = true) {
        collapsed = !!on;
        document.body.classList.toggle('panel-collapsed', collapsed);
        dom.panelOpen.setAttribute('aria-expanded', String(!collapsed));
        if (remember) { try { localStorage.setItem(PANEL_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ } }
    }
    dom.panelClose.addEventListener('click', () => setCollapsed(true));
    dom.panelOpen.addEventListener('click', () => setCollapsed(false));
    try { setCollapsed(localStorage.getItem(PANEL_KEY) === '1', false); } catch { /* private mode */ }

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

    const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const cardinal = deg => COMPASS_16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

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

    function setCompassReading({ heading, northOffset }) {
        dom.calHeading.textContent = heading == null ? '–' : `${cardinal(heading)} ${heading.toFixed(0)}°`;
        dom.calOffset.textContent = `Model north offset ${northOffset.toFixed(0)}° · saved for this bridge`;
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
    function toast(msg, ms = 2800) {
        dom.toast.textContent = msg;
        dom.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => dom.toast.classList.remove('show'), ms);
    }

    /* ------------------------------------------------------------------ */
    return {
        buildPicker, openPicker, closePicker,
        setSite(site) { dom.siteName.textContent = site.name; },
        setTypes, setActive, setPiersState,
        setCollapsed, get collapsed() { return collapsed; },
        setCompassState, setCompassReading, setTiltState,
        loader, toast,
    };
}
