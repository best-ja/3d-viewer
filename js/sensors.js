/**
 * Equipment detection and highlighting.
 *
 * Four types, found three different ways, because the exports name them three
 * different ways:
 *
 *   AXLE DETECTOR  node "TF03-100 LiDAR-R004" x4, plus 4 unnamed Plate Axles
 *   CAMERA         node "AxisCam_Q16O#<n>" x2
 *   WEIGHT SENSOR  unnamed strain plates on the girders and slab soffit,
 *                  plus the uPVC conduit run that wires them
 *   CAS / BTS      the two named nameplates and the enclosure around them
 *
 * Names are matched on a punctuation-stripped key: GLTFLoader rewrites node
 * names on import ("TF03-100 LiDAR-R004" arrives as "TF03-100_LiDAR-R004") and
 * the camera instance number differs per site (#2 on four sites, #3 on BRC).
 *
 * THE PLATES. Nothing in any model is named "strain", "plate", "ตู้" or
 * "ครอบ", so the 150 mm plates are found geometrically and then sorted out by
 * where they sit. They come in three families, consistently across all five
 * models (BKT shown):
 *
 *     band A   8 on the girder bottom flanges       y 2.5, z 19.9
 *     band B   8 on the slab soffit                 y 3.1, z 20.7
 *     band C   4 mid-deck                           y 3.6, z 17.9 and 22.9
 *
 * All three are weight sensors. The only plates that are NOT are the ones
 * sitting right on a detector or camera, which are that unit's own mount and
 * are handed to it. classifyPlates() has the rules; STRAIN has the thresholds.
 *
 * The Plate Axle and the detector housing sit just OUTSIDE the named TF03
 * node, so highlighting the node alone misses them. Measured in all five
 * models, each detector has, within 8 cm of it: a 0.22 x 0.22 x 0.27 m
 * M06_Steel_Smoke housing and three small mounting plates. The nearest
 * unrelated geometry is 0.63 m away, so attachUnitShells() sweeps them in
 * with a 0.5 m radius.
 *
 * An export can ship its camera nodes as empty placeholders - one of them did,
 * before it was revised - so the camera type resolves positions from the nodes
 * and works whether or not there is geometry hanging off them. report() warns
 * when a model arrives with none.
 */
import * as THREE from 'three';

export const AXLE = 'axle';
export const CAMERA = 'camera';
export const WEIGHT = 'weight';
export const CABINET = 'cabinet';

/**
 * Geometric thresholds, all derived from the five exports in Model-glb/ as of
 * Sept 2026. These are the first thing to revisit if the models change.
 */
const STRAIN = {
    /** Cluster candidates: small parts in the right metal. */
    MAX_PART: 0.5,
    /** Which of the two is used differs per model, so accept both. */
    MATERIALS: ['metalsilver', 'aluminum', 'aluminium'],
    /** Single-link clustering distance: a plate plus its studs. */
    CLUSTER: 0.4,
    /** A cluster only counts if it holds a plate of this shape, in metres. */
    PLATE_MIN_THIN: 0.06,
    PLATE_FACE: [0.10, 0.25],
    /** A plate inside the cabinet enclosure, grown by this, is cabinet
     *  hardware. A sphere around the nameplate does not work: on SSW and BKT
     *  the cabinet sits inside the strain array, and any radius wide enough to
     *  catch its own plates also swallows real weight sensors. The enclosure
     *  box is tight in exactly the directions that matter. */
    IN_CABINET: 0.15,
    /** Closer than this to a detector or camera and the plate is that unit's
     *  own mount, so it belongs to that unit rather than to the weight array.
     *  1.2 and not more: TPA's mount plates sit 0.23 m from their detector,
     *  while SSW's nearest weight sensor is 1.48 m from one. */
    NEAR_UNIT: 1.2,
};

/** The detector's own hardware, which the exports leave outside its node. */
const UNIT_SHELL = {
    /** Housing at 0.08 m, mounting plates at 0.03-0.04 m, nearest unrelated
     *  geometry at 0.63 m - so anything in here belongs to the detector. */
    RADIUS: 0.5,
    /** Guards against a deck slab whose centre happens to fall nearby. */
    MAX_PART: 0.6,
};

