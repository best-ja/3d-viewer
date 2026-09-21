/**
 * Three.js plumbing: renderer, scene, camera, orbit controls, model loading,
 * camera fly-to and framing, and the highlight overlay pass.
 *
 * The overlay pass is what lets a 150 mm strain plate bolted to a girder web
 * read on a 130 m bridge. Highlighted meshes are moved to HIGHLIGHT_LAYER, and
 * a frame is drawn as:
 *
 *   layer 0  the model
 *            a full-screen dim quad, so the structure recedes
 *   depth clear
 *   layer 1  the highlighted equipment, drawn over everything
 *
 * Rendering is on demand - the loop only draws when something actually moved.
 * With 1200-2100 draw calls per frame that is the difference between a warm
 * phone and a cold one.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { HIGHLIGHT_LAYER } from './sensors.js';

const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** Coarse pointer == phone/tablet. Drives the quality/battery trade-offs. */
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

export function createViewer({ canvas, labelsEl }) {
    /* ---------------- renderer ---------------- */
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: !IS_TOUCH,                 // MSAA is expensive on mobile GPUs
        alpha: true,
        powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, IS_TOUCH ? 1.5 : 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearAlpha(0);
    renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.autoClear = false;               // we drive the passes by hand

    /* ---------------- scene ---------------- */
    const scene = new THREE.Scene();

    // The SimLab materials declare KHR_materials_pbrSpecularGlossiness, which no
    // current three.js reads; they fall back to pbrMetallicRoughness with
    // metallic 0.5, and without an environment map that looks flat and dark.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(0.6, 1, 0.4);
    scene.add(dir);

    // Fill from below. The weight sensors are viewed looking up at the girder
    // soffit, which catches nothing from the key light and renders pure black.
    const fill = new THREE.DirectionalLight(0xdbeafe, 1.3);
    fill.position.set(-0.35, -1, -0.25);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.3, 8000);
    camera.position.set(-80, 55, 90);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 1.5;
    controls.maxDistance = 4000;
    controls.zoomToCursor = true;

    /* ---------------- dim pass ---------------- */
    const dimCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const dimScene = new THREE.Scene();
    dimScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({
        color: 0x02040a, transparent: true, opacity: 0.45,
        depthTest: false, depthWrite: false,
    })));
    let overlay = false;      // true while a type is highlighted

    /* ---------------- frame scheduling ---------------- */
    let dirty = true;
    const frameCbs = [];        // return truthy to request another frame
    const beforeRenderCbs = [];

    const invalidate = () => { dirty = true; };
    const detach = (list, cb) => { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); };
    controls.addEventListener('change', invalidate);

    /* ---------------- camera fly-to ---------------- */
    let fly = null;
    function flyTo(toPos, toTarget, dur = 750) {
        fly = {
            fromP: camera.position.clone(), toP: toPos.clone(),
            fromT: controls.target.clone(), toT: toTarget.clone(),
            start: performance.now(), dur,
        };
        controls.enabled = false;
        invalidate();
    }
    const isFlying = () => fly !== null;
    function cancelFly() {
        if (!fly) return;
        fly = null;
        controls.enabled = true;
    }

    /* ---------------- model ---------------- */
    let model = null;   // { root, bbox, center, size, span, majorAxis, minorAxis }

    function disposeObject(root) {
        const seenGeo = new Set(), seenMat = new Set();
        root.traverse(o => {
            if (o.geometry && !seenGeo.has(o.geometry)) { seenGeo.add(o.geometry); o.geometry.dispose(); }
            // A highlight may still be applied; the original is what needs freeing.
            const mats = [o.userData.origMaterial, ...(Array.isArray(o.material) ? o.material : [o.material])];
            for (const m of mats) {
                if (!m || seenMat.has(m)) continue;
                seenMat.add(m);
                for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
                m.dispose();
            }
        });
    }

    function clearModel() {
        clearPierLabels();
        if (!model) return;
        scene.remove(model.root);
        disposeObject(model.root);
        model = null;
        invalidate();
    }

    function loadModel(url, onProgress) {
        clearModel();
        return new Promise((resolve, reject) => {
            new GLTFLoader().load(url, gltf => {
                const root = gltf.scene;
                root.updateMatrixWorld(true);
                scene.add(root);

                const bbox = new THREE.Box3().setFromObject(root);
                const center = bbox.getCenter(new THREE.Vector3());
                const size = bbox.getSize(new THREE.Vector3());

                // Bridges run along X on some sites (BRC) and Z on the others.
                // Every framing decision keys off this rather than assuming.
                const majorAxis = size.x >= size.z ? 'x' : 'z';
                const minorAxis = majorAxis === 'x' ? 'z' : 'x';
                const span = Math.max(size.x, size.z);

                camera.near = Math.max(0.1, span / 4000);
                camera.far = span * 12;
                camera.updateProjectionMatrix();
                controls.maxDistance = span * 4;
                controls.target.copy(center);

                model = { root, bbox, center, size, span, majorAxis, minorAxis };
                invalidate();
                resolve(model);
            }, onProgress, reject);
        });
    }

    /* ---------------- framing ---------------- */
    // Distance at which a sphere of this radius fits. Both FOV axes matter: a
    // portrait phone is far narrower horizontally than vertically, and fitting
    // only the vertical crops a wide run of sensors straight off the sides.
    const _sphere = new THREE.Sphere();
    const _ray = new THREE.Raycaster();
    _ray.layers.enableAll();
    const _rayBox = new THREE.Box3();
    const _raySize = new THREE.Vector3();
    const _dir = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);

    /** Swings tried when the computed shot is blocked, and how far to close in
     *  if swinging alone does not help. Under a deck there is structure in
     *  every horizontal direction, so backing off is not always an option -
     *  coming in past the obstruction is. */
    const VIEW_SWINGS = [0, Math.PI, Math.PI / 4, -Math.PI / 4,
                         Math.PI / 2, -Math.PI / 2, 3 * Math.PI / 4, -3 * Math.PI / 4];
    const VIEW_SCALES = [1, 0.6, 0.45];
    /** Anything this close to the target is what the equipment is mounted on,
     *  not something in the way. */
    const MOUNTED_ON = 1.5;

    /**
     * How many things bigger than 30 cm stand between the camera and what it is
     * pointed at. Runs once per selection, never per frame.
     */
    function blockedCount(eye, target, ignore) {
        if (!model) return 0;
        const dist = eye.distanceTo(target);
        const far = dist - MOUNTED_ON;
        if (far <= 0) return 0;
        _ray.set(eye, _dir.subVectors(target, eye).normalize());
        _ray.far = far;
        let n = 0;
        for (const hit of _ray.intersectObject(model.root, true)) {
            if (ignore && ignore.has(hit.object)) continue;
            _rayBox.setFromObject(hit.object).getSize(_raySize);
            if (Math.max(_raySize.x, _raySize.y, _raySize.z) > 0.3) n++;
        }
        return n;
    }
    function fitRadius(radius) {
        const vHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        const hHalf = vHalf * camera.aspect;
        return (radius / Math.min(vHalf, hHalf)) * 1.08;
    }

    /**
     * Point the camera at a bounding box from a direction chosen for what is
     * being shown.
     *
     *   overview  the whole structure, raised three-quarter view
     *   above     looking down onto the deck
     *   roadside  from over the carriageway, looking down and outward
     *   outside   off the side of the deck, looking slightly up
     *   under     below the deck looking UP at the girder soffit
     */
    function frameBox(box, mode = 'overview', { ignore, view } = {}) {
        if (!model || box.isEmpty()) return;

        const centre = box.getCenter(new THREE.Vector3());
        const along = model.majorAxis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const across = model.majorAxis === 'x' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);

        // Approach from whichever side of the deck the group sits on, so the
        // structure is never between the camera and the equipment. For a group
        // sitting near the centreline this sign is close to arbitrary, which is
        // why the line-of-sight search below matters.
        const off = centre[model.minorAxis] - model.center[model.minorAxis];
        const side = (Math.sign(off) || 1) * (view?.flip ? -1 : 1);

        const target = centre.clone();
        let radius = box.getBoundingSphere(_sphere).radius;
        if (mode === 'overview') {
            target.copy(model.center);
            radius = model.bbox.getBoundingSphere(_sphere).radius;
        }
        const D = Math.max(fitRadius(Math.max(radius, 1.5)), 5);

        // Each mode reduces to a horizontal direction plus, for `under`, a
        // pinned height. Both depend on how far back the shot is taken, so they
        // are recomputed per candidate distance.
        let baseDir;
        const geometryFor = d => {
            if (mode !== 'under') return { reach: d, eyeY: null };
            const eyeY = Math.min(target.y - 0.8,
                                  Math.max(model.bbox.min.y + 1.6, target.y - d * 0.7));
            const drop = target.y - eyeY;
            return { reach: Math.sqrt(Math.max(d * d - drop * drop, (d * 0.4) ** 2)), eyeY };
        };
        if (mode === 'under') {
            // Stand in the space under the deck: below the girders, but above
            // the ground. Several sites model the ground as a large plane, and
            // dropping through it fills the screen with its unlit underside.
            // With the height pinned, the stand-off is taken along the bridge,
            // which is also the view an inspector actually has down there.
            target.y = box.min.y;
            baseDir = along.clone().negate().addScaledVector(across, 0.3 * side).setY(0).normalize();
        } else if (mode === 'above') {
            baseDir = along.clone().multiplyScalar(-0.62)
                .addScaledVector(across, 0.5 * side)
                .addScaledVector(UP, 0.58).normalize();
        } else if (mode === 'roadside') {
            // Stand over the carriageway. Axle detectors are mounted on a
            // ~1.85 m barrier whose centre is only 0.2 m outboard of them,
            // so approaching from outside - which every other raised mode
            // does - puts the wall between the camera and the device. This
            // negates `side` to come in from the deck centre instead, which
            // is also the face the detector actually points at.
            baseDir = across.clone().multiplyScalar(-0.85 * side)
                .addScaledVector(along, -0.30)
                .addScaledVector(UP, 0.45).normalize();
        } else if (mode === 'outside') {
            baseDir = across.clone().multiplyScalar(0.9 * side)
                .addScaledVector(along, -0.35)
                .addScaledVector(UP, 0.2).normalize();
        } else {
            baseDir = new THREE.Vector3(-0.65, 0.45, 0.65).normalize();
        }

        /** The same shot, swung `rot` radians around the target and taken from
         *  `scale` of the fitted distance. */
        const eyeAt = (rot, scale = 1) => {
            const { reach, eyeY } = geometryFor(D * scale);
            const h = new THREE.Vector3(baseDir.x, 0, baseDir.z).applyAxisAngle(UP, rot);
            if (mode === 'under') {
                return target.clone().addScaledVector(h.normalize(), reach).setY(eyeY);
            }
            return target.clone()
                .addScaledVector(new THREE.Vector3(h.x, baseDir.y, h.z).normalize(), reach);
        };

        let eye;
        if (Number.isFinite(view?.azimuth)) {
            // An explicit angle is what was asked for, so take it as given -
            // but still say so if it turns out to look into something.
            // azimuth(v) = atan2(v.x, -v.z), and rotating about +Y *decreases*
            // it, so the swing needed is current - wanted, not the reverse.
            const want = THREE.MathUtils.degToRad(view.azimuth);
            eye = eyeAt(Math.atan2(baseDir.x, -baseDir.z) - want);
            const n = blockedCount(eye, target, ignore);
            if (n) console.warn(`[view] ${mode} pinned to ${view.azimuth}° but ${n} object(s) block it.`);
        } else {
            // Try the computed shot, then swing round, then close in.
            let bestN = Infinity;
            outer:
            for (const scale of VIEW_SCALES) {
                for (const rot of VIEW_SWINGS) {
                    const e = eyeAt(rot, scale);
                    const n = blockedCount(e, target, ignore);
                    if (n === 0) { eye = e; bestN = 0; break outer; }
                    if (n < bestN) { bestN = n; eye = e; }
                }
            }
            if (bestN > 0) {
                console.warn(`[view] no clear angle for ${mode}; best of `
                    + `${VIEW_SWINGS.length * VIEW_SCALES.length} tried still has `
                    + `${bestN} object(s) in the way.`);
            }
        }
        flyTo(eye, target);
    }

    const frameModel = () => model && frameBox(model.bbox, 'overview');

    /* ---------------- pier name tags ----------------
       Pier numbers come from the `piers` list in js/sites.js - they are not in
       the model files. The label renderer only runs when there are labels, so
       with the toggle off this costs nothing. */
    const pierGroup = new THREE.Group();
    scene.add(pierGroup);
    const labelRenderer = new CSS2DRenderer({ element: labelsEl });
    labelRenderer.setSize(innerWidth, innerHeight);

    function clearPierLabels() {
        for (const o of [...pierGroup.children]) {
            o.element?.remove();
            pierGroup.remove(o);
        }
        invalidate();
    }

    /** Tag height: high on the structure, so tags line up and read against the
     *  sky whether they came from the model or from the sites.js list. */
    const tagY = () => model.bbox.min.y + (model.bbox.max.y - model.bbox.min.y) * 0.82;

    /** A point on the deck centreline at chainage `at` along the long axis. */
    function pointAtChainage(at) {
        if (!model || !Number.isFinite(at)) return null;
        return new THREE.Vector3(
            model.majorAxis === 'x' ? at : model.center.x,
            tagY(),
            model.majorAxis === 'x' ? model.center.z : at,
        );
    }

    /** @param piers [{ label, position }] */
    function setPierLabels(piers) {
        clearPierLabels();
        if (!model || !piers?.length) return;
        for (const p of piers) {
            if (!p?.position) continue;
            const el = document.createElement('div');
            el.className = 'pier-tag';
            el.textContent = p.label;               // textContent: Thai-safe
            const o = new CSS2DObject(el);
            o.position.set(p.position.x, tagY(), p.position.z);
            pierGroup.add(o);
        }
        invalidate();
    }

    /* ---------------- render ---------------- */
    function render() {
        for (const cb of beforeRenderCbs) cb();
        renderer.clear();
        camera.layers.set(0);
        renderer.render(scene, camera);
        if (overlay) {
            renderer.render(dimScene, dimCamera);
            renderer.clearDepth();
            camera.layers.set(HIGHLIGHT_LAYER);
            renderer.render(scene, camera);
            camera.layers.set(0);
        }
        if (pierGroup.children.length) labelRenderer.render(scene, camera);
    }

    function animate() {
        requestAnimationFrame(animate);
        const t = performance.now();
        let changed = false;

        if (fly) {
            const k = Math.min(1, (t - fly.start) / fly.dur);
            const e = easeInOut(k);
            camera.position.lerpVectors(fly.fromP, fly.toP, e);
            controls.target.lerpVectors(fly.fromT, fly.toT, e);
            camera.lookAt(controls.target);
            if (k >= 1) { fly = null; controls.enabled = true; }
            changed = true;
        } else if (controls.update()) {
            changed = true;
        }

        for (const cb of frameCbs) if (cb(t)) changed = true;

        if (changed || dirty) { dirty = false; render(); }
    }

    /* ---------------- resize ---------------- */
    function resize() {
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(innerWidth, innerHeight);
        labelRenderer.setSize(innerWidth, innerHeight);
        invalidate();
    }
    addEventListener('resize', resize);
    addEventListener('orientationchange', () => setTimeout(resize, 250));

    return {
        THREE, renderer, scene, camera, controls, canvas,
        get model() { return model; },
        isTouch: IS_TOUCH,
        loadModel, clearModel,
        flyTo, isFlying, cancelFly, frameBox, frameModel, fitRadius,
        invalidate,
        // Both return an unsubscribe fn.
        onFrame: cb => { frameCbs.push(cb); return () => detach(frameCbs, cb); },
        onBeforeRender: cb => { beforeRenderCbs.push(cb); return () => detach(beforeRenderCbs, cb); },
        setOverlay(on) { overlay = !!on; invalidate(); },
        setPierLabels, clearPierLabels, pointAtChainage,
        start: animate,
    };
}
