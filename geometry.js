// ===================================================================================
// geometry.js — pole contraction (fullerene -> Catalan-like C(n)) and its inverse,
// plus the canonical-form polish used to touch up the reconstructed fullerene view.
// C(n) itself is loaded pre-solved from catalan_data.js, not built or canonicalized
// here — the values that data was solved for. This module only handles the topology
// bridge between C(n) and its underlying fullerene.
//
// A "Poly" is {verts: THREE.Vector3[], faces: number[][]} where each face is a CCW
// (outward-facing) list of vertex indices.
// ===================================================================================
(function (global) {
  'use strict';

  // Contract each pentagon of a fullerene to its centroid pole, producing C(n).
  // Requires IPR (no two pentagons share an edge / vertex) to be well-defined.
  function poleContract(fullerene) {
    const nv = fullerene.verts.length;
    const pentagonFaces = [];
    for (let fi = 0; fi < fullerene.faces.length; fi++) if (fullerene.faces[fi].length === 5) pentagonFaces.push(fi);
    if (pentagonFaces.length !== 12) return { ok: false, msg: `expected 12 pentagons, found ${pentagonFaces.length}` };

    const vertexPentagon = new Array(nv).fill(-1);
    for (const fi of pentagonFaces) {
      for (const v of fullerene.faces[fi]) {
        if (vertexPentagon[v] !== -1) return { ok: false, msg: `vertex ${v} belongs to 2 pentagons (non-IPR); pole contraction undefined` };
        vertexPentagon[v] = fi;
      }
    }

    const poleId = new Map(), keepId = new Map();
    const newVerts = [];
    for (const fi of pentagonFaces) {
      const sum = new THREE.Vector3();
      for (const v of fullerene.faces[fi]) sum.add(fullerene.verts[v]);
      poleId.set(fi, newVerts.length);
      newVerts.push(sum.multiplyScalar(1 / 5).normalize());
    }
    for (let v = 0; v < nv; v++) if (vertexPentagon[v] === -1) { keepId.set(v, newVerts.length); newVerts.push(fullerene.verts[v].clone()); }
    const mapVert = v => vertexPentagon[v] !== -1 ? poleId.get(vertexPentagon[v]) : keepId.get(v);

    const newFaces = [];
    for (let fi = 0; fi < fullerene.faces.length; fi++) {
      if (fullerene.faces[fi].length === 5) continue;
      const mapped = fullerene.faces[fi].map(mapVert);
      const collapsed = [];
      for (const v of mapped) if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== v) collapsed.push(v);
      if (collapsed.length > 1 && collapsed[0] === collapsed[collapsed.length - 1]) collapsed.pop();
      newFaces.push(collapsed);
    }

    const poly = { verts: newVerts, faces: newFaces };
    const counts = { a3: 0, a4: 0, a5: 0, other: 0 };
    for (const f of newFaces) {
      if (f.length === 3) counts.a3++; else if (f.length === 4) counts.a4++; else if (f.length === 5) counts.a5++; else counts.other++;
    }
    const admissible = counts.other === 0; // a face of size!=3,4,5 after contraction means an isolated (p=0) hexagon survived
    const mapping = new Array(nv);
    for (let v = 0; v < nv; v++) mapping[v] = mapVert(v);
    return { ok: true, poly, poleCount: pentagonFaces.length, keptCount: keepId.size, counts, admissible, mapping };
  }

  // Reverse of poleContract: given C(n) (with 12 degree-5 poles), reconstruct a fullerene
  // by expanding each pole into a pentagon of 5 new vertices. For a pole P touching faces
  // in cyclic order F_0..F_4 (F_w between neighbours[w] and neighbours[w+1]), F_w gets P
  // replaced by (p_w, p_{w+1}) — this is exactly the inverse of the collapse used above,
  // and produces a topologically valid fullerene (checked before returning).
  function poleExpand(poly) {
    const nv = poly.verts.length;
    const degree = new Array(nv).fill(0);
    for (const f of poly.faces) for (const v of f) degree[v]++;
    const poles = [];
    for (let v = 0; v < nv; v++) if (degree[v] === 5) poles.push(v);
    if (poles.length !== 12) return { ok: false, msg: `expected 12 degree-5 vertices, found ${poles.length}` };

    const poleData = new Map();
    for (const P of poles) {
      const recs = [];
      for (let fi = 0; fi < poly.faces.length; fi++) {
        const f = poly.faces[fi];
        const idx = f.indexOf(P);
        if (idx < 0) continue;
        const n = f.length;
        recs.push([f[(idx - 1 + n) % n], f[(idx + 1) % n], fi]);
      }
      if (recs.length !== 5) return { ok: false, msg: `pole ${P} touches ${recs.length} faces, expected 5` };
      const map = new Map();
      for (const r of recs) map.set(r[0], [r[1], r[2]]);
      const start = recs[0][0];
      const neighbors = [start];
      const faceSeq = [];
      let cur = start;
      for (let step = 0; step < 5; step++) {
        const [nxt, fi] = map.get(cur);
        faceSeq.push(fi);
        if (step < 4) neighbors.push(nxt);
        cur = nxt;
      }
      poleData.set(P, { neighbors, faceSeq });
    }

    const newVerts = [];
    const keepId = new Map();
    for (let v = 0; v < nv; v++) if (degree[v] !== 5) { keepId.set(v, newVerts.length); newVerts.push(poly.verts[v].clone()); }
    const poleNewIds = new Map();
    for (const P of poles) {
      const pd = poleData.get(P);
      const ids = [];
      // seed each of the 5 new vertices distinctly (nudged toward its own external neighbour)
      // rather than all 5 coincident at the pole's position — a degenerate coincident start
      // gives the canonicalize polish nothing to work with.
      for (let i = 0; i < 5; i++) {
        ids.push(newVerts.length);
        const nb = poly.verts[pd.neighbors[i]];
        newVerts.push(poly.verts[P].clone().lerp(nb, 0.35).normalize());
      }
      poleNewIds.set(P, ids);
    }
    // wedge lookup: for pole P and face fi, which wedge index (0..4) is this occurrence
    const wedgeOf = new Map(); // "P_fi" -> j
    for (const P of poles) {
      const pd = poleData.get(P);
      for (let j = 0; j < 5; j++) wedgeOf.set(P + '_' + pd.faceSeq[j], j);
    }

    const rebuilt = [];
    for (let fi = 0; fi < poly.faces.length; fi++) {
      const f = poly.faces[fi];
      const out = [];
      for (let i = 0; i < f.length; i++) {
        const v = f[i];
        if (degree[v] !== 5) { out.push(keepId.get(v)); continue; }
        const j = wedgeOf.get(v + '_' + fi);
        const ids = poleNewIds.get(v);
        out.push(ids[j], ids[(j + 1) % 5]);
      }
      rebuilt.push(out);
    }
    for (const P of poles) rebuilt.push(poleNewIds.get(P).slice());

    const fullerene = { verts: newVerts, faces: rebuilt };
    const check = validateFullereneTopology(fullerene, newVerts.length);
    return { ok: check.ok, fullerene, msg: check.ok ? 'ok' : 'expanded topology failed validation', keepId, poleNewIds, poles };
  }

  // Ensure every face is wound consistently with its neighbours (a proper orientable manifold
  // has each undirected edge appear as (a,b) in exactly one face and (b,a) in the other). BFS
  // over face-adjacency from face 0, flipping any face found wound the wrong way relative to
  // its already-fixed neighbour.
  function fixOrientationConsistency(poly) {
    const faces = poly.faces;
    const nf = faces.length;
    const undirected = new Map();
    const addU = (a, b, fi) => {
      const key = Math.min(a, b) + '_' + Math.max(a, b);
      if (!undirected.has(key)) undirected.set(key, []);
      undirected.get(key).push(fi);
    };
    for (let fi = 0; fi < nf; fi++) {
      const f = faces[fi];
      for (let i = 0; i < f.length; i++) addU(f[i], f[(i + 1) % f.length], fi);
    }
    const hasDirectedEdge = (fi, a, b) => {
      const f = faces[fi];
      for (let i = 0; i < f.length; i++) if (f[i] === a && f[(i + 1) % f.length] === b) return true;
      return false;
    };

    const visited = new Array(nf).fill(false);
    let flips = 0;
    for (let start = 0; start < nf; start++) {
      if (visited[start]) continue;
      visited[start] = true;
      const queue = [start];
      while (queue.length) {
        const fi = queue.shift();
        const f = faces[fi];
        const n = f.length;
        for (let i = 0; i < n; i++) {
          const a = f[i], b = f[(i + 1) % n];
          const key = Math.min(a, b) + '_' + Math.max(a, b);
          const touching = undirected.get(key) || [];
          const fj = touching.find(x => x !== fi);
          if (fj === undefined || visited[fj]) continue;
          if (hasDirectedEdge(fj, a, b)) { faces[fj].reverse(); flips++; }
          visited[fj] = true;
          queue.push(fj);
        }
      }
    }
    return flips;
  }

  // Spherical spring relaxation: cheap seed embedding, used only for the reconstructed
  // fullerene view (C(n) itself is loaded pre-solved, never relaxed). Pure neighbour
  // averaging + renormalizing is a consensus process — run to full convergence it
  // collapses EVERY vertex onto a single point, not just onto a smoother layout. How
  // many iterations that takes depends on the graph's mixing rate, which varies a lot,
  // so instead of trusting the iteration budget, detect incipient collapse directly:
  // if the mean of the (unit-vector) candidate positions has grown large, the vertices
  // are converging onto a common direction — stop before applying that step.
  function sphereRelax(poly, iterations) {
    const verts = poly.verts, faces = poly.faces;
    const nv = verts.length;
    const neighbors = new Array(nv).fill(null).map(() => []);
    const seen = new Set();
    for (const f of faces) {
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        neighbors[a].push(b); neighbors[b].push(a);
      }
    }
    for (let iter = 0; iter < iterations; iter++) {
      const next = new Array(nv);
      for (let v = 0; v < nv; v++) {
        const nbs = neighbors[v];
        const sum = new THREE.Vector3();
        for (const u of nbs) sum.add(verts[u]);
        next[v] = nbs.length > 0 ? sum.multiplyScalar(1 / nbs.length).normalize() : verts[v].clone();
      }
      const mean = new THREE.Vector3();
      for (const v of next) mean.add(v);
      mean.multiplyScalar(1 / nv);
      if (mean.length() > 0.9) break;
      for (let v = 0; v < nv; v++) verts[v] = next[v];
    }
  }

  // Hart's canonical-form iteration: planarize faces, then scale edges so their
  // closest-point-to-origin lands on the unit sphere (midsphere), then recenter.
  // Used here only to polish the reconstructed fullerene view — a weak local refiner,
  // not a general solver, but adequate given the wedge-expansion seed above is already
  // close (kept vertices carry over exact positions from the loaded C(n) data).
  function canonicalize(poly, maxIter, tol) {
    const verts = poly.verts, faces = poly.faces;
    const nv = verts.length;
    let residual = Infinity;
    for (let iter = 0; iter < maxIter; iter++) {
      const accum = new Array(nv), cnt = new Array(nv).fill(0);
      for (let i = 0; i < nv; i++) accum[i] = new THREE.Vector3();
      for (const f of faces) {
        const centroid = new THREE.Vector3();
        for (const vi of f) centroid.add(verts[vi]);
        centroid.multiplyScalar(1 / f.length);
        const normal = new THREE.Vector3();
        for (let i = 0; i < f.length; i++) {
          const p1 = verts[f[i]], p2 = verts[f[(i + 1) % f.length]];
          normal.x += (p1.y - p2.y) * (p1.z + p2.z);
          normal.y += (p1.z - p2.z) * (p1.x + p2.x);
          normal.z += (p1.x - p2.x) * (p1.y + p2.y);
        }
        if (normal.length() < 1e-14) continue;
        normal.normalize();
        for (const vi of f) {
          const p = verts[vi];
          const dist = new THREE.Vector3().subVectors(p, centroid).dot(normal);
          const proj = new THREE.Vector3().subVectors(p, normal.clone().multiplyScalar(dist));
          accum[vi].add(proj); cnt[vi]++;
        }
      }
      const stepA = new Array(nv);
      for (let i = 0; i < nv; i++) stepA[i] = cnt[i] > 0 ? accum[i].multiplyScalar(1 / cnt[i]) : verts[i].clone();

      const accumB = new Array(nv), cntB = new Array(nv).fill(0);
      for (let i = 0; i < nv; i++) accumB[i] = new THREE.Vector3();
      const edgeSeen = new Set();
      for (const f of faces) {
        const n = f.length;
        for (let i = 0; i < n; i++) {
          const u = f[i], w = f[(i + 1) % n];
          const ek = Math.min(u, w) + '_' + Math.max(u, w);
          if (edgeSeen.has(ek)) continue;
          edgeSeen.add(ek);
          const pu = stepA[u], pv = stepA[w];
          const d = new THREE.Vector3().subVectors(pv, pu);
          const dl2 = d.dot(d);
          let t = dl2 > 1e-18 ? -pu.dot(d) / dl2 : 0.5;
          t = Math.max(0, Math.min(1, t));
          const closest = new THREE.Vector3().addVectors(pu, d.clone().multiplyScalar(t));
          const cl = closest.length();
          const s = cl > 1e-14 ? 1 / cl : 1;
          accumB[u].add(pu.clone().multiplyScalar(s)); cntB[u]++;
          accumB[w].add(pv.clone().multiplyScalar(s)); cntB[w]++;
        }
      }
      const stepB = new Array(nv);
      for (let i = 0; i < nv; i++) stepB[i] = cntB[i] > 0 ? accumB[i].multiplyScalar(1 / cntB[i]) : stepA[i];

      let tangSum = new THREE.Vector3(); let tangCnt = 0; let maxResidual = 0;
      const seen2 = new Set();
      for (const f of faces) {
        const n = f.length;
        for (let i = 0; i < n; i++) {
          const u = f[i], w = f[(i + 1) % n];
          const ek = Math.min(u, w) + '_' + Math.max(u, w);
          if (seen2.has(ek)) continue;
          seen2.add(ek);
          const pu = stepB[u], pv = stepB[w];
          const d = new THREE.Vector3().subVectors(pv, pu);
          const dl2 = d.dot(d);
          let t = dl2 > 1e-18 ? -pu.dot(d) / dl2 : 0.5;
          t = Math.max(0, Math.min(1, t));
          const closest = new THREE.Vector3().addVectors(pu, d.clone().multiplyScalar(t));
          tangSum.add(closest); tangCnt++;
          maxResidual = Math.max(maxResidual, Math.abs(closest.length() - 1));
        }
      }
      const center = tangCnt > 0 ? tangSum.multiplyScalar(1 / tangCnt) : new THREE.Vector3();
      for (let i = 0; i < nv; i++) verts[i] = new THREE.Vector3().subVectors(stepB[i], center);
      residual = maxResidual;
      if (maxResidual < tol) break;
    }
    return residual;
  }

  function computeInvariants(poly) {
    const verts = poly.verts, faces = poly.faces;
    let areaMin = Infinity, areaMax = -Infinity, dMin = Infinity, dMax = -Infinity;
    const counts = { a3: 0, a4: 0, a5: 0 };
    for (const f of faces) {
      const centroid = new THREE.Vector3();
      for (const vi of f) centroid.add(verts[vi]);
      centroid.multiplyScalar(1 / f.length);
      const normal = new THREE.Vector3();
      for (let i = 0; i < f.length; i++) {
        const p1 = verts[f[i]], p2 = verts[f[(i + 1) % f.length]];
        normal.add(new THREE.Vector3().crossVectors(p1, p2));
      }
      const area = normal.length() * 0.5;
      const dist = Math.abs(centroid.dot(normal.clone().normalize()));
      areaMin = Math.min(areaMin, area); areaMax = Math.max(areaMax, area);
      dMin = Math.min(dMin, dist); dMax = Math.max(dMax, dist);
      if (f.length === 3) counts.a3++; else if (f.length === 4) counts.a4++; else if (f.length === 5) counts.a5++;
    }
    return { rho: areaMax / areaMin, iota: dMin / dMax, areaMin, areaMax, dMin, dMax, counts };
  }

  function validateFullereneTopology(poly, expectV) {
    const faces = poly.faces;
    const nv = poly.verts.length;
    if (nv !== expectV) return { ok: false };
    const edgeCount = new Map();
    for (const f of faces) {
      if (f.length < 3) return { ok: false };
      const n = f.length;
      for (let i = 0; i < n; i++) {
        const a = f[i], b = f[(i + 1) % n];
        if (a === b) return { ok: false };
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      }
    }
    for (const c of edgeCount.values()) if (c !== 2) return { ok: false };
    const deg = new Array(nv).fill(0);
    for (const key of edgeCount.keys()) { const [a, b] = key.split('_').map(Number); deg[a]++; deg[b]++; }
    if (!deg.every(d => d === 3)) return { ok: false };
    let p5 = 0, other = 0;
    for (const f of faces) { if (f.length === 5) p5++; else if (f.length !== 6) other++; }
    if (p5 !== 12 || other !== 0) return { ok: false };
    return { ok: true };
  }

  global.Geo = {
    poleContract, poleExpand, fixOrientationConsistency, sphereRelax, canonicalize,
    computeInvariants, validateFullereneTopology
  };
})(window);