const CAB = {
    /** Capture radius around each nameplate. 0.9 and 1.1 give the same result
     *  on four of the five models, so this is not delicate. */
    RADIUS: 0.7,
    /** Nothing cabinet-sized is bigger than this. */
    MAX_PART: 1.3,
};

export const SENSOR_TYPES = [
    // unitFraming: how to frame ONE unit, when that differs from the whole
    // type. Zooming to a single detector has to come in over the road - see the
    // roadside note in viewer.js.
    { key: AXLE,    label: 'AXLE DETECTOR', color: 0x22d3ee, css: '#22d3ee', framing: 'above',
      unitFraming: 'roadside' },
    { key: CAMERA,  label: 'CAMERA',        color: 0xc084fc, css: '#c084fc', framing: 'outside' },
    { key: WEIGHT,  label: 'WEIGHT SENSOR', color: 0xfbbf24, css: '#fbbf24', framing: 'under' },
    { key: CABINET, label: 'CAS / BTS',     color: 0x34d399, css: '#34d399', framing: 'under' },
];

/** Name reduced to lowercase alphanumerics, so spaces, underscores, hyphens
 *  and instance suffixes cannot break matching. */
const key = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const IS_AXLE = /^tf03100lidar/;
const IS_CAMERA = /^axiscamq16o/;
const IS_CONDUIT = /conduitupvc/;
const IS_ANCHOR = /^(bts|cas)(\d+)?$/;
/** Girder-scale rolled sections: |L-75x75... and |[-150x75... The key has its
 *  hyphens stripped, so the pattern must not contain one. */
