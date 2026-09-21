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
import { HIGHLIGHT_LAYER } from './sensors.js';

const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** Coarse pointer == phone/tablet. Drives the quality/battery trade-offs. */
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

export function createViewer({ canvas }) {
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
     *   outside   off the side of the deck, looking slightly up
     *   under     below the deck looking UP at the girder soffit
     */
    function frameBox(box, mode = 'overview') {
        if (!model || box.isEmpty()) return;

        const centre = box.getCenter(new THREE.Vector3());
        const along = model.majorAxis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const across = model.majorAxis === 'x' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);

        // Approach from whichever side of the deck the group sits on, so the
        // structure is never between the camera and the equipment.
        const off = centre[model.minorAxis] - model.center[model.minorAxis];
        const side = Math.sign(off) || 1;

        const target = centre.clone();
        let radius = box.getBoundingSphere(_sphere).radius;
        if (mode === 'overview') {
            target.copy(model.center);
            radius = model.bbox.getBoundingSphere(_sphere).radius;
        }
        const D = Math.max(fitRadius(Math.max(radius, 1.5)), 5);

        let eye;
        if (mode === 'under') {
            // Stand in the space under the deck: below the girders, but above
            // the ground. Several sites model the ground as a large plane, and
            // dropping through it fills the screen with its unlit underside.
            // With the height pinned, the stand-off is taken along the bridge,
            // which is also the view an inspector actually has down there.
            target.y = box.min.y;
            const eyeY = Math.min(target.y - 0.8,
                                  Math.max(model.bbox.min.y + 1.6, target.y - D * 0.7));
            const drop = target.y - eyeY;
            const horizontal = Math.sqrt(Math.max(D * D - drop * drop, (D * 0.4) ** 2));
            const away = along.clone().negate().addScaledVector(across, 0.3 * side).normalize();
            eye = target.clone().addScaledVector(away, horizontal).setY(eyeY);
        } else {
            let dirV;
            if (mode === 'above') {
                dirV = along.clone().multiplyScalar(-0.62)
                    .addScaledVector(across, 0.5 * side)
                    .addScaledVector(new THREE.Vector3(0, 1, 0), 0.58);
            } else if (mode === 'outside') {
                dirV = across.clone().multiplyScalar(0.9 * side)
                    .addScaledVector(along, -0.35)
                    .addScaledVector(new THREE.Vector3(0, 1, 0), 0.2);
            } else {
                dirV = new THREE.Vector3(-0.65, 0.45, 0.65);
            }
            eye = target.clone().addScaledVector(dirV.normalize(), D);
        }
        flyTo(eye, target);
    }

    const frameModel = () => model && frameBox(model.bbox, 'overview');

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
        start: animate,
    };
}
