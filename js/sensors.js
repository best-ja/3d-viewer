/**
 * Equipment detection and type highlighting.
 *
 * Three types, found three different ways, because the exports name them three
 * different ways:
 *
 *   AXLE DETECTOR  node named "TF03-100 LiDAR-R004"  - exact, 4 per site
 *   CAMERA         node named "AxisCam_Q16O#<n>"     - exact, 2 per site
 *   WEIGHT SENSOR  unnamed strain plates + the uPVC conduit run
 *
 * Names are matched on a punctuation-stripped key: GLTFLoader rewrites node
 * names on import ("TF03-100 LiDAR-R004" arrives as "TF03-100_LiDAR-R004") and
 * the camera instance number differs per site (#2 on four sites, #3 on BRC).
 *
 * The strain gauges are the awkward one - nothing in any of the five models is
 * named "strain" or "WeightSensor", so they are found geometrically. See STRAIN
 * below. The conduit they are wired through is the opposite: every piece has
 * "conduit upvc" in its node name, which finds all 195-328 of them. (The
 * VBO_Pipe material only covers 5-19 fittings, so do not use the material.)
 *
 * Note 260919_BKT.glb has no camera geometry at all - both camera nodes are
 * empty placeholders. The camera type still resolves a position there so the
 * view can fly to the mounting point; it just has nothing to light up.
 */
import * as THREE from 'three';

export const AXLE = 'axle';
export const CAMERA = 'camera';
export const WEIGHT = 'weight';

/**
 * Strain-plate detection thresholds.
 *
 * These were derived from the five exports in Model-glb/ as of Sept 2026 and
 * are the first thing to revisit if the models change. What the installation
 * looks like in the file: ~150 mm plates with mounting studs, at girder level,
 * roughly 2 m apart across the deck, in two cross-sections near midspan.
 */
const STRAIN = {
    /** Ignore anything bigger than this - a plate is 0.154 m. */
    MAX_PART: 0.5,
    /** Which of the two is the sensor differs per model, so accept both. */
    MATERIALS: ['metalsilver', 'aluminum', 'aluminium'],
    /** Single-link clustering distance: plate + its studs. */
    CLUSTER: 0.4,
    /** Clusters this close to a LiDAR or camera are its mounting bracket. */
    MIN_FROM_UNIT: 1.0,
    /** Cross-section grouping tolerance along the deck. */
    ROW_TOL: 0.5,
    /** Keep only the N biggest cross-sections. This is what rejects the stray
     *  clusters every site carries just above the real rows. */
    ROWS_KEPT: 2,
};

export const SENSOR_TYPES = [
    { key: AXLE,   label: 'AXLE DETECTOR', color: 0x22d3ee, css: '#22d3ee', framing: 'above' },
    { key: CAMERA, label: 'CAMERA',        color: 0xc084fc, css: '#c084fc', framing: 'outside' },
    { key: WEIGHT, label: 'WEIGHT SENSOR', color: 0xfbbf24, css: '#fbbf24', framing: 'under' },
];

/** Name reduced to lowercase alphanumerics, so spaces, underscores, hyphens and
 *  instance suffixes cannot break matching. */
const key = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const IS_AXLE = /^tf03100lidar/;
const IS_CAMERA = /^axiscamq16o/;
const IS_CONDUIT = /conduitupvc/;

const materialNames = mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    .map(m => key(m && m.name));

/* ------------------------------------------------------------------ *
 * Detection                                                           *
 * ------------------------------------------------------------------ */

/**
 * @returns {{axle:Group, camera:Group, weight:Group}} where Group is
 *          { key, meshes: Mesh[], points: Vector3[], box: Box3 }
 */
export function detectSensors(model) {
    const { root, majorAxis } = model;
    root.updateMatrixWorld(true);

    const units = { [AXLE]: [], [CAMERA]: [] };   // { position, meshes }
    const owned = new Set();                      // meshes belonging to a named unit
    const conduit = [];
    const loose = [];                             // everything else, for strain

    (function walk(obj, unit, inConduit) {
        const k = key(obj.name);
        let u = unit;
        if (!u && (IS_AXLE.test(k) || IS_CAMERA.test(k))) {
            u = { type: IS_AXLE.test(k) ? AXLE : CAMERA, meshes: [],
                  position: obj.getWorldPosition(new THREE.Vector3()) };
            units[u.type].push(u);
        }
        const cond = inConduit || IS_CONDUIT.test(k);

        if (obj.isMesh) {
            if (u) { u.meshes.push(obj); owned.add(obj); }
            else if (cond) { conduit.push(obj); owned.add(obj); }
            else loose.push(obj);
        }
        for (const c of obj.children) walk(c, u, cond);
    })(root, null, false);

    const strain = findStrainPlates(loose, majorAxis, [...units[AXLE], ...units[CAMERA]]);

    const groups = {
        [AXLE]:   makeGroup(AXLE, units[AXLE].flatMap(u => u.meshes), units[AXLE].map(u => u.position)),
        [CAMERA]: makeGroup(CAMERA, units[CAMERA].flatMap(u => u.meshes), units[CAMERA].map(u => u.position)),
        [WEIGHT]: makeGroup(WEIGHT, [...strain.meshes, ...conduit], strain.points),
    };

    console.groupCollapsed('[sensors] detected');
    console.table(SENSOR_TYPES.map(t => ({
        type: t.label, units: groups[t.key].points.length, meshes: groups[t.key].meshes.length,
    })));
    console.log('conduit meshes', conduit.length);
    console.table(strain.points.map(p => ({
        x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
    })));
    console.groupEnd();
    if (!groups[CAMERA].meshes.length) {
        console.warn('[sensors] this model carries no camera geometry - the camera nodes are empty placeholders.');
    }
    return groups;
}

