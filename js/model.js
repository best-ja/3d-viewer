/**
 * Loading a bridge GLB and describing it.
 *
 * Kept separate from js/viewer.js because two pages need it - the inspector
 * (index.html) and the show screen (show.html) - and because js/sensors.js
 * depends on the exact fields computed here. `majorAxis` in particular decides
 * how every unit is ordered along the deck, so the two pages must derive it the
 * same way or detection would quietly differ between them.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Measure a loaded scene graph.
 *
 * Returns the shape the rest of the app calls a "model":
 *
 *   root       the Object3D, not yet added to any scene
 *   bbox       world-space bounds
 *   center     centre of those bounds
 *   size       their extent
 *   span       the longer horizontal extent, used for camera near/far
 *   majorAxis  'x' or 'z' - which way the deck runs
 *   minorAxis  the other one - across the deck
 */
export function describeModel(root) {
    root.updateMatrixWorld(true);

    const bbox = new THREE.Box3().setFromObject(root);
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());

    // Bridges run along X on some sites (BRC) and Z on the others. Every
    // framing and ordering decision keys off this rather than assuming.
    const majorAxis = size.x >= size.z ? 'x' : 'z';
    const minorAxis = majorAxis === 'x' ? 'z' : 'x';
    const span = Math.max(size.x, size.z);

    return { root, bbox, center, size, span, majorAxis, minorAxis };
}

/** Fetch a GLB and describe it. The caller adds `root` to its own scene. */
export function loadGLB(url, onProgress) {
    return new Promise((resolve, reject) => {
        new GLTFLoader().load(url, gltf => resolve(describeModel(gltf.scene)), onProgress, reject);
    });
}
