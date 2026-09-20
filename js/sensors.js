/**
 * Sensor detection and on-screen highlighting.
 *
 * Nothing about sensors is hardcoded per site. Every GLB in Model-glb/ is a
 * SimLab export that carries the same node names for the installed hardware:
 *
 *   TF03-100 LiDAR-R004[_1]   x4 per site
 *   AxisCam_Q16O#<n>[_1]      x2 per site
 *
 * so the sensors are found by walking the loaded scene. Names are matched on a
 * punctuation-stripped key, because GLTFLoader sanitises node names on import
 * ("TF03-100 LiDAR-R004" arrives as "TF03-100_LiDAR-R004") and because the
 * camera instances are numbered per site (#2 on four sites, #3 on BRC).
 *
 * IDs, chainage and side are then derived from the model bounding box, so a
 * re-export with moved hardware needs no code change at all.
 *
 * One trap this is built around: in 260919_BKT.glb the two camera nodes are
 * EMPTY - 24 transform nodes and not a single mesh, where the other four sites
 * have 11 meshes each. Markers therefore hang off the node world position and
 * never depend on finding geometry. Mesh tinting is a bonus applied only when
 * there is something to tint.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const SENSOR_TYPES = {
    lidar: {
        key: 'lidar',
        prefix: 'LDR',
        label: 'LiDAR',
        plural: 'LiDAR range finders',
        model: 'Benewake TF03-100',
        pattern: /^tf03100lidar/,
        color: 0x22d3ee,
        css: '#22d3ee',
        // Edit here if the installed variant differs.
        spec: [
            ['Range', '0.1 - 100 m'],
            ['Ingress rating', 'IP67'],
            ['Interface', 'UART / CAN'],
        ],
    },
    camera: {
        key: 'camera',
        prefix: 'CAM',
        label: 'Camera',
        plural: 'Monitoring cameras',
        model: 'Axis Q16 series',
        pattern: /^axiscamq16o/,
        color: 0xc084fc,
        css: '#c084fc',
        spec: [
            ['Mount', 'Pole / rail bracket'],
            ['Housing', 'Outdoor, shielded'],
        ],
    },
};

const TYPE_LIST = Object.values(SENSOR_TYPES);

/** Node name reduced to lowercase alphanumerics, so spaces, underscores,
 *  hyphens and instance suffixes cannot break detection. */
const nameKey = name => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export const cardinal = deg => COMPASS_16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

/**
 * Bearing of a model-space direction, in degrees clockwise from true north.
 * `northOffsetDeg` is the bearing of the model's -Z axis (see js/sites.js).
 */
export function bearingOfModelDir(dx, dz, northOffsetDeg) {
    const local = THREE.MathUtils.radToDeg(Math.atan2(dx, -dz));
    return ((northOffsetDeg + local) % 360 + 360) % 360;
}

/* ------------------------------------------------------------------ *
 * Detection                                                           *
 * ------------------------------------------------------------------ */

