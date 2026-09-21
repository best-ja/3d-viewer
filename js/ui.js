/**
 * All DOM wiring. The markup lives in index.html; this module fills it in and
 * turns interactions into callbacks for main.js.
 *
 * Every piece of site-supplied text goes in through textContent, so Thai bridge
 * names render as written and can never be parsed as markup.
 */
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

/** #rrggbb -> rgba(r,g,b,a), for the selected-entry tint without color-mix(). */
function softColor(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function createUI(handlers) {
    const dom = {
        siteBtn: $('siteBtn'), siteName: $('siteName'), compassBtn: $('compassBtn'),
        typeList: $('typeList'), overviewBtn: $('overviewBtn'),
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
     * Sensor types                                                        *
     * ------------------------------------------------------------------ */
    let activeType = null;

    function setTypes(entries) {
        dom.typeList.replaceChildren(...entries.map(e => {
            const node = el('button', {
                class: 'type', type: 'button', 'data-type': e.key, 'aria-pressed': 'false',
            }, [
                el('i', { class: 'bar' }),
                el('span', { class: 't' }, [
                    el('span', { class: 'tl', text: e.label }),
                    el('span', { class: 'tn', text: e.count === 1 ? '1 unit' : `${e.count} units` }),
                ]),
            ]);
            node.style.setProperty('--c', e.css);
            node.style.setProperty('--c-soft', softColor(e.css, 0.18));
            // Tapping the selected type again clears it.
            node.addEventListener('click', () => handlers.onSelectType(activeType === e.key ? null : e.key));
            return node;
        }));
        setActiveType(activeType);
    }

    function setActiveType(k) {
        activeType = k || null;
        for (const node of dom.typeList.children) {
            node.setAttribute('aria-pressed', String(node.dataset.type === activeType));
        }
    }

    dom.overviewBtn.addEventListener('click', () => handlers.onOverview());

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
        setTypes, setActiveType,
        setCompassState, setCompassReading, setTiltState,
        loader, toast,
    };
}
