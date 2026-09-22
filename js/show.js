/**
 * Conference-room show screen.
 *
 * One big panel featuring a bridge at a time, four small panels showing the
 * ones coming up. It runs itself, and anyone who walks up to it can take over:
 * tap a small panel to bring that bridge up, drag to turn it on either axis.
 * Five seconds after they stop, it picks up where it left off.
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
 * waiting panels would flicker to black. The same flag is what lets a bridge
 * change be cross-dissolved: the outgoing pixels can still be read back out.
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
    AXLE, CAMERA, WEIGHT, CABINET,
} from './sensors.js';

// Same cache-busting import as index.html uses: js/sites.js is the file that
// gets edited between reloads and a stale copy looks like a bug.
const { SITES } = await import(`./sites.js?t=${Date.now()}`);

const params = new URLSearchParams(location.search);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ *
 * Everything worth tuning for the room                                *
 * ------------------------------------------------------------------ */
const SHOW = {
    /** Lit together on every bridge, each in its own colour, and framed
     *  together - so everything that glows is somewhere in shot. */
    TYPES:     [AXLE, CAMERA, WEIGHT, CABINET],
    /** How long each bridge holds the big panel. Five of these is one pass. */
    DWELL_MS:  Number(params.get('dwell')) || 14000,
    /** Cross-dissolve when the featured bridge changes. */
    FADE_MS:   900,
    /**
     * Orbit speed for the featured bridge, degrees per second. A turn lasts
     * DWELL_MS, so this also decides how far from broadside the shot ever
     * gets - and, because the distance is fixed, how far back it has to stand
     * to hold the whole sweep. That second part is expensive: on SSW the fit at
     * 30 deg off broadside is 59% further out than at broadside, so a wide
     * sweep buys movement by shrinking the bridge for the entire show. At
     * 2.2 deg/s a 14 s turn sweeps 31 deg, and the wider fit that pays for is
     * the price of the livelier turn - measure it before changing this.
     */
    ORBIT_DPS: 2.2,
    /**
     * And for the four waiting in the strip. Slower on purpose: those panels
     * are redrawn in rotation, a few times a second, so a gentle turn keeps
     * the step between redraws too small to read as juddering.
     */
    IDLE_DPS:  1.2,
    /**
     * The RESTING angle above the deck: what every shot is fitted at, and what
     * the tilt returns to once a hand lets go. Kept low: with the roadside
     * cameras in the shot the lit box is around 8 m tall, which makes the
     * VERTICAL fit the binding one on most bridges - and the across-deck
     * half-width enters that fit as `half * sin(elevation)`, so every degree
     * of tilt costs reach.
     */
    FRAME:     { elevation: 12 },
    /**
     * How far a hand may tilt. Not 90: orbitDir() builds its right vector from
     * UP x dir, which degenerates when the camera is straight overhead.
     */
    TILT_MAX:  80,
    /** And how far above the model's own base the camera must stay, so tilting
     *  under the deck to look up at the soffit cannot drop it through the
     *  ground into the unlit underside. */
    GROUND_CLEAR: 1.5,
    /** Floor on the speed the tilt returns at. The return is mostly
     *  proportional, which eases it; this is what guarantees it arrives. */
    TILT_HOME_DPS: 8,
    /** Breathing room around the lit equipment, as a multiple of the tight fit. */
    FIT_PAD:   1.12,
    /** Degrees of turn per pixel dragged. */
    DRAG_DPP:  0.3,
    /**
     * Stillness before the display takes itself back: the bridge starts
     * turning again, the tilt eases home, and the cycle is free to move on.
     * One number for all three - "back to normal" should not arrive in
     * instalments.
     */
    HOLD_MS:   5000,
    /**
     * What the governor aims for. The per-level cap may be higher; this is the
     * line below which frames are judged too slow, and it stays fixed so the
     * target cannot move with the level and set off an oscillation.
     */
    TARGET_MS: 1000 / 30,
    SLOTS:     4,
};

