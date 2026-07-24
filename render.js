// ===================================================================================
// render.js — Three.js scene, hand-rolled orbit camera (r128 has no OrbitControls),
// mesh construction from a Poly (arbitrary convex polygon faces, fan-triangulated),
// and the pole-contraction morph animation.
// ===================================================================================
(function (global) {
  'use strict';

  // Faces are classified by actual shape, not just side count:
  //   C(n) faces: triangle / rhombus (all 4 sides equal, or trying to be) / trapezoid
  //     (including skewed quads from a pentagon-pentagon defect) / floret pentagon
  //   fullerene faces (pre-contraction view): hexagon / pole pentagon
  // The one error marker left is a leftover 6-sided face in C(n) context ("isolated
  // hexagons" isomers — an admissible C(n) never has one). A "non-isolated pentagons"
  // defect is flagged differently: as a highlighted edge in the fullerene view (see
  // buildEdgeGeometry/setPoly's highlightEdges param), not by recoloring faces — the C(n)
  // faces around it still get their normal classification, just possibly less regular.
  const FACE_COLORS = {
    triangle: 0xf2c94c,        // yellow
    rhombus: 0xd6493a,         // red
    trapezoid: 0x4caf6d,       // green
    floretPentagon: 0x3f7fd1,  // blue
    fullereneHexagon: 0xf7f7f2,  // white
    fullerenePentagon: 0x1a1a1a, // black
    error: 0xd633c4              // magenta
  };
  const EDGE_COLOR = 0x3a352c;
  const EDGE_HIGHLIGHT_COLOR = 0xd633c4; // magenta, marks a pentagon-pentagon adjacency edge
  const POLE_COLOR = 0x24211b;

  // Which face-context a poly is being viewed in must be passed explicitly rather than
  // inferred from its faces — a fullerene has only pentagon/hexagon faces, but a C(n)
  // (specifically an "invalid: isolated hexagons" one) can ALSO contain a hexagon face,
  // so hexagon-presence alone can't tell the two apart. In C(n) context every hexagon face
  // IS an isolated one (an admissible C(n) never has any); in fullerene context only the
  // specific faces named in isolatedHexFaceIndices (by index into poly.faces) are.
  // highlightIsolatedHex is a toggle: off, isolated hexagons read as plain white in both
  // contexts instead of the magenta error color.
  function classifyFace(poly, face, faceIndex, isFullereneCtx, isolatedHexFaceIndices) {
    const n = face.length;
    if (n === 6) {
      const isIsolated = isFullereneCtx ? !!(isolatedHexFaceIndices && isolatedHexFaceIndices.has(faceIndex)) : true;
      if (isIsolated) return toggles.highlightIsolatedHex ? 'error' : 'fullereneHexagon';
      return 'fullereneHexagon';
    }
    if (n === 5) return isFullereneCtx ? 'fullerenePentagon' : 'floretPentagon';
    if (n === 3) return 'triangle';
    if (n === 4) {
      // A quad "trying to be" a rhombus reads as one even with modest deviation — these
      // isomers aren't always fully converged to canonical form, so a strict tolerance
      // would misclassify a near-rhombus as a trapezoid.
      const pts = face.map(vi => poly.verts[vi]);
      const sides = [0, 1, 2, 3].map(i => pts[i].distanceTo(pts[(i + 1) % 4]));
      const avg = sides.reduce((a, b) => a + b, 0) / 4;
      const allEqual = sides.every(s => Math.abs(s - avg) < avg * 0.12);
      return allEqual ? 'rhombus' : 'trapezoid';
    }
    return 'fullereneHexagon';
  }

  let scene, camera, rendererGL, canvas;
  let world; // group holding the polyhedron + edges + poles
  let faceMesh = null, edgeLines = null, highlightLines = null, poleGroup = null, sphereMesh = null;
  let orbitQuat = new THREE.Quaternion();
  let dragging = false, lastX = 0, lastY = 0;
  let autoRotate = true, userInteracted = false, idleTimer = null;
  let camDistance = 3.4;
  let toggles = { color: true, edges: true, sphere: false, poles: false, spin: false, highlightIsolatedHex: true };

  // Returns true on success, false if a WebGL context couldn't be created (e.g. WebGL
  // disabled in the browser) — THREE.WebGLRenderer throws in that case rather than
  // failing gracefully, so the caller needs a way to find out without a crash.
  function init(canvasEl) {
    canvas = canvasEl;
    try {
      rendererGL = new THREE.WebGLRenderer({ canvas, antialias: true });
    } catch (e) {
      return false;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f6f3);

    camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, camDistance);

    rendererGL.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    world = new THREE.Group();
    scene.add(world);

    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(3, 4, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-4, -2, -3);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const sphereGeo = new THREE.SphereGeometry(1, 48, 32);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x9fb8c9, transparent: true, opacity: 0.28, depthWrite: false });
    sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
    sphereMesh.visible = false;
    world.add(sphereMesh);

    poleGroup = new THREE.Group();
    world.add(poleGroup);

    resize();
    window.addEventListener('resize', resize);

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', () => { dragging = false; });
    return true;
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    rendererGL.setSize(w, h, false);
  }

  function markInteracted() {
    userInteracted = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { userInteracted = false; }, 4000);
  }

  function onDown(e) { dragging = true; lastX = e.clientX; lastY = e.clientY; markInteracted(); }
  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    applyDrag(dx, dy);
  }
  function onUp() { dragging = false; }
  function onWheel(e) {
    e.preventDefault();
    markInteracted();
    camDistance *= (1 + e.deltaY * 0.001);
    camDistance = Math.max(1.6, Math.min(12, camDistance));
    camera.position.set(0, 0, camDistance);
  }
  let touchLast = null;
  function onTouchStart(e) { if (e.touches.length === 1) { touchLast = [e.touches[0].clientX, e.touches[0].clientY]; dragging = true; markInteracted(); } }
  function onTouchMove(e) {
    if (!dragging || e.touches.length !== 1) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - touchLast[0], dy = e.touches[0].clientY - touchLast[1];
    touchLast = [e.touches[0].clientX, e.touches[0].clientY];
    applyDrag(dx, dy);
  }
  function applyDrag(dx, dy) {
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * 0.006);
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * 0.006);
    orbitQuat.premultiply(qx).premultiply(qy);
    world.quaternion.copy(orbitQuat);
  }

  function autoRotateStep(dt) {
    if (!toggles.spin || userInteracted) return;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.15);
    orbitQuat.premultiply(q);
    world.quaternion.copy(orbitQuat);
  }

  function faceCentroid(poly, f) {
    const c = new THREE.Vector3();
    for (const vi of f) c.add(poly.verts[vi]);
    return c.multiplyScalar(1 / f.length);
  }

  // Build a BufferGeometry (fan-triangulated) with a per-vertex color determined by
  // the size of the face it belongs to (a vertex touching only one face size gets
  // that color cleanly; shared verts get whichever face is drawn — fine since color
  // is meant to read at the face level and faces don't share triangulation verts here).
  function buildFaceGeometry(poly, isFullereneCtx, isolatedHexFaceIndices) {
    const positions = [];
    const colors = [];
    const normals = [];
    const colorObj = new THREE.Color();
    poly.faces.forEach((f, fi) => {
      if (f.length < 3) return;
      const col = FACE_COLORS[classifyFace(poly, f, fi, isFullereneCtx, isolatedHexFaceIndices)] || 0x999999;
      colorObj.setHex(col);
      const centroid = faceCentroid(poly, f);
      let normal = new THREE.Vector3();
      for (let i = 0; i < f.length; i++) {
        const p1 = poly.verts[f[i]], p2 = poly.verts[f[(i + 1) % f.length]];
        normal.add(new THREE.Vector3().crossVectors(p1, p2));
      }
      if (normal.lengthSq() < 1e-20) normal.copy(centroid).normalize(); else normal.normalize();
      for (let i = 0; i < f.length; i++) {
        const a = poly.verts[f[i]], b = poly.verts[f[(i + 1) % f.length]];
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z, centroid.x, centroid.y, centroid.z);
        for (let k = 0; k < 3; k++) { colors.push(colorObj.r, colorObj.g, colorObj.b); normals.push(normal.x, normal.y, normal.z); }
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    return geo;
  }

  // highlightEdgeSet, if given, is a Set of "min_max" vertex-index-pair keys to exclude from
  // the normal edge lines (they're drawn separately, see buildHighlightEdgeGeometry) so the
  // highlight color isn't blended with/hidden under the regular edge color at the same spot.
  function buildEdgeGeometry(poly, highlightEdgeSet) {
    const positions = [];
    const seen = new Set();
    for (const f of poly.faces) {
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        if (highlightEdgeSet && highlightEdgeSet.has(key)) continue;
        const pa = poly.verts[a], pb = poly.verts[b];
        positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }

  function buildHighlightEdgeGeometry(poly, highlightEdgeSet) {
    const positions = [];
    for (const key of highlightEdgeSet) {
      const [a, b] = key.split('_').map(Number);
      const pa = poly.verts[a], pb = poly.verts[b];
      positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }

  // highlightEdges (only meaningful in fullerene context): an array of [a,b] vertex-index
  // pairs to draw in magenta — marks a pentagon-pentagon adjacency edge in a "non-isolated
  // pentagons" isomer. isolatedHexFaceIndices (also fullerene-context only): a Set of indices
  // into poly.faces marking which hexagon faces are isolated ones, for the same highlight
  // treatment C(n) context always gives its (necessarily isolated) hexagon faces.
  let lastSetPolyArgs = null; // cached so the highlightIsolatedHex toggle can trigger a rebuild
  function setPoly(poly, poleIndices, isFullereneCtx, highlightEdges, isolatedHexFaceIndices) {
    lastSetPolyArgs = [poly, poleIndices, isFullereneCtx, highlightEdges, isolatedHexFaceIndices];
    if (faceMesh) { scene_disposeMesh(faceMesh); world.remove(faceMesh); faceMesh = null; }
    if (edgeLines) { scene_disposeMesh(edgeLines); world.remove(edgeLines); edgeLines = null; }
    if (highlightLines) { scene_disposeMesh(highlightLines); world.remove(highlightLines); highlightLines = null; }
    while (poleGroup.children.length) { const c = poleGroup.children.pop(); c.geometry.dispose(); c.material.dispose(); }

    const faceGeo = buildFaceGeometry(poly, isFullereneCtx, isolatedHexFaceIndices);
    // flatShading:true would recompute normals per-triangle via screen-space derivatives,
    // which visibly creases each face along its centroid-fan triangulation seams even when
    // the face is perfectly planar. We already supply one true face-normal per vertex, so
    // smooth shading (flatShading:false) reads it directly and renders every face uniformly.
    const faceMat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: false, roughness: 0.75, metalness: 0.02,
      side: THREE.DoubleSide
    });
    if (!toggles.color) faceMat.vertexColors = false, faceMat.color = new THREE.Color(0xb9a98e);
    faceMesh = new THREE.Mesh(faceGeo, faceMat);
    world.add(faceMesh);

    const highlightEdgeSet = (isFullereneCtx && highlightEdges && highlightEdges.length)
      ? new Set(highlightEdges.map(([a, b]) => Math.min(a, b) + '_' + Math.max(a, b)))
      : null;

    const edgeGeo = buildEdgeGeometry(poly, highlightEdgeSet);
    const edgeMat = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.55 });
    edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
    edgeLines.visible = toggles.edges;
    world.add(edgeLines);

    if (highlightEdgeSet) {
      const highlightGeo = buildHighlightEdgeGeometry(poly, highlightEdgeSet);
      const highlightMat = new THREE.LineBasicMaterial({ color: EDGE_HIGHLIGHT_COLOR, linewidth: 3 });
      highlightLines = new THREE.LineSegments(highlightGeo, highlightMat);
      highlightLines.visible = toggles.edges;
      world.add(highlightLines);
    }

    if (poleIndices && poleIndices.length) {
      const poleGeo = new THREE.SphereGeometry(0.035, 12, 8);
      const poleMat = new THREE.MeshStandardMaterial({ color: POLE_COLOR, roughness: 0.5 });
      for (const idx of poleIndices) {
        const m = new THREE.Mesh(poleGeo, poleMat);
        m.position.copy(poly.verts[idx]);
        poleGroup.add(m);
      }
    }
    poleGroup.visible = toggles.poles;
  }

  function scene_disposeMesh(obj) { if (obj.geometry) obj.geometry.dispose(); if (obj.material) obj.material.dispose(); }

  function setToggles(t) {
    const hexToggleChanged = 'highlightIsolatedHex' in t && t.highlightIsolatedHex !== toggles.highlightIsolatedHex;
    Object.assign(toggles, t);
    if (edgeLines) edgeLines.visible = toggles.edges;
    if (highlightLines) highlightLines.visible = toggles.edges;
    if (sphereMesh) sphereMesh.visible = toggles.sphere;
    if (poleGroup) poleGroup.visible = toggles.poles;
    if (faceMesh) {
      faceMesh.material.vertexColors = toggles.color;
      if (!toggles.color) faceMesh.material.color = new THREE.Color(0xb9a98e);
      faceMesh.material.needsUpdate = true;
    }
    // face colors for isolated hexagons are baked into the geometry, not a visibility flag,
    // so this toggle needs an actual rebuild rather than just flipping a material property.
    if (hexToggleChanged && lastSetPolyArgs) setPoly(...lastSetPolyArgs);
  }

  // Render an intermediate frame during the morph: same face list as `baseFaces`
  // (the fullerene's pentagon/hexagon faces) but vertex positions lerped toward
  // `targetPositions` (each fullerene vertex -> its pole's or its own target spot).
  function renderMorphFrame(baseFaces, fromPositions, targetPositions, t) {
    const n = fromPositions.length;
    const lerped = new Array(n);
    for (let i = 0; i < n; i++) lerped[i] = new THREE.Vector3().lerpVectors(fromPositions[i], targetPositions[i], t);
    setPoly({ verts: lerped, faces: baseFaces }, null, true);
  }

  function render() {
    rendererGL.render(scene, camera);
  }

  function startLoop(onFrame) {
    let last = performance.now();
    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      resize();
      autoRotateStep(dt);
      if (onFrame) onFrame(dt);
      render();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  global.Renderer = { init, setPoly, setToggles, renderMorphFrame, startLoop, resize, FACE_COLORS };
})(window);
