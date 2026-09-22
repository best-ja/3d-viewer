/**
 * All DOM wiring. The markup lives in index.html; this module fills it in and
 * turns interactions into callbacks for main.js.
 *
 * Every piece of site-supplied text goes in through textContent, so Thai bridge
 * names render as written and can never be parsed as markup.
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
        siteBtn: $('siteBtn'), siteName: $('siteName'),
        typeBar: $('typeBar'), typeList: $('typeList'), unitList: $('unitList'),
        allBtn: $('allBtn'), floorBtn: $('floorBtn'),
        panelOpen: $('panelOpen'), panelClose: $('panelClose'),
        picker: $('picker'), siteList: $('siteList'), pickerClose: $('pickerClose'),
        loader: $('loader'), loadTitle: $('loadTitle'), loadSub: $('loadSub'),
        loadFill: $('loadFill'), loadPct: $('loadPct'), loadRetry: $('loadRetry'),
        toast: $('toast'),
    };

    /* ------------------------------------------------------------------ *
     * Bridge picker - the front door, not a dialog                        *
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
    let types = [];                     // the entries setTypes() was given
    let active = { types: [], unitId: null };
    let unitsFor = null;                // which type the unit row is currently built for

    const typeEntry = k => types.find(t => t.key === k) || null;

    function setTypes(entries) {
        types = entries || [];
        unitsFor = null;
        dom.typeList.replaceChildren(...types.map(e => {
            const chip = el('button', {
                class: 'chip', type: 'button', 'data-type': e.key,
                'aria-pressed': 'false', title: e.label, 'aria-label': e.label,
            }, [
                el('span', { class: 'full', text: e.label }),
                el('span', { class: 'short', text: e.short || e.label }),
            ]);
            chip.style.setProperty('--c', e.css);
            chip.style.setProperty('--c-soft', softColor(e.css, 0.18));
            if (!e.count) {
                chip.disabled = true;
                chip.title = `No ${e.label} in this model.`;
            }
            chip.addEventListener('click', () => handlers.onToggleType(e.key));
            return chip;
        }));
        setActive(active.types, active.unitId);
    }

    /**
     * The unit row is only offered when exactly one type is lit: narrowing to
     * one unit has no meaning across two types, and the highlighter ignores a
     * unit id in that case anyway.
     */
    function buildUnits(entry) {
        unitsFor = entry.key;
        dom.unitList.replaceChildren(...entry.units.map(u => {
            const b = el('button', {
                class: 'unit', type: 'button', 'data-unit': u.id,
                'aria-pressed': 'false', text: u.label,
            });
            b.style.setProperty('--c', entry.css);
            b.style.setProperty('--c-soft', softColor(entry.css, 0.18));
            b.addEventListener('click', () =>
                handlers.onSelectUnit(entry.key, active.unitId === u.id ? null : u.id));
            return b;
        }));
    }

    function setActive(lit, unitId = null) {
        active = { types: [...(lit || [])], unitId: unitId || null };

        for (const chip of dom.typeList.children) {
            chip.setAttribute('aria-pressed', String(active.types.includes(chip.dataset.type)));
        }

        const solo = active.types.length === 1 ? typeEntry(active.types[0]) : null;
        const show = !!solo && solo.units.length > 1;
        if (show) {
            if (unitsFor !== solo.key) buildUnits(solo);
            for (const b of dom.unitList.children) {
                b.setAttribute('aria-pressed', String(b.dataset.unit === active.unitId));
            }
        } else {
            unitsFor = null;
        }
        dom.unitList.hidden = !show;

        const all = types.filter(t => t.count).length;
        const on = all > 0 && active.types.length === all;
        dom.allBtn.classList.toggle('active', on);
        dom.allBtn.setAttribute('aria-pressed', String(on));
        dom.allBtn.title = on ? 'Turn every sensor type off' : 'Light every sensor type at once';
    }

    dom.allBtn.addEventListener('click', () => handlers.onAll());

    /* ------------------------------------------------------------------ *
     * The floor                                                           *
     * ------------------------------------------------------------------ */
    dom.floorBtn.addEventListener('click', () => handlers.onToggleFloor());

    function setFloorState(shown, available) {
        dom.floorBtn.disabled = !available;
        dom.floorBtn.setAttribute('aria-pressed', String(!!shown && available));
        dom.floorBtn.title = !available
            ? 'This model has no ground under the bridge.'
            : shown ? 'Hide the ground under the bridge' : 'Show the ground under the bridge';
    }

    /* ------------------------------------------------------------------ *
     * Strip collapse                                                      *
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
        /** A bridge is up: name it, show the strip, and let the picker be
         *  dismissed - until now there was nothing behind it to go back to. */
        setSite(site) {
            dom.siteName.textContent = site.name;
            document.body.classList.add('has-model');
            dom.pickerClose.hidden = false;
        },
        setTypes, setActive, setFloorState,
        setCollapsed, get collapsed() { return collapsed; },
        loader, toast,
    };
}