/**
 * Exceptions to the standard shot, by site code.
 *
 * Everything stays LIT either way - this only decides what the camera has to
 * hold in frame, and what it turns about.
 *
 * SSW earns one. Its two cameras are on a single post at z 64 while the weigh
 * station sits at z 39-46, so framing all four types puts the centre of the
 * box at z 51.5 - in empty road, with nothing there to be the still point and
 * the equipment swinging round the outside of it. Framing the weigh station
 * and pivoting on the cabinet puts the still point on the hardware and, as a
 * bonus, more than halves the amount of scene on screen. The cameras go on
 * glowing; they simply leave the frame.
 */
const SHOT = {
    SSW: { frame: [AXLE, WEIGHT, CABINET], pivot: CABINET },
};

const $ = id => document.getElementById(id);
const dom = {
    canvas: $('stage'), big: $('big'), strip: $('strip'),
    bigName: $('bigName'), bigCode: $('bigCode'), bigLegend: $('bigLegend'),
    bigWait: $('bigWait'), held: $('held'),
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
    // Required twice over: panels that are not redrawn this frame must keep
    // their pixels, and a bridge change reads the outgoing pixels back out.
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

/** Unit vector from the target towards a camera at this azimuth and elevation. */
function orbitDir(azDeg, elDeg) {
    const az = THREE.MathUtils.degToRad(azDeg);
    const el = THREE.MathUtils.degToRad(elDeg);
    return _dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

/**
 * How far back the camera has to stand at this angle for the whole box to fit.
 *
 * The bridges are long and thin, so a bounding sphere would leave them tiny
 * end-on and overflowing side-on. Measuring the eight box corners along the
 * camera's own axes instead keeps the bridge filling the panel all the way
 * round the orbit.
 *
 * `deepest` comes back separately because it is the term that swings hardest
 * with azimuth - it is the box's reach towards the camera, so it grows as the
 * long axis turns into the view direction. Adding it to a fit recomputed every
 * frame is what used to make the shot creep in and out.
 */
function fitDistance(box, centre, fov, aspect, azDeg, elDeg) {
    orbitDir(azDeg, elDeg);
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
    const vHalf = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const hHalf = vHalf * aspect;
    return { fit: Math.max(needU / vHalf, needR / hHalf) * SHOW.FIT_PAD + deepest, deepest };
}

/** Put `cam` on the orbit at a distance somebody else decided. */
function aim(cam, centre, azDeg, elDeg, radius) {
    cam.position.copy(centre).addScaledVector(orbitDir(azDeg, elDeg), radius);
    cam.lookAt(centre);
}

/** Signed degrees from `a` round to `b`, in -180..180. */
const offsetDeg = (a, b) => ((a - b + 540) % 360) - 180;

/** Half the arc the orbit sweeps while a bridge is featured, plus a margin.
 *  Capped, because ?dwell= can make the sweep arbitrarily long. */
const fitArc = () => Math.min(turnSweep() / 2 + 2, 25);

/**
 * The fixed distance for this bridge in a panel of this shape.
 *
 * Worked out once and cached, which is the whole point: recomputing the fit
 * every frame is what made the shot zoom in and out as it turned. The cache key
 * carries the field of view and the aspect, so it invalidates itself when a
 * panel changes shape and nothing has to remember to clear it.
 *
 * Fitted over the arc the show actually sweeps and NOT over the full circle.
 * The two are far apart: the equipment runs three to four times longer than it
 * is deep, so the end-on fit sits 45-60% further out than the broadside one,
 * and fitting the circle would hold every bridge at its worst angle for the
 * whole show. Turned past the arc by hand it grows past the edges of the panel,
 * which is exactly what a fixed distance should do.
 */
function radiusFor(b, cam) {
    const key = `${cam.fov}@${cam.aspect.toFixed(3)}`;
    const cached = b.fit.get(key);
    if (cached !== undefined) return cached;

    const arc = fitArc();
    let sweep = 0, worstDeep = 0;
    for (let a = 0; a < 360; a += 3) {
        const m = fitDistance(b.frame, b.centre, cam.fov, cam.aspect, a, SHOW.FRAME.elevation);
        worstDeep = Math.max(worstDeep, m.deepest);
        if (Math.abs(offsetDeg(a, b.broadside)) <= arc) sweep = Math.max(sweep, m.fit);
    }
    // One guarantee that has to hold outside the arc too: turned by hand to any
    // angle at all, the camera still ends up outside the box rather than
    // somewhere inside the bridge.
    const r = Math.max(sweep, worstDeep * 1.05 + 1);
    b.fit.set(key, r);
    return r;
}

/**
 * Which side to stand on - found, not assumed.
 *
 * Across the deck is the obvious answer and the right one four times out of
 * five. It is wrong on PM1-BWK, where the equipment spans 25 m ACROSS a 35 m
 * wide bridge and only 17 m along it: standing across the deck there turns the
 * long dimension into depth and pushes the camera 35 m back, where looking
 * along the deck needs 28. So sweep the circle, take the cheapest angle, and
 * prefer the deck broadside among everything within 5% of it - the search then
 * only overrules the classic shot where the equipment really is laid out the
 * other way round.
 */
function chooseBroadside(box, centre, fov, aspect, deckAz) {
    const fits = [];
    let cheapest = Infinity;
    for (let a = 0; a < 360; a += 3) {
        const { fit } = fitDistance(box, centre, fov, aspect, a, SHOW.FRAME.elevation);
        fits.push([a, fit]);
        cheapest = Math.min(cheapest, fit);
    }
    let pick = deckAz, closest = Infinity;
    for (const [a, fit] of fits) {
        if (fit > cheapest * 1.05) continue;
        const off = Math.abs(offsetDeg(a, deckAz));
        if (off < closest) { closest = off; pick = a; }
    }
    return pick;
}

/**
 * What the shot is of: everything that gets lit, and nothing else.
 *
 * NOT the whole bridge. These decks are 80-130 m long and the equipment sits in
 * a weigh station on one of them; fitting the full model puts the camera 110 m
 * back, where the sensors are a few pixels and the point of the screen is lost.
 * With the roadside cameras in it this box runs 17-41 m - they are mounted
 * 23-41 m apart on four of the five bridges - against 7-21 m for the weigh
 * station on its own.
 *
 * Deliberately unpadded. The slack that keeps bridge in shot around the
 * equipment is slack the fit already carries for the orbit sweep: the camera
 * stands back far enough for the angle at the end of the sweep, so at broadside
 * there is room to spare on every side. Padding the box as well would pay for
 * the same margin twice.
 */
function litBox(model, groups, keys = SHOW.TYPES) {
    const box = new THREE.Box3();
    for (const k of keys) {
        const g = groups[k];
        if (g && g.focus && !g.focus.isEmpty()) box.union(g.focus);
    }
    return box.isEmpty() ? model.bbox.clone() : box;
}

/** Square across the deck: the shot to prefer when nothing argues against it. */
const deckBroadside = model => (model.majorAxis === 'z' ? 90 : 0);

/** How far the orbit travels while a bridge holds the big panel. */
const turnSweep = () => SHOW.ORBIT_DPS * SHOW.DWELL_MS / 1000;

/* ------------------------------------------------------------------ *
 * Bridges                                                             *
 * ------------------------------------------------------------------ */
/** One per site. `azimuth` lives here, not on the panel, so a bridge keeps
 *  turning at the same rate whichever panel it is currently shown in - and
 *  arrives on the big panel still facing where someone turned it. */
const bridges = SITES.map((site, i) => ({
    site, ready: false, failed: false,
    model: null, scene: null, groups: null, highlighter: null,
    azimuth: 0,                         // set from chooseBroadside() once loaded
    broadside: 0,
    /** Tilt lives on the bridge too, so one turned by hand in the strip
     *  arrives on the big panel still tilted that way. It returns to
     *  SHOW.FRAME.elevation once the hand has been off it for HOLD_MS. */
    elevation: SHOW.FRAME.elevation,
    /** -Infinity, not 0: performance.now() starts near zero, so a plain 0 would
     *  read as "touched a moment ago" and hold every bridge still for the
     *  first HOLD_MS after the page loads. */
    touchedAt: -Infinity,
    // Worked out once at load: everything is lit at once, so the shot never
    // changes while a bridge is on screen. `frame` is the lit equipment,
    // `fit` caches the fixed camera distance, one entry per panel shape.
    frame: null, centre: new THREE.Vector3(), fit: new Map(),
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
 *          code:HTMLElement, freeze:HTMLCanvasElement, drawn:number}[]} */
const panels = [];

/** The snapshot an outgoing bridge dissolves from. One per cell. */
function addFreeze(cell) {
    const c = el('canvas', { class: 'freeze', 'aria-hidden': 'true' });
    c.style.opacity = '0';
    cell.appendChild(c);
    return c;
}

function buildPanels() {
    panels.push({
        el: dom.big, big: true, wait: dom.bigWait,
        name: dom.bigName, code: dom.bigCode, freeze: addFreeze(dom.big),
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
            el: cell, big: false, wait, name, code, freeze: addFreeze(cell),
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
    aim(cam, b.centre, b.azimuth, b.elevation, radiusFor(b, cam));

    // Two passes, so the lit equipment reads through the structure. The second
    // is cheap wherever it is used - the camera is restricted to the highlight
    // layer, so it draws the few hundred lit meshes and not the bridge's
    // 1 200-2 100 - which is why the small panels get it too. Without it their
    // sensors sit behind the deck and may as well not be lit at all.
    renderer.clear();
    cam.layers.set(0);
    renderer.render(b.scene, cam);
    renderer.render(dimScene, dimCamera);
    renderer.clearDepth();
    cam.layers.set(HIGHLIGHT_LAYER);
    renderer.render(b.scene, cam);
    cam.layers.set(0);

    p.drawn += 1;
    return true;
}

/* ------------------------------------------------------------------ *
 * The cycle                                                           *
 * ------------------------------------------------------------------ */
const cycle = { featured: 0, since: 0, paused: false, hold: 0 };
/** Set when a bridge change needs every panel redrawn on the next frame, so
 *  the new content is in place before the dissolve uncovers it. */
let redrawAll = false;

/** Skip past any bridge whose model never arrived. */
function nextLive(from, step = 1) {
    for (let i = 1; i <= bridges.length; i++) {
        const j = (from + step * i + bridges.length * i) % bridges.length;
        if (bridges[j].ready) return j;
    }
    return from;
}

/** One chip per sensor type, in its own colour. Built once: every bridge
 *  carries all four types, so this is a key to the colours and nothing more. */
function buildLegend() {
    dom.bigLegend.replaceChildren(...SHOW.TYPES.map(key => {
        const t = typeDef(key);
        const chip = el('span', { class: 'chip', text: t.label });
        chip.style.setProperty('--c', t.css);
        return chip;
    }));
}

/**
 * Freeze the panels that are about to change bridge.
 *
 * Reading the pixels back out is only possible because the renderer was asked
 * for preserveDrawingBuffer. Note the source rectangle is the plain DOM one,
 * top-left origin - not the Y-flipped rectangle measure() keeps for GL.
 */
function snapshot(changing) {
    if (REDUCED) return;
    const ratio = renderer.getPixelRatio();
    for (const p of changing) {
        const r = p.el.getBoundingClientRect();
        const w = Math.round(r.width * ratio), h = Math.round(r.height * ratio);
        if (w < 2 || h < 2) continue;
        const c = p.freeze;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        try {
            c.getContext('2d').drawImage(dom.canvas,
                Math.round(r.left * ratio), Math.round(r.top * ratio), w, h, 0, 0, w, h);
        } catch { continue; }            // context lost mid-change - just cut
        // Opaque with no transition, committed, then released to ease away.
        c.classList.add('instant');
        c.style.opacity = '1';
        void c.offsetWidth;
        c.classList.remove('instant');
        c.style.opacity = '0';
    }
}

/** Swap a caption under cover of the dissolve rather than letting it pop. */
function swapText(node, text, fade) {
    if (node.textContent === text) return;
    clearTimeout(node._swap);
    if (!fade || REDUCED) { node.textContent = text; node.style.opacity = '1'; return; }
    node.style.opacity = '0';
    node._swap = setTimeout(() => {
        node.textContent = text;
        node.style.opacity = '1';
    }, SHOW.FADE_MS * 0.35);
}

/**
 * Put the featured bridge on the big panel and the rest in the strip.
 *
 * `fade`      cross-dissolve every panel whose bridge changes.
 * `keepAngle` leave the incoming bridge turned where it is. The cycle restarts
 *             the sweep so a bridge always passes through broadside halfway
 *             through its turn; a promotion by hand keeps the angle the person
 *             just dragged it to.
 */
function apply({ fade = false, keepAngle = false } = {}) {
    const featured = bridges[cycle.featured];

    const want = panels.map((p, i) =>
        i === 0 ? cycle.featured : (cycle.featured + i) % bridges.length);
    const changing = panels.filter((p, i) => p.bridge !== want[i]);
    if (fade && changing.length) snapshot(changing);

    if (!keepAngle && featured.ready) {
        featured.azimuth = featured.broadside - turnSweep() / 2;
        featured.elevation = SHOW.FRAME.elevation;
    }
    panels.forEach((p, i) => { p.bridge = want[i]; });

    swapText(dom.bigName, featured.site.name, fade);
    swapText(dom.bigCode, featured.site.code, fade);

    for (const p of panels) {
        const b = bridges[p.bridge];
        if (!p.big) {
            swapText(p.name, b.site.name, fade);
            swapText(p.code, b.site.code, fade);
        }
        p.wait.hidden = b.ready;
        p.wait.classList.toggle('failed', b.failed);
        if (b.failed) p.wait.textContent = `${b.site.code} unavailable`;
    }

    if (changing.length) redrawAll = true;
}

function advance(now) {
    if (cycle.paused || now < cycle.hold || now - cycle.since < SHOW.DWELL_MS) return;
    cycle.since = now;
    cycle.featured = nextLive(cycle.featured);
    apply({ fade: true });
}

function step(dir) {
    cycle.since = performance.now();
    cycle.featured = nextLive(cycle.featured, dir);
    apply({ fade: true });
}

/** Bring one bridge up on the big panel, keeping however it has been turned. */
function feature(index) {
    if (index === cycle.featured || !bridges[index] || !bridges[index].ready) return;
    cycle.since = performance.now();
    cycle.featured = index;
    apply({ fade: true, keepAngle: true });
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
    showState();
    if (!cycle.paused) {
        for (const b of bridges) {
            // Leave alone what is under a hand, and what a hand has only just
            // let go of - that pause is the whole point of HOLD_MS.
            if (!b.ready || b === drag.bridge || now - b.touchedAt < SHOW.HOLD_MS) continue;
            const dps = b === bridges[cycle.featured] ? SHOW.ORBIT_DPS : SHOW.IDLE_DPS;
            b.azimuth = (b.azimuth + dps * dt) % 360;
            homeTilt(b, dt);
        }
    }

    if (redrawAll) {
        // One heavy frame, hidden behind an opaque snapshot: every panel has to
        // be holding its new bridge before the dissolve starts to uncover it.
        redrawAll = false;
        for (const p of panels) drawPanel(p);
        return;
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
    apply();
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
            const shot = SHOT[b.site.code] || {};
            b.frame = litBox(b.model, b.groups, shot.frame);
            // What the camera turns about: a named group's centre where one is
            // called for, the middle of the framed box otherwise. The fit takes
            // the box and the pivot separately, so an off-centre pivot is
            // handled already - it just costs reach.
            const pivot = shot.pivot && b.groups[shot.pivot];
            if (pivot && pivot.focus && !pivot.focus.isEmpty()) pivot.focus.getCenter(b.centre);
            else b.frame.getCenter(b.centre);
            b.elevation = SHOW.FRAME.elevation;
            // Judged on the big panel's shape, since that is the one that
            // matters; the strip then uses the same angle at its own distance.
            const big = panels[0].rect;
            b.broadside = chooseBroadside(b.frame, b.centre, panels[0].camera.fov,
                                          big.w / big.h, deckBroadside(b.model));
            b.azimuth = b.broadside + i * 11;
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
 * Anyone who walks up to it                                           *
 * ------------------------------------------------------------------ */
/** The bridge currently under someone's finger; its auto-orbit stands down. */
const drag = { bridge: null };

/** Someone is working on this bridge: hold its orbit, and stop the cycle
 *  taking it away from them. Both let go HOLD_MS after the last movement. */
function touched(b) {
    const now = performance.now();
    b.touchedAt = now;
    cycle.hold = now + SHOW.HOLD_MS;
}

/**
 * How far down this bridge can be tilted before the camera goes through the
 * ground. At elevation `e` the eye sits `sin(e) * radius` above the pivot, so
 * the limit is where that equals the drop from the pivot to the ground - and
 * where the pivot is already lower than that, the camera may not go below
 * level at all.
 */
function tiltFloor(b, radius) {
    const drop = b.centre.y - (b.model.bbox.min.y + SHOW.GROUND_CLEAR);
    if (drop >= radius) return -SHOW.TILT_MAX;
    const deg = THREE.MathUtils.radToDeg(Math.asin(Math.max(drop, 0) / radius));
    return Math.max(-SHOW.TILT_MAX, -deg);
}

/** Ease the tilt back to the resting angle. Mostly proportional, so it leaves
 *  quickly and settles softly, with a floor on the speed so it arrives. */
function homeTilt(b, dt) {
    const d = SHOW.FRAME.elevation - b.elevation;
    if (Math.abs(d) < 0.05) { b.elevation = SHOW.FRAME.elevation; return; }
    const step = Math.min(Math.abs(d), Math.max(Math.abs(d) * 3.5, SHOW.TILT_HOME_DPS) * dt);
    b.elevation += Math.sign(d) * step;
}

/** Say so when a presenter has stopped it on the space bar. Touching the screen
 *  also holds the cycle, but only for five seconds and only while whoever did
 *  it is standing right there, so that needs no announcing. */
function showState() {
    const state = cycle.paused ? 'paused' : '';
    if (dom.held.textContent === state) return;
    dom.held.textContent = state;
    dom.held.hidden = !state;
}

/**
 * Drag to turn on either axis, tap a small panel to bring it up.
 *
 * Both angles move; the distance never does, so a hand can turn a bridge to
 * any angle at all but can never zoom it into something unrecognisable. The
 * camera follows the drag on both axes - pull right and it swings right, pull
 * up and it rises. Because the angles live on the bridge rather than on the
 * panel, one turned in the strip arrives on the big panel still facing that way.
 *
 * The fit is worked out at the RESTING tilt and cached, so a steep tilt lets
 * the bridge grow past the edges of the panel, exactly as turning past the
 * fitted arc already does. That is the deal a fixed distance buys, and five
 * seconds later the tilt has eased home anyway.
 */
function bindPointer(p) {
    let id = null, startX = 0, startY = 0, fromAz = 0, fromEl = 0, moved = false, turning = null;

    p.el.addEventListener('pointerdown', e => {
        if (id !== null) return;
        turning = bridges[p.bridge];
        if (!turning || !turning.ready) return;
        id = e.pointerId;
        try { p.el.setPointerCapture(id); } catch { /* nothing to capture */ }
        startX = e.clientX; startY = e.clientY;
        fromAz = turning.azimuth;
        fromEl = turning.elevation;
        moved = false;
        drag.bridge = turning;
        touched(turning);
        document.body.classList.add('has-pointer', 'dragging');
    });

    p.el.addEventListener('pointermove', e => {
        if (e.pointerId !== id) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > 4) moved = true;
        if (moved) {
            turning.azimuth = fromAz + dx * SHOW.DRAG_DPP;
            const floor = tiltFloor(turning, radiusFor(turning, p.camera));
            turning.elevation = Math.min(SHOW.TILT_MAX,
                Math.max(floor, fromEl - dy * SHOW.DRAG_DPP));
        }
        touched(turning);
    });

    const release = e => {
        if (e.pointerId !== id) return;
        try { p.el.releasePointerCapture(id); } catch { /* already gone */ }
        id = null;
        drag.bridge = null;
        document.body.classList.remove('dragging');
        touched(turning);
        // A tap on a waiting bridge promotes it. The big panel does nothing:
        // pause stays on the space bar, where a visitor cannot hit it by
        // accident while turning the bridge.
        if (!moved && !p.big) feature(p.bridge);
    };
    p.el.addEventListener('pointerup', release);
    p.el.addEventListener('pointercancel', release);
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
        if (!cycle.paused) { cycle.since = performance.now(); cycle.hold = 0; }
        showState();                    // right away, not on the next frame
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
buildLegend();
panels.forEach(bindPointer);
measure();
loadAll();

// Same debug seam as the inspector page, for the test harness and the console.
if (params.has('debug')) {
    window.__show = {
        renderer, SHOW, SHOT, bridges, panels, cycle, apply, step, feature, measure,
        perf, LEVELS, radiusFor, drag, tiltFloor, homeTilt, litBox,
    };
}