export function detectSensors(model) {
    const { root, bbox, majorAxis, minorAxis } = model;
    root.updateMatrixWorld(true);

    const found = [];
    root.traverse(obj => {
        const key = nameKey(obj.name);
        const type = TYPE_LIST.find(t => t.pattern.test(key));
        if (!type) return;
        const meshes = [];
        obj.traverse(o => { if (o.isMesh) meshes.push(o); });
        found.push({
            type: type.key,
            node: obj,
            position: obj.getWorldPosition(new THREE.Vector3()),
            meshes,
        });
    });

    // Chainage runs from the low end of the deck along whichever horizontal
    // axis is longer (X on BRC, Z on the other four).
    const minorCentre = (bbox.min[minorAxis] + bbox.max[minorAxis]) / 2;
    // Walking along increasing chainage with Y up, "left" is -X when the deck
    // runs along Z, and +Z when it runs along X.
    const leftSign = majorAxis === 'z' ? -1 : 1;

    for (const s of found) {
        s.chainage = s.position[majorAxis] - bbox.min[majorAxis];
        s.offset = s.position[minorAxis] - minorCentre;
        s.side = (Math.sign(s.offset) || 1) === leftSign ? 'Left' : 'Right';
        s.height = s.position.y - bbox.min.y;
        s.location = `${s.side} side · ch ${s.chainage.toFixed(1)} m`;
    }

    // Stable IDs: sorted along the deck, so they stay put across reloads and
    // read in the order an inspector walks the structure.
    const sensors = [];
    for (const type of TYPE_LIST) {
        const group = found.filter(s => s.type === type.key)
                           .sort((a, b) => a.chainage - b.chainage);
        group.forEach((s, i) => {
            s.id = `${type.prefix}-${String(i + 1).padStart(2, '0')}`;
            s.typeDef = type;
            s.hasGeometry = s.meshes.length > 0;
            sensors.push(s);
        });
    }

    if (sensors.length) {
        console.table(sensors.map(s => ({
            id: s.id, type: s.type, location: s.location,
            x: +s.position.x.toFixed(3), y: +s.position.y.toFixed(3), z: +s.position.z.toFixed(3),
            meshes: s.meshes.length,
        })));
    }
    const missing = sensors.filter(s => !s.hasGeometry).map(s => s.id);
    if (missing.length) {
        console.warn(`[sensors] no geometry in the model for: ${missing.join(', ')} ` +
                     '- markers and details still work, mesh tint is skipped.');
    }
    return sensors;
}

export function countByType(sensors) {
    const out = {};
    for (const t of TYPE_LIST) out[t.key] = sensors.filter(s => s.type === t.key).length;
    return out;
}

/* ------------------------------------------------------------------ *
 * Markers                                                             *
 * ------------------------------------------------------------------ */

/** Ring sprite texture, drawn once per colour and cached. */
const ringCache = new Map();
function ringTexture(hex) {
    if (ringCache.has(hex)) return ringCache.get(hex);
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const col = '#' + hex.toString(16).padStart(6, '0');

    g.strokeStyle = 'rgba(2,6,14,0.85)';
    g.lineWidth = 14;
    g.beginPath(); g.arc(S / 2, S / 2, 44, 0, Math.PI * 2); g.stroke();

    g.strokeStyle = col;
    g.lineWidth = 9;
    g.beginPath(); g.arc(S / 2, S / 2, 44, 0, Math.PI * 2); g.stroke();

    g.fillStyle = col;
    g.beginPath(); g.arc(S / 2, S / 2, 9, 0, Math.PI * 2); g.fill();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    ringCache.set(hex, tex);
    return tex;
}

