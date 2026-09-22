/**
 * Conference-room show screen.
 *
 * One big panel featuring a bridge at a time, four small panels showing the
 * ones coming up. It runs itself: nobody touches this machine.
 *
 * WHY ONE CANVAS
 * Five bridges are live at once. Five <canvas> elements would mean five WebGL
 * contexts, five copies of the environment map and five render loops, with no
 * way to spend the frame budget where it matters. Instead there is a single
 * context and five scenes, and each panel is drawn into its own rectangle with
 * setViewport/setScissor. The panels in the DOM are transparent boxes that
 * exist only to supply those rectangles - all text stays in HTML on top.
 *
 * THE FRAME BUDGET
 * The five models are 8 400 draw calls between them, so drawing all of them
 * every frame is not affordable. The big panel is redrawn every frame; the
 * small ones take turns, one per frame. A skipped panel keeps the pixels it
 * had, which is the whole reason the renderer asks for preserveDrawingBuffer -
 * without it WebGL may throw the drawing buffer away after compositing and the
 * waiting panels would flicker to black.
 *
 * WHY ONE SHOT PER BRIDGE SERVES EVERY SENSOR TYPE
 * Everything is lit at once, each type in its own colour, and the highlight
 * pass clears the depth buffer before drawing the highlight layer - so the
 * weight sensors and cabinets under the deck glow straight up through it. The
 * camera never has to see past anything, and one raised orbit does the job.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadGLB } from './model.js';
import {
    detectSensors, createHighlighter, SENSOR_TYPES, HIGHLIGHT_LAYER,
    AXLE, WEIGHT, CABINET,
} from './sensors.js';

// Same cache-busting import as index.html uses: js/sites.js is the file that
// gets edited between reloads and a stale copy looks like a bug.
const { SITES } = await import(`./sites.js?t=${Date.now()}`);

const params = new URLSearchParams(location.search);

/* ------------------------------------------------------------------ *
 * Everything worth tuning for the room                                *
 * ------------------------------------------------------------------ */
const SHOW = {
    /** Lit together on every bridge, each in its own colour. No cameras. */
    TYPES:     [AXLE, WEIGHT, CABINET],
    /** How long each bridge holds the big panel. Five of these is one pass. */
    DWELL_MS:  Number(params.get('dwell')) || 14000,
    /** Dip-to-black when the featured bridge changes. */
    FADE_MS:   700,
    /**
     * Orbit speed for the featured bridge, degrees per second. A turn lasts
     * DWELL_MS, so this also decides how far from broadside the shot ever
     * gets: at 3 deg/s a 14 s turn sweeps 42 deg, which is broadside give or
     * take half of that. Faster than about 4 and the bridge swings round to
     * end-on, where a deck is just a receding sliver.
     */
    ORBIT_DPS: 3,
    /**
     * And for the four waiting in the strip. Slower on purpose: those panels
     * are redrawn in rotation, a few times a second, so a gentle turn keeps
     * the step between redraws too small to read as juddering.
     */
    IDLE_DPS:  1.2,
    /**
     * The one shot per bridge - the union of the three lit groups, padded.
     * `elevation` is degrees above the deck, `minSpan` the least metres of
     * bridge kept in frame so a tight group cannot pull the camera into the
     * girder.
     */
    FRAME:     { elevation: 20, minSpan: 30 },
    /**
     * What the governor aims for. The per-level cap may be higher; this is the
     * line below which frames are judged too slow, and it stays fixed so the
     * target cannot move with the level and set off an oscillation.
     */
    TARGET_MS: 1000 / 30,
    SLOTS:     4,
};

const $ = id => document.getElementById(id);
const dom = {
    canvas: $('stage'), big: $('big'), strip: $('strip'),
    bigName: $('bigName'), bigCode: $('bigCode'), bigLegend: $('bigLegend'),
    bigWait: $('bigWait'), bigFade: $('bigFade'),
    clock: $('clock'), fault: $('fault'),
};
document.documentElement.style.setProperty('--fade', `${SHOW.FADE_MS}ms`);

function el(tag, props = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;      // never innerHTML: Thai names
        else n.setAttribute(k, v);
    }
    for (const kid of [].concat(kids)) if (kid) n.appendChild(kid);
    return n;
}

const typeDef = key => SENSOR_TYPES.find(t => t.key === key);

/* ------------------------------------------------------------------ *
 * Renderer - one context for all five panels                          *
 * ------------------------------------------------------------------ */
