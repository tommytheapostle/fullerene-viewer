// ===================================================================================
// render.js — Three.js scene, hand-rolled orbit camera (r128 has no OrbitControls),
// mesh construction from a Poly (arbitrary convex polygon faces, fan-triangulated),
// and the pole-contraction morph animation.
// ===================================================================================
(function (global) {
  'use strict';

  // Faces are classified by actual shape, not just side count:
  //   C(n) faces: triangle / rhombus (all 4 sides equal) / trapezoid (other quad) / shield pentagon
  //   fullerene faces (pre-contraction view): hexagon / regular pentagon
  const FACE_COLORS = {
    triangle: 0xf2c94c,        // yellow
    rhombus: 0xd6493a,         // red
    trapezoid: 0x4caf6d,       // green
    shieldPentagon: 0x3f7fd1,  // blue
    fullereneHexagon: 0xf7f7f2,  // white
    fullerenePentagon: 0x1a1a1a  // black
  };
  const EDGE_COLOR = 0x3a352c;
  const POLE_COLOR = 0x24211b;

  // A poly's face-size composition tells us whether it's the fullerene (pentagons only
  // touch hexagons, never triangles/quads) or the contracted C(n) (never has hexagons) —
  // within this app's n >= 20 range the fullerene always has at least one hexagon face.
  function classifyFace(poly, face, isFullereneCtx) {
    const n = face.length;
    if (n === 6) return 'fullereneHexagon';
    if (n === 5) return isFullereneCtx ? 'fullerenePentagon' : 'shieldPentagon';
    if (n === 3) return 'triangle';
    if (n === 4) {
      const pts = face.map(vi => poly.verts[vi]);
      const sides = [0, 1, 2, 3].map(i => pts[i].distanceTo(pts[(i + 1) % 4]));
      const avg = sides.reduce((a, b) => a + b, 0) / 4;
      const allEqual = sides.every(s => Math.abs(s - avg) < avg * 0.02);
      return allEqual ? 'rhombus' : 'trapezoid';
    }
    return 'fullereneHexagon';
  }

  let scene, camera, rendererGL, canvas;
  let world; // group holding the polyhedron + edges + poles
  let faceMesh = null, edgeLines = null, poleGroup = null, sphereMesh = null;
  let orbitQuat = new THREE.Quaternion();
  let dragging = false, lastX = 0, lastY = 0;
  let autoRotate = true, userInteracted = false, idleTimer = null;
  let camDistance = 3.4;
  let toggles = { color: true, edges: true, sphere: false, poles: false, spin: false };

  function init(canvasEl) {
    canvas = canvasEl;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f6f3);

    camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, camDistance);

    rendererGL = new THREE.WebGLRenderer({ canvas, antialias: true });
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
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x9fb8c9, transparent: true, opacity: 0.12, depthWrite: false });
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
  function buildFaceGeometry(poly) {
    const positions = [];
    const colors = [];
    const normals = [];
    const colorObj = new THREE.Color();
    const isFullereneCtx = poly.faces.some(f => f.length === 6);
    for (const f of poly.faces) {
      if (f.length < 3) continue;
      const col = FACE_COLORS[classifyFace(poly, f, isFullereneCtx)] || 0x999999;
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
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    return geo;
  }

  function buildEdgeGeometry(poly) {
    const positions = [];
    const seen = new Set();
    for (const f of poly.faces) {
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        const pa = poly.verts[a], pb = poly.verts[b];
        positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }

  function setPoly(poly, poleIndices) {
    if (faceMesh) { scene_disposeMesh(faceMesh); world.remove(faceMesh); faceMesh = null; }
    if (edgeLines) { scene_disposeMesh(edgeLines); world.remove(edgeLines); edgeLines = null; }
    while (poleGroup.children.length) { const c = poleGroup.children.pop(); c.geometry.dispose(); c.material.dispose(); }

    const faceGeo = buildFaceGeometry(poly);
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

    const edgeGeo = buildEdgeGeometry(poly);
    const edgeMat = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.55 });
    edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
    edgeLines.visible = toggles.edges;
    world.add(edgeLines);

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
    Object.assign(toggles, t);
    if (edgeLines) edgeLines.visible = toggles.edges;
    if (sphereMesh) sphereMesh.visible = toggles.sphere;
    if (poleGroup) poleGroup.visible = toggles.poles;
    if (faceMesh) {
      faceMesh.material.vertexColors = toggles.color;
      if (!toggles.color) faceMesh.material.color = new THREE.Color(0xb9a98e);
      faceMesh.material.needsUpdate = true;
    }
  }

  // Render an intermediate frame during the morph: same face list as `baseFaces`
  // (the fullerene's pentagon/hexagon faces) but vertex positions lerped toward
  // `targetPositions` (each fullerene vertex -> its pole's or its own target spot).
  function renderMorphFrame(baseFaces, fromPositions, targetPositions, t) {
    const n = fromPositions.length;
    const lerped = new Array(n);
    for (let i = 0; i < n; i++) lerped[i] = new THREE.Vector3().lerpVectors(fromPositions[i], targetPositions[i], t);
    setPoly({ verts: lerped, faces: baseFaces }, null);
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