const IS_BIG_SECTION = /^\|(l(7[5-9]|[89]\d|\d{3})|\[)/;

const materialKeys = mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    .map(m => key(m && m.name));

const isStrainMetal = mesh =>
    materialKeys(mesh).some(n => STRAIN.MATERIALS.some(m => n.includes(m)));

/* ------------------------------------------------------------------ *
 * Detection                                                           *
 * ------------------------------------------------------------------ */

export function detectSensors(model) {
    const { root, majorAxis } = model;
    root.updateMatrixWorld(true);

    const units = { [AXLE]: [], [CAMERA]: [] };
    const anchors = [];        // { name, position, meshes }
    const conduit = [];
    const loose = [];

    (function walk(obj, unit, anchor, inConduit) {
        const k = key(obj.name);
        let u = unit;
        if (!u && (IS_AXLE.test(k) || IS_CAMERA.test(k))) {
            u = { type: IS_AXLE.test(k) ? AXLE : CAMERA, meshes: [],
                  position: obj.getWorldPosition(new THREE.Vector3()) };
            units[u.type].push(u);
        }
        let a = anchor;
        if (!a && IS_ANCHOR.test(k)) {
            a = { name: k.slice(0, 3).toUpperCase(), meshes: [],
                  position: obj.getWorldPosition(new THREE.Vector3()) };
            anchors.push(a);
        }
        const cond = inConduit || IS_CONDUIT.test(k);

        if (obj.isMesh) {
            if (u) u.meshes.push(obj);
            else if (cond) conduit.push(obj);
            else { loose.push(obj); if (a) a.meshes.push(obj); }
        }
        for (const c of obj.children) walk(c, u, a, cond);
    })(root, null, null, false);

    // Each detector's housing and mounting plates sit outside its node, so
    // sweep them in first and mark them claimed - otherwise the cabinet and
    // plate passes below would compete for the same meshes.
    const claimed = new Set();
    const shells = attachUnitShells(loose, units[AXLE], claimed);

    // The cabinet shell is found next: classifyPlates() needs its box to tell
    // the cabinet's own plates from the weight sensors packed in around it.
    const cabinet = collectCabinet(loose, anchors, claimed);
    const plates = classifyPlates(loose, units[AXLE], units[CAMERA], cabinet.box, claimed);
    cabinet.absorb(plates.cabinet.meshes);

    const groups = {
        [AXLE]: makeGroup(AXLE,
            [...units[AXLE].flatMap(u => u.meshes), ...plates.axle.meshes],
            [...units[AXLE].map(u => u.position), ...plates.axle.points],
            numberedUnits(units[AXLE], 'axle', 'AXLE', majorAxis)),
        [CAMERA]: makeGroup(CAMERA,
            [...units[CAMERA].flatMap(u => u.meshes), ...plates.camera.meshes],
            units[CAMERA].map(u => u.position),
            numberedUnits(units[CAMERA], 'cam', 'CAM', majorAxis)),
        [WEIGHT]: makeGroup(WEIGHT,
            [...plates.weight.meshes, ...conduit],
            plates.weight.points, []),
        [CABINET]: makeGroup(CABINET, cabinet.meshes, cabinet.points, cabinet.units),
    };
    // Neither WEIGHT nor CAS/BTS has selectable units, so their panel counts
    // come from the detections rather than from units.length.
    groups[WEIGHT].count = plates.weight.points.length;
    groups[CABINET].count = cabinet.points.length;

    report(groups, conduit, plates, shells, model);
    return groups;
}

/**
 * Pull each detector's own hardware into its unit. The exports leave the
 * housing and mounting plates outside the named TF03 node, so highlighting the
 * node alone lights the 44 mm device and nothing around it.
 */
function attachUnitShells(loose, units, claimed) {
    const box = new THREE.Box3(), size = new THREE.Vector3();
    let n = 0;
    for (const mesh of loose) {
        if (claimed.has(mesh)) continue;
        box.setFromObject(mesh).getSize(size);
        if (Math.max(size.x, size.y, size.z) > UNIT_SHELL.MAX_PART) continue;
        const centre = box.getCenter(new THREE.Vector3());
        let best = null, bestD = UNIT_SHELL.RADIUS;
        for (const u of units) {
            const d = u.position.distanceTo(centre);
            if (d < bestD) { bestD = d; best = u; }
        }
        if (!best) continue;
        best.meshes.push(mesh);
        claimed.add(mesh);
        n++;
    }
    return n;
}

/** Turn detected units into selectable, chainage-ordered entries. */
function numberedUnits(list, idPrefix, labelPrefix, majorAxis) {
    return [...list]
        .sort((a, b) => a.position[majorAxis] - b.position[majorAxis])
        .map((u, i) => ({
            id: `${idPrefix}-${i + 1}`,
            label: `${labelPrefix} ${i + 1}`,
            meshes: u.meshes,
            position: u.position,
        }));
}

function makeGroup(k, meshes, points, units) {
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

    for (const u of units) {
        u.box = new THREE.Box3();
        for (const m of u.meshes) u.box.union(new THREE.Box3().setFromObject(m));
        if (u.box.isEmpty()) u.box.setFromCenterAndSize(u.position, new THREE.Vector3(1, 1, 1));
    }
    return { key: k, meshes, points, box, focus, units, count: units.length };
}

/**
 * Find the 150 mm plates and sort them into Plate Axles, weight sensors and
 * cabinet hardware. See the three-band note at the top of the file.
 */
function classifyPlates(loose, axleUnits, cameraUnits, cabinetBox, claimed) {
    const box = new THREE.Box3();
    const size = new THREE.Vector3();

    // 1. Candidates: small parts in the right metal. The studs come along for
    //    the ride so the highlight reads bigger than a bare plate would.
    const candidates = [];
    for (const mesh of loose) {
        if (claimed.has(mesh) || !isStrainMetal(mesh)) continue;
        box.setFromObject(mesh).getSize(size);
        const d = [size.x, size.y, size.z].sort((a, b) => a - b);
        if (d[2] > STRAIN.MAX_PART) continue;
        const isPlate = d[0] <= STRAIN.PLATE_MIN_THIN
            && d[1] >= STRAIN.PLATE_FACE[0] && d[1] <= STRAIN.PLATE_FACE[1]
            && d[2] >= STRAIN.PLATE_FACE[0] && d[2] <= STRAIN.PLATE_FACE[1];
        candidates.push({ mesh, isPlate, centre: box.getCenter(new THREE.Vector3()) });
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

    // 3. Sort every cluster that actually holds a plate. Nothing is discarded:
    //    a plate on a unit is handed to that unit, everything else is a weight
    //    sensor.
    const inCabinet = cabinetBox && !cabinetBox.isEmpty()
        ? cabinetBox.clone().expandByScalar(STRAIN.IN_CABINET) : null;
    const out = {
        axle: { meshes: [], points: [] },
        camera: { meshes: [] },
        weight: { meshes: [], points: [] },
        cabinet: { meshes: [] },
        claimed: new Set(),
        noPlate: 0,
    };

    for (const cl of clusters) {
        if (!cl.some(c => c.isPlate)) { out.noPlate++; continue; }   // bolts and offcuts
        const centre = cl.reduce((v, c) => v.add(c.centre), new THREE.Vector3()).divideScalar(cl.length);
        const meshes = cl.map(c => c.mesh);
        meshes.forEach(m => out.claimed.add(m));

        if (inCabinet && inCabinet.containsPoint(centre)) {
            out.cabinet.meshes.push(...meshes);
        } else if (axleUnits.some(u => u.position.distanceTo(centre) < STRAIN.NEAR_UNIT)) {
            out.axle.meshes.push(...meshes);           // a detector's own mount
            out.axle.points.push(centre);
        } else if (cameraUnits.some(u => u.position.distanceTo(centre) < STRAIN.NEAR_UNIT)) {
            out.camera.meshes.push(...meshes);         // a camera's own mount
        } else {
            out.weight.meshes.push(...meshes);
            out.weight.points.push(centre);
        }
    }
    return out;
}

/**
 * The CAS and BTS cabinets: the two nameplates and the ตู้ครอบ around them.
 * The enclosure is two flat panels on SSW and BKT and a welded angle-and-SHS
 * frame on the other three, so it is taken by radius rather than by name.
 */
function collectCabinet(loose, anchors, claimed) {
    if (!anchors.length) {
        return { meshes: [], points: [], units: [], box: new THREE.Box3(), absorb() {} };
    }
    const box = new THREE.Box3();
    const size = new THREE.Vector3();

    const nearest = centre => {
        let best = -1, bestD = Infinity;
        anchors.forEach((a, i) => {
            const d = a.position.distanceTo(centre);
            if (d < bestD) { bestD = d; best = i; }
        });
        return [best, bestD];
    };

    const meshes = [];
    const shell = new THREE.Box3();
    const add = mesh => meshes.push(mesh);

    for (const mesh of loose) {
        if (claimed.has(mesh)) continue;
        // Strain plates are packed in around the cabinet on SSW and BKT. They
        // must not shape the shell box - that box is what decides which plates
        // are the cabinet's own, so letting them in feeds back on itself. They
        // come back through absorb() once classifyPlates() has ruled on them.
        if (isStrainMetal(mesh)) continue;
        // Girder members pass within the radius on SSW and BKT; skip them.
        if (IS_BIG_SECTION.test(key(mesh.name)) || IS_BIG_SECTION.test(key(mesh.parent?.name))) continue;
        box.setFromObject(mesh).getSize(size);
        if (Math.max(size.x, size.y, size.z) > CAB.MAX_PART) continue;
        const [, d] = nearest(box.getCenter(new THREE.Vector3()));
        if (d > CAB.RADIUS) continue;
        add(mesh);
        shell.union(box.setFromObject(mesh));
    }
    for (const a of anchors) for (const mesh of a.meshes) {
        if (!meshes.includes(mesh)) { add(mesh); shell.union(box.setFromObject(mesh)); }
    }

    // No sub-units: the two cabinets are 0.56 m apart and are always looked at
    // together, so they stack into one entry with no submenu.
    return {
        meshes,
        box: shell,
        points: anchors.map(a => a.position),
        units: [],
        /** Plate clusters classifyPlates() decided belong to the cabinet. */
        absorb(extra) {
            for (const mesh of extra) if (!meshes.includes(mesh)) add(mesh);
        },
    };
}

/**
 * Chainages of anything that looks like a pier column, logged as a starting
 * point for the `piers` list in js/sites.js. Reliable on TPA, SSW and BKT;
 * noisy on BRC and finds nothing on PM1-BWK - which is exactly why pier labels
 * are configured by hand rather than detected.
 */
function pierHints(model) {
    const { root, bbox, majorAxis } = model;
    const lowWater = bbox.min.y + (bbox.max.y - bbox.min.y) * 0.35;
    const box = new THREE.Box3(), size = new THREE.Vector3();
    const at = [];
    root.traverse(o => {
        if (!o.isMesh) return;
        box.setFromObject(o).getSize(size);
        if (size.y < 1.5 || size.y < 1.6 * Math.max(size.x, size.z)) return;
        if (box.min.y > lowWater) return;
        at.push(box.getCenter(new THREE.Vector3())[majorAxis]);
    });
    const lines = [];
    for (const v of at.sort((a, b) => a - b)) {
        if (lines.length && Math.abs(v - lines[lines.length - 1]) < 3) continue;
        lines.push(v);
    }
    return lines.slice(0, 20).map(v => +v.toFixed(1));
}

function report(groups, conduit, plates, shells, model) {
    console.groupCollapsed('[sensors] detected');
    console.table(SENSOR_TYPES.map(t => ({
        type: t.label,
        count: groups[t.key].count,
        units: groups[t.key].units.length,
        meshes: groups[t.key].meshes.length,
    })));
    console.log('conduit meshes', conduit.length,
        '| weight sensors', plates.weight.points.length,
        '| cabinet plates', plates.cabinet.meshes.length,
        '| detector housing/plate meshes', shells,
        '| clusters without a plate', plates.noPlate);
    const hints = pierHints(model);
    if (hints.length) {
        console.log(`pier hint - column lines along ${model.majorAxis} at: ${hints.join(', ')}`
            + '  (a starting point for the `piers` list in js/sites.js - check them against the model)');
    }
    console.groupEnd();
    if (!groups[CAMERA].meshes.length) {
        console.warn('[sensors] this model carries no camera geometry - the camera nodes are empty placeholders.');
    }
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
 * cloning: the weight group alone is 300-500 meshes, and the whole model only
 * has 12-18 materials, so cloning would tint the bridge.
 */
export function createHighlighter(viewer, groups) {
    // DoubleSide is not optional. Every material in these GLBs is
    // doubleSided, and the Plate Axle is a zero-thickness 1.12 x 0.81 m plane -
    // with the default FrontSide it is culled from behind and the highlight
    // simply vanishes, leaving only the 0.19 m detector body visible.
    const materials = Object.fromEntries(SENSOR_TYPES.map(t => [
        t.key,
        new THREE.MeshBasicMaterial({ color: t.color, toneMapped: false, side: THREE.DoubleSide }),
    ]));

    let active = null;      // { type, unitId }
    let lit = [];

    function clear() {
        for (const mesh of lit) {
            if (mesh.userData.origMaterial) {
                mesh.material = mesh.userData.origMaterial;
                delete mesh.userData.origMaterial;
            }
            mesh.layers.set(0);
        }
        lit = [];
        active = null;
    }

    return {
        get active() { return active; },
        /** `unitId` narrows the highlight to a single unit of that type. */
        set(typeKey, unitId = null) {
            clear();
            const group = typeKey && groups[typeKey];
            if (group) {
                const unit = unitId && group.units.find(u => u.id === unitId);
                lit = unit ? unit.meshes : group.meshes;
                for (const mesh of lit) {
                    mesh.userData.origMaterial = mesh.material;
                    mesh.material = materials[typeKey];
                    mesh.layers.set(HIGHLIGHT_LAYER);
                }
                active = { type: typeKey, unitId: unit ? unit.id : null };
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
