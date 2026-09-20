/**
 * Three.js plumbing: renderer, scenes, camera, orbit controls, model loading,
 * camera fly-to, view presets and the "focus dim" pass.
 *
 * Two scenes are kept apart on purpose:
 *   scene        the bridge model
 *   markerScene  sensor markers, drawn after a depth clear so a sensor hidden
 *                behind a girder is still visible. This is also what makes the
 *                focus dim possible in a handful of lines.
 *
 * Rendering is on demand - the loop only draws when something actually moved.
 * With 1200-2100 draw calls per frame that is the difference between a warm
 * phone and a cold one.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

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

    /* ---------------- scenes ---------------- */
    const scene = new THREE.Scene();
    const markerScene = new THREE.Scene();

    // The SimLab materials declare KHR_materials_pbrSpecularGlossiness, which no
    // current three.js reads; they fall back to pbrMetallicRoughness with
    // metallic 0.5, and without an environment map that looks flat and dark.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(0.6, 1, 0.4);
    scene.add(dir);

    const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.3, 8000);
    camera.position.set(-80, 55, 90);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 1.5;
    controls.maxDistance = 4000;
    controls.zoomToCursor = true;

    const labelRenderer = new CSS2DRenderer({ element: labelsEl });
    labelRenderer.setSize(innerWidth, innerHeight);

    /* ---------------- focus dim pass ---------------- */
    // A single full-screen translucent quad drawn between the model and the
    // markers. Cheaper than any post-processing chain and reads well in daylight.
    const dimCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const dimScene = new THREE.Scene();
    const dimMat = new THREE.MeshBasicMaterial({
        color: 0x02040a, transparent: true, opacity: 0.62,
        depthTest: false, depthWrite: false,
    });
    dimScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dimMat));
    let focusDim = false;

    /* ---------------- frame scheduling ---------------- */
    let dirty = true;
    const frameCbs = [];        // return truthy to request another frame
    const beforeRenderCbs = []; // run right before drawing (sprite sizing etc.)

    const invalidate = () => { dirty = true; };
    const detach = (list, cb) => { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); };
    controls.addEventListener('change', invalidate);

    /* ---------------- camera fly-to ---------------- */
    let fly = null;
    function flyTo(toPos, toTarget, dur = 650) {
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
            const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
            for (const m of mats) {
                if (seenMat.has(m)) continue;
                seenMat.add(m);
                for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
                m.dispose();
            }
        });
    }

    function clearModel() {
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
                // Everything downstream - chainage, side, view presets - keys
                // off this rather than assuming an axis.
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

    /* ---------------- view presets ---------------- */
    const fitDistance = s => (s / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.2;

    function applyView(name) {
        if (!model) return;
        const c = model.center;
        const D = fitDistance(model.span);
        const along = model.majorAxis;          // look down the deck for elevation
        let pos;
        if (name === 'top') {
            pos = new THREE.Vector3(c.x + 0.01, c.y + D * 1.5, c.z + 0.02);
        } else if (name === 'elev') {
            // stand off the deck sideways, at deck height
            pos = along === 'z'
                ? new THREE.Vector3(c.x + D, c.y + model.span * 0.10, c.z)
                : new THREE.Vector3(c.x, c.y + model.span * 0.10, c.z + D);
        } else {
            pos = new THREE.Vector3(c.x - D * 0.65, c.y + D * 0.45, c.z + D * 0.65);
        }
        flyTo(pos, c);
    }

    /** Fly in close to a point, keeping a sensible stand-off distance. */
    function focusOn(worldPos, distance = 6) {
        if (!model) return;
        const away = worldPos.clone().sub(model.center);
        away.y = 0;
        if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
        away.normalize();
        const off = away.multiplyScalar(distance).add(new THREE.Vector3(0, distance * 0.45, 0));
        flyTo(worldPos.clone().add(off), worldPos.clone());
    }

    /* ---------------- picking ---------------- */
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    function pick(clientX, clientY, objects, recursive = false) {
        const r = canvas.getBoundingClientRect();
        ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        return raycaster.intersectObjects(objects, recursive);
    }

    /* ---------------- render ---------------- */
    function render() {
        for (const cb of beforeRenderCbs) cb();
        renderer.clear();
        renderer.render(scene, camera);
        if (focusDim) renderer.render(dimScene, dimCamera);
        renderer.clearDepth();
        renderer.render(markerScene, camera);
        labelRenderer.render(markerScene, camera);
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
        THREE, renderer, scene, markerScene, camera, controls, canvas,
        get model() { return model; },
        isTouch: IS_TOUCH,
        loadModel, clearModel,
        flyTo, isFlying, cancelFly, applyView, focusOn, fitDistance,
        pick, invalidate,
        // Both return an unsubscribe fn - marker layers register on every site
        // load, so without it the callback lists grow for the whole session.
        onFrame: cb => { frameCbs.push(cb); return () => detach(frameCbs, cb); },
        onBeforeRender: cb => { beforeRenderCbs.push(cb); return () => detach(beforeRenderCbs, cb); },
        setFocusDim(on) { focusDim = !!on; invalidate(); },
        get focusDim() { return focusDim; },
        start: animate,
    };
}