const renderer = new THREE.WebGLRenderer({
    canvas: dom.canvas,
    antialias: true,
    powerPreference: 'high-performance',
    // Required: panels that are not redrawn this frame must keep their pixels.
    preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x060912, 1);
renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.autoClear = false;             // the panel loop drives the clears
renderer.setScissorTest(true);
// Several render() calls make up one frame here, and three.js resets its
// counters on each one - so the numbers would only ever describe the last
// panel drawn. Reset once per frame instead and they describe the frame.
renderer.info.autoReset = false;

// One environment map, shared by every scene. This is the saving that pays for
// five bridges being resident at once.
const pmrem = new THREE.PMREMGenerator(renderer);
const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// The dim quad behind the highlight pass, exactly as the inspector draws it.
const dimCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const dimScene = new THREE.Scene();
dimScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({
    color: 0x02040a, transparent: true, opacity: 0.45,
    depthTest: false, depthWrite: false,
})));

/** The highlighter only ever calls these two, so this is the whole contract. */
const NO_VIEWER = { setOverlay() {}, invalidate() {} };

/* ------------------------------------------------------------------ *
 * Camera placement                                                    *
 * ------------------------------------------------------------------ */
const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const _corner = new THREE.Vector3();

/**
 * Put `cam` on the orbit at `azDeg` and back it off far enough that the whole
 * bridge fits.
 *
 * The bridges are long and thin, so a bounding sphere would leave them tiny
 * end-on and overflowing side-on. Measuring the eight box corners along the
 * camera's own axes instead keeps the bridge filling the panel all the way
 * round the orbit.
 */
function aim(cam, box, centre, azDeg, elDeg) {
    const az = THREE.MathUtils.degToRad(azDeg);
    const el = THREE.MathUtils.degToRad(elDeg);
    _dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    _right.crossVectors(UP, _dir).normalize();
    _up.crossVectors(_dir, _right).normalize();

    let needR = 0, needU = 0, deepest = 0;
    for (let i = 0; i < 8; i++) {
        _corner.set(i & 1 ? box.max.x : box.min.x,
                    i & 2 ? box.max.y : box.min.y,
                    i & 4 ? box.max.z : box.min.z).sub(centre);
        needR = Math.max(needR, Math.abs(_corner.dot(_right)));
        needU = Math.max(needU, Math.abs(_corner.dot(_up)));
        deepest = Math.max(deepest, _corner.dot(_dir));
    }
    const vHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const hHalf = vHalf * cam.aspect;

    cam.position.copy(centre).addScaledVector(_dir, Math.max(needU / vHalf, needR / hHalf) * 1.06 + deepest);
    cam.lookAt(centre);
}

/**
 * The one shot for a bridge - everything that gets lit, framed together.
 *
 * NOT the whole bridge. These decks are 80-130 m long and the equipment sits
 * in a 10-15 m weigh station on one of them; fitting the full model puts the
 * camera 110 m back, where the sensors are a few pixels and the point of the
 * screen is lost. This takes the union of the lit groups, pads it out until
 * there is recognisable bridge on either side, and clips it back inside the
 * model so the shot never floats off the end.
 *
 * The cameras are deliberately left out of the union as well as out of the
 * highlight: they are mounted further apart than anything else on the bridge,
 * and including them stretches the shot wide enough to shrink everything else
 * back out of sight.
 */
function frameFor(model, groups) {
    const box = new THREE.Box3();
    for (const k of SHOW.TYPES) {
        const g = groups[k];
        if (g && g.focus && !g.focus.isEmpty()) box.union(g.focus);
    }
    if (box.isEmpty()) return model.bbox.clone();

    // Pad ALONG the deck, barely across it. A bridge is 9-20 m wide and 80 m
    // long; padding both axes equally frames 30 m of thin air to either side
    // and shrinks the equipment back into the middle of an empty panel.
    const size = box.getSize(new THREE.Vector3());
    const along = size[model.majorAxis];
    const pad = new THREE.Vector3();
    pad[model.majorAxis] = Math.max(along * 0.55, (SHOW.FRAME.minSpan - along) / 2, 3);
    pad[model.minorAxis] = Math.max(size[model.minorAxis] * 0.3, 1.5);
    pad.y = Math.max(size.y * 0.5, 2.5);

    box.expandByVector(pad);
    return box.intersect(model.bbox);
}