function makeGroup(k, meshes, points) {
    const box = new THREE.Box3();
    for (const m of meshes) box.union(new THREE.Box3().setFromObject(m));
    // BKT's cameras have no geometry; fall back to the node positions so the
    // view can still fly to where they should be.
    if (box.isEmpty()) for (const p of points) box.expandByPoint(p);

    // What the camera frames. For the weight group this is deliberately NOT
    // `box`: that includes a 20 m+ conduit run, and framing it pushes the
    // camera so far back the sensors become specks. Frame the units, and let
    // the conduit lead off the edge of the screen.
    const focus = new THREE.Box3();
    for (const p of points) focus.expandByPoint(p);
    if (focus.isEmpty()) focus.copy(box); else focus.expandByScalar(0.8);

    return { key: k, meshes, points, box, focus };
}

/**
 * Find the strain plates among the meshes that do not belong to a named unit.
 * Geometric, not by name - see the STRAIN comment above.
 */
function findStrainPlates(loose, majorAxis, knownUnits) {
    const box = new THREE.Box3();
    const size = new THREE.Vector3();

    // 1. Small parts made of the right metal.
    const candidates = [];
    for (const mesh of loose) {
        const names = materialNames(mesh);
        if (!names.some(n => STRAIN.MATERIALS.some(m => n.includes(m)))) continue;
        box.setFromObject(mesh).getSize(size);
        if (Math.max(size.x, size.y, size.z) > STRAIN.MAX_PART) continue;
        candidates.push({ mesh, centre: box.getCenter(new THREE.Vector3()) });
    }

    // 2. Single-link cluster: one plate plus its studs becomes one sensor.
    const clusters = [];
    for (const c of candidates) {
        const hit = clusters.find(cl => cl.some(o => o.centre.distanceTo(c.centre) < STRAIN.CLUSTER));
        if (hit) hit.push(c); else clusters.push([c]);
    }
    for (let merged = true; merged;) {
        merged = false;
        outer:
        for (let a = 0; a < clusters.length; a++) {
            for (let b = a + 1; b < clusters.length; b++) {
                if (clusters[a].some(p => clusters[b].some(q => p.centre.distanceTo(q.centre) < STRAIN.CLUSTER))) {
                    clusters[a].push(...clusters.splice(b, 1)[0]);
                    merged = true;
                    break outer;
                }
            }
        }
    }

    // 3. Drop the LiDAR and camera mounting brackets.
    const kept = clusters
        .map(cl => ({
            parts: cl,
            centre: cl.reduce((v, c) => v.add(c.centre), new THREE.Vector3()).divideScalar(cl.length),
        }))
        .filter(cl => knownUnits.every(u => u.position.distanceTo(cl.centre) > STRAIN.MIN_FROM_UNIT));

    // 4. Keep the biggest cross-sections. Sensors sit in rows across the deck;
    //    the leftovers are stray fittings sitting just above them.
    const rows = [];
    for (const cl of kept) {
        const at = cl.centre[majorAxis];
        const row = rows.find(r => Math.abs(r.at - at) < STRAIN.ROW_TOL);
        if (row) { row.members.push(cl); row.at = (row.at * (row.members.length - 1) + at) / row.members.length; }
        else rows.push({ at, members: [cl] });
    }
    rows.sort((a, b) => b.members.length - a.members.length);
    const chosen = rows.slice(0, STRAIN.ROWS_KEPT).flatMap(r => r.members);

    return {
        meshes: chosen.flatMap(cl => cl.parts.map(p => p.mesh)),
        points: chosen.map(cl => cl.centre),
    };
}

/* ------------------------------------------------------------------ *
 * Highlighting                                                        *
 * ------------------------------------------------------------------ */

/** Meshes are moved to this layer while highlighted; the viewer draws that
 *  layer in a second pass, after a depth clear, so equipment buried inside the
 *  structure still reads. */
export const HIGHLIGHT_LAYER = 1;

/**
 * One shared material per type, swapped in over the originals. Swapping beats
 * cloning here: the weight group alone is 300-500 meshes, and the whole model
 * only has 12-18 materials to begin with, so cloning would tint the bridge.
 */
export function createHighlighter(viewer, groups) {
    const materials = Object.fromEntries(SENSOR_TYPES.map(t => [
        t.key,
        new THREE.MeshBasicMaterial({ color: t.color, toneMapped: false }),
    ]));

    let active = null;

    function clear() {
        if (!active) return;
        for (const mesh of groups[active].meshes) {
            if (mesh.userData.origMaterial) {
                mesh.material = mesh.userData.origMaterial;
                delete mesh.userData.origMaterial;
            }
            mesh.layers.set(0);
        }
        active = null;
    }

    return {
        get active() { return active; },
        set(k) {
            clear();
            if (k && groups[k]) {
                for (const mesh of groups[k].meshes) {
                    mesh.userData.origMaterial = mesh.material;
                    mesh.material = materials[k];
                    mesh.layers.set(HIGHLIGHT_LAYER);
                }
                active = k;
            }
            viewer.setOverlay(!!active);
            viewer.invalidate();
        },
        dispose() {
            clear();
            for (const m of Object.values(materials)) m.dispose();
            viewer.setOverlay(false);
        },
    };
}