function haloTexture() {
    if (ringCache.has('halo')) return ringCache.get('halo');
    const S = 128;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(56,189,248,0.55)');
    grad.addColorStop(0.55, 'rgba(56,189,248,0.18)');
    grad.addColorStop(1, 'rgba(56,189,248,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    ringCache.set('halo', tex);
    return tex;
}

/**
 * Build the marker layer for a set of sensors.
 * Markers live in viewer.markerScene, which is drawn after a depth clear, so a
 * sensor behind a girder is still visible - which is the whole point when you
 * are standing under the deck trying to find it.
 */
export function createMarkers(viewer, sensors, { onSelect }) {
    const { THREE: T, markerScene, camera } = viewer;
    const group = new T.Group();
    markerScene.add(group);

    const entries = new Map();   // id -> { sprite, labelEl, label, mats }
    const pickables = [];

    for (const s of sensors) {
        const spriteMat = new T.SpriteMaterial({
            map: ringTexture(s.typeDef.color),
            depthTest: false, depthWrite: false, transparent: true,
            sizeAttenuation: true,
        });
        const sprite = new T.Sprite(spriteMat);
        sprite.position.copy(s.position);
        sprite.renderOrder = 10;
        sprite.userData.sensorId = s.id;
        group.add(sprite);
        pickables.push(sprite);

        const el = document.createElement('div');
        el.className = `marker-label ${s.type}`;
        el.textContent = s.id;                       // textContent: Thai-safe
        el.addEventListener('pointerdown', e => { e.stopPropagation(); onSelect(s.id); });
        const label = new CSS2DObject(el);
        label.position.copy(s.position);   // lifted above the ring every frame
        group.add(label);

        // The whole model shares 12-18 materials, so tinting a sensor means
        // cloning its materials first or the entire bridge changes colour.
        const mats = [];
        for (const m of s.meshes) {
            const arr = Array.isArray(m.material)
                ? (m.material = m.material.map(x => x.clone()))
                : [m.material = m.material.clone()];
            m.userData.sensorId = s.id;
            for (const mat of arr) {
                mat.userData.origEmissive = mat.emissive ? mat.emissive.getHex() : null;
                mat.userData.origEI = mat.emissiveIntensity;
                mats.push(mat);
            }
        }
        entries.set(s.id, { sensor: s, sprite, labelEl: el, label, mats });
    }

    const bodyMeshes = sensors.flatMap(s => s.meshes);

    /* selection halo - one shared sprite, moved to whatever is selected */
    const halo = new T.Sprite(new T.SpriteMaterial({
        map: haloTexture(), depthTest: false, depthWrite: false,
        transparent: true, sizeAttenuation: true,
    }));
    halo.renderOrder = 9;
    halo.visible = false;
    group.add(halo);

    let filterType = null;
    let selectedId = null;

    function applyStates() {
        for (const [id, e] of entries) {
            const match = !filterType || e.sensor.type === filterType;
            const isSel = id === selectedId;
            e.sprite.material.opacity = match ? 1 : 0.16;
            e.labelEl.classList.toggle('muted', !match);
            e.labelEl.classList.toggle('selected', isSel);
            for (const mat of e.mats) {
                if (!mat.emissive) continue;
                if (isSel) {
                    mat.emissive.setHex(e.sensor.typeDef.color);
                    mat.emissiveIntensity = 0.9;
                } else if (mat.userData.origEmissive != null) {
                    mat.emissive.setHex(mat.userData.origEmissive);
                    mat.emissiveIntensity = mat.userData.origEI;
                }
            }
        }
        const sel = selectedId && entries.get(selectedId);
        halo.visible = !!sel;
        if (sel) halo.position.copy(sel.sensor.position);
        viewer.invalidate();
    }

    // Keep markers at a constant on-screen size, otherwise they vanish on a
    // 130 m span and swamp the view up close.
    let pulse = 2.2;
    const tmp = new T.Vector3();
    const tanHalfFov = () => Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const offSize = viewer.onBeforeRender(() => {
        const k = 2 * tanHalfFov() * 0.075;
        for (const e of entries.values()) {
            const d = camera.position.distanceTo(tmp.copy(e.sprite.position));
            const size = THREE.MathUtils.clamp(d * k, 0.35, 9);
            e.sprite.scale.setScalar(size);
            // Sit the nametag just above the ring. The ring holds a constant
            // on-screen size, so this offset has to track it in world units.
            e.label.position.copy(e.sensor.position);
            e.label.position.y += size * 0.62;
        }
        if (halo.visible) {
            const d = camera.position.distanceTo(tmp.copy(halo.position));
            halo.scale.setScalar(THREE.MathUtils.clamp(d * k * pulse, 0.7, 26));
        }
    });

    // Pulse the halo while something is selected. Throttled to ~25 fps so a
    // long-lived selection does not pin the GPU at full rate.
    let lastPulse = 0;
    const offPulse = viewer.onFrame(t => {
        if (!halo.visible || t - lastPulse < 40) return false;
        lastPulse = t;
        pulse = 2.0 + Math.sin(t * 0.0035) * 0.55;
        return true;
    });

    return {
        pickables,
        bodyMeshes,
        setTypeFilter(type) { filterType = type || null; applyStates(); },
        setSelected(id) { selectedId = id || null; applyStates(); },
        get selected() { return selectedId; },
        dispose() {
            offSize();
            offPulse();
            for (const e of entries.values()) {
                e.sprite.material.dispose();
                e.label.removeFromParent();
                e.labelEl.remove();
            }
            halo.material.dispose();
            group.removeFromParent();
            group.clear();
            entries.clear();
        },
    };
}