/** Broadside: the camera sits across the deck, never looking down its length. */
const broadsideOf = model => (model.majorAxis === 'z' ? 90 : 0);

/** How far the orbit travels while a bridge holds the big panel. */
const turnSweep = () => SHOW.ORBIT_DPS * SHOW.DWELL_MS / 1000;

/* ------------------------------------------------------------------ *
 * Bridges                                                             *
 * ------------------------------------------------------------------ */
/** One per site. `azimuth` lives here, not on the panel, so a bridge keeps
 *  turning at the same rate whichever panel it is currently shown in. */
const bridges = SITES.map((site, i) => ({
    site, ready: false, failed: false,
    model: null, scene: null, groups: null, highlighter: null,
    azimuth: 0,                         // set from broadsideOf() once loaded
    broadside: 0,
    // Framed once at load: everything is lit at once, so the shot never
    // changes while a bridge is on screen.
    frame: null, centre: new THREE.Vector3(),
}));

function buildScene(model) {
    const scene = new THREE.Scene();
    scene.environment = envTexture;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.6, 1, 0.4);
    scene.add(key);

    // Fill from below - the girder soffits catch nothing from the key light
    // and the under-deck equipment would sit on black.
    const fill = new THREE.DirectionalLight(0xdbeafe, 1.3);
    fill.position.set(-0.35, -1, -0.25);
    scene.add(fill);

    scene.add(model.root);
    return scene;
}

/* ------------------------------------------------------------------ *
 * Panels                                                              *
 * ------------------------------------------------------------------ */
/** @type {{el:HTMLElement, big:boolean, camera:THREE.PerspectiveCamera,
 *          rect:{x,y,w,h}, bridge:number, wait:HTMLElement, name:HTMLElement,
 *          code:HTMLElement}[]} */
const panels = [];

function buildPanels() {
    panels.push({
        el: dom.big, big: true, wait: dom.bigWait,
        name: dom.bigName, code: dom.bigCode,
        camera: new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 10000),
        rect: null, bridge: 0, drawn: 0,
    });

    const cells = [];
    for (let i = 0; i < SHOW.SLOTS; i++) {
        const name = el('div', { class: 'thai wrap-any' });
        const code = el('div', { class: 'code' });
        const wait = el('div', { class: 'placeholder', text: 'Loading…' });
        const cell = el('section', { class: 'cell small', 'data-slot': String(i) },
                        [wait, el('div', { class: 'cap' }, [name, code])]);
        cells.push(cell);
        panels.push({
            el: cell, big: false, wait, name, code,
            camera: new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 10000),
            rect: null, bridge: (i + 1) % bridges.length, drawn: 0,
        });
    }
    dom.strip.replaceChildren(...cells);
}

/** Panel rectangles in GL coordinates - same CSS pixels, origin bottom-left. */
function measure() {
    const h = innerHeight;
    for (const p of panels) {
        const r = p.el.getBoundingClientRect();
        p.rect = { x: r.left, y: h - r.bottom, w: Math.max(1, r.width), h: Math.max(1, r.height) };
    }
}

/** Wipe the whole buffer. Only the panel rectangles are cleared after this, so
 *  the gaps between them would otherwise hold whatever was there before. */
function wipe() {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.clear();
    renderer.setScissorTest(true);
}

function drawPanel(p) {
    const b = bridges[p.bridge];
    if (!b || !b.ready || !p.rect) return false;

    const { x, y, w, h } = p.rect;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);

    const cam = p.camera;
    cam.aspect = w / h;
    cam.near = Math.max(0.1, b.model.span / 4000);
    cam.far = b.model.span * 12;
    cam.updateProjectionMatrix();
    aim(cam, b.frame, b.centre, b.azimuth, SHOW.FRAME.elevation);

    renderer.clear();
    if (p.big) {
        // Two passes, so the lit equipment reads through the structure.
        cam.layers.set(0);
        renderer.render(b.scene, cam);
        renderer.render(dimScene, dimCamera);
        renderer.clearDepth();
        cam.layers.set(HIGHLIGHT_LAYER);
        renderer.render(b.scene, cam);
        cam.layers.set(0);
    } else {
        // One pass. The highlight still shows in its real position, just
        // without the glow-through - half the cost, and these are thumbnails.
        cam.layers.enableAll();
        renderer.render(b.scene, cam);
    }
    p.drawn += 1;
    return true;
}

/* ------------------------------------------------------------------ *
 * The cycle                                                           *
 * ------------------------------------------------------------------ */
const cycle = { featured: 0, since: 0, paused: false };

/** Skip past any bridge whose model never arrived. */
function nextLive(from, step = 1) {
    for (let i = 1; i <= bridges.length; i++) {
        const j = (from + step * i + bridges.length * i) % bridges.length;
        if (bridges[j].ready) return j;
    }
    return from;
}

/** One chip per sensor type, in its own colour, with how many there are. */
function drawLegend(b) {
    dom.bigLegend.replaceChildren(...SHOW.TYPES.map(key => {
        const t = typeDef(key);
        const chip = el('span', { class: 'chip' }, [
            el('span', { text: t.label }),
            el('span', { class: 'n', text: String(b.groups[key].count) }),
        ]);
        chip.style.setProperty('--c', t.css);
        return chip;
    }));
}

function apply({ fade = false } = {}) {
    const featured = bridges[cycle.featured];

    // Restart the featured bridge's sweep so it passes through broadside
    // halfway through its turn - the dip to black hides the jump.
    if (fade && featured.ready) featured.azimuth = featured.broadside - turnSweep() / 2;

    panels[0].bridge = cycle.featured;
    for (let i = 0; i < SHOW.SLOTS; i++) {
        panels[i + 1].bridge = (cycle.featured + 1 + i) % bridges.length;
    }

    dom.bigName.textContent = featured.site.name;
    dom.bigCode.textContent = featured.site.code;
    if (featured.ready) drawLegend(featured);
    else dom.bigLegend.replaceChildren();

    for (const p of panels) {
        const b = bridges[p.bridge];
        if (!p.big) {
            p.name.textContent = b.site.name;
            p.code.textContent = b.site.code;
        }
        p.wait.hidden = b.ready;
        p.wait.classList.toggle('failed', b.failed);
        if (b.failed) p.wait.textContent = `${b.site.code} unavailable`;
    }

    if (fade) {
        // Straight to black with no transition, then let it ease back out.
        dom.bigFade.classList.add('instant');
        dom.bigFade.style.opacity = '1';
        void dom.bigFade.offsetWidth;               // commit before easing
        dom.bigFade.classList.remove('instant');
        dom.bigFade.style.opacity = '0';
    }
}

function advance(now) {
    if (cycle.paused || now - cycle.since < SHOW.DWELL_MS) return;
    cycle.since = now;
    cycle.featured = nextLive(cycle.featured);
    apply({ fade: true });
}

function step(dir) {
    cycle.since = performance.now();
    cycle.featured = nextLive(cycle.featured, dir);
    apply({ fade: true });
}

/* ------------------------------------------------------------------ *
 * Keeping up                                                          *
 * ------------------------------------------------------------------ */
/**
 * Nobody knows what is plugged into the TV. This watches how long frames
 * actually take and gives work back until they fit, rather than letting the
 * whole display crawl on a weak GPU.
 *
 * Steps down first by halving the frame rate, then by dropping resolution, and
 * only last by redrawing the small panels less often - that is the one that
 * shows, because it is what makes their orbit judder. `?quality=0` pins it at
 * full for testing.
 */
const LEVELS = [
    { fps: 60, every: 1, ratio: Math.min(devicePixelRatio, 1.25) },
    { fps: 30, every: 1, ratio: 1 },
    { fps: 30, every: 3, ratio: 0.75 },
];
const perf = {
    level: 0,
    pinned: params.has('quality') ? Number(params.get('quality')) : null,
    times: [],
    nextCheck: 0,
};
if (perf.pinned !== null) perf.level = Math.max(0, Math.min(LEVELS.length - 1, perf.pinned));

function governor(now, ms) {
    perf.times.push(ms);
    if (perf.times.length > 120) perf.times.shift();
    if (perf.pinned !== null || now < perf.nextCheck || perf.times.length < 12) return;
    perf.nextCheck = now + 3000;

    const sorted = [...perf.times].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const target = SHOW.TARGET_MS;
    const was = perf.level;

    if (median > target * 1.6 && perf.level < LEVELS.length - 1) perf.level += 1;
    else if (median < target * 0.75 && perf.level > 0) perf.level -= 1;

    if (perf.level !== was) {
        console.log(`[show] frames averaging ${median.toFixed(0)} ms against a ${target.toFixed(0)} ms `
            + `target - moving to quality level ${perf.level}`);
        renderer.setPixelRatio(LEVELS[perf.level].ratio);
        renderer.setSize(innerWidth, innerHeight);
        measure();
        wipe();
        perf.times.length = 0;
    }
}

/* ------------------------------------------------------------------ *
 * Loop                                                                *
 * ------------------------------------------------------------------ */
let running = false;
let lastFrame = 0;
let turn = 0;                      // which small panel gets this frame
let frames = 0;

function frame(now) {
    requestAnimationFrame(frame);
    const minGap = 1000 / LEVELS[perf.level].fps;
    if (now - lastFrame < minGap - 0.5) return;
    const dt = Math.min((now - lastFrame) / 1000, 0.25);
    governor(now, now - lastFrame);
    lastFrame = now;
    frames += 1;
    renderer.info.reset();

    advance(now);
    if (!cycle.paused) {
        for (const b of bridges) {
            if (!b.ready) continue;
            const dps = b === bridges[cycle.featured] ? SHOW.ORBIT_DPS : SHOW.IDLE_DPS;
            b.azimuth = (b.azimuth + dps * dt) % 360;
        }
    }

    drawPanel(panels[0]);
    // The small panels take turns, so at most one extra bridge is drawn per
    // frame - and less often than that once the governor has stepped down.
    if (frames % LEVELS[perf.level].every === 0) {
        for (let i = 0; i < SHOW.SLOTS; i++) {
            const p = panels[1 + (turn + i) % SHOW.SLOTS];
            if (drawPanel(p)) { turn = (turn + i + 1) % SHOW.SLOTS; break; }
        }
    }
}

function startLoop() {
    if (running) return;
    running = true;
    measure();
    wipe();
    lastFrame = performance.now();
    cycle.since = performance.now();
    apply({ fade: true });
    requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ *
 * Loading                                                             *
 * ------------------------------------------------------------------ */
async function loadAll() {
    for (let i = 0; i < bridges.length; i++) {
        const b = bridges[i];
        try {
            b.model = await loadGLB(b.site.file);
            b.scene = buildScene(b.model);
            b.groups = detectSensors(b.model);
            b.frame = frameFor(b.model, b.groups);
            b.frame.getCenter(b.centre);
            b.broadside = broadsideOf(b.model);
            b.azimuth = b.broadside + i * 37;
            b.highlighter = createHighlighter(NO_VIEWER, b.groups);
            // Everything at once, each type in its own colour, and it stays
            // that way - the cycle only moves the camera from here on.
            b.highlighter.set(SHOW.TYPES);
            b.ready = true;
        } catch (err) {
            console.error(`[show] ${b.site.code} failed to load`, err);
            b.failed = true;
        }

        // Start on the first bridge that arrives rather than holding a blank
        // room display for the whole 82 MB. The rest join as they land, each
        // panel showing its placeholder until then.
        if (b.ready && !running) { cycle.featured = i; startLoop(); }
        else if (running) apply();
    }

    if (!bridges.some(b => b.ready)) {
        dom.fault.textContent = 'No bridge models could be loaded. Check the files in Model-glb/.';
        dom.fault.hidden = false;
    }
}

/* ------------------------------------------------------------------ *
 * Running unattended                                                  *
 * ------------------------------------------------------------------ */
addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    measure();
    wipe();
});

dom.canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    dom.fault.textContent = 'Display interrupted - restarting…';
    dom.fault.hidden = false;
    setTimeout(() => location.reload(), 4000);
});

// Keep the screen awake. Browsers drop the lock whenever the tab is hidden, so
// it has to be taken again on the way back.
let wakeLock = null;
async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not granted */ }
}
keepAwake();
addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });

// A pointer only appears if someone actually moves one.
addEventListener('pointermove', () => document.body.classList.add('has-pointer'), { once: true });

addEventListener('keydown', e => {
    if (e.key === ' ') {
        e.preventDefault();
        cycle.paused = !cycle.paused;
        if (!cycle.paused) cycle.since = performance.now();
    } else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
    }
});

const tick = () => {
    dom.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
tick();
setInterval(tick, 10000);

/* ------------------------------------------------------------------ *
 * Go                                                                  *
 * ------------------------------------------------------------------ */
buildPanels();
measure();
loadAll();

// Same debug seam as the inspector page, for the test harness and the console.
if (params.has('debug')) {
    window.__show = { renderer, SHOW, bridges, panels, cycle, apply, step, measure, perf, LEVELS };
}
